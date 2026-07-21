import type { ValidationResult, VerificationMailboxMode } from "../../shared/types.js";

export interface MailConfig {
  apiEndpoint?: string;
  apiToken?: string;
  username?: string;
  password?: string;
  providerId?: string;
  mailboxAddress?: string;
  pollingIntervalMs?: number;
}

export type MailProviderConfig = MailConfig;

export interface VerificationMailMessage {
  id?: string;
  from: string;
  to: string[];
  subject: string;
  receivedAt: Date;
  text?: string;
  html?: string;
}

export interface VerificationCodeCandidate {
  code: string;
  receivedAt: string;
  sender: string;
  subject: string;
}

export interface VerificationCodeResult {
  code?: string;
  candidates?: VerificationCodeCandidate[];
  manualActionRequired: boolean;
  reason: string;
}

export interface MailProvider {
  validate(config: MailConfig): Promise<ValidationResult>;
  waitForVerificationCode(input: {
    recipient: string;
    startedAt: Date;
    timeoutMs: number;
    senderAllowlist: string[];
    subjectMatchers: RegExp[];
  }): Promise<VerificationCodeResult>;
}

export class ManualMailProvider implements MailProvider {
  async validate(): Promise<ValidationResult> {
    return { ok: true, message: "当前为手动输入验证码模式。" };
  }

  async waitForVerificationCode(): Promise<VerificationCodeResult> {
    return {
      manualActionRequired: true,
      reason: "当前邮箱适配器为手动模式，请在界面中输入验证码。"
    };
  }
}

type MailboxFetch = typeof fetch;

interface RawMailboxMessage extends Record<string, unknown> {
  id?: unknown;
  from?: unknown;
  from_address?: unknown;
  sender?: unknown;
  source?: unknown;
  to?: unknown;
  recipient?: unknown;
  recipients?: unknown;
  subject?: unknown;
  receivedAt?: unknown;
  received_at?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
  date?: unknown;
  timestamp?: unknown;
  text?: unknown;
  body?: unknown;
  content?: unknown;
  html?: unknown;
}

export class HttpJsonMailProvider implements MailProvider {
  constructor(
    protected readonly config: MailConfig,
    private readonly fetcher: MailboxFetch = fetch
  ) {}

  async validate(config: MailConfig = this.config): Promise<ValidationResult> {
    if (!config.apiEndpoint) {
      return { ok: false, message: "cerise-bouquet 邮箱适配器需要 endpoint。" };
    }
    try {
      const url = new URL(config.apiEndpoint);
      if (!/^https?:$/.test(url.protocol)) {
        return { ok: false, message: "Endpoint 必须是 http 或 https 地址。" };
      }
    } catch {
      return { ok: false, message: "Endpoint 不是有效 URL。" };
    }
    if (!config.mailboxAddress) {
      return { ok: false, message: "请填写用于接收验证码的总邮箱地址。" };
    }
    if (!config.apiToken && !config.password) {
      return { ok: false, message: "cerise-bouquet 邮箱适配器需要 API token 或密码。" };
    }
    return { ok: true, message: "cerise-bouquet 邮箱适配器配置有效。" };
  }

  async waitForVerificationCode(input: {
    recipient: string;
    startedAt: Date;
    timeoutMs: number;
    senderAllowlist: string[];
    subjectMatchers: RegExp[];
  }): Promise<VerificationCodeResult> {
    const validation = await this.validate();
    if (!validation.ok) {
      return { manualActionRequired: true, reason: validation.message };
    }

    const deadline = Date.now() + input.timeoutMs;
    const pollingIntervalMs = Math.max(1000, this.config.pollingIntervalMs ?? 5000);
    let lastReason = "未收到符合条件的验证码邮件。";

    while (Date.now() <= deadline) {
      const messages = await this.fetchMessages(input.recipient, input.startedAt);
      const candidates = messages
        .filter((message) => isAllowedSender(message.from, input.senderAllowlist))
        .filter((message) => message.receivedAt >= input.startedAt)
        .filter((message) => message.to.length === 0 || message.to.some((recipient) => sameMailbox(recipient, input.recipient)))
        .filter((message) => input.subjectMatchers.some((matcher) => matchesSubject(matcher, message.subject)))
        .map((message) => ({ message, code: extractVerificationCodeFromMessage(message) }))
        .filter((item): item is { message: VerificationMailMessage; code: string } => Boolean(item.code));

      if (candidates.length === 1) {
        return {
          code: candidates[0].code,
          candidates: candidates.map(toCandidateMetadata),
          manualActionRequired: false,
          reason: "已从验证码邮箱读取验证码。"
        };
      }
      if (candidates.length > 1) {
        return {
          candidates: candidates.map(toCandidateMetadata),
          manualActionRequired: true,
          reason: "发现多封候选验证码邮件，请人工确认。"
        };
      }
      lastReason = messages.length > 0 ? "候选邮件中没有可安全提取的验证码。" : lastReason;
      await delay(Math.min(pollingIntervalMs, Math.max(0, deadline - Date.now())));
    }

    return { manualActionRequired: true, reason: lastReason };
  }

  private async fetchMessages(recipient: string, startedAt: Date): Promise<VerificationMailMessage[]> {
    const response = await this.fetcher(this.buildEndpoint(recipient, startedAt), {
      headers: this.buildHeaders(recipient)
    });
    if (response.status === 401) {
      throw new Error("邮箱 API 鉴权失败：Address JWT 无效或已过期。");
    }
    if (!response.ok) {
      throw new Error(`邮箱 API 请求失败：HTTP ${response.status}`);
    }
    return normalizeMailboxResponse(await response.json());
  }

  protected buildEndpoint(recipient: string, startedAt: Date): URL {
    const endpoint = new URL(this.config.apiEndpoint ?? "");
    const basePath = endpoint.pathname.replace(/\/$/, "");
    endpoint.pathname = `${basePath}/api/parsed_mails`.replace(/\/+/g, "/");
    endpoint.searchParams.set("limit", endpoint.searchParams.get("limit") ?? "50");
    endpoint.searchParams.set("offset", endpoint.searchParams.get("offset") ?? "0");
    return endpoint;
  }

  protected buildHeaders(recipient: string): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.apiToken) {
      headers.Authorization = `Bearer ${this.config.apiToken}`;
    }
    if (this.config.password) {
      headers["x-custom-auth"] = this.config.password;
    }
    return headers;
  }
}

export class AuthMailboxProvider extends HttpJsonMailProvider {
  override async validate(config: MailConfig = this.config): Promise<ValidationResult> {
    const baseValidation = await super.validate(config);
    if (!baseValidation.ok) {
      return baseValidation;
    }
    if (!config.providerId) {
      return { ok: false, message: "auth mailbox 模式需要在 Provider ID 中填写 app_id。" };
    }
    if (!config.apiToken) {
      return { ok: false, message: "auth mailbox 模式需要填写统一账户 JWT 到 API token。" };
    }
    return { ok: true, message: "auth mailbox 配置有效。" };
  }

  protected override buildEndpoint(recipient: string): URL {
    const endpoint = new URL(this.config.apiEndpoint ?? "");
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/api/temp-mail/mails`.replace(/\/+/g, "/");
    endpoint.searchParams.set("app_id", this.config.providerId ?? "");
    endpoint.searchParams.set("limit", endpoint.searchParams.get("limit") ?? "50");
    endpoint.searchParams.set("offset", endpoint.searchParams.get("offset") ?? "0");
    endpoint.searchParams.set("address", recipient);
    return endpoint;
  }
}

export function createMailProvider(
  mode: VerificationMailboxMode,
  config: MailConfig,
  fetcher?: MailboxFetch
): MailProvider {
  if (mode === "manual") {
    return new ManualMailProvider();
  }
  if (mode === "temp-mail-forwarder") {
    return new HttpJsonMailProvider(config, fetcher);
  }
  if (mode === "auth-mailbox") {
    return new AuthMailboxProvider(config, fetcher);
  }
  throw new Error(`不支持 ${mode} 邮箱模式。请选择 manual、temp-mail-forwarder 或 auth-mailbox。`);
}

export function extractVerificationCodeFromMessage(message: VerificationMailMessage): string | undefined {
  const body = htmlToText(message.html) || message.text || "";
  const haystack = `${message.subject}\n${body}`;
  if (!/(e\+|eplus|イープラス|認証|確認|verification|コード|code)/i.test(haystack)) {
    return undefined;
  }
  const patterns = [
    /(?:認証コード|確認コード|verification code|auth code|コード)\s*[：:]\s*([0-9][0-9\s-]{4,10}[0-9])/i,
    /(?:認証|確認|verification|auth(?:entication)?|コード|code)[^\d]{0,40}([0-9][0-9\s-]{4,10}[0-9])/i,
    /\b([0-9]{6})\b/
  ];
  for (const pattern of patterns) {
    const match = haystack.match(pattern);
    const code = match?.[1]?.replace(/\D/g, "");
    if (code && code.length >= 4 && code.length <= 8) {
      return code;
    }
  }
  return undefined;
}

function toCandidateMetadata(item: { message: VerificationMailMessage; code: string }): VerificationCodeCandidate {
  return {
    code: item.code,
    receivedAt: item.message.receivedAt.toISOString(),
    sender: item.message.from,
    subject: item.message.subject
  };
}

function normalizeMailboxResponse(json: unknown): VerificationMailMessage[] {
  const container = json && typeof json === "object" ? json as Record<string, unknown> : {};
  const mailboxKeys = ["results", "mails", "messages", "data", "items"];
  const messagesKey = mailboxKeys.find((key) => Array.isArray(container[key]));
  const rawMessages = Array.isArray(json) ? json : messagesKey ? container[messagesKey] : [];
  if (!Array.isArray(rawMessages)) {
    return [];
  }
  return rawMessages.map(normalizeMessage).filter((message): message is VerificationMailMessage => Boolean(message));
}

function normalizeMessage(raw: unknown): VerificationMailMessage | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const message = raw as RawMailboxMessage;
  const receivedAt = parseMailDate(message.receivedAt ?? message.received_at ?? message.createdAt ?? message.created_at ?? message.date ?? message.timestamp);
  const from = String(message.sender ?? message.source ?? message.from ?? message.from_address ?? "").trim();
  const subject = String(message.subject ?? "").trim();
  if (!receivedAt || !from || !subject) {
    return undefined;
  }
  return {
    id: message.id === undefined ? undefined : String(message.id),
    from,
    to: normalizeRecipients(message.to ?? message.recipient ?? message.recipients),
    subject,
    receivedAt,
    text: stringifyMaybe(message.text ?? message.body ?? message.content),
    html: stringifyMaybe(message.html)
  };
}

function normalizeRecipients(value: unknown): string[] {
  return (Array.isArray(value) ? value.map(String) : String(value ?? "").split(/[;,]/))
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMailDate(value: unknown): Date | undefined {
  const timestamp = typeof value === "number" ? (value < 10_000_000_000 ? value * 1000 : value) : Date.parse(String(value ?? ""));
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp);
}

function stringifyMaybe(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function htmlToText(html?: string): string | undefined {
  return html
    ?.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function isAllowedSender(sender: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return true;
  }
  const domain = sender.toLowerCase().split("@").pop()?.replace(/[>\s]/g, "") ?? "";
  return allowlist.some((allowed) => domain === allowed.toLowerCase() || domain.endsWith(`.${allowed.toLowerCase()}`));
}

function matchesSubject(matcher: RegExp, subject: string): boolean {
  matcher.lastIndex = 0;
  return matcher.test(subject);
}

function sameMailbox(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
