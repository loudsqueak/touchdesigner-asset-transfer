// What to send and where each piece goes. No I/O here except through the
// functions passed in, so the tests can drive it with fakes.
//
// An upload is a list of paths: files, folders and .zip files. Every top-level
// item that lands on Control is routed to the exhibition's artwork/ or plugins/:
//
//   folder          -> artwork/<folder>/  (layout kept, so a .tox keeps its asset paths)
//   .zip            -> unpacked on Control; each top-level entry is routed like the above
//   loose file      -> artwork/ by default; mark it "plugin" to put it in plugins/
//                      (a plugin's associated files are loose siblings of its .tox)

export type Destination = "artwork" | "plugin";

export interface Item {
  name: string;          // top-level name as it will appear in the transfer folder on Control
  isDir: boolean;
  from: string;          // the path or zip it comes from, for display
  inZip: boolean;
  dest: Destination;
  askTox: boolean;       // a loose .tox: the sender must decide artwork or plugin
}

export interface Plan {
  unzip: string[];
  items: Record<string, Destination>;
}

export interface PathInfo {
  isDir: boolean;
}

const JUNK = new Set(["__MACOSX", ".DS_Store", "Thumbs.db", "desktop.ini", ".Spotlight-V100", ".Trashes", ".fseventsd"]);

// OS clutter that never goes to Control: Finder and Explorer metadata, and
// macOS "._name" resource-fork files (made on non-APFS drives and in zips).
export const isJunk = (name: string) => JUNK.has(name) || name.startsWith("._");

export const baseName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;

// Top-level entries of a zip from its listing (one path per line, as `tar -tf`
// prints it). A name followed by more path is a folder.
export function zipTopLevel(listing: string): { name: string; isDir: boolean }[] {
  const seen = new Map<string, boolean>();
  for (const raw of listing.split(/\r?\n/)) {
    const line = raw.trim().replace(/\\/g, "/");
    if (!line) continue;
    const parts = line.split("/").filter(Boolean);
    if (!parts.length || isJunk(parts[0]) || parts.some((p) => p === "__MACOSX")) continue;
    const isDir = parts.length > 1 || line.endsWith("/");
    seen.set(parts[0], (seen.get(parts[0]) ?? false) || isDir);
  }
  return [...seen].map(([name, isDir]) => ({ name, isDir })).sort((a, b) => a.name.localeCompare(b.name));
}

function looseItem(name: string, isDir: boolean, from: string, inZip: boolean): Item {
  const isTox = !isDir && name.toLowerCase().endsWith(".tox");
  return { name, isDir, from, inZip, dest: "artwork", askTox: isTox };
}

// Turns the chosen paths into routable items. `info` stats a path; `listZip`
// returns a zip's listing. Throws with a readable reason on any clash.
export function buildItems(
  paths: string[],
  info: (path: string) => PathInfo,
  listZip: (path: string) => string,
): Item[] {
  const items: Item[] = [];
  const names = new Map<string, string>();
  const add = (item: Item) => {
    const clash = names.get(item.name);
    if (clash) {
      throw new Error(`"${item.name}" comes from both ${clash} and ${item.from}; rename one of them`);
    }
    names.set(item.name, item.from);
    items.push(item);
  };
  const sent = new Set<string>();
  for (const path of paths) {
    const name = baseName(path);
    if (sent.has(name)) throw new Error(`two of the chosen paths are both called "${name}"`);
    sent.add(name);
    const { isDir } = info(path);
    if (!isDir && name.toLowerCase().endsWith(".zip")) {
      const entries = zipTopLevel(listZip(path));
      if (!entries.length) throw new Error(`${name} is empty`);
      for (const e of entries) add(looseItem(e.name, e.isDir, name, true));
    } else {
      add(looseItem(name, isDir, path, false));
    }
  }
  return items;
}

export function makePlan(items: Item[]): Plan {
  const unzip = [...new Set(items.filter((i) => i.inZip).map((i) => i.from))];
  const plan: Plan = { unzip, items: {} };
  for (const i of items) plan.items[i.name] = i.isDir ? "artwork" : i.dest;
  return plan;
}

// A name croc will accept on Control, and that Windows can store. croc refuses
// any character Go does not count as printable: every space except the plain
// one (macOS screenshots put U+202F before "AM"), and control/format
// characters. Windows also refuses <>:"/\|?* and a trailing dot or space.
export function safeName(name: string): string {
  let out = name
    .replace(/\p{Z}/gu, " ")              // narrow no-break space etc. -> plain space
    .replace(/[\p{C}]/gu, "")             // control, format (zero-width), private-use
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/[. ]+$/, "");
  if (!out || out === "." || out === "..") out = "file";
  return out;
}

export const isSafeName = (name: string) => safeName(name) === name;

// A one-time croc code phrase. croc needs at least 6 characters; this is
// "<4 digits>-<word>-<word>-<word>" like croc's own, from crypto randomness.
const WORDS = ("amber birch cedar delta ember fable glade harbor iris juniper kestrel lumen maple "
  + "nectar orbit pebble quartz raven saffron tundra umber velvet willow yarrow zephyr").split(" ");

export function newCode(random: (n: number) => number = cryptoInt): string {
  const digits = String(random(10000)).padStart(4, "0");
  return [digits, WORDS[random(WORDS.length)], WORDS[random(WORDS.length)], WORDS[random(WORDS.length)],
    random(1_000_000).toString(36)].join("-");
}

function cryptoInt(n: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / n) * n;  // reject the biased tail
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % n;
}
