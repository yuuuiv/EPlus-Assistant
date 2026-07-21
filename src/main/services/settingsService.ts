import type {
  ValidationResult,
  VerificationCodeReadInput,
  VerificationCodeReadResult,
  VerificationMailboxSettings,
  VerificationMailboxUpdate,
  NetworkSettings,
  NetworkSettingsUpdate
} from "../../shared/types.js";
import type { ClashConfig } from "../adapters/networkRotationProvider.js";
import { createMailProvider, type MailProviderConfig } from "../adapters/mailProviders.js";
import type { AppDatabase } from "../storage/database.js";
import type { SecretStore } from "../storage/secretStore.js";

const SETTING_KEY = "verification_mailbox";
const NETWORK_SETTING_KEY = "network";
const NETWORK_SECRET_SETTING_KEY = "network_controller_secret";
const supportedMailboxModes = ["manual", "temp-mail-forwarder", "auth-mailbox"] as const;

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
      throw new Error("不支持 IMAP 或 HTTP API 邮箱模式。请选择 manual、temp-mail-forwarder 或 auth-mailbox。");
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
      endpoint: input.endpoint?.trim() || undefined,
      username: input.username?.trim() || undefined,
      senderAllowlist: input.senderAllowlist.map((item) => item.trim()).filter(Boolean),
      subjectMatchers: input.subjectMatchers.map((item) => item.trim()).filter(Boolean),
      pollingIntervalMs: Math.max(1000, Number(input.pollingIntervalMs) || defaultVerificationMailbox.pollingIntervalMs),
      timeoutMs: Math.max(30000, Number(input.timeoutMs) || defaultVerificationMailbox.timeoutMs),
      secretConfigured: hasNewSecret || Boolean(existing?.publicConfig.secretConfigured),
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
    return this.db.getSetting<NetworkSettings>(NETWORK_SETTING_KEY) ?? defaultNetworkSettings;
  }

  saveNetworkSettings(input: NetworkSettingsUpdate): NetworkSettings {
    const existing = this.getNetworkSettings();
    const secret = input.secret?.trim();
    const settings: NetworkSettings = {
      host: input.host.trim(),
      port: Math.max(1, Math.floor(Number(input.port) || defaultNetworkSettings.port)),
      proxyGroup: input.proxyGroup.trim(),
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

  getClashConfig(): ClashConfig | undefined {
    const settings = this.getNetworkSettings();
    const encryptedSecret = this.db.getSetting<string>(NETWORK_SECRET_SETTING_KEY);
    if (!settings.host || !settings.proxyGroup || !encryptedSecret) return undefined;
    return { host: settings.host, port: settings.port, secret: this.secretStore.decryptString(encryptedSecret), proxyGroup: settings.proxyGroup };
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
      const settings = this.getVerificationMailbox();
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
    try {
      const stored = this.db.getSetting<StoredVerificationMailbox>(SETTING_KEY);
      if (!stored?.encryptedSecretConfig) {
        return {};
      }
      return this.secretStore.decryptJson<VerificationMailboxSecretConfig>(stored.encryptedSecretConfig);
    } catch {
      return {};
    }
  }
}

function validateProviderConfigSync(
  settings: VerificationMailboxSettings,
  secret: VerificationMailboxSecretConfig
): ValidationResult | undefined {
  if (!isSupportedMailboxMode(settings.mode)) {
    return { ok: false, message: "不支持 IMAP 或 HTTP API 邮箱模式。请选择 manual、temp-mail-forwarder 或 auth-mailbox。" };
  }
  if (settings.mode === "manual") {
    return { ok: true, message: "当前为手动输入验证码模式。" };
  }
  if (!settings.endpoint) {
    return { ok: false, message: "请填写邮箱读取服务 endpoint。" };
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
