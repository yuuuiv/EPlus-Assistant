import type {
  ValidationResult,
  VerificationCodeReadInput,
  VerificationCodeReadResult,
  VerificationMailboxSettings,
  VerificationMailboxUpdate,
  NetworkSettings,
  NetworkSettingsUpdate,
  NetworkImportResult
} from "../../shared/types.js";
import type { ClashConfig } from "../adapters/networkRotationProvider.js";
import { createMailProvider, DEFAULT_CERISE_BOUQUET_ENDPOINT, type ApplicationConfirmationResult, type MailProviderConfig } from "../adapters/mailProviders.js";
import type { AppDatabase } from "../storage/database.js";
import type { SecretStore } from "../storage/secretStore.js";

const SETTING_KEY = "verification_mailbox";
const NETWORK_SETTING_KEY = "network";
const NETWORK_SECRET_SETTING_KEY = "network_controller_secret";
const supportedMailboxModes = ["manual", "temp-mail-forwarder", "auth-mailbox", "cerise-bouquet"] as const;

interface StoredVerificationMailbox {
  publicConfig: VerificationMailboxSettings;
  encryptedSecretConfig?: string;
}

interface VerificationMailboxSecretConfig {
  password?: string;
  apiToken?: string;
}

const defaultVerificationMailbox: VerificationMailboxSettings = {
  providerId: "manual",
  mailboxAddress: "",
  mode: "manual",
  senderAllowlist: ["eplus.co.jp"],
  subjectMatchers: ["認証", "確認", "コード", "e\\+"],
  pollingIntervalMs: 5000,
  timeoutMs: 180000,
  secretConfigured: false
};

const defaultNetworkSettings: NetworkSettings = {
  controller: "clash",
  host: "",
  port: 9090,
  proxyGroup: "",
  requiredCountry: "Japan",
  policy: "required",
  secretConfigured: false
};

export class SettingsService {
  constructor(
    private readonly db: AppDatabase,
    private readonly secretStore: SecretStore
  ) {}

  getVerificationMailbox(): VerificationMailboxSettings {
    return this.db.getSetting<StoredVerificationMailbox>(SETTING_KEY)?.publicConfig ?? defaultVerificationMailbox;
  }

  saveVerificationMailbox(input: VerificationMailboxUpdate): VerificationMailboxSettings {
    if (!isSupportedMailboxMode(input.mode)) {
      throw new Error("不支持当前邮箱模式。请选择 manual、temp-mail-forwarder、auth-mailbox 或 cerise-bouquet。");
    }
    const existing = this.db.getSetting<StoredVerificationMailbox>(SETTING_KEY);
    const trimmedSecret = {
      password: input.password?.trim() || undefined,
      apiToken: input.apiToken?.trim() || undefined
    };
    const hasNewSecret = Boolean(trimmedSecret.password || trimmedSecret.apiToken);
    const publicConfig: VerificationMailboxSettings = {
      providerId: input.providerId.trim() || input.mode,
      mailboxAddress: input.mailboxAddress.trim(),
      mode: input.mode,
      endpoint: input.endpoint?.trim() || (input.mode === "cerise-bouquet" ? DEFAULT_CERISE_BOUQUET_ENDPOINT : undefined),
      username: input.username?.trim() || undefined,
      senderAllowlist: input.senderAllowlist.map((item) => item.trim()).filter(Boolean),
      subjectMatchers: input.subjectMatchers.map((item) => item.trim()).filter(Boolean),
      pollingIntervalMs: Math.max(1000, Number(input.pollingIntervalMs) || defaultVerificationMailbox.pollingIntervalMs),
      timeoutMs: Math.max(30000, Number(input.timeoutMs) || defaultVerificationMailbox.timeoutMs),
      secretConfigured: input.mode === "cerise-bouquet"
        ? Boolean(process.env.EPLUS_CERISE_BOUQUET_JWT?.trim() || process.env.EPLUS_CERISE_BOUQUET_ADMIN_AUTH?.trim())
        : hasNewSecret || Boolean(existing?.publicConfig.secretConfigured),
      updatedAt: new Date().toISOString()
    };
    const stored: StoredVerificationMailbox = {
      publicConfig,
      encryptedSecretConfig: hasNewSecret
        ? this.secretStore.encryptJson(trimmedSecret)
        : existing?.encryptedSecretConfig
    };
    this.db.setSetting(SETTING_KEY, stored);
    return publicConfig;
  }

  getNetworkSettings(): NetworkSettings {
    // Reconstruct explicitly (rather than spreading the raw stored blob) so a settings row
    // saved under an older schema - e.g. the retired flat `selectedNodes` field - can never leak
    // an unrecognized key back out to the renderer, where the strict IPC save schema would
    // reject it as soon as the user tries to save again.
    const stored = this.db.getSetting<NetworkSettings & { selectedNodes?: string[] }>(NETWORK_SETTING_KEY);
    if (!stored) return envNetworkSettings() ?? defaultNetworkSettings;
    const migratedNodeSelections = stored.nodeSelectionsByGroup ?? (stored.selectedNodes?.length && stored.proxyGroup ? { [stored.proxyGroup]: stored.selectedNodes } : undefined);
    return {
      controller: stored.controller ?? "clash",
      host: stored.host,
      port: stored.port,
      proxyGroup: stored.proxyGroup,
      requiredCountry: stored.requiredCountry,
      policy: stored.policy,
      secretConfigured: stored.secretConfigured || Boolean(process.env.EPLUS_CLASH_SECRET?.trim()),
      ...(stored.proxyGroups ? { proxyGroups: stored.proxyGroups } : {}),
      ...(migratedNodeSelections ? { nodeSelectionsByGroup: migratedNodeSelections } : {}),
      ...(stored.updatedAt ? { updatedAt: stored.updatedAt } : {})
    };
  }

  saveNetworkSettings(input: NetworkSettingsUpdate): NetworkSettings {
    const existing = this.getNetworkSettings();
    const secret = input.secret?.trim();
    const settings: NetworkSettings = {
      controller: input.controller,
      host: input.host.trim(),
      port: Math.max(1, Math.floor(Number(input.port) || defaultNetworkSettings.port)),
      proxyGroup: input.proxyGroup.trim(),
      proxyGroups: input.proxyGroups?.map((group) => group.trim()).filter(Boolean) ?? existing.proxyGroups,
      nodeSelectionsByGroup: input.nodeSelectionsByGroup ?? existing.nodeSelectionsByGroup,
      requiredCountry: input.requiredCountry.trim(),
      policy: input.policy.trim() || defaultNetworkSettings.policy,
      secretConfigured: Boolean(secret) || existing.secretConfigured,
      updatedAt: new Date().toISOString()
    };
    if (secret) this.db.setSetting(NETWORK_SECRET_SETTING_KEY, this.secretStore.encryptString(secret));
    this.db.setSetting(NETWORK_SETTING_KEY, settings);
    this.db.addLog({ level: "info", message: "network.settings.updated", metadata: { host: settings.host, port: settings.port, proxyGroup: settings.proxyGroup, requiredCountry: settings.requiredCountry, policy: settings.policy, secret: "[redacted]" } });
    return settings;
  }

  importNetworkConfig(input: { readonly controller: "clash" | "sing-box"; readonly text: string }): NetworkImportResult {
    const parsed = parseNetworkControllerConfig(input.controller, input.text);
    const current = this.getNetworkSettings();
    return { controller: input.controller, host: parsed.host, port: parsed.port, secret: parsed.secret, proxyGroup: parsed.proxyGroup, proxyGroups: parsed.proxyGroups, availableNodes: parsed.availableNodes, requiredCountry: current.requiredCountry, policy: current.policy };
  }

  getClashConfig(): ClashConfig | undefined {
    const settings = this.getNetworkSettings();
    if (settings.controller === "direct") return undefined;
    const encryptedSecret = this.db.getSetting<string>(NETWORK_SECRET_SETTING_KEY);
    const secret = encryptedSecret ? this.secretStore.decryptString(encryptedSecret) : process.env.EPLUS_CLASH_SECRET?.trim();
    if (!settings.host || !settings.proxyGroup || !secret) return undefined;
    const selectedNodes = settings.nodeSelectionsByGroup?.[settings.proxyGroup];
    return { host: settings.host, port: settings.port, secret, proxyGroup: settings.proxyGroup, ...(selectedNodes?.length ? { selectedNodes } : {}) };
  }

  async testVerificationMailbox(): Promise<ValidationResult> {
    const settings = this.getVerificationMailbox();
    try {
      return await this.validateWithProvider(settings);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async readVerificationCode(input: VerificationCodeReadInput = {}): Promise<VerificationCodeReadResult> {
    try {
      const settings = this.resolveMailboxSettings(input.recipient);
      const validation = await this.validateWithProvider(settings);
      if (!validation.ok) {
        return { manualActionRequired: true, reason: validation.message };
      }
      const provider = createMailProvider(settings.mode, this.toProviderConfig(settings));
      const startedAt = input.startedAt ? new Date(input.startedAt) : new Date(Date.now() - 5 * 60_000);
      const subjectMatchers = settings.subjectMatchers.map((pattern) => new RegExp(pattern, "i"));
      return await provider.waitForVerificationCode({
        recipient: input.recipient?.trim() || settings.mailboxAddress,
        startedAt,
        timeoutMs: Math.max(3000, input.timeoutMs ?? settings.timeoutMs),
        senderAllowlist: settings.senderAllowlist,
        subjectMatchers
      });
    } catch (error) {
      return {
        manualActionRequired: true,
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async waitForApplicationConfirmation(input: { recipient?: string; startedAt: string; timeoutMs?: number }): Promise<ApplicationConfirmationResult> {
    try {
      const settings = this.resolveMailboxSettings(input.recipient);
      const validation = await this.validateWithProvider(settings);
      if (!validation.ok) return { confirmed: false, reason: validation.message };
      const provider = createMailProvider(settings.mode, this.toProviderConfig(settings));
      return await provider.waitForApplicationConfirmation({
        recipient: input.recipient?.trim() || settings.mailboxAddress,
        startedAt: new Date(input.startedAt),
        timeoutMs: Math.max(3000, input.timeoutMs ?? settings.timeoutMs)
      });
    } catch (error) {
      return { confirmed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private resolveMailboxSettings(recipient?: string): VerificationMailboxSettings {
    const settings = this.getVerificationMailbox();
    const address = recipient?.trim();
    const hasCeriseCredential = Boolean(process.env.EPLUS_CERISE_BOUQUET_JWT?.trim() || process.env.EPLUS_CERISE_BOUQUET_ADMIN_AUTH?.trim());
    const ceriseEndpoint = process.env.EPLUS_CERISE_BOUQUET_ENDPOINT?.trim() || DEFAULT_CERISE_BOUQUET_ENDPOINT;
    // A cerise-bouquet account address is sufficient to identify the mailbox.
    // The JWT/admin credential remains process-only and is never requested from the renderer.
    if (address?.toLowerCase().endsWith("@cerise-bouquet.xyz") && hasCeriseCredential && (settings.mode === "manual" || settings.mode === "cerise-bouquet")) {
      return {
        ...settings,
        providerId: "cerise-bouquet",
        mailboxAddress: address,
        mode: "cerise-bouquet",
        endpoint: settings.endpoint || ceriseEndpoint,
        secretConfigured: true
      };
    }
    if (settings.mode === "cerise-bouquet") {
      return {
        ...settings,
        endpoint: settings.endpoint || ceriseEndpoint,
        mailboxAddress: settings.mailboxAddress || address || ""
      };
    }
    return settings;
  }

  private async validateWithProvider(settings: VerificationMailboxSettings): Promise<ValidationResult> {
    const secret = this.getVerificationMailboxSecret();
    if (settings.mode !== "manual" && !settings.mailboxAddress) {
      return { ok: false, message: "请填写用于接收验证码的总邮箱地址。" };
    }
    const syncResult = validateProviderConfigSync(settings, secret);
    if (syncResult?.ok === false) {
      return syncResult;
    }
    const provider = createMailProvider(settings.mode, this.toProviderConfig(settings, secret));
    return provider.validate(this.toProviderConfig(settings, secret));
  }

  private toProviderConfig(
    settings: VerificationMailboxSettings,
    secret = this.getVerificationMailboxSecret()
  ): MailProviderConfig {
    return {
      providerId: settings.providerId,
      apiEndpoint: settings.endpoint,
      mailboxAddress: settings.mailboxAddress,
      username: settings.username,
      password: secret.password,
      apiToken: secret.apiToken,
      pollingIntervalMs: settings.pollingIntervalMs
    };
  }

  private getVerificationMailboxSecret(): VerificationMailboxSecretConfig {
    const environmentSecret: VerificationMailboxSecretConfig = {
      apiToken: process.env.EPLUS_CERISE_BOUQUET_JWT?.trim() || undefined,
      password: process.env.EPLUS_CERISE_BOUQUET_ADMIN_AUTH?.trim() || undefined
    };
    try {
      const stored = this.db.getSetting<StoredVerificationMailbox>(SETTING_KEY);
      if (!stored?.encryptedSecretConfig) {
        return environmentSecret;
      }
      return { ...this.secretStore.decryptJson<VerificationMailboxSecretConfig>(stored.encryptedSecretConfig), ...environmentSecret };
    } catch {
      return environmentSecret;
    }
  }
}

function validateProviderConfigSync(
  settings: VerificationMailboxSettings,
  secret: VerificationMailboxSecretConfig
): ValidationResult | undefined {
  if (!isSupportedMailboxMode(settings.mode)) {
    return { ok: false, message: "不支持当前邮箱模式。请选择 manual、temp-mail-forwarder、auth-mailbox 或 cerise-bouquet。" };
  }
  if (settings.mode === "manual") {
    return { ok: true, message: "当前为手动输入验证码模式。" };
  }
  if (!settings.endpoint) {
    return { ok: false, message: "请填写邮箱读取服务 endpoint。" };
  }
  if (settings.mode === "cerise-bouquet") {
    return undefined;
  }
  if (!secret.apiToken && !secret.password) {
    return { ok: false, message: "请在 API token 中填写读取凭证。" };
  }
  if (settings.mode === "auth-mailbox" && !settings.providerId) {
    return { ok: false, message: "auth mailbox 模式需要在 Provider ID 中填写 app_id。" };
  }
  return { ok: true, message: "验证码邮箱配置有效，可尝试读取验证码。" };
}

function isSupportedMailboxMode(mode: VerificationMailboxUpdate["mode"]): mode is typeof supportedMailboxModes[number] {
  return supportedMailboxModes.some((supportedMode) => supportedMode === mode);
}

/** Returns the text of a top-level YAML block (e.g. "proxies:" or "proxy-groups:"), stopping at the next top-level key or EOF. */
function extractYamlSection(text: string, key: string): string {
  const lines = text.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => new RegExp(`^${key}\\s*:\\s*$`).test(line));
  if (startIndex === -1) return "";
  const sectionLines: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\S/.test(line)) break; // a non-indented line starts the next top-level key
    sectionLines.push(line);
  }
  return sectionLines.join("\n");
}

/** Matches `name:` on a "- ..." list item, in both block style (own line) and flow style (`- {name: "x", ...}`). */
function yamlListItemNames(sectionText: string): string[] {
  const names: string[] = [];
  for (const match of sectionText.matchAll(/-\s*\{?[^{}\r\n]*?\bname\s*:\s*["']?([^"',}\r\n]+?)["']?\s*(?:[,}]|$)/gimu)) {
    const name = match[1]?.trim();
    if (name) names.push(name);
  }
  return names;
}

export function parseNetworkControllerConfig(controller: "clash" | "sing-box", source: string): { host: string; port: number; secret?: string; proxyGroup: string; proxyGroups: string[]; availableNodes: string[] } {
  const text = source.trim();
  if (!text) throw new Error("请粘贴 Clash 或 sing-box 配置内容。");
  let json: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) json = value;
  } catch {
    // Clash Verge commonly exports YAML; the scalar fallback below handles its controller keys.
  }
  const scalar = (keys: readonly string[]): string | undefined => {
    for (const key of keys) {
      const value = json ? readNestedScalar(json, key.split(".")) : undefined;
      if (value) return value;
      const match = text.match(new RegExp(`(?:^|\\n)\\s*(?:${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")})\\s*:\\s*["']?([^"'\\r\\n,}]+)`, "iu"));
      // Real-world configs commonly annotate a value with a trailing inline comment
      // (e.g. "external-controller: 127.0.0.1:9090  # do not change"); without stripping it
      // the address-format check below fails and the whole import is rejected.
      const cleaned = match?.[1]?.replace(/\s+#.*$/, "").trim();
      if (cleaned) return cleaned;
    }
    return undefined;
  };
  const address = scalar(controller === "sing-box" ? ["experimental.clash_api.external_controller", "external_controller", "external-controller"] : ["external-controller", "external_controller"]);
  const secret = scalar(["experimental.clash_api.secret", "secret"]);
  // "proxy-groups:" (selectors) and "proxies:" (individual servers) share the same
  // "- name: x" list-item shape in Clash YAML, so each must be scoped to its own
  // top-level section - otherwise every server name leaks into the group dropdown.
  const yamlGroupNames = controller === "clash" ? yamlListItemNames(extractYamlSection(text, "proxy-groups")) : [];
  const yamlNodeNames = controller === "clash" ? yamlListItemNames(extractYamlSection(text, "proxies")) : [];
  const jsonGroupNames = json && Array.isArray(json["proxy-groups"])
    ? json["proxy-groups"].flatMap((value) => isRecord(value) && typeof value.name === "string" ? [value.name.trim()] : [])
    : [];
  const jsonNodeNames = json && Array.isArray(json.proxies)
    ? json.proxies.flatMap((value) => isRecord(value) && typeof value.name === "string" ? [value.name.trim()] : [])
    : [];
  const proxyGroups = Array.from(new Set([...yamlGroupNames, ...jsonGroupNames].filter(Boolean)));
  const availableNodes = Array.from(new Set([...yamlNodeNames, ...jsonNodeNames].filter(Boolean)));
  const defaultGroup = scalar(controller === "sing-box" ? ["experimental.clash_api.default_mode", "proxy-group", "selector"] : ["proxy-group", "proxy_group"]);
  const proxyGroup = defaultGroup ?? proxyGroups[0];
  const normalizedAddress = address?.replace(/^https?:\/\//iu, "").replace(/^\/\//, "");
  // Accept both "host:port" and IPv6 bracket notation "[::1]:port".
  const addressMatch = normalizedAddress?.match(/^\[([^\]]+)\]:(\d+)$/) ?? normalizedAddress?.match(/^([^:]+):(\d+)$/);
  if (!addressMatch) throw new Error(address ? `未能识别 external-controller 的地址格式：“${address}”；请确认格式为 host:port。` : "未找到有效的 Clash API external-controller；请确认导入的是控制器配置。");
  if (!proxyGroup) throw new Error("未找到代理组/selector 名称，请在界面中手动填写后保存。");
  return { host: addressMatch[1], port: Number(addressMatch[2]), ...(secret ? { secret } : {}), proxyGroup, proxyGroups: proxyGroups.length > 0 ? proxyGroups : [proxyGroup], availableNodes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNestedScalar(record: Record<string, unknown>, path: readonly string[]): string | undefined {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" && current.trim() ? current.trim() : typeof current === "number" ? String(current) : undefined;
}

function envNetworkSettings(): NetworkSettings | undefined {
  const controller = process.env.EPLUS_CLASH_CONTROLLER?.trim();
  const proxyGroup = process.env.EPLUS_CLASH_PROXY_GROUP?.trim();
  const secretConfigured = Boolean(process.env.EPLUS_CLASH_SECRET?.trim());
  if (!controller || !proxyGroup || !secretConfigured) return undefined;
  const match = controller.match(/^([^:]+):(\d+)$/);
  if (!match) return undefined;
  return {
    controller: "clash",
    host: match[1] ?? "",
    port: Number(match[2]),
    proxyGroup,
    requiredCountry: process.env.EPLUS_CLASH_REQUIRED_COUNTRY?.trim() || defaultNetworkSettings.requiredCountry,
    policy: process.env.EPLUS_CLASH_POLICY?.trim() || defaultNetworkSettings.policy,
    secretConfigured
  };
}
