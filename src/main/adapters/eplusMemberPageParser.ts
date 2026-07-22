import { load } from "cheerio";
import type { Element } from "domhandler";
import type { ApplicationRecord, Companion, CreditCardSummary, LotteryResultRecord } from "../../shared/types.js";

export interface MemberProfileData {
  readonly name?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly gender?: string;
  readonly birthday?: string;
  readonly address?: string;
  readonly creditCards?: readonly CreditCardSummary[];
}

export interface CompanionData {
  readonly companions: readonly Companion[];
  readonly pastCompanions: readonly Companion[];
}

export function parseMemberProfile(html: string): MemberProfileData {
  const $ = load(html);
  const fields = new Map<string, string>();
  $("[data-profile-field]").each((_index, element) => {
    const field = $(element).attr("data-profile-field");
    const value = $(element).text().trim();
    if (field && value) fields.set(field, value);
  });
  $("tr").each((_index, row) => {
    const label = $(row).find("th, dt").first().text().trim();
    const value = $(row).find("td, dd").first().text().trim();
    if (label && value) fields.set(label, value);
  });
  $("dl").each((_index, definitionList) => {
    $(definitionList).find("dt").each((_termIndex, term) => {
      const label = $(term).text().trim();
      const value = $(term).nextAll("dd").first().text().trim();
      if (label && value) fields.set(label, value);
    });
  });
  $("input, select, textarea").each((_index, element) => {
    const key = `${$(element).attr("name") ?? ""} ${$(element).attr("id") ?? ""} ${$(element).attr("autocomplete") ?? ""} ${$(element).attr("aria-label") ?? ""}`;
    const value = element.tagName.toLowerCase() === "select"
      ? $(element).find("option:selected").text().trim()
      : ($(element).attr("value") ?? $(element).text()).trim();
    if (key.trim() && value && !/password|card|cvv|cvc|security/iu.test(key)) fields.set(key, value);
  });
  return {
    name: findField(fields, ["name", "氏名", "お名前"]),
    email: findField(fields, ["email", "メール", "メールアドレス"]),
    phone: findField(fields, ["phone", "電話"]),
    gender: findField(fields, ["gender", "性別"]),
    birthday: findField(fields, ["birthday", "生年月日"]),
    address: findField(fields, ["address", "住所"]),
    creditCards: parseCreditCards($.html())
  };
}

export function parseCreditCards(html: string): readonly CreditCardSummary[] {
  const $ = load(html);
  const cards: CreditCardSummary[] = [];
  const seen = new Set<string>();
  $(`[data-credit-card], [data-card-last4], [data-last4]`).each((_index, element) => {
    const last4 = ($(element).attr("data-card-last4") || $(element).attr("data-last4") || "").replace(/\D/g, "").slice(-4);
    if (last4.length !== 4 || seen.has(last4)) return;
    seen.add(last4);
    const brand = $(element).attr("data-card-brand")?.trim() || $(element).find("[data-card-brand]").first().text().trim() || undefined;
    cards.push({ ...(brand ? { brand } : {}), last4, updatedAt: new Date().toISOString() });
  });
  $("tr, li, p, dd").each((_index, element) => {
    const text = $(element).text().replace(/\s+/g, " ").trim();
    if (!/(Visa|Mastercard|JCB|American Express|AMEX|楽天|カード|クレジット)/iu.test(text)) return;
    const match = text.match(/(?:\*{2,}|Ｘ{2,}|x{2,}|末尾|下4桁|番号)[^0-9]{0,8}(\d{4})\b/iu) || text.match(/\b(\d{4})\b/);
    const last4 = match?.[1];
    if (!last4 || seen.has(last4)) return;
    seen.add(last4);
    const brand = text.match(/Visa|Mastercard|JCB|American Express|AMEX|楽天/iu)?.[0];
    cards.push({ ...(brand ? { brand } : {}), last4, updatedAt: new Date().toISOString() });
  });
  return cards;
}

export function parseCompanions(html: string): CompanionData {
  const $ = load(html);
  const companions: Companion[] = [];
  const pastCompanions: Companion[] = [];
  $("[data-companion]").each((_index, element) => {
    const companion = companionFromElement($, element);
    if (!companion) return;
    if ($(element).attr("data-companion") === "past") pastCompanions.push(companion);
    else companions.push(companion);
  });
  return { companions, pastCompanions };
}

export function parseApplicationRecords(html: string): readonly Omit<ApplicationRecord, "id" | "accountId" | "harvestedAt">[] {
  const $ = load(html);
  const explicit = $("[data-application-record]").toArray().flatMap((element) => {
    const eventTitle = $(element).attr("data-event-title")?.trim();
    const appliedAt = $(element).attr("data-applied-at")?.trim();
    const ticketType = $(element).attr("data-ticket-type")?.trim();
    const quantity = Number($(element).attr("data-quantity"));
    const status = $(element).attr("data-status")?.trim();
    if (!eventTitle || !appliedAt || !ticketType || !Number.isFinite(quantity) || !status) return [];
    return [{ eventTitle, appliedAt, ticketType, quantity, status, sessionOrDay: optionalAttribute($, element, "data-session-or-day"), applicationId: optionalAttribute($, element, "data-application-id") }];
  });
  if (explicit.length > 0) return explicit;
  return parseRecordRows($).map((row) => ({
    eventTitle: row.eventTitle,
    appliedAt: row.appliedAt,
    ticketType: row.ticketType,
    quantity: row.quantity,
    status: row.status,
    ...(row.applicationId ? { applicationId: row.applicationId } : {})
  }));
}

export function parseLotteryResults(html: string): readonly Omit<LotteryResultRecord, "id" | "accountId" | "harvestedAt">[] {
  const $ = load(html);
  const explicit = $("[data-lottery-result]").toArray().flatMap((element) => {
    const eventTitle = $(element).attr("data-event-title")?.trim();
    const resultKind = $(element).attr("data-result-kind")?.trim();
    if (!eventTitle || !isLotteryResultKind(resultKind)) return [];
    return [{ eventTitle, resultKind, decidedAt: optionalAttribute($, element, "data-decided-at"), paymentDeadline: optionalAttribute($, element, "data-payment-deadline"), applicationId: optionalAttribute($, element, "data-application-id") }];
  });
  if (explicit.length > 0) return explicit;
  return parseRecordRows($).flatMap((row) => {
    const resultKind = resultKindFromText(row.status);
    return resultKind ? [{ eventTitle: row.eventTitle, resultKind, decidedAt: row.decidedAt, paymentDeadline: row.paymentDeadline, ...(row.applicationId ? { applicationId: row.applicationId } : {}) }] : [];
  });
}

interface RecordRow {
  eventTitle: string;
  appliedAt: string;
  ticketType: string;
  quantity: number;
  status: string;
  applicationId?: string;
  decidedAt?: string;
  paymentDeadline?: string;
}

function parseRecordRows($: ReturnType<typeof load>): RecordRow[] {
  const rows: RecordRow[] = [];
  $("table").each((_tableIndex, table) => {
    const headers = $(table).find("thead tr").first().find("th,td").toArray().map((cell) => normalize($(cell).text()));
    if (headers.length === 0) return;
    $(table).find("tbody tr, tr").each((_rowIndex, row) => {
      if ($(row).closest("thead").length > 0) return;
      const cells = $(row).find("th,td").toArray().map((cell) => normalize($(cell).text()));
      if (cells.length < 2 || cells.every((cell) => !cell)) return;
      const value = (patterns: readonly RegExp[]): string | undefined => {
        const index = headers.findIndex((header) => patterns.some((pattern) => pattern.test(header)));
        return index >= 0 ? cells[index] : undefined;
      };
      const eventTitle = value([/公演|イベント|タイトル|作品/iu]) || cells[0];
      const appliedAt = value([/申込|応募|受付|日時|日付/iu]) || "";
      const status = value([/状態|ステータス|結果|当落/iu]) || "";
      const ticketType = value([/券種|チケット|席種/iu]) || "-";
      const quantityText = value([/枚数|数量/iu]) || "1";
      const quantity = Number(quantityText.match(/\d+/)?.[0] ?? 1);
      if (!eventTitle || !status) return;
      rows.push({ eventTitle, appliedAt, ticketType, quantity: Number.isFinite(quantity) ? quantity : 1, status, applicationId: value([/受付番号|申込番号|ID|番号/iu]), decidedAt: value([/発表|当落日/iu]), paymentDeadline: value([/支払期限|入金期限/iu]) });
    });
  });
  return rows;
}

function resultKindFromText(value: string): LotteryResultRecord["resultKind"] | undefined {
  if (/落選|はずれ|未当選/iu.test(value)) return "落選";
  if (/当選|中選|当たりました/iu.test(value)) return "中選";
  if (/取消|キャンセル/iu.test(value)) return "取消";
  if (/待|未発表|抽選中|確認中/iu.test(value)) return "待通知";
  return undefined;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function findField(fields: ReadonlyMap<string, string>, candidates: readonly string[]): string | undefined {
  for (const [key, value] of fields) {
    if (candidates.some((candidate) => key.toLowerCase().includes(candidate.toLowerCase()))) return value;
  }
  return undefined;
}

function companionFromElement($: ReturnType<typeof load>, element: Element): Companion | undefined {
  const name = $(element).attr("data-name")?.trim();
  if (!name) return undefined;
  return {
    name,
    relationship: optionalAttribute($, element, "data-relationship"),
    memberId: optionalAttribute($, element, "data-member-id"),
    boundAt: optionalAttribute($, element, "data-bound-at"),
    unboundAt: optionalAttribute($, element, "data-unbound-at")
  };
}

function optionalAttribute($: ReturnType<typeof load>, element: Element, name: string): string | undefined {
  return $(element).attr(name)?.trim() || undefined;
}

function isLotteryResultKind(value: string | undefined): value is LotteryResultRecord["resultKind"] {
  return value === "中選" || value === "落選" || value === "待通知" || value === "取消";
}
