import type {
  ValidationResult,
  VerificationCodeReadInput,
  VerificationCodeReadResult,
  VerificationMailboxSettings,
  VerificationMailboxUpdate
} from "../../shared/types.js";
import { createMailProvider, type MailProviderConfig } from "../adapters/mailProviders.js";
import type { AppDatabase } from "../storage/database.js";
import type { SecretStore } from "../storage/secretStore.js";

const SETTING_KEY = "verification_mailbox";

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

export class SettingsService {
  constructor(
    private readonly db: AppDatabase,
    private readonly secretStore: SecretStore
  ) {}

  getVerificationMailbox(): VerificationMailboxSettings {
    return this.db.getSetting<StoredVerificationMailbox>(SETTING_KEY)?.publicConfig ?? defaultVerificationMailbox;
  }

  saveVerificationMailbox(input: VerificationMailboxUpdate): VerificationMailboxSettings {
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
        pollingIntervalMs: settings.pollingIntervalMs,
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
    const provider = createMailProvider(settings.mode, this.toProviderConfig(settings, secret));
    const syncResult = validateProviderConfigSync(settings, secret);
    return syncResult?.ok === false ? syncResult : provider.validate(this.toProviderConfig(settings, secret));
  }

  private toProviderConfig(
    settings: VerificationMailboxSettings,
    secret = this.getVerificationMailboxSecret()
  ): MailProviderConfig {
    return {
      providerId: settings.providerId,
      endpoint: settings.endpoint,
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
  if (settings.mode === "manual") {
    return { ok: true, message: "当前为手动输入验证码模式。" };
  }
  if (!settings.endpoint && ["http-api", "temp-mail-forwarder", "auth-mailbox"].includes(settings.mode)) {
    return { ok: false, message: "请填写邮箱读取服务 endpoint。" };
  }
  if (!secret.apiToken && ["http-api", "temp-mail-forwarder", "auth-mailbox"].includes(settings.mode)) {
    return { ok: false, message: "请在 API token 中填写读取凭证。" };
  }
  if (settings.mode === "auth-mailbox" && !settings.providerId) {
    return { ok: false, message: "auth mailbox 模式需要在 Provider ID 中填写 app_id。" };
  }
  if (settings.mode === "imap") {
    return { ok: false, message: "IMAP 本地协议客户端尚未接入，请使用 temp-mail forwarder、auth mailbox 或 HTTP API。" };
  }
  return { ok: true, message: "验证码邮箱配置有效，可尝试读取验证码。" };
}
