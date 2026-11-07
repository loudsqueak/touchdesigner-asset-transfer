// The Asset Transfer wizard: a full-screen terminal app for sending artwork and
// exhibition plugins to Control.
//
//   bun run cli
//
// HOME       pick files / a folder / paste paths, or open SETTINGS
// BASKET     what will be sent; space switches a file between artwork/ and plugins/
// EXHIBITION type to filter, enter to choose
// REVIEW     everything that will happen, enter to send
// SENDING    route, LAN-or-relay, progress, then one line per item
//
// ↑/↓ move, enter goes forward, esc goes back, ctrl-c quits from anywhere.
// Control is looked for in the background: the LAN address first, then the
// Cloudflare route. The header always says which one is in use.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { makePlan, type Item } from "./plan";
import {
  api, lanRoute, loadSettings, pickRoute, probe, remoteRoute, saveSettings, type Route, type Settings,
} from "./settings";
import { pick, splitPaths } from "./term";
import { deliver, itemsFor, shortDest, type Outcome } from "./transfer";

const { stdin, stdout } = process;
const k = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m", inv: "\x1b[48;5;237m\x1b[97m",
  green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const paint = (t: string, code: string) => `${code}${t}${k.reset}`;
const visible = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visible(s).length));
const cut = (s: string, w: number) => (s.length > w ? s.slice(0, Math.max(0, w - 1)) + "…" : s);
function clamp(line: string, width: number): string {
  let out = "";
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    const m = line[i] === "\x1b" ? /^\x1b\[[0-9;?]*[A-Za-z]/.exec(line.slice(i)) : null;
    if (m) { out += m[0]; i += m[0].length - 1; continue; }
    if (n++ >= width) break;
    out += line[i];
  }
  return out + k.reset;
}
const row = (text: string, on: boolean) =>
  on ? `${k.inv} › ${text.split(k.reset).join(k.reset + k.inv)} ${k.reset}` : `   ${text}`;

type Screen = "home" | "basket" | "exhibition" | "review" | "sending" | "settings";

// ── state ───────────────────────────────────────────────────────────────────
let settings: Partial<Settings> = loadSettings();
let screen: Screen = settings.token && (settings.url || settings.remoteUrl) ? "home" : "settings";
let cursor = 0;
let paths: string[] = [];
let items: Item[] = [];
let exhibitions: any[] = [];
let filter = "";
let chosen: any = null;
let route: Route | null = null;
let routeNote = "looking for Control…";
let checking = false;
let note: { text: string; error: boolean } | null = null;
let input: { label: string; value: string; secret?: boolean; done: (v: string) => void } | null = null;
let send: {
  abort: AbortController; phase: string; dataPath: "lan" | "relay" | null; percent: number | null;
  line: string; outcome?: Outcome; error?: string; started: number; renamed: { from: string; to: string }[];
} | null = null;
let settingsReport: string[] = [];

const say = (text: string, error = false) => { note = { text, error }; };

// ── Control (background) ────────────────────────────────────────────────────
async function findControl(): Promise<void> {
  if (checking || send) return;
  checking = true;
  try {
    if (!settings.token || !(settings.url || settings.remoteUrl)) {
      route = null;
      routeNote = "not set up: open SETTINGS";
    } else {
      route = await pickRoute(settings as Settings);
      routeNote = "";
      const { exhibitions: list } = await api(route, settings.token!, "GET", "/api/exhibitions");
      exhibitions = list;
    }
  } catch (e) {
    route = null;
    routeNote = (e as Error).message.replace(/\s*\n\s*/g, " · ");
  }
  checking = false;
  draw();
}

// ── basket ──────────────────────────────────────────────────────────────────
function rebuild(next: string[]): boolean {
  const before = new Map(items.map((i) => [i.name, i]));
  try {
    const fresh = itemsFor(next);
    for (const i of fresh) {
      const old = before.get(i.name);
      if (old) { i.dest = old.dest; i.askTox = old.askTox; }
    }
    paths = next;
    items = fresh;
    return true;
  } catch (e) {
    say((e as Error).message, true);
    return false;
  }
}

function addPaths(raw: string[]): void {
  const fresh = raw.map((p) => resolve(p.trim())).filter(Boolean);
  const missing = fresh.filter((p) => !existsSync(p));
  if (missing.length) return say(`not found: ${missing.join(", ")}`, true);
  const next = [...paths, ...fresh.filter((p) => !paths.includes(p))];
  if (rebuild(next)) {
    say(`${fresh.length} added`);
    screen = "basket";
    cursor = 0;
  }
}

async function pickInto(kind: "files" | "folder"): Promise<void> {
  const picked = await pick(kind);
  if (picked === null) {
    say("no file picker on this computer: use paste instead", true);
  } else if (picked.length) {
    addPaths(picked);
  }
  draw();
}

function askPaths(): void {
  input = {
    label: "Drag files or folders here (or paste paths), then press enter",
    value: "",
    done: (v) => { if (v.trim()) addPaths(splitPaths(v)); },
  };
}

function removeAt(n: number): void {
  const it = items[n];
  if (!it) return;
  const source = it.inZip ? paths.find((p) => p.endsWith(it.from)) : it.from;
  rebuild(paths.filter((p) => p !== source));
  say(it.inZip ? `removed ${it.from} (the whole zip)` : `removed ${it.name}`);
  cursor = Math.min(cursor, Math.max(0, items.length - 1));
  if (!items.length) screen = "home";
}

// ── sending ─────────────────────────────────────────────────────────────────
async function startSend(): Promise<void> {
  if (!route || !chosen) return;
  const abort = new AbortController();
  send = { abort, phase: "starting croc…", dataPath: null, percent: null, line: "", started: Date.now(), renamed: [] };
  screen = "sending";
  draw();
  try {
    send.outcome = await deliver({
      route, token: settings.token!, paths, plan: makePlan(items), exhibitionId: chosen.id, signal: abort.signal,
      onEvent: (e) => {
        if (!send) return;
        if (e.type === "renamed") send.renamed = e.renamed;
        else if (e.type === "preparing") send.phase = "preparing files (croc is hashing them)…";
        else if (e.type === "dataPath") send.dataPath = e.path;
        else if (e.type === "status") {
          send.phase = e.state === "receiving" ? "sending" : e.state === "delivering" ? "placing files on Control…" : e.state;
          send.percent = e.percent;
          send.line = e.line;
        } else if (e.type === "warning") say(e.message, true);
        draw();
      },
    });
  } catch (e) {
    send.error = (e as Error).message;
  }
  draw();
}

// ── settings ────────────────────────────────────────────────────────────────
const FIELDS: { key: keyof Settings; label: string; secret?: boolean; hint: string }[] = [
  { key: "url", label: "LAN address", hint: "from Control's panel, e.g. http://10.108.0.25:8004" },
  { key: "remoteUrl", label: "Remote address", hint: "https://pa-touchdesigner-assettransfer.nodefoundation.com" },
  { key: "cfClientId", label: "Cloudflare Client ID", hint: "service token for the remote route" },
  { key: "cfClientSecret", label: "Cloudflare Client Secret", secret: true, hint: "printed once by `access token grant`" },
  { key: "token", label: "Plugin token", hint: "shown on Control's panel" },
];

async function testRoutes(): Promise<void> {
  settingsReport = ["testing…"];
  draw();
  const s = settings as Settings;
  const out: string[] = [];
  for (const [label, r] of [["LAN", lanRoute(s)], ["remote", remoteRoute(s)]] as const) {
    if (!r) { out.push(paint(`  – ${label}: not set`, k.dim)); continue; }
    const p = await probe(r, r.mode === "lan" ? 2000 : 10_000);
    if (!p.ok) { out.push(paint(`  ✗ ${label}: ${p.reason}`, k.yellow)); continue; }
    try {
      const { exhibitions: list } = await api(r, s.token, "GET", "/api/exhibitions");
      out.push(paint(`  ✓ ${label}: connected, ${list.length} exhibition(s)`, k.green));
    } catch (e) {
      out.push(paint(`  ✗ ${label}: ${(e as Error).message}`, k.red));
    }
  }
  settingsReport = out;
  draw();
}

function editField(n: number): void {
  const f = FIELDS[n];
  input = {
    label: `${f.label} (${f.hint})`,
    value: f.secret ? "" : String(settings[f.key] ?? ""),
    secret: f.secret,
    done: (v) => {
      let val = v.trim();
      if (f.secret && !val) return;  // empty secret keeps the old one
      if ((f.key === "url" || f.key === "remoteUrl") && val && !/^https?:\/\//.test(val)) {
        val = (f.key === "url" ? "http://" : "https://") + val;
      }
      (settings as any)[f.key] = val.replace(/\/$/, "") || undefined;
      saveSettings(settings as Settings);
      say(`saved ${f.label}`);
      route = null;
      routeNote = "looking for Control…";
      void findControl();
      void testRoutes();
    },
  };
}

// ── drawing ─────────────────────────────────────────────────────────────────
const shown = () => exhibitions.filter((e) =>
  !filter || `${e.name} ${e.id}`.toLowerCase().includes(filter.toLowerCase()));

function header(): string[] {
  const where = route
    ? route.mode === "lan" ? paint(`● on the LAN  ${route.base}`, k.green)
      : paint(`● remote via Cloudflare  ${new URL(route.base).host}`, k.cyan)
    : checking ? paint("○ looking for Control…", k.dim) : paint(`○ ${routeNote}`, k.red);
  const croc = Bun.which("croc") ? "" : paint("   ! croc not installed", k.yellow);
  return [`${paint(" ASSET TRANSFER ", k.bold + k.inv)}  ${where}${croc}`, ""];
}

function bar(percent: number | null, width: number): string {
  if (percent == null) return paint("░".repeat(width), k.dim);
  const full = Math.round((percent / 100) * width);
  return paint("█".repeat(full), k.green) + paint("░".repeat(width - full), k.dim);
}

function body(width: number): { lines: string[]; keys: string } {
  const L: string[] = [];
  if (screen === "home") {
    const opts = homeOptions();
    L.push(paint("What do you want to send?", k.bold), "");
    opts.forEach((o, i) => L.push(row(o.text, i === cursor)));
    if (items.length) L.push("", paint(`basket: ${items.length} item(s) waiting`, k.dim));
    return { lines: L, keys: "↑/↓ move · enter choose · ctrl-c quit" };
  }
  if (screen === "basket") {
    L.push(paint("Where should each item go?", k.bold), paint("Folders keep their layout in artwork/. Mark a plugin's .tox and its sibling files as plugin.", k.dim), "");
    items.forEach((it, i) => {
      const dest = it.isDir ? paint("artwork/ (folder)", k.dim)
        : it.dest === "plugin" ? paint("plugins/", k.yellow) : paint("artwork/", k.green);
      const extra = (it.inZip ? paint(`  in ${it.from}`, k.dim) : "")
        + (it.askTox ? paint("  ← .tox: artwork or plugin?", k.cyan) : "");
      L.push(row(`${pad(cut(it.name + (it.isDir ? "/" : ""), 38), 40)}${dest}${extra}`, i === cursor));
    });
    return { lines: L, keys: "space artwork/plugin · a add files · f add folder · p paste · d remove · enter next · esc home" };
  }
  if (screen === "exhibition") {
    const list = shown();
    L.push(paint("Which exhibition?", k.bold), `filter: ${filter || paint("type to filter", k.dim)}`, "");
    if (!route) L.push(paint(`Control is not reachable: ${routeNote}`, k.red));
    list.slice(0, 20).forEach((e, i) => L.push(row(`${pad(cut(e.name, 40), 42)}${paint(e.id, k.dim)}`, i === cursor)));
    if (list.length > 20) L.push(paint(`  …${list.length - 20} more, type to narrow`, k.dim));
    return { lines: L, keys: "type to filter · ↑/↓ move · enter choose · esc back" };
  }
  if (screen === "review") {
    const plugins = items.filter((i) => !i.isDir && i.dest === "plugin");
    L.push(paint("Ready to send", k.bold), "");
    L.push(`  exhibition  ${paint(chosen.name, k.bold)} ${paint(chosen.id, k.dim)}`);
    L.push(`  Control     ${route ? (route.mode === "lan" ? paint("on the LAN", k.green) : paint("remote via Cloudflare", k.cyan)) : paint("not reachable", k.red)}`);
    L.push(`  items       ${items.length}  (${items.length - plugins.length} to artwork/, ${plugins.length} to plugins/)`, "");
    for (const it of items) {
      const to = it.isDir || it.dest === "artwork" ? "artwork/" : paint("plugins/", k.yellow);
      L.push(`    ${pad(cut(it.name + (it.isDir ? "/" : ""), 40), 42)}→ ${to}`);
    }
    if (plugins.length) L.push("", paint("  Plugins load with this exhibition and run on Control.", k.yellow));
    return { lines: L, keys: "enter send · esc back" };
  }
  if (screen === "sending" && send) {
    const s = send;
    const via = s.dataPath === "lan" ? paint("directly over the LAN", k.green)
      : s.dataPath === "relay" ? paint("through croc's relay over the internet", k.cyan) : paint("connecting…", k.dim);
    L.push(paint(`Sending to ${chosen.name}`, k.bold), "");
    L.push(`  Control  ${route?.mode === "lan" ? paint("on the LAN", k.green) : paint("remote via Cloudflare", k.cyan)}`);
    L.push(`  files    ${via}`);
    L.push(`  elapsed  ${Math.round((Date.now() - s.started) / 1000)} s`);
    if (s.renamed.length) {
      L.push(paint(`  renamed  ${s.renamed.length} name(s): hidden or reserved characters replaced (e.g. the narrow space in screenshot names):`, k.yellow));
      for (const r of s.renamed.slice(0, 4)) L.push(paint(`           ${cut(r.from, 50)}  →  ${cut(r.to, 50)}`, k.dim));
      if (s.renamed.length > 4) L.push(paint(`           …and ${s.renamed.length - 4} more`, k.dim));
    }
    L.push("");
    if (!s.outcome && !s.error) {
      L.push(`  ${bar(s.percent, Math.min(50, width - 12))} ${s.percent == null ? "" : s.percent + "%"}`);
      L.push(`  ${s.phase}`, paint(`  ${cut(s.line, width - 4)}`, k.dim));
      return { lines: L, keys: "esc cancel" };
    }
    if (s.error) L.push(paint(`  ✗ ${s.error}`, k.red));
    for (const r of s.outcome?.results ?? []) {
      L.push(r.error ? paint(`  ✗ ${r.name}: ${r.error}`, k.red) : `  ${paint("✓", k.green)} ${r.name} ${paint("→ " + shortDest(r.dest), k.dim)}`);
    }
    if (s.outcome?.ok) L.push("", paint(`  Done. Run the artwork scan in Control to add the new artwork.`, k.green));
    else if (s.outcome && s.outcome.results.length) L.push("", paint(`  ${s.outcome.error ?? "not everything was placed"}; the rest is in Control's staging folder.`, k.yellow));
    else if (s.outcome) L.push("", paint(`  Nothing arrived on Control: ${s.outcome.error ?? "the transfer failed"}`, k.red));
    return { lines: L, keys: "enter home (new send) · r send the same items again · ctrl-c quit" };
  }
  if (screen === "settings") {
    L.push(paint("Settings", k.bold), paint("Saved to cli/settings.json on this computer only.", k.dim), "");
    FIELDS.forEach((f, i) => {
      const v = settings[f.key];
      const val = !v ? paint("not set", k.dim) : f.secret ? paint("•••••••• (set)", k.dim) : String(v);
      L.push(row(`${pad(f.label, 26)}${val}`, i === cursor));
    });
    L.push(row("Done", cursor === FIELDS.length), "", ...settingsReport);
    return { lines: L, keys: "enter edit · t test both routes · esc home" };
  }
  return { lines: L, keys: "" };
}

function homeOptions(): { text: string; act: () => void | Promise<void> }[] {
  const o: { text: string; act: () => void | Promise<void> }[] = [];
  if (items.length) o.push({ text: `Continue with the basket (${items.length} item(s))`, act: () => { screen = "basket"; cursor = 0; } });
  o.push({ text: "Send files…", act: () => pickInto("files") });
  o.push({ text: "Send a folder…  (a .tox with its assets goes to artwork/<folder>/)", act: () => pickInto("folder") });
  o.push({ text: "Paste or drag paths", act: askPaths });
  if (items.length) o.push({ text: "Clear the basket", act: () => { paths = []; items = []; say("basket cleared"); cursor = 0; } });
  o.push({ text: "Settings", act: () => { screen = "settings"; cursor = 0; settingsReport = []; } });
  o.push({ text: "Quit", act: quit });
  return o;
}

let lastDrawn = "";
function draw(): void {
  const width = stdout.columns || 100;
  const height = stdout.rows || 30;
  const { lines, keys } = body(width);
  const out = [...header(), ...lines];
  const bottom: string[] = [];
  if (input) {
    const shownValue = input.secret ? "•".repeat(input.value.length) : input.value;
    bottom.push("", paint(input.label, k.bold), `> ${shownValue}${k.inv} ${k.reset}`, paint("enter accept · esc cancel", k.dim));
  } else {
    if (note) bottom.push("", paint(note.text, note.error ? k.red : k.dim));
    bottom.push("", paint(keys, k.dim));
  }
  const room = Math.max(0, height - bottom.length);
  const frame = [...out.slice(0, room), ...Array(Math.max(0, room - out.length)).fill(""), ...bottom]
    .map((l) => clamp(l, width) + "\x1b[K").join("\n");
  if (frame === lastDrawn) return;
  lastDrawn = frame;
  stdout.write("\x1b[?2026h\x1b[H" + frame + "\x1b[J\x1b[?2026l");
}

// ── keys ────────────────────────────────────────────────────────────────────
const UP = new Set(["\x1b[A", "k"]);
const DOWN = new Set(["\x1b[B", "j"]);
const ENTER = new Set(["\r", "\n"]);

function move(key: string, count: number): boolean {
  if (!count) return false;
  if (key === "\x1b[A" || (key === "k" && screen !== "exhibition")) { cursor = (cursor + count - 1) % count; return true; }
  if (key === "\x1b[B" || (key === "j" && screen !== "exhibition")) { cursor = (cursor + 1) % count; return true; }
  return false;
}

async function onKey(key: string): Promise<void> {
  if (key === "\x03") return quit();
  if (input) {
    if (ENTER.has(key)) { const i = input; input = null; i.done(i.value); }
    else if (key === "\x1b") input = null;
    else if (key === "\x7f" || key === "\b") input.value = input.value.slice(0, -1);
    else if (key >= " " && !key.startsWith("\x1b")) input.value += key;
    return draw();
  }
  note = null;
  if (screen === "home") {
    const opts = homeOptions();
    if (move(key, opts.length)) return draw();
    if (ENTER.has(key)) await opts[cursor]?.act();
    else if (key === "q") return quit();
  } else if (screen === "basket") {
    if (move(key, items.length)) return draw();
    if (key === " " && items[cursor]) {
      const it = items[cursor];
      if (it.isDir) say("folders always go to artwork/ (with their layout)");
      else { it.dest = it.dest === "artwork" ? "plugin" : "artwork"; it.askTox = false; }
    } else if (key === "a") await pickInto("files");
    else if (key === "f") await pickInto("folder");
    else if (key === "p") askPaths();
    else if (key === "d") removeAt(cursor);
    else if (key === "\x1b") { screen = "home"; cursor = 0; }
    else if (ENTER.has(key)) {
      const undecided = items.filter((i) => i.askTox);
      if (undecided.length) {
        // A loose .tox must be a deliberate choice; enter once more accepts artwork for all.
        undecided.forEach((i) => { i.askTox = false; });
        say(`${undecided.map((i) => i.name).join(", ")}: kept as artwork. Press space on one to make it a plugin, or enter to continue.`);
      } else {
        screen = "exhibition"; cursor = 0; filter = "";
        if (!route) void findControl();
      }
    }
  } else if (screen === "exhibition") {
    const list = shown();
    if (move(key, Math.min(list.length, 20))) return draw();
    if (ENTER.has(key)) {
      if (!route) say("Control is not reachable yet", true);
      else if (list[cursor]) { chosen = list[cursor]; screen = "review"; cursor = 0; }
    } else if (key === "\x1b") { if (filter) filter = ""; else { screen = "basket"; cursor = 0; } }
    else if (key === "\x7f" || key === "\b") { filter = filter.slice(0, -1); cursor = 0; }
    else if (key.length === 1 && key >= " ") { filter += key; cursor = 0; }
  } else if (screen === "review") {
    if (ENTER.has(key)) { if (route) await startSend(); else say("Control is not reachable", true); }
    else if (key === "\x1b") { screen = "exhibition"; cursor = 0; }
  } else if (screen === "sending" && send) {
    const finished = Boolean(send.outcome || send.error);
    if (!finished && key === "\x1b") { send.abort.abort(); say("cancelled"); }
    else if (finished && ENTER.has(key)) {
      if (send.outcome?.ok) { paths = []; items = []; }
      send = null; screen = "home"; cursor = 0; void findControl();
    } else if (finished && key === "r") { send = null; screen = "review"; }
  } else if (screen === "settings") {
    if (move(key, FIELDS.length + 1)) return draw();
    if (ENTER.has(key)) {
      if (cursor === FIELDS.length) { screen = "home"; cursor = 0; }
      else editField(cursor);
    } else if (key === "t") await testRoutes();
    else if (key === "\x1b") { screen = "home"; cursor = 0; }
  }
  draw();
}

// ── start / stop ────────────────────────────────────────────────────────────
let closed = false;
function quit(): void {
  if (closed) return;
  closed = true;
  send?.abort.abort();
  stdout.write("\x1b[?25h\x1b[?1049l");
  try { stdin.setRawMode(false); } catch {}
  process.exit(0);
}

if (!stdin.isTTY) {
  console.error("The wizard needs an interactive terminal. For scripts use: bun run send <paths> -e <exhibition>");
  process.exit(1);
}
stdout.write("\x1b[?1049h\x1b[?25l\x1b[H\x1b[2J");
process.on("exit", () => { if (!closed) stdout.write("\x1b[?25h\x1b[?1049l"); });
stdin.setRawMode(true);
stdin.resume();
stdin.setEncoding("utf8");
let queue = Promise.resolve();
stdin.on("data", (chunk: string) => {
  for (const key of chunk.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/g) ?? []) {
    queue = queue.then(() => onKey(key)).catch((e) => { say(String(e?.message ?? e), true); draw(); });
  }
});
stdout.on("resize", () => { stdout.write("\x1b[2J"); lastDrawn = ""; draw(); });
if (screen === "settings") say("First run: fill in the addresses and tokens (enter edits a line), then press t to test.");
draw();
void findControl();
setInterval(() => { if (screen === "home" || screen === "basket" || screen === "settings") void findControl(); }, 15_000);
setInterval(() => { if (screen === "sending") { lastDrawn = ""; draw(); } }, 1000);
