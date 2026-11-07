// The send engine shared by `bun run send` and the wizard: list what a path
// holds, run croc with a fresh code, hand the code to the plugin, and follow
// the delivery until Control has placed everything.

import { constants, copyFileSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildItems, isJunk, isSafeName, newCode, safeName, type Item, type Plan } from "./plan";
import { api, crocPath, type Route } from "./settings";

export function listZip(path: string): string {
  // bsdtar reads zips on macOS and Windows 10+; Linux usually has unzip.
  const tar = Bun.spawnSync(["tar", "-tf", path], { stdout: "pipe", stderr: "pipe" });
  if (tar.exitCode === 0) return tar.stdout.toString();
  const unzip = Bun.which("unzip") && Bun.spawnSync(["unzip", "-Z1", path], { stdout: "pipe", stderr: "pipe" });
  if (unzip && unzip.exitCode === 0) return unzip.stdout.toString();
  throw new Error(`cannot read ${path} as a zip: ${tar.stderr.toString().trim()}`);
}

export function itemsFor(paths: string[]): Item[] {
  return buildItems(paths, (p) => ({ isDir: statSync(p).isDirectory() }), listZip);
}

// ── names croc would refuse ─────────────────────────────────────────────────

// True when a folder can go as it is: every name safe and no OS clutter in it.
function treeIsSafe(dir: string): boolean {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (isJunk(e.name) || !isSafeName(e.name)) return false;
    if (e.isDirectory() && !treeIsSafe(join(dir, e.name))) return false;
  }
  return true;
}

// Mirrors a file or folder under safe names, leaving out OS clutter. Files are
// hard-linked (no copying, same drive), else cloned (instant on APFS), else
// copied. croc only reads them; the originals are never touched.
function cloneSafe(src: string, dest: string, renamed: { from: string; to: string }[], rel: string): void {
  if (!statSync(src).isDirectory()) {
    try {
      linkSync(src, dest);
    } catch {
      copyFileSync(src, dest, constants.COPYFILE_FICLONE);
    }
    return;
  }
  mkdirSync(dest);
  const taken = new Set<string>();
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (isJunk(e.name)) continue;
    let name = safeName(e.name);
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${safeName(e.name)} (${n})`;
    taken.add(name.toLowerCase());
    if (name !== e.name) renamed.push({ from: `${rel}/${e.name}`, to: `${rel}/${name}` });
    cloneSafe(join(src, e.name), join(dest, name), renamed, `${rel}/${name}`);
  }
}

export interface Prepared {
  paths: string[];
  plan: Plan;
  renamed: { from: string; to: string }[];
  cleanup: () => void;
}

// What croc actually sends: the original paths when every name is safe,
// otherwise temporary clones under safe names, with the plan translated.
export function prepareForCroc(paths: string[], plan: Plan): Prepared {
  let tmp: string | null = null;
  const out: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  const next: Plan = { unzip: [...plan.unzip], items: { ...plan.items } };
  const used = new Set<string>();
  try {
    for (const p of paths) {
      const name = basename(p);
      const safe = safeName(name);
      const isDir = statSync(p).isDirectory();
      if (used.has(safe.toLowerCase())) throw new Error(`two items would both arrive as "${safe}"; rename one`);
      used.add(safe.toLowerCase());
      if (safe === name && (!isDir || treeIsSafe(p))) {
        out.push(p);
        continue;
      }
      tmp ??= mkdtempSync(join(tmpdir(), "asset-transfer-"));
      cloneSafe(p, join(tmp, safe), renamed, safe);
      if (safe !== name) {
        renamed.unshift({ from: name, to: safe });
        if (name in next.items) {
          next.items[safe] = next.items[name];
          delete next.items[name];
        }
        next.unzip = next.unzip.map((z) => (z === name ? safe : z));
      }
      out.push(join(tmp, safe));
    }
  } catch (e) {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return { paths: out, plan: next, renamed, cleanup: () => { if (tmp) rmSync(tmp, { recursive: true, force: true }); } };
}

export type SendEvent =
  | { type: "renamed"; renamed: { from: string; to: string }[] }
  | { type: "preparing" }
  | { type: "dataPath"; path: "lan" | "relay" }
  | { type: "status"; state: string; percent: number | null; line: string }
  | { type: "warning"; message: string };

export interface Result {
  name: string;
  kind: string;
  dest: string | null;
  error: string | null;
}

export interface Outcome {
  ok: boolean;
  error: string | null;
  results: Result[];
}

// "D:\\…\\exhibitions\\summer\\artwork\\x.mp4" -> "summer/artwork/x.mp4"
export const shortDest = (dest: string | null) =>
  (dest ?? "").replace(/^.*[\\/]exhibitions[\\/]/, "").replace(/\\/g, "/");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Collects a stream's output, split on \r and \n (croc redraws its bar with \r).
function follow(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  return (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += decoder.decode(chunk, { stream: true });
      const parts = buf.split(/[\r\n]/);
      buf = parts.pop() ?? "";
      for (const p of parts) if (p.trim()) onLine(p.trim());
    }
    if (buf.trim()) onLine(buf.trim());
  })();
}

// Sends `paths` and has Control place them per `plan` into `exhibitionId`.
// Resolves when Control is done (ok or not). Throws only when the send could
// not start or croc died before Control received anything.
export async function deliver(opts: {
  route: Route; token: string; paths: string[]; plan: Plan; exhibitionId: string;
  onEvent: (e: SendEvent) => void; signal?: AbortSignal;
}): Promise<Outcome> {
  const { route, token, exhibitionId, onEvent } = opts;
  if (!Bun.which("croc")) throw new Error("croc is not installed (macOS: brew install croc)");
  const prepared = prepareForCroc(opts.paths, opts.plan);
  const { paths, plan } = prepared;
  if (prepared.renamed.length) onEvent({ type: "renamed", renamed: prepared.renamed });
  const code = newCode();
  const child = Bun.spawn(["croc", "--no-compress", "send", ...paths], {
    env: { ...process.env, CROC_SECRET: code },  // never on the command line
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
  });
  opts.signal?.addEventListener("abort", () => child.kill());

  let ready = false;
  let lastLine = "";
  let dataPath: "lan" | "relay" | null = null;
  const output: string[] = [];
  const watch = (raw: string) => {
    const line = raw.replaceAll(code, "<code>");
    output.push(line);
    lastLine = line;
    if (raw.includes(code) || /sending|code is/i.test(raw)) ready = true;
    const p = crocPath(raw);
    if (p && p !== dataPath) {
      dataPath = p;
      onEvent({ type: "dataPath", path: p });
    }
  };
  let exited: number | null = null;
  Promise.all([follow(child.stdout, watch), follow(child.stderr, watch)])
    .then(() => child.exited).then((c) => { exited = c; });

  try {
    onEvent({ type: "preparing" });
    while (!ready && exited === null) {
      if (opts.signal?.aborted) throw new Error("cancelled");
      await sleep(100);
    }
    if (!ready) throw new Error(`croc stopped before sending: ${output.slice(-3).join(" / ")}`);

    let { delivery } = await api(route, token, "POST", "/api/deliveries", { code, exhibition: exhibitionId, plan });
    while (delivery.state !== "done" && delivery.state !== "failed") {
      if (opts.signal?.aborted) throw new Error("cancelled");
      await sleep(600);
      try {
        ({ delivery } = await api(route, token, "GET", `/api/deliveries/${delivery.id}`));
      } catch (e) {
        onEvent({ type: "warning", message: (e as Error).message });
        continue;
      }
      onEvent({ type: "status", state: delivery.state, percent: delivery.percent ?? null, line: lastLine });
      if (exited !== null && exited !== 0 && delivery.state === "receiving") {
        throw new Error(`croc failed: ${output.slice(-3).join(" / ")}`);
      }
    }
    return { ok: delivery.state === "done", error: delivery.error ?? null, results: delivery.results ?? [] };
  } finally {
    child.kill();
    prepared.cleanup();
  }
}
