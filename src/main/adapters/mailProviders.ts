import type { ValidationResult, VerificationMailboxMode } from "../../shared/types.js";

export const DEFAULT_CERISE_BOUQUET_ENDPOINT = "https://temp-mail.lianminglai.workers.dev";

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
  originatingRecipient?: string;
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

export interface ApplicationConfirmationResult {
  confirmed: boolean;
  receivedAt?: string;
  sender?: string;
  subject?: string;
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
  waitForApplicationConfirmation(input: {
    recipient: string;
    startedAt: Date;
    timeoutMs: number;
  }): Promise<ApplicationConfirmationResult>;
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

  async waitForApplicationConfirmation(): Promise<ApplicationConfirmationResult> {
    return { confirmed: false, reason: "当前邮箱适配器为手动模式，无法自动确认申请完成邮件。" };
  }
}

type MailboxFetch = typeof fetch;

interface RawMailboxMessage extends Record<string, unknown> {
  id?: unknown;
  from?: unknown;
  from_address?: unknown;
  sender?: unknown;
  source?: unknown;
  address?: unknown;
  metadata?: unknown;
  to?: unknown;
  recipient?: unknown;
  recipients?: unknown;
  original_to?: unknown;
  original_recipient?: unknown;
  originalRecipient?: unknown;
  forwarded_to?: unknown;
  forwardedTo?: unknown;
  delivered_to?: unknown;
  deliveredTo?: unknown;
  envelope_to?: unknown;
  envelopeTo?: unknown;
  source_mailbox?: unknown;
  sourceMailbox?: unknown;
  forwarded_from?: unknown;
  forwardedFrom?: unknown;
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
    protected readonly fetcher: MailboxFetch = fetch
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
        .filter((message) => belongsToRecipient(message, input.recipient))
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

  async waitForApplicationConfirmation(input: {
    recipient: string;
    startedAt: Date;
    timeoutMs: number;
  }): Promise<ApplicationConfirmationResult> {
    const validation = await this.validate();
    if (!validation.ok) return { confirmed: false, reason: validation.message };

    const deadline = Date.now() + input.timeoutMs;
    const pollingIntervalMs = Math.max(1000, this.config.pollingIntervalMs ?? 5000);
    while (Date.now() <= deadline) {
      const messages = await this.fetchMessages(input.recipient, input.startedAt);
      const match = messages
        .filter((message) => message.receivedAt >= input.startedAt)
        .filter((message) => isExactSender(message.from, "info@eplus.co.jp"))
        .filter((message) => belongsToRecipient(message, input.recipient))
        .find(isApplicationCompletionMessage);
      if (match) {
        return {
          confirmed: true,
          receivedAt: match.receivedAt.toISOString(),
          sender: match.from,
          subject: match.subject,
          reason: "已收到 info@eplus.co.jp 发出的申请完成邮件。"
        };
      }
      await delay(Math.min(pollingIntervalMs, Math.max(0, deadline - Date.now())));
    }
    return { confirmed: false, reason: "在等待时间内没有收到符合要求的 e+ 申请完成邮件。" };
  }

  protected async fetchMessages(recipient: string, startedAt: Date): Promise<VerificationMailMessage[]> {
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

/** Reads a managed Cerise Bouquet mailbox without exposing its credential to the renderer. */
export class CeriseBouquetMailProvider extends HttpJsonMailProvider {
  override async validate(): Promise<ValidationResult> {
    if (!this.config.apiEndpoint) return { ok: false, message: "cerise-bouquet 邮箱地址未配置。" };
    if (!this.config.apiToken && !this.config.password) return { ok: false, message: "主进程没有找到 cerise-bouquet 邮箱读取凭证。请设置 EPLUS_CERISE_BOUQUET_JWT 或 EPLUS_CERISE_BOUQUET_ADMIN_AUTH。" };
    if (!this.config.mailboxAddress) return { ok: false, message: "请填写验证码收件邮箱。" };
    return { ok: true, message: "cerise-bouquet 邮箱托管读取已配置。" };
  }

  protected override buildEndpoint(_recipient: string): URL {
    const endpoint = new URL(this.config.apiEndpoint ?? DEFAULT_CERISE_BOUQUET_ENDPOINT);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/api/parsed_mails`.replace(/\/+/g, "/");
    endpoint.searchParams.set("limit", endpoint.searchParams.get("limit") ?? "100");
    endpoint.searchParams.set("offset", endpoint.searchParams.get("offset") ?? "0");
    return endpoint;
  }

  protected override async fetchMessages(recipient: string, startedAt: Date): Promise<VerificationMailMessage[]> {
    if (!this.config.password || this.config.apiToken) return super.fetchMessages(recipient, startedAt);
    const base = new URL(this.config.apiEndpoint ?? DEFAULT_CERISE_BOUQUET_ENDPOINT);
    const adminHeaders = { Accept: "application/json", "x-admin-auth": this.config.password };
    const userResponse = await this.fetcher(new URL("/admin/users", base), { headers: adminHeaders });
    if (!userResponse.ok) throw new Error(`cerise admin 用户查询失败：HTTP ${userResponse.status}`);
    const userPayload: unknown = await userResponse.json();
    const userRows = extractRows(userPayload);
    const user = userRows.find((row) => String(row.user_email ?? row.email ?? "").trim().toLowerCase() === this.config.mailboxAddress?.trim().toLowerCase());
    if (!user?.id) throw new Error("cerise admin bridge 未找到对应邮箱用户。");
    const addressResponse = await this.fetcher(new URL(`/admin/users/bind_address/${encodeURIComponent(String(user.id))}`, base), { headers: adminHeaders });
    if (!addressResponse.ok) throw new Error(`cerise admin 地址查询失败：HTTP ${addressResponse.status}`);
    const addressRows = extractRows(await addressResponse.json());
    const address = addressRows.find((row) => String(row.address ?? row.name ?? "").trim().toLowerCase() === recipient.trim().toLowerCase());
    if (!address?.id) throw new Error("cerise admin bridge 未找到对应收件地址。");
    const credentialResponse = await this.fetcher(new URL(`/admin/show_password/${encodeURIComponent(String(address.id))}`, base), { headers: adminHeaders });
    if (!credentialResponse.ok) throw new Error(`cerise admin 凭证获取失败：HTTP ${credentialResponse.status}`);
    const credentialPayload: unknown = await credentialResponse.json();
    const jwt = isRecord(credentialPayload) && typeof credentialPayload.jwt === "string" ? credentialPayload.jwt : undefined;
    if (!jwt) throw new Error("cerise admin bridge 未返回地址 JWT。");
    const endpoint = this.buildEndpoint(recipient);
    endpoint.searchParams.set("limit", "100");
    endpoint.searchParams.set("offset", "0");
    const mailResponse = await this.fetcher(endpoint, { headers: { Accept: "application/json", Authorization: `Bearer ${jwt}` } });
    if (!mailResponse.ok) throw new Error(`cerise 邮件读取失败：HTTP ${mailResponse.status}`);
    return normalizeMailboxResponse(await mailResponse.json()).filter((message) => message.receivedAt >= startedAt);
  }

  protected override buildHeaders(recipient: string): Record<string, string> {
    const headers = super.buildHeaders(recipient);
    if (this.config.password && !this.config.apiToken) {
      delete headers["x-custom-auth"];
      headers["x-admin-auth"] = this.config.password;
    }
    return headers;
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
  if (mode === "cerise-bouquet") {
    return new CeriseBouquetMailProvider(config, fetcher);
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

export function isApplicationCompletionMessage(message: VerificationMailMessage): boolean {
  const body = htmlToText(message.html) || message.text || "";
  const haystack = `${message.subject}\n${body}`;
  return isExactSender(message.from, "info@eplus.co.jp")
    && /申込み完了[・･]抽選結果確認期間のご案内/u.test(haystack)
    && /申込み(?:履歴|状況照会)/u.test(haystack)
    && /https?:\/\/eplus\.jp\/jyoukyou\/?/iu.test(haystack);
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

function extractRows(json: unknown): Record<string, unknown>[] {
  if (Array.isArray(json)) return json.filter(isRecord);
  if (!isRecord(json)) return [];
  for (const key of ["results", "items", "data", "addresses", "users"]) {
    const value = json[key];
    if (Array.isArray(value)) return value.filter(isRecord);
  }
  return [];
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
  const text = stringifyMaybe(message.text ?? message.body ?? message.content);
  const html = stringifyMaybe(message.html);
  const originatingRecipient = firstMailbox([
    message.original_to, message.original_recipient, message.originalRecipient,
    message.forwarded_to, message.forwardedTo, message.delivered_to, message.deliveredTo,
    message.envelope_to, message.envelopeTo, message.source_mailbox, message.sourceMailbox,
    message.forwarded_from, message.forwardedFrom,
    message.address,
    extractOriginalRecipient(text), extractOriginalRecipient(htmlToText(html)),
    extractOriginalRecipient(stringifyMaybe(message.metadata))
  ]);
  return {
    id: message.id === undefined ? undefined : String(message.id),
    from,
    to: normalizeRecipients(message.to ?? message.recipient ?? message.recipients),
    subject,
    receivedAt,
    originatingRecipient,
    text,
    html
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function firstMailbox(values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = Array.isArray(value) ? value[0] : value;
    const match = String(candidate ?? "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0];
    if (match) return match.toLowerCase();
  }
  return undefined;
}

function extractOriginalRecipient(body?: string): string | undefined {
  if (!body) return undefined;
  return body.match(/(?:x-original-to|delivered-to|envelope-to|original[- ]?(?:to|recipient))\s*:\s*<?([^>\s,;]+@[^>\s,;]+)>?/iu)?.[1]?.toLowerCase();
}

function isExactSender(sender: string, expected: string): boolean {
  const address = sender.match(/<([^>]+)>/)?.[1] ?? sender;
  return address.trim().toLowerCase() === expected.toLowerCase();
}

function matchesSubject(matcher: RegExp, subject: string): boolean {
  matcher.lastIndex = 0;
  return matcher.test(subject);
}

function sameMailbox(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function belongsToRecipient(message: VerificationMailMessage, recipient: string): boolean {
  const normalized = recipient.trim().toLowerCase();
  return message.to.some((value) => sameMailbox(value, normalized)) || message.originatingRecipient === normalized;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
