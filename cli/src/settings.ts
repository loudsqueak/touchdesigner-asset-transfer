// Where Control is and how to get in. Kept in cli/settings.json (not in git),
// written by `bun run setup`. Environment variables override the file:
//
//   ASSET_TRANSFER_URL         LAN address, e.g. http://10.20.90.231:8004 (tried first)
//   ASSET_TRANSFER_REMOTE_URL  Cloudflare hostname, e.g. https://pa-touchdesigner-assettransfer.nodefoundation.com
//   CF_ACCESS_CLIENT_ID        Cloudflare Access service token for the remote route
//   CF_ACCESS_CLIENT_SECRET
//   ASSET_TRANSFER_TOKEN       the plugin's own token (shown in its panel on Control)
//   CROC_RELAY, CROC_PASS      read by croc itself, when Control uses a private relay

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Settings {
  url?: string;
  remoteUrl?: string;
  cfClientId?: string;
  cfClientSecret?: string;
  token: string;
}

// How this run reaches the plugin: the LAN address, or the Cloudflare tunnel.
export interface Route {
  mode: "lan" | "remote";
  base: string;
  headers: Record<string, string>;
}

export const SETTINGS_FILE = join(import.meta.dir, "..", "settings.json");

const clean = (u?: string) => u?.trim().replace(/\/$/, "") || undefined;

export function loadSettings(): Partial<Settings> {
  let file: Partial<Settings> = {};
  if (existsSync(SETTINGS_FILE)) {
    try {
      file = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    } catch (e) {
      throw new Error(`${SETTINGS_FILE} is not valid JSON: ${(e as Error).message}`);
    }
  }
  const env = process.env;
  return {
    url: clean(env.ASSET_TRANSFER_URL ?? file.url),
    remoteUrl: clean(env.ASSET_TRANSFER_REMOTE_URL ?? file.remoteUrl),
    cfClientId: env.CF_ACCESS_CLIENT_ID ?? file.cfClientId,
    cfClientSecret: env.CF_ACCESS_CLIENT_SECRET ?? file.cfClientSecret,
    token: env.ASSET_TRANSFER_TOKEN ?? file.token,
  };
}

export function saveSettings(settings: Settings): void {
  const out = Object.fromEntries(Object.entries(settings).filter(([, v]) => v));
  writeFileSync(SETTINGS_FILE, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
}

export function lanRoute(s: Settings): Route | null {
  return s.url ? { mode: "lan", base: s.url, headers: {} } : null;
}

export function remoteRoute(s: Settings): Route | null {
  if (!s.remoteUrl) return null;
  const headers: Record<string, string> = {};
  if (s.cfClientId && s.cfClientSecret) {
    headers["CF-Access-Client-Id"] = s.cfClientId;
    headers["CF-Access-Client-Secret"] = s.cfClientSecret;
  }
  return { mode: "remote", base: s.remoteUrl, headers };
}

export const describeRoute = (r: Route) =>
  r.mode === "lan" ? `on the LAN (${r.base})` : `remotely through Cloudflare (${new URL(r.base).host})`;

// Asks /api/health on this route. `ok` when the plugin answered; otherwise
// `reason` says which hop failed, so setup and send can tell the user what to fix.
export async function probe(r: Route, ms: number): Promise<{ ok: boolean; reason: string }> {
  let res: Response;
  try {
    res = await fetch(r.base + "/api/health", { headers: r.headers, redirect: "manual", signal: AbortSignal.timeout(ms) });
  } catch (e) {
    const timeout = (e as Error).name === "TimeoutError";
    return { ok: false, reason: timeout ? `no answer within ${ms / 1000}s` : `cannot connect (${(e as Error).message})` };
  }
  if (r.mode === "remote") {
    if (res.status >= 300 && res.status < 400 || res.status === 401 || res.status === 403) {
      return { ok: false, reason: r.headers["CF-Access-Client-Id"]
        ? "Cloudflare Access refused the service token (check Client ID and Secret)"
        : "Cloudflare Access wants a service token (Client ID and Secret)" };
    }
    if (res.status === 502 || res.status === 504) {
      return { ok: false, reason: "Cloudflare reached Control, but nothing answers on the plugin's port: "
        + "is the updated plugin (API port 8004) loaded on Control?" };
    }
    if (res.status === 530 || res.status === 1033) {
      return { ok: false, reason: "Control's Cloudflare tunnel is down (is the machine on and cloudflared running?)" };
    }
  }
  try {
    const body: any = await res.json();
    if (res.ok && body?.service === "asset-transfer") return { ok: true, reason: "" };
  } catch { /* not JSON */ }
  return { ok: false, reason: `HTTP ${res.status} from something that is not the Asset Transfer plugin` };
}

export async function reachable(r: Route, ms: number): Promise<boolean> {
  return (await probe(r, ms)).ok;
}

// The LAN address when the plugin answers there quickly, otherwise the remote
// route. Throws with what was tried when neither answers.
export async function pickRoute(s: Settings): Promise<Route> {
  const lan = lanRoute(s);
  const remote = remoteRoute(s);
  if (!lan && !remote) throw new Error("no Control address set up: run `bun run setup`");
  const tried: string[] = [];
  if (lan) {
    const p = await probe(lan, 1500);
    if (p.ok) return lan;
    tried.push(`LAN ${lan.base}: ${p.reason}`);
  }
  if (remote) {
    const p = await probe(remote, 10_000);
    if (p.ok) return remote;
    tried.push(`Cloudflare ${remote.base}: ${p.reason}`);
  }
  throw new Error(`cannot reach the Asset Transfer plugin.\n  ${tried.join("\n  ")}`);
}

// Calls the plugin's API over `route`. Returns the parsed body; throws with
// the server's own reason (or a network explanation) when it is not ok.
export async function api(route: Route, token: string, method: string, path: string, body?: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(route.base + path, {
      method,
      redirect: "manual",
      headers: { ...route.headers, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new Error(`lost Control ${describeRoute(route)}: ${(e as Error).message}`);
  }
  if (res.status >= 300 && res.status < 400 || res.status === 403 && route.mode === "remote"
      && !(res.headers.get("content-type") ?? "").includes("json")) {
    throw new Error("Cloudflare Access refused this computer: check the service token id and secret (bun run setup)");
  }
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error(`${route.base}${path} answered ${res.status} with something that is not the plugin's API`);
  }
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error ?? `HTTP ${res.status}`);
  }
  return data;
}

// croc prints "Sending (<from>-><to>)" once it is connected. A private <to>
// address means the files go straight across the LAN; anything else goes
// through croc's relay over the internet.
export function crocPath(line: string): "lan" | "relay" | null {
  const m = /Sending \(([^)]*)->([^)]*)\)/.exec(line);
  if (!m) return null;
  const host = m[2].replace(/^\[|\]$/g, "").replace(/:\d+$/, "");
  return isPrivate(host) ? "lan" : "relay";
}

export function isPrivate(host: string): boolean {
  if (/^(10|127)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) return true;
  const m = /^172\.(\d+)\./.exec(host);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  return /^(fe80|fc|fd)/i.test(host) || host === "::1" || host === "localhost";
}
