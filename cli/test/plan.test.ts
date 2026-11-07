import { describe, expect, test } from "bun:test";
import { buildItems, makePlan, newCode, splitKeys, splitPathsForTest, zipTopLevel } from "./helpers";

describe("splitKeys", () => {
  test("batched keys and arrows", () => {
    expect(splitKeys(" \r")).toEqual([" ", "\r"]);
    expect(splitKeys("\x1b[B\x1b[Bj \r")).toEqual(["\x1b[B", "\x1b[B", "j", " ", "\r"]);
    expect(splitKeys("\x1b")).toEqual(["\x1b"]);
  });
});

const fs: Record<string, boolean> = {
  "/u/clip.mp4": false, "/u/cue.tox": false, "/u/cue.json": false, "/u/piece": true,
  "/u/pack.zip": false, "/v/clip.mp4": false,
};
const info = (p: string) => ({ isDir: fs[p] });
const zips: Record<string, string> = {
  "/u/pack.zip": "show/\nshow/show.tox\nshow/media/a.png\nloose.tox\n__MACOSX/show/._a.png\n.DS_Store\n._loose.tox\n",
};
const listZip = (p: string) => zips[p];

describe("zipTopLevel", () => {
  test("folders, files and junk", () => {
    expect(zipTopLevel(zips["/u/pack.zip"])).toEqual([
      { name: "loose.tox", isDir: false }, { name: "show", isDir: true }]);
  });
  test("windows separators", () => {
    expect(zipTopLevel("a\\b.png\r\nc.png\r\n")).toEqual([{ name: "a", isDir: true }, { name: "c.png", isDir: false }]);
  });
});

describe("buildItems + makePlan", () => {
  test("files default to artwork, a loose .tox asks, folders are artwork", () => {
    const items = buildItems(["/u/clip.mp4", "/u/cue.tox", "/u/piece"], info, listZip);
    expect(items.map((i) => [i.name, i.dest, i.askTox])).toEqual([
      ["clip.mp4", "artwork", false], ["cue.tox", "artwork", true], ["piece", "artwork", false]]);
  });

  test("plugin marking reaches the plan; folders stay artwork", () => {
    const items = buildItems(["/u/cue.tox", "/u/cue.json", "/u/piece"], info, listZip);
    for (const i of items) i.dest = "plugin";
    expect(makePlan(items)).toEqual({
      unzip: [], items: { "cue.tox": "plugin", "cue.json": "plugin", piece: "artwork" } });
  });

  test("a zip is listed by its top-level entries and unpacked on Control", () => {
    const items = buildItems(["/u/pack.zip"], info, listZip);
    expect(items.map((i) => [i.name, i.isDir, i.inZip, i.askTox])).toEqual([
      ["loose.tox", false, true, true], ["show", true, true, false]]);
    expect(makePlan(items)).toEqual({ unzip: ["pack.zip"], items: { "loose.tox": "artwork", show: "artwork" } });
  });

  test("same name twice is refused", () => {
    expect(() => buildItems(["/u/clip.mp4", "/v/clip.mp4"], info, listZip)).toThrow(/both called/);
  });

  test("a zip entry clashing with a sent file is refused", () => {
    zips["/u/pack.zip"] += "clip.mp4\n";
    expect(() => buildItems(["/u/clip.mp4", "/u/pack.zip"], info, listZip)).toThrow(/comes from both/);
  });
});

describe("newCode", () => {
  test("croc-shaped and long enough", () => {
    const code = newCode();
    expect(code).toMatch(/^\d{4}-[a-z]+-[a-z]+-[a-z]+-[0-9a-z]+$/);
    expect(code.length).toBeGreaterThanOrEqual(6);
  });
  test("different every time", () => {
    expect(new Set(Array.from({ length: 50 }, () => newCode())).size).toBe(50);
  });
});

describe("splitPaths", () => {
  test("dragged mac paths and quotes", () => {
    expect(splitPathsForTest("/a/my\\ file.mp4 '/b/two words.tox' \"/c/x.zip\"")).toEqual(
      ["/a/my file.mp4", "/b/two words.tox", "/c/x.zip"]);
  });
});
