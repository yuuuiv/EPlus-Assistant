import type { ValidationResult, VerificationMailboxMode } from "../../shared/types.js";

export interface MailProviderConfig {
  providerId?: string;
  endpoint?: string;
  mailboxAddress?: string;
  username?: string;
  password?: string;
  apiToken?: string;
  pollingIntervalMs?: number;
  agentParsedMails?: boolean;
}

export interface VerificationMailMessage {
  id?: string;
  from: string;
  to: string[];
  subject: string;
  receivedAt: Date;
  text?: string;
  html?: string;
}

export interface VerificationCodeResult {
  code?: string;
  manualActionRequired: boolean;
  reason: string;
}

export interface MailProvider {
  validate(config: MailProviderConfig): Promise<ValidationResult>;
  waitForVerificationCode(input: {
    recipient: string;
    startedAt: Date;
    timeoutMs: number;
    pollingIntervalMs: number;
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
    protected readonly config: MailProviderConfig,
    private readonly fetcher: MailboxFetch = fetch
  ) {}

  async validate(config: MailProviderConfig = this.config): Promise<ValidationResult> {
    if (!config.endpoint) {
      return { ok: false, message: "HTTP 邮箱适配器需要 endpoint。" };
    }
    try {
      const url = new URL(config.endpoint);
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
      return { ok: false, message: "HTTP 邮箱适配器需要 API token 或密码。" };
    }
    return { ok: true, message: "HTTP 邮箱适配器配置有效。" };
  }

  async waitForVerificationCode(input: {
    recipient: string;
    startedAt: Date;
    timeoutMs: number;
    pollingIntervalMs: number;
    senderAllowlist: string[];
    subjectMatchers: RegExp[];
  }): Promise<VerificationCodeResult> {
    const validation = await this.validate();
    if (!validation.ok) {
      return { manualActionRequired: true, reason: validation.message };
    }

    const started = Date.now();
    const deadline = started + input.timeoutMs;
    let backoffMs = Math.max(1000, input.pollingIntervalMs || this.config.pollingIntervalMs || 5000);
    let lastReason = "未收到符合条件的验证码邮件。";

    while (Date.now() <= deadline) {
      const { messages, retryAfterMs } = await this.fetchMessages(input.recipient, input.startedAt);
      if (retryAfterMs) {
        backoffMs = Math.min(Math.max(backoffMs * 2, retryAfterMs), 60000);
        await delay(Math.min(backoffMs, Math.max(0, deadline - Date.now())));
        continue;
      }
      const candidates = messages
        .filter((message) => isAllowedSender(message.from, input.senderAllowlist))
        .filter((message) => message.receivedAt >= input.startedAt)
        .filter((message) => message.to.length === 0 || message.to.some((recipient) => sameMailbox(recipient, input.recipient)))
        .filter((message) => input.subjectMatchers.some((matcher) => matcher.test(message.subject)));

      const matches = candidates
        .map((message) => ({ message, code: extractVerificationCodeFromMessage(message) }))
        .filter((item): item is { message: VerificationMailMessage; code: string } => Boolean(item.code));

      if (matches.length === 1) {
        return { code: matches[0].code, manualActionRequired: false, reason: "已从验证码邮箱读取验证码。" };
      }
      if (matches.length > 1) {
        return { manualActionRequired: true, reason: "发现多封候选验证码邮件，请人工确认。" };
      }
      lastReason = candidates.length > 0 ? "候选邮件中没有可安全提取的验证码。" : lastReason;
      await delay(Math.min(backoffMs, Math.max(0, deadline - Date.now())));
    }

    return { manualActionRequired: true, reason: lastReason };
  }

  private async fetchMessages(
    recipient: string,
    startedAt: Date
  ): Promise<{ messages: VerificationMailMessage[]; retryAfterMs?: number }> {
    const endpoint = this.buildEndpoint(recipient, startedAt);

    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.config.apiToken) {
      headers.Authorization = `Bearer ${this.config.apiToken}`;
    }
    if (this.config.agentParsedMails && this.config.password) {
      headers["x-custom-auth"] = this.config.password;
    } else if (!this.config.apiToken && this.config.password) {
      headers.Authorization = `Basic ${Buffer.from(`${this.config.username ?? recipient}:${this.config.password}`).toString("base64")}`;
    }

    const response = await this.fetcher(endpoint, { headers });
    if (response.status === 401) {
      throw new Error("邮箱 API 鉴权失败：Address JWT 无效或已过期。");
    }
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") || "", 10);
      return {
        messages: [],
        retryAfterMs: Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined
      };
    }
    if (!response.ok) {
      throw new Error(`邮箱 API 请求失败：HTTP ${response.status}`);
    }
    const json = await response.json();
    return { messages: normalizeMailboxResponse(json) };
  }

  protected buildEndpoint(recipient: string, startedAt: Date): URL {
    const endpoint = new URL(this.config.endpoint!);
    if (this.config.agentParsedMails) {
      const basePath = endpoint.pathname.replace(/\/$/, "");
      if (!basePath.endsWith("/api/parsed_mails")) {
        endpoint.pathname = `${basePath}/api/parsed_mails`.replace(/\/+/g, "/");
      }
      endpoint.searchParams.set("limit", endpoint.searchParams.get("limit") ?? "50");
      endpoint.searchParams.set("offset", endpoint.searchParams.get("offset") ?? "0");
      return endpoint;
    }
    endpoint.searchParams.set("recipient", recipient);
    endpoint.searchParams.set("since", startedAt.toISOString());
    return endpoint;
  }
}

export class AuthMailboxProvider extends HttpJsonMailProvider {
  constructor(config: MailProviderConfig, fetcher?: MailboxFetch) {
    super({ ...config, agentParsedMails: false }, fetcher);
  }

  override async validate(config: MailProviderConfig = this.config): Promise<ValidationResult> {
    if (!config.endpoint) {
      return { ok: false, message: "auth mailbox 模式需要填写 auth 服务 endpoint。" };
    }
    try {
      const url = new URL(config.endpoint);
      if (!/^https?:$/.test(url.protocol)) {
        return { ok: false, message: "auth 服务 endpoint 必须是 http 或 https 地址。" };
      }
    } catch {
      return { ok: false, message: "auth 服务 endpoint 不是有效 URL。" };
    }
    if (!config.providerId) {
      return { ok: false, message: "auth mailbox 模式需要在 Provider ID 中填写 app_id。" };
    }
    if (!config.mailboxAddress) {
      return { ok: false, message: "auth mailbox 模式需要填写总邮箱地址。" };
    }
    if (!config.apiToken) {
      return { ok: false, message: "auth mailbox 模式需要填写统一账户 JWT 到 API token。" };
    }
    return { ok: true, message: "auth mailbox 配置有效。" };
  }

  protected override buildEndpoint(recipient: string): URL {
    const endpoint = new URL(this.config.endpoint!);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/api/temp-mail/mails`.replace(/\/+/g, "/");
    endpoint.searchParams.set("app_id", this.config.providerId!);
    endpoint.searchParams.set("limit", endpoint.searchParams.get("limit") ?? "50");
    endpoint.searchParams.set("offset", endpoint.searchParams.get("offset") ?? "0");
    if (recipient) {
      endpoint.searchParams.set("address", recipient);
    }
    return endpoint;
  }
}

export class UnsupportedAutomaticMailProvider implements MailProvider {
  constructor(private readonly mode: VerificationMailboxMode) {}

  async validate(): Promise<ValidationResult> {
    return {
      ok: false,
      message: `${this.mode} 尚未接入本地协议客户端，请使用 HTTP API/forwarder/auth 服务或手动输入。`
    };
  }

  async waitForVerificationCode(): Promise<VerificationCodeResult> {
    return {
      manualActionRequired: true,
      reason: `${this.mode} 尚未接入本地协议客户端，请人工输入验证码。`
    };
  }
}

export function createMailProvider(
  mode: VerificationMailboxMode,
  config: MailProviderConfig,
  fetcher?: MailboxFetch
): MailProvider {
  if (mode === "manual") {
    return new ManualMailProvider();
  }
  if (mode === "temp-mail-forwarder") {
    return new HttpJsonMailProvider({ ...config, agentParsedMails: true }, fetcher);
  }
  if (mode === "auth-mailbox") {
    return new AuthMailboxProvider(config, fetcher);
  }
  if (mode === "http-api") {
    return new HttpJsonMailProvider(config, fetcher);
  }
  return new UnsupportedAutomaticMailProvider(mode);
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

function normalizeMailboxResponse(json: unknown): VerificationMailMessage[] {
  const rawMessages = Array.isArray(json)
    ? json
    : Array.isArray((json as { results?: unknown }).results)
      ? (json as { results: unknown[] }).results
      : Array.isArray((json as { mails?: unknown }).mails)
        ? (json as { mails: unknown[] }).mails
        : Array.isArray((json as { messages?: unknown }).messages)
          ? (json as { messages: unknown[] }).messages
          : Array.isArray((json as { data?: unknown }).data)
            ? (json as { data: unknown[] }).data
            : Array.isArray((json as { items?: unknown }).items)
              ? (json as { items: unknown[] }).items
              : [];
  return rawMessages.map(normalizeMessage).filter((message): message is VerificationMailMessage => Boolean(message));
}

function normalizeMessage(raw: unknown): VerificationMailMessage | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const message = raw as RawMailboxMessage;
  const receivedAt = parseMailDate(
    message.receivedAt ?? message.received_at ?? message.createdAt ?? message.created_at ?? message.date ?? message.timestamp
  );
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
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  return String(value ?? "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMailDate(value: unknown): Date | undefined {
  if (typeof value === "number") {
    const timestamp = value < 10_000_000_000 ? value * 1000 : value;
    return new Date(timestamp);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
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

function sameMailbox(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
