import { load } from "cheerio";
import type { Element } from "domhandler";
import type { ApplicationRecord, Companion, LotteryResultRecord } from "../../shared/types.js";

export interface MemberProfileData {
  readonly name?: string;
  readonly email?: string;
  readonly phone?: string;
  readonly gender?: string;
  readonly birthday?: string;
  readonly address?: string;
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
  return {
    name: findField(fields, ["name", "氏名", "お名前"]),
    email: findField(fields, ["email", "メール", "メールアドレス"]),
    phone: findField(fields, ["phone", "電話"]),
    gender: findField(fields, ["gender", "性別"]),
    birthday: findField(fields, ["birthday", "生年月日"]),
    address: findField(fields, ["address", "住所"])
  };
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
  return $("[data-application-record]").toArray().flatMap((element) => {
    const eventTitle = $(element).attr("data-event-title")?.trim();
    const appliedAt = $(element).attr("data-applied-at")?.trim();
    const ticketType = $(element).attr("data-ticket-type")?.trim();
    const quantity = Number($(element).attr("data-quantity"));
    const status = $(element).attr("data-status")?.trim();
    if (!eventTitle || !appliedAt || !ticketType || !Number.isFinite(quantity) || !status) return [];
    return [{ eventTitle, appliedAt, ticketType, quantity, status, sessionOrDay: optionalAttribute($, element, "data-session-or-day"), applicationId: optionalAttribute($, element, "data-application-id") }];
  });
}

export function parseLotteryResults(html: string): readonly Omit<LotteryResultRecord, "id" | "accountId" | "harvestedAt">[] {
  const $ = load(html);
  return $("[data-lottery-result]").toArray().flatMap((element) => {
    const eventTitle = $(element).attr("data-event-title")?.trim();
    const resultKind = $(element).attr("data-result-kind")?.trim();
    if (!eventTitle || !isLotteryResultKind(resultKind)) return [];
    return [{ eventTitle, resultKind, decidedAt: optionalAttribute($, element, "data-decided-at"), paymentDeadline: optionalAttribute($, element, "data-payment-deadline"), applicationId: optionalAttribute($, element, "data-application-id") }];
  });
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
