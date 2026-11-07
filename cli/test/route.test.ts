import { afterAll, describe, expect, test } from "bun:test";
import { crocPath, isPrivate, pickRoute } from "./helpers";

// A fake plugin, and a fake Cloudflare front that refuses without the service token.
const plugin = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true, service: "asset-transfer" }) });
const cloudflare = Bun.serve({
  port: 0,
  fetch: (req) => req.headers.get("CF-Access-Client-Id") === "id" && req.headers.get("CF-Access-Client-Secret") === "secret"
    ? Response.json({ ok: true, service: "asset-transfer" })
    : new Response(null, { status: 302, headers: { location: "https://example.cloudflareaccess.com/login" } }),
});
afterAll(() => { plugin.stop(true); cloudflare.stop(true); });

const lan = `http://127.0.0.1:${plugin.port}`;
const remote = `http://127.0.0.1:${cloudflare.port}`;
const dead = "http://127.0.0.1:1";

describe("pickRoute", () => {
  test("LAN wins when it answers", async () => {
    const r = await pickRoute({ url: lan, remoteUrl: remote, cfClientId: "id", cfClientSecret: "secret", token: "t" });
    expect(r.mode).toBe("lan");
  });
  test("falls back to remote with the Access headers", async () => {
    const r = await pickRoute({ url: dead, remoteUrl: remote, cfClientId: "id", cfClientSecret: "secret", token: "t" });
    expect(r.mode).toBe("remote");
    expect(r.headers["CF-Access-Client-Id"]).toBe("id");
  });
  test("remote without the service token is refused, with a hint", async () => {
    await expect(pickRoute({ url: dead, remoteUrl: remote, token: "t" })).rejects.toThrow(/wants a service token/);
    await expect(pickRoute({ url: dead, remoteUrl: remote, cfClientId: "x", cfClientSecret: "y", token: "t" }))
      .rejects.toThrow(/refused the service token/);
  });
  test("tunnel up but plugin not listening is named", async () => {
    const badGateway = Bun.serve({ port: 0, fetch: () => new Response("bad gateway", { status: 502 }) });
    try {
      await expect(pickRoute({ remoteUrl: `http://127.0.0.1:${badGateway.port}`, cfClientId: "id",
        cfClientSecret: "secret", token: "t" })).rejects.toThrow(/updated plugin \(API port 8004\)/);
    } finally {
      badGateway.stop(true);
    }
  });
  test("nothing configured", async () => {
    await expect(pickRoute({ token: "t" })).rejects.toThrow(/setup/);
  });
});

describe("crocPath", () => {
  test("private peer is LAN, public is relay", () => {
    expect(crocPath("Sending (127.0.0.1->10.20.30.124)")).toBe("lan");
    expect(crocPath("Sending (->192.168.1.20:9009)")).toBe("lan");
    expect(crocPath("Sending (->203.0.113.7:9009)")).toBe("relay");
    expect(crocPath("loopback.mp4 45% |███")).toBeNull();
  });
  test("isPrivate ranges", () => {
    expect(isPrivate("172.16.0.1")).toBe(true);
    expect(isPrivate("172.32.0.1")).toBe(false);
    expect(isPrivate("fd00::1")).toBe(true);
  });
});
