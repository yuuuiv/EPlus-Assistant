import { describe, expect, it, vi } from "vitest";
import { ClashControllerProvider, DirectNetworkRotationProvider, type NetworkRotationProvider } from "./networkRotationProvider.js";

describe("ClashControllerProvider", () => {
  it("initializes with valid config", () => {
    expect(() => new ClashControllerProvider(validConfig(), fetch)).not.toThrow();
  });

  it("throws on missing config fields", () => {
    expect(() => new ClashControllerProvider({ ...validConfig(), host: "" }, fetch)).toThrow("host");
    expect(() => new ClashControllerProvider({ ...validConfig(), port: 0 }, fetch)).toThrow("port");
    expect(() => new ClashControllerProvider({ ...validConfig(), secret: "" }, fetch)).toThrow("secret");
  });

  it("allows construction without a resolved proxyGroup yet, but rejects group-scoped calls until one is known", async () => {
    const { proxyGroup: _proxyGroup, ...configWithoutGroup } = validConfig();
    const provider = new ClashControllerProvider(configWithoutGroup, vi.fn<typeof fetch>());

    await expect(provider.rotate()).rejects.toThrow("No Clash proxy group is resolved yet.");
  });

  it("listGroups discovers group names live, filtering out individual leaf proxies", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      proxies: {
        Auto: { type: "Selector", now: "node-a", all: ["node-a", "node-b"] },
        Fallback: { type: "Fallback", now: "node-c", all: ["node-c"] },
        "node-a": { type: "ss" },
        "node-b": { type: "ss" }
      }
    }));
    const provider = new ClashControllerProvider(validConfig(), fetcher);

    await expect(provider.listGroups()).resolves.toEqual(["Auto", "Fallback"]);
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:9090/proxies", expect.objectContaining({ headers: { Authorization: "Bearer controller-secret" } }));
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

  it("rotate only cycles among the user's selected node subset when configured", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ now: "node-a", all: ["node-a", "node-b", "node-c"] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const provider = new ClashControllerProvider({ ...validConfig(), selectedNodes: ["node-a", "node-c"] }, fetcher);

    await provider.rotate();

    expect(fetcher).toHaveBeenNthCalledWith(2, "http://127.0.0.1:9090/proxies/Auto", expect.objectContaining({ body: JSON.stringify({ name: "node-c" }), method: "PUT" }));
  });

  it("rotate falls back to the full node list when the selected subset is entirely stale", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ now: "node-a", all: ["node-a", "node-b"] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const provider = new ClashControllerProvider({ ...validConfig(), selectedNodes: ["node-removed"] }, fetcher);

    await provider.rotate();

    expect(fetcher).toHaveBeenNthCalledWith(2, "http://127.0.0.1:9090/proxies/Auto", expect.objectContaining({ body: JSON.stringify({ name: "node-b" }), method: "PUT" }));
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

  it("listNodes queries an explicit group override instead of the configured default group", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ now: "node-c", all: ["node-c"], history: [] }));
    const provider = new ClashControllerProvider(validConfig(), fetcher);

    await expect(provider.listNodes("Fallback")).resolves.toEqual([{ name: "node-c", type: "proxy", alive: true }]);
    expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:9090/proxies/Fallback", expect.objectContaining({ headers: { Authorization: "Bearer controller-secret" } }));
  });

  it("reads Clash mixed-port for the browser and proxy-aware IP checks", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ "mixed-port": 7897, port: 0, "socks-port": 0 }));
    const provider = new ClashControllerProvider(validConfig(), fetcher);

    await expect(provider.getBrowserProxy()).resolves.toEqual({ server: "http://127.0.0.1:7897" });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:9090/configs",
      expect.objectContaining({ headers: { Authorization: "Bearer controller-secret" } })
    );
  });
});

describe("DirectNetworkRotationProvider", () => {
  it("detects the machine's own direct outbound IP with no proxy involved", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ query: "203.0.113.8", country: "Japan", regionName: "Tokyo", city: "Chiyoda" }));
    const provider = new DirectNetworkRotationProvider(fetcher);

    await expect(provider.detectIp()).resolves.toEqual({ ip: "203.0.113.8", country: "Japan", region: "Tokyo", city: "Chiyoda" });
    expect(fetcher).toHaveBeenCalledWith("http://ip-api.com/json/?fields=query,country,regionName,city", expect.any(Object));
  });

  it("rotate is a no-op since there is no proxy layer to switch", async () => {
    const provider = new DirectNetworkRotationProvider(vi.fn<typeof fetch>());

    await expect(provider.rotate()).resolves.toBeUndefined();
  });

  it("has no getBrowserProxy - the browser launches without any proxy configuration", () => {
    const provider: NetworkRotationProvider = new DirectNetworkRotationProvider(vi.fn<typeof fetch>());

    expect(provider.getBrowserProxy).toBeUndefined();
  });
});

function validConfig(): { host: string; port: number; secret: string; proxyGroup: string } {
  return { host: "127.0.0.1", port: 9090, secret: "controller-secret", proxyGroup: "Auto" };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}
