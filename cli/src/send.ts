// Send files, a folder or a zip to Control from the command line (scripts and
// quick sends). For the full-screen wizard, run `bun run cli`.
//
//   bun run send [paths...] [--exhibition <id>]
//
// With no paths it asks: pick files, pick a folder, or paste/drag paths. Then you
// mark each loose file artwork or plugin, choose the exhibition, and it does the
// rest. Nothing is ever overwritten on Control; anything it cannot place stays
// in its staging folder and is listed here with the reason.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { makePlan, type Item } from "./plan";
import { api, describeRoute, loadSettings, pickRoute, type Settings } from "./settings";
import { ask, c, choose, paint, pick, Quit, splitPaths, toggleList } from "./term";
import { deliver, itemsFor, shortDest } from "./transfer";

function fail(message: string): never {
  console.error(paint(`✗ ${message}`, c.red));
  process.exit(1);
}

function parseArgs(argv: string[]): { paths: string[]; exhibition?: string; plugins: string[]; artwork: boolean } {
  const paths: string[] = [];
  const plugins: string[] = [];
  let exhibition: string | undefined;
  let artwork = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--exhibition" || argv[i] === "-e") exhibition = argv[++i];
    else if (argv[i] === "--plugin") plugins.push(argv[++i]);
    else if (argv[i] === "--artwork") artwork = true;
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("bun run send [paths...] [--exhibition <id>] [--plugin <name>]... [--artwork]\n"
        + "  --plugin <name>  send that top-level file to plugins/ (repeat for its sibling files)\n"
        + "  --artwork        every other loose .tox is artwork (needed without a terminal)\n"
        + "(or `bun run cli` for the wizard)");
      process.exit(0);
    } else paths.push(argv[i]);
  }
  return { paths, exhibition, plugins, artwork };
}

async function choosePaths(): Promise<string[]> {
  const which = await choose("What do you want to send?", ["Pick files…", "Pick a folder…", "Paste or drag paths into the terminal"]);
  if (which < 2) {
    const picked = await pick(which === 0 ? "files" : "folder");
    if (picked === null) console.log(paint("No file picker on this computer; paste the paths instead.", c.yellow));
    else if (!picked.length) throw new Quit();
    else return picked;
  }
  return splitPaths(await ask("Paths (drag files or folders here, then press enter):"));
}

export function rowText(i: Item): string {
  const where = i.isDir ? paint("artwork/ (folder)", c.dim)
    : i.dest === "plugin" ? paint("plugins/", c.yellow) : paint("artwork/", c.green);
  const askTox = i.askTox ? paint("  ← .tox: artwork or plugin?", c.cyan) : "";
  const from = i.inZip ? paint(`  (in ${i.from})`, c.dim) : "";
  return `${(i.name + (i.isDir ? "/" : "")).padEnd(36)} ${where}${from}${askTox}`;
}

export function toggleItem(i: Item): boolean {
  if (i.isDir) return false;  // folders always go to artwork/ with their layout
  i.dest = i.dest === "artwork" ? "plugin" : "artwork";
  i.askTox = false;
  return true;
}

async function main() {
  const { paths: argPaths, exhibition: wanted, plugins: asPlugin, artwork: toxAsArtwork } = parseArgs(process.argv.slice(2));
  const loaded = loadSettings();
  if (!(loaded.url || loaded.remoteUrl) || !loaded.token) fail("not set up yet: run `bun run setup` first");
  const settings = loaded as Settings;

  const paths = (argPaths.length ? argPaths : await choosePaths()).map((p) => resolve(p));
  for (const p of paths) if (!existsSync(p)) fail(`${p} does not exist`);
  let items: Item[];
  try {
    items = itemsFor(paths);
  } catch (e) {
    fail((e as Error).message);
  }
  for (const name of asPlugin) {
    const it = items.find((i) => i.name === name);
    if (!it) fail(`--plugin ${name}: no top-level item with that name`);
    if (it.isDir) fail(`--plugin ${name}: a plugin must be a file, not a folder`);
    it.dest = "plugin";
    it.askTox = false;
  }
  if (toxAsArtwork) for (const i of items) i.askTox = false;
  if (!process.stdin.isTTY) {
    const undecided = items.filter((i) => i.askTox).map((i) => i.name);
    if (undecided.length) fail(`${undecided.join(", ")}: say --plugin <name> or --artwork (no terminal to ask in)`);
  } else if (items.some((i) => !i.isDir) && !asPlugin.length && !toxAsArtwork) {
    await toggleList("Where should each item go?", () => items.map(rowText), (n) => toggleItem(items[n]),
      "space switches artwork/plugin for a file · folders always go to artwork · enter continue · q quit");
  }
  const plan = makePlan(items);

  process.stdout.write(paint("Looking for Control…", c.dim));
  const route = await pickRoute(settings);
  process.stdout.write(`\r\x1b[2KControl reached ${paint(describeRoute(route), route.mode === "lan" ? c.green : c.cyan)}\n`);
  const { exhibitions } = await api(route, settings.token, "GET", "/api/exhibitions");
  if (!exhibitions.length) fail("Control has no exhibitions (check the plugin's Depository folder)");
  let exhibition = exhibitions.find((e: any) => e.id === wanted);
  if (wanted && !exhibition) fail(`no exhibition "${wanted}" on Control`);
  if (!exhibition) {
    exhibition = exhibitions[await choose("Which exhibition?", exhibitions.map((e: any) => `${e.name}  ${paint(e.id, c.dim)}`))];
  }
  const plugins = Object.entries(plan.items).filter(([, d]) => d === "plugin").map(([n]) => n);
  console.log(`\nSending ${items.length} item(s) to ${paint(exhibition.name, c.bold)}`
    + (plugins.length ? `; ${paint(plugins.join(", "), c.yellow)} into plugins/` : ""));

  const abort = new AbortController();
  process.on("SIGINT", () => { abort.abort(); process.exit(130); });
  let via = "";
  const outcome = await deliver({
    route, token: settings.token, paths, plan, exhibitionId: exhibition.id, signal: abort.signal,
    onEvent: (e) => {
      if (e.type === "renamed") {
        console.log(paint(`Renamed ${e.renamed.length} name(s): characters croc or Windows refuse (like the hidden narrow space in macOS screenshot names) were replaced:`, c.yellow));
        for (const r of e.renamed) console.log(paint(`  ${r.from}  →  ${r.to}`, c.dim));
      } else if (e.type === "preparing") process.stdout.write(paint("Preparing files…", c.dim));
      else if (e.type === "dataPath") {
        via = e.path === "lan" ? paint(" [LAN]", c.green) : paint(" [relay]", c.cyan);
        process.stdout.write(`\r\x1b[2KFiles are going ${e.path === "lan"
          ? paint("directly over the LAN", c.green) : paint("through croc's relay over the internet", c.cyan)}\n`);
      } else if (e.type === "status") {
        const pct = e.percent == null ? "" : `${e.percent}% `;
        const status = e.state === "receiving" ? `Sending${via} ${pct}${paint(e.line.slice(0, 60), c.dim)}`
          : e.state === "delivering" ? "Placing files on Control…" : e.state;
        process.stdout.write(`\r\x1b[2K${status}`);
      } else if (e.type === "warning") {
        process.stdout.write(`\r\x1b[2K${paint(e.message, c.yellow)}`);
      }
    },
  });
  process.stdout.write("\r\x1b[2K");
  for (const r of outcome.results) {
    console.log(r.error ? paint(`✗ ${r.name}: ${r.error}`, c.red) : `${paint("✓", c.green)} ${r.name} → ${paint(shortDest(r.dest), c.dim)}`);
  }
  if (!outcome.ok) fail(outcome.results.length ? (outcome.error ?? "delivery failed")
    : `nothing arrived on Control: ${outcome.error ?? "the transfer failed"}`);
  console.log(paint(`Done. Run the artwork scan in Control to add new artwork to ${exhibition.name}.`, c.green));
}

if (import.meta.main) {
  main().catch((e) => {
    if (e instanceof Quit) {
      console.log(paint("Cancelled.", c.dim));
      process.exit(130);
    }
    fail(e?.message ?? String(e));
  });
}
