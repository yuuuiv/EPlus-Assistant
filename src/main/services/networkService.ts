import { createHash } from "node:crypto";
import type { NetworkLease } from "../../shared/types.js";
import type { BrowserProxy, IpInfo, NetworkRotationProvider } from "../adapters/networkRotationProvider.js";

const NETWORK_SETTING_KEY = "network";
const LEASE_TTL_MS = 30 * 60_000;

export interface NetworkSettings {
  readonly host: string;
  readonly port: number;
  readonly proxyGroup: string;
  readonly requiredCountry: string;
  readonly policy: string;
  readonly secretConfigured: boolean;
}

export interface NetworkAuditEntry {
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly metadata: Record<string, unknown>;
}

export interface NetworkHooks {
  readonly audit?: (entry: NetworkAuditEntry) => void;
  readonly quarantineContext?: (contextId: string, reason: "expired" | "wrong-run" | "changed-ip") => void;
}

export class NetworkService {
  private generation = 0;
  private readonly fingerprintsByAccount = new Map<string, string>();

  constructor(
    private readonly provider: NetworkRotationProvider,
    private readonly settings: { getSetting(key: string): NetworkSettings | undefined },
    private readonly hooks: NetworkHooks = {}
  ) {}

  async acquireLease(input: { readonly accountId: string; readonly runId: string; readonly contextId: string }): Promise<NetworkLease | "manual-takeover"> {
    const network = this.settings.getSetting(NETWORK_SETTING_KEY);
    if (!network || !isConfigured(network)) return this.manualTakeover("Network configuration is missing");
    try {
      if (this.provider.getBrowserProxy) await this.provider.getBrowserProxy();
      await this.provider.rotate();
      const identity = await this.provider.detectIp();
      const fingerprint = this.generateFingerprint(identity.ip);
      if (identity.country !== network.requiredCountry) return this.manualTakeover("Network country policy rejected", identity);
      if ([...this.fingerprintsByAccount.entries()].some(([accountId, existing]) => accountId !== input.accountId && existing === fingerprint)) {
        return this.manualTakeover("Network identity reuse rejected", identity);
      }
      this.generation += 1;
      this.fingerprintsByAccount.set(input.accountId, fingerprint);
      const createdAt = new Date().toISOString();
      const lease: NetworkLease = { ...input, networkFingerprint: fingerprint, generation: this.generation, country: identity.country, policy: network.policy, createdAt, expiresAt: new Date(Date.now() + LEASE_TTL_MS).toISOString() };
      this.audit("info", "network.lease.acquired", identity, { accountId: input.accountId, runId: input.runId, generation: lease.generation });
      return lease;
    } catch {
      return this.manualTakeover("Network rotation or detection failed");
    }
  }

  async validateLease(lease: NetworkLease, runId: string): Promise<"valid" | "expired" | "wrong-run" | "changed-ip"> {
    if (Date.parse(lease.expiresAt) <= Date.now()) return this.rejectLease(lease, "expired");
    if (lease.runId !== runId) return this.rejectLease(lease, "wrong-run");
    try {
      const identity = await this.provider.detectIp();
      if (this.generateFingerprint(identity.ip) !== lease.networkFingerprint) return this.rejectLease(lease, "changed-ip", identity);
      return "valid";
    } catch {
      return this.rejectLease(lease, "changed-ip");
    }
  }

  async detectCurrentIp(): Promise<IpInfo> {
    if (this.provider.getBrowserProxy) await this.provider.getBrowserProxy();
    return this.provider.detectIp();
  }

  async getBrowserProxy(): Promise<BrowserProxy | undefined> {
    return this.provider.getBrowserProxy ? this.provider.getBrowserProxy() : undefined;
  }

  generateFingerprint(ip: string): string {
    return createHash("sha256").update(ip).digest("hex");
  }

  private manualTakeover(message: string, identity?: IpInfo): "manual-takeover" {
    this.audit("warn", "network.manual-takeover", identity, { reason: message });
    return "manual-takeover";
  }

  private rejectLease(lease: NetworkLease, reason: "expired" | "wrong-run" | "changed-ip", identity?: IpInfo): "expired" | "wrong-run" | "changed-ip" {
    this.hooks.quarantineContext?.(lease.contextId, reason);
    this.audit("warn", "network.lease.quarantined", identity, { accountId: lease.accountId, runId: lease.runId, contextId: lease.contextId, reason });
    return reason;
  }

  private audit(level: NetworkAuditEntry["level"], message: string, identity: IpInfo | undefined, metadata: Record<string, unknown>): void {
    this.hooks.audit?.({ level, message, metadata: { ...metadata, ...(identity ? { ip: maskIp(identity.ip), country: identity.country, region: identity.region } : {}) } });
  }
}

function isConfigured(settings: NetworkSettings): boolean {
  return Boolean(settings.host.trim() && settings.port > 0 && settings.proxyGroup.trim() && settings.secretConfigured && settings.requiredCountry.trim() && settings.policy.trim());
}

function maskIp(ip: string): string {
  const [first, second] = ip.split(".");
  return `${first ?? "x"}.${second ?? "x"}.xxx.xxx`;
}
