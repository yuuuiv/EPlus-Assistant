import { describe, expect, it, vi } from "vitest";
import type { IpInfo, NetworkRotationProvider } from "../adapters/networkRotationProvider.js";
import { NetworkService } from "./networkService.js";

describe("NetworkService", () => {
  it("acquireLease with successful rotate+detect returns a valid lease", async () => {
    const provider = providerWith("203.0.113.8");
    const service = serviceWith(provider);

    const lease = await service.acquireLease({ accountId: "account-a", runId: "run-a", contextId: "context-a" });

    expect(lease).toMatchObject({ accountId: "account-a", runId: "run-a", contextId: "context-a", country: "Japan", policy: "JP-only", generation: 1 });
    expect(provider.rotate).toHaveBeenCalledOnce();
  });

  it("rotate failure returns manual-takeover and zero browser launches", async () => {
    const provider = providerWith("203.0.113.8");
    provider.rotate.mockRejectedValueOnce(new Error("controller unavailable"));
    const launchBrowser = vi.fn();
    const service = serviceWith(provider);

    await expect(service.acquireLease({ accountId: "account-a", runId: "run-a", contextId: "context-a" })).resolves.toBe("manual-takeover");
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("detectIp failure returns manual-takeover and zero browser launches", async () => {
    const provider = providerWith("203.0.113.8");
    provider.detectIp.mockRejectedValueOnce(new Error("lookup unavailable"));
    const launchBrowser = vi.fn();
    const service = serviceWith(provider);

    await expect(service.acquireLease({ accountId: "account-a", runId: "run-a", contextId: "context-a" })).resolves.toBe("manual-takeover");
    expect(launchBrowser).not.toHaveBeenCalled();
  });

  it("wrong-country after detectIp returns manual-takeover", async () => {
    const service = serviceWith(providerWith("203.0.113.8", "United States"));

    await expect(service.acquireLease({ accountId: "account-a", runId: "run-a", contextId: "context-a" })).resolves.toBe("manual-takeover");
  });

  it("exposes the specific reason behind the most recent manual-takeover", async () => {
    const service = serviceWith(providerWith("203.0.113.8", "United States"));

    await service.acquireLease({ accountId: "account-a", runId: "run-a", contextId: "context-a" });

    expect(service.lastFailureReason()).toBe("Network country policy rejected");
  });

  it("validateLease rejects expired leases", async () => {
    const service = serviceWith(providerWith("203.0.113.8"));
    const lease = await requiredLease(service);
    const expired = { ...lease, expiresAt: "2000-01-01T00:00:00.000Z" };

    await expect(service.validateLease(expired, "run-a")).resolves.toBe("expired");
  });

  it("validateLease rejects wrong-run leases", async () => {
    const service = serviceWith(providerWith("203.0.113.8"));
    const lease = await requiredLease(service);

    await expect(service.validateLease(lease, "run-b")).resolves.toBe("wrong-run");
  });

  it("validateLease detects changed IP after rotation", async () => {
    const provider = providerWith("203.0.113.8");
    const quarantineContext = vi.fn();
    const service = serviceWith(provider, { quarantineContext });
    const lease = await requiredLease(service);
    provider.detectIp.mockResolvedValueOnce(ip("203.0.113.9"));

    await expect(service.validateLease(lease, "run-a")).resolves.toBe("changed-ip");
    expect(quarantineContext).toHaveBeenCalledWith("context-a", "changed-ip");
  });

  it("same-IP baseline for new account run is denied", async () => {
    const service = serviceWith(providerWith("203.0.113.8"));
    await requiredLease(service);

    await expect(service.acquireLease({ accountId: "account-b", runId: "run-b", contextId: "context-b" })).resolves.toBe("manual-takeover");
  });

  it("full IP address is never persisted in lease", async () => {
    const service = serviceWith(providerWith("203.0.113.8"));
    const lease = await requiredLease(service);

    expect(JSON.stringify(lease)).not.toContain("203.0.113.8");
    expect(lease.networkFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("already-open context is quarantined on lease validation failure", async () => {
    const provider = providerWith("203.0.113.8");
    const quarantineContext = vi.fn();
    const service = serviceWith(provider, { quarantineContext });
    const lease = await requiredLease(service);
    provider.detectIp.mockRejectedValueOnce(new Error("lookup unavailable"));

    await expect(service.validateLease(lease, "run-a")).resolves.toBe("changed-ip");
    expect(quarantineContext).toHaveBeenCalledWith("context-a", "changed-ip");
  });

  it("direct controller mode acquires a lease with no proxy config, host, port, or secret required", async () => {
    const provider = providerWith("203.0.113.8");
    const service = new NetworkService(provider, {
      getSetting: (key) => key === "network" ? { controller: "direct", host: "", port: 0, proxyGroup: "", requiredCountry: "Japan", policy: "JP-only", secretConfigured: false } : undefined
    });

    const lease = await service.acquireLease({ accountId: "account-a", runId: "run-a", contextId: "context-a" });

    expect(lease).toMatchObject({ accountId: "account-a", runId: "run-a", contextId: "context-a", country: "Japan", policy: "JP-only" });
    expect(provider.rotate).toHaveBeenCalledOnce();
  });

  it("direct controller mode allows every account to reuse the machine's one real IP without being rejected", async () => {
    const provider = providerWith("203.0.113.8");
    const service = new NetworkService(provider, {
      getSetting: (key) => key === "network" ? { controller: "direct", host: "", port: 0, proxyGroup: "", requiredCountry: "Japan", policy: "JP-only", secretConfigured: false } : undefined
    });
    await service.acquireLease({ accountId: "account-a", runId: "run-a", contextId: "context-a" });

    const second = await service.acquireLease({ accountId: "account-b", runId: "run-b", contextId: "context-b" });

    expect(second).toMatchObject({ accountId: "account-b", runId: "run-b" });
  });

  it("direct controller mode still falls back to manual-takeover when the country doesn't match", async () => {
    const provider = providerWith("203.0.113.8", "United States");
    const service = new NetworkService(provider, {
      getSetting: (key) => key === "network" ? { controller: "direct", host: "", port: 0, proxyGroup: "", requiredCountry: "Japan", policy: "JP-only", secretConfigured: false } : undefined
    });

    await expect(service.acquireLease({ accountId: "account-a", runId: "run-a", contextId: "context-a" })).resolves.toBe("manual-takeover");
  });

  it("audit entry has masked IP", async () => {
    const audit = vi.fn();
    const service = serviceWith(providerWith("203.0.113.8"), { audit });

    await requiredLease(service);

    expect(JSON.stringify(audit.mock.calls)).not.toContain("203.0.113.8");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ ip: "203.0.xxx.xxx" }) }));
  });
});

function serviceWith(provider: TestProvider, hooks: { readonly audit?: ReturnType<typeof vi.fn>; readonly quarantineContext?: ReturnType<typeof vi.fn>; readonly launchBrowser?: ReturnType<typeof vi.fn> } = {}): NetworkService {
  return new NetworkService(provider, {
    getSetting: (key) => key === "network" ? { controller: "clash", host: "127.0.0.1", port: 9090, proxyGroup: "Auto", requiredCountry: "Japan", policy: "JP-only", secretConfigured: true } : undefined
  }, hooks);
}

async function requiredLease(service: NetworkService) {
  const lease = await service.acquireLease({ accountId: "account-a", runId: "run-a", contextId: "context-a" });
  if (lease === "manual-takeover") throw new Error("Expected a network lease");
  return lease;
}

interface TestProvider extends NetworkRotationProvider {
  rotate: ReturnType<typeof vi.fn>;
  detectIp: ReturnType<typeof vi.fn>;
}

function providerWith(address: string, country = "Japan"): TestProvider {
  return { rotate: vi.fn().mockResolvedValue(undefined), detectIp: vi.fn().mockResolvedValue(ip(address, country)) };
}

function ip(address: string, country = "Japan"): IpInfo {
  return { ip: address, country, region: "Tokyo", city: "Chiyoda" };
}
