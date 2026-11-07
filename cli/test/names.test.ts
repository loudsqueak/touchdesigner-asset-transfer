import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSafeName, safeName } from "../src/plan";
import { prepareForCroc } from "../src/transfer";

const SHOT = "Screenshot 2026-11-02 at 11.51.42 AM.png";

describe("safeName", () => {
  test("macOS screenshot narrow no-break space becomes a plain space", () => {
    expect(safeName(SHOT)).toBe("Screenshot 2026-11-02 at 11.51.42 AM.png");
    expect(isSafeName(SHOT)).toBe(false);
  });
  test("zero-width and control characters are dropped", () => {
    expect(safeName("a​b\u0007c.mp4")).toBe("abc.mp4");
  });
  test("Windows-reserved characters and trailing dots", () => {
    expect(safeName('a:b?c*"d".mov')).toBe("a-b-c--d-.mov");
    expect(safeName("name. ")).toBe("name");
  });
  test("ordinary names are untouched", () => {
    for (const n of ["clip.mp4", "Night Garden", "café – 1.png", "日本.tox"]) expect(safeName(n)).toBe(n);
  });
});

describe("prepareForCroc", () => {
  const root = mkdtempSync(join(tmpdir(), "at-names-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, SHOT), "png");
  writeFileSync(join(root, "ok.mp4"), "mp4");
  mkdirSync(join(root, "piece", "media"), { recursive: true });
  writeFileSync(join(root, "piece", "media", `still 1.png`), "x");
  writeFileSync(join(root, "piece", "piece.tox"), "t");

  test("safe paths are sent as-is; unsafe ones as clones with the plan translated", () => {
    const p = prepareForCroc([join(root, SHOT), join(root, "ok.mp4"), join(root, "piece")],
      { unzip: [], items: { [SHOT]: "artwork", "ok.mp4": "artwork", piece: "artwork" } });
    try {
      expect(p.paths[1]).toBe(join(root, "ok.mp4"));
      expect(p.paths[0].endsWith("Screenshot 2026-11-02 at 11.51.42 AM.png")).toBe(true);
      expect(readFileSync(p.paths[0], "utf8")).toBe("png");
      expect(readdirSync(join(p.paths[2], "media"))).toEqual(["still 1.png"]);
      expect(p.plan.items).toEqual({ "Screenshot 2026-11-02 at 11.51.42 AM.png": "artwork", "ok.mp4": "artwork", piece: "artwork" });
      expect(p.renamed.map((r) => r.to)).toEqual(["Screenshot 2026-11-02 at 11.51.42 AM.png", "piece/media/still 1.png"]);
      expect(existsSync(join(root, SHOT))).toBe(true);  // original untouched
    } finally {
      p.cleanup();
    }
    expect(existsSync(p.paths[0])).toBe(false);
  });

  test("OS clutter is left out of folders, wherever it is", () => {
    mkdirSync(join(root, "show", "media", "__MACOSX"), { recursive: true });
    for (const f of [".DS_Store", "show.tox", "._show.tox", "Thumbs.db", "media/a.png", "media/.DS_Store", "media/desktop.ini", "media/__MACOSX/x"]) {
      writeFileSync(join(root, "show", f), "x");
    }
    const p = prepareForCroc([join(root, "show")], { unzip: [], items: { show: "artwork" } });
    try {
      expect(p.paths[0]).not.toBe(join(root, "show"));
      expect(readdirSync(p.paths[0]).sort()).toEqual(["media", "show.tox"]);
      expect(readdirSync(join(p.paths[0], "media"))).toEqual(["a.png"]);
      expect(p.renamed).toEqual([]);
      expect(existsSync(join(root, "show", ".DS_Store"))).toBe(true);
    } finally {
      p.cleanup();
    }
  });

  test("a clean folder is sent from where it is", () => {
    mkdirSync(join(root, "clean"), { recursive: true });
    writeFileSync(join(root, "clean", "a.mp4"), "x");
    const p = prepareForCroc([join(root, "clean")], { unzip: [], items: { clean: "artwork" } });
    expect(p.paths[0]).toBe(join(root, "clean"));
    p.cleanup();
  });

  test("two names that clean up to the same thing are refused", () => {
    writeFileSync(join(root, "a b.png"), "1");
    writeFileSync(join(root, "a b.png"), "2");
    expect(() => prepareForCroc([join(root, "a b.png"), join(root, "a b.png")], { unzip: [], items: {} }))
      .toThrow(/both arrive/);
  });
});
