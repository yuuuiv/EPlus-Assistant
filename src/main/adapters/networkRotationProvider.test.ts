import { describe, expect, it, vi } from "vitest";
import { ClashControllerProvider } from "./networkRotationProvider.js";

describe("ClashControllerProvider", () => {
  it("initializes with valid config", () => {
    expect(() => new ClashControllerProvider(validConfig(), fetch)).not.toThrow();
  });

  it("throws on missing config fields", () => {
    expect(() => new ClashControllerProvider({ ...validConfig(), host: "" }, fetch)).toThrow("host");
    expect(() => new ClashControllerProvider({ ...validConfig(), port: 0 }, fetch)).toThrow("port");
    expect(() => new ClashControllerProvider({ ...validConfig(), secret: "" }, fetch)).toThrow("secret");
    expect(() => new ClashControllerProvider({ ...validConfig(), proxyGroup: "" }, fetch)).toThrow("proxyGroup");
  });

  it("mocked rotate then detect yields a changed policy-approved identity", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ now: "node-a", all: ["node-a", "node-b"] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ query: "203.0.113.8", country: "Japan", regionName: "Tokyo", city: "Chiyoda" }));
    const provider = new ClashControllerProvider(validConfig(), fetcher);

    await provider.rotate();
    const identity = await provider.detectIp();

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:9090/proxies/Auto",
      expect.objectContaining({ headers: { Authorization: "Bearer controller-secret" } })
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:9090/proxies/Auto",
      expect.objectContaining({ body: JSON.stringify({ name: "node-b" }), method: "PUT" })
    );
    expect(identity).toEqual({ ip: "203.0.113.8", country: "Japan", region: "Tokyo", city: "Chiyoda" });
  });

  it("detectIp validates response schema", async () => {
    const provider = new ClashControllerProvider(validConfig(), vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ query: "not-an-ip" })));

    await expect(provider.detectIp()).rejects.toThrow("IP detection response");
  });

  it("listNodes returns typed results", async () => {
    const provider = new ClashControllerProvider(
      validConfig(),
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ now: "node-a", all: ["node-a", "node-b"], history: [{ name: "node-a", delay: 24 }] }))
    );

    await expect(provider.listNodes()).resolves.toEqual([
      { name: "node-a", type: "proxy", alive: true, delay: 24 },
      { name: "node-b", type: "proxy", alive: true }
    ]);
  });
});

function validConfig(): { host: string; port: number; secret: string; proxyGroup: string } {
  return { host: "127.0.0.1", port: 9090, secret: "controller-secret", proxyGroup: "Auto" };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
