// One-time setup on a sender's computer.
//
//   bun run setup
//
// Two ways to reach Control; send uses the LAN one whenever it answers and
// falls back to the remote one:
//   LAN     the address on the Asset Transfer panel on Control ("SEND CLI http://…")
//   remote  the Cloudflare hostname, plus a Cloudflare Access service token
//           (from `access token grant asset-transfer …`; ask a fleet admin)
// Both use the plugin's token, also shown on the panel.

import { api, lanRoute, loadSettings, probe, remoteRoute, saveSettings, SETTINGS_FILE, type Route, type Settings } from "./settings";
import { ask, c, paint } from "./term";

const DEFAULT_REMOTE = "https://pa-touchdesigner-assettransfer.nodefoundation.com";
const withScheme = (u: string) => (u && !/^https?:\/\//.test(u) ? `http://${u}` : u).replace(/\/$/, "");

const cur = loadSettings();
console.log(paint("Asset Transfer setup", c.bold));
console.log(paint("Press enter to keep a value in [brackets]. Leave the LAN address blank if you only send from offsite.", c.dim));
const s: Settings = {
  url: withScheme(await ask("LAN address on Control's panel (http://ip:port):", cur.url ?? "")) || undefined,
  remoteUrl: withScheme(await ask("Remote (Cloudflare) address:", cur.remoteUrl ?? DEFAULT_REMOTE)) || undefined,
  cfClientId: (await ask("Cloudflare service token Client ID:", cur.cfClientId ?? "")) || undefined,
  cfClientSecret: (await ask("Cloudflare service token Client Secret:", cur.cfClientSecret ? "(keep)" : "")),
  token: await ask("Plugin token (from the panel):", cur.token ?? ""),
};
if (s.cfClientSecret === "(keep)") s.cfClientSecret = cur.cfClientSecret;
if (!s.cfClientSecret) s.cfClientSecret = undefined;
if (!s.token || !(s.url || s.remoteUrl)) {
  console.error(paint("✗ a plugin token and at least one address are needed", c.red));
  process.exit(1);
}

async function check(label: string, route: Route | null): Promise<boolean> {
  if (!route) return false;
  const p = await probe(route, route.mode === "lan" ? 2000 : 10_000);
  if (!p.ok) {
    console.log(paint(`  ✗ ${label} (${route.base}): ${p.reason}`, c.yellow));
    return false;
  }
  try {
    const { exhibitions } = await api(route, s.token, "GET", "/api/exhibitions");
    console.log(paint(`  ✓ ${label}: connected, ${exhibitions.length} exhibition(s)`, c.green));
    return true;
  } catch (e) {
    console.log(paint(`  ✗ ${label}: ${(e as Error).message}`, c.red));
    return false;
  }
}

console.log("Checking…");
const lanOk = await check("LAN", lanRoute(s));
const remoteOk = await check("remote", remoteRoute(s));
saveSettings(s);
console.log(paint(`Saved to ${SETTINGS_FILE}`, c.dim));
if (!lanOk && !remoteOk) {
  console.log(paint("Neither route works from here yet. Saved anyway; fix what's marked ✗ and run setup again.", c.yellow));
  process.exit(1);
}
if (!lanOk && s.url) console.log(paint("LAN is not reachable from here (normal when offsite); send will use the remote route.", c.dim));
if (!Bun.which("croc")) console.log(paint("! croc is not installed on this computer yet (macOS: brew install croc)", c.yellow));
