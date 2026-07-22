import { createHash } from "node:crypto";
import type { NetworkLease } from "../../shared/types.js";
import type { BrowserProxy, IpInfo, NetworkRotationProvider } from "../adapters/networkRotationProvider.js";

const NETWORK_SETTING_KEY = "network";
const LEASE_TTL_MS = 30 * 60_000;

export interface NetworkSettings {
  readonly controller: "clash" | "sing-box" | "direct";
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
  private lastManualTakeoverReason: string | undefined;

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
      // In direct mode every account shares the machine's one real IP by definition, so the
      // cross-account identity-reuse guard (meant to catch proxy rotation failing to actually
      // rotate) would otherwise reject every account after the first.
      if (network.controller !== "direct" && [...this.fingerprintsByAccount.entries()].some(([accountId, existing]) => accountId !== input.accountId && existing === fingerprint)) {
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

  /** The specific reason the most recent acquireLease() call fell back to manual takeover, if any. */
  lastFailureReason(): string | undefined {
    return this.lastManualTakeoverReason;
  }

  private manualTakeover(message: string, identity?: IpInfo): "manual-takeover" {
    this.lastManualTakeoverReason = message;
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
  if (settings.controller === "direct") return Boolean(settings.requiredCountry.trim() && settings.policy.trim());
  return Boolean(settings.host.trim() && settings.port > 0 && settings.proxyGroup.trim() && settings.secretConfigured && settings.requiredCountry.trim() && settings.policy.trim());
}

function maskIp(ip: string): string {
  const [first, second] = ip.split(".");
  return `${first ?? "x"}.${second ?? "x"}.xxx.xxx`;
}

const NETWORK_FAILURE_REASON_LABELS: Record<string, string> = {
  "Network configuration is missing": "网络设置尚未保存或缺少必填项（主机、端口、代理组或密钥），请前往网络设置重新保存。",
  "Network country policy rejected": "出口 IP 所在国家/地区与网络设置中“要求国家”不一致。",
  "Network identity reuse rejected": "该出口 IP 指纹已被同一批次中的另一账号占用，代理未能轮换到新出口。",
  "Network rotation or detection failed": "代理轮换或出口 IP 检测失败，请检查控制器（Clash/sing-box）是否在运行。"
};

/** Surfaces acquireLease()'s specific rejection reason instead of one generic sentence for every cause. */
export function translateNetworkFailureReason(reason: string | undefined): string {
  if (!reason) return "Network lease requires manual takeover.";
  return NETWORK_FAILURE_REASON_LABELS[reason] ?? reason;
}
