import { createHash, randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import type { EplusRawFormSchema, EventOption, EventSnapshot } from "../../shared/types.js";
import { discoverRuntimePaymentOptions } from "./runtimePaymentDiscovery.js";

export interface ParsedEplusPage {
  sourceUrl: string;
  canonicalUrl: string;
  title: string;
  venue?: string;
  scheduleText?: string;
  applicationDeadline?: string;
  rawFormSchema: EplusRawFormSchema;
  pageFingerprint: string;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\u00a0/g, " ").trim();
}

function optionId(prefix: string, label: string, index: number): string {
  const slug = label
    .normalize("NFKC")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${prefix}-${slug || index}`;
}

function absoluteUrl(base: string, href?: string): string | undefined {
  if (!href || href === "#") {
    return undefined;
  }
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

function onclickUrl(base: string, onclick?: string): string | undefined {
  const raw = onclick?.match(/(?:window\.location(?:\.href)?\s*=\s*['"]|location\.href\s*=\s*['"])([^'"]+)/iu)?.[1];
  return raw ? absoluteUrl(base, raw) : undefined;
}

function extractJsonLd($: cheerio.CheerioAPI): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  $("script[type='application/ld+json']").each((_index, element) => {
    try {
      const parsed = JSON.parse($(element).text());
      if (Array.isArray(parsed)) {
        entries.push(...parsed.filter((item) => item && typeof item === "object"));
      } else if (parsed && typeof parsed === "object") {
        entries.push(parsed);
      }
    } catch {
      // Ignore malformed embedded data; Eplus pages can contain old templates.
    }
  });
  return entries;
}

function getMeta($: cheerio.CheerioAPI, name: string): string | undefined {
  return (
    $(`meta[property='${name}']`).attr("content") ||
    $(`meta[name='${name}']`).attr("content") ||
    undefined
  );
}

function buildTicketOptions(applications: Array<{ id: string; label: string; status?: string }>): EventOption | undefined {
  if (applications.length === 0) {
    return undefined;
  }
  return {
    id: "application-link",
    label: "受付 / 公演",
    kind: "ticket",
    required: true,
    values: applications.map((item) => ({
      id: item.id,
      label: item.status ? `${item.label} (${item.status})` : item.label,
      disabled: /受付終了|予定枚数終了|終了|停止/.test(item.status ?? "")
    }))
  };
}

function buildRuntimeOptions(html: string): EventOption[] {
  const discovery = discoverRuntimePaymentOptions(html);
  return discovery.groups.map((group) => ({
    id: `runtime-${group.groupOrder}`,
    label: group.groupKey,
    kind: group.groupKey === "payment" ? "payment" : group.groupKey === "delivery" ? "delivery" : "unknown",
    required: group.groupKey === "payment",
    values: group.options.map((option) => ({ id: option.candidateId, label: option.label, disabled: !option.enabled })),
    runtimeGroup: group
  }));
}

function parseQuantityRange(text: string): { min: number; max: number } | undefined {
  const matches = [...text.matchAll(/(?:枚数制限|各|それぞれ|につき)?[^。]*?(\d{1,2})\s*枚まで/g)];
  const max = matches
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)[0];
  return max ? { min: 1, max } : undefined;
}

function parseDeadline(text: string): string | undefined {
  const match = text.match(/受付期間[^0-9０-９]*(.+?～\s*[^。]+?\d{1,2}:\d{2})/);
  return match ? normalizeText(match[1]) : undefined;
}

function parseApplications($: cheerio.CheerioAPI, baseUrl: string): Array<{
  id: string;
  label: string;
  href?: string;
  status?: string;
  sessionName?: string;
  selectorHint?: string;
}> {
  const seen = new Set<string>();
  const applications: Array<{
    id: string;
    label: string;
    href?: string;
    status?: string;
    sessionName?: string;
    selectorHint?: string;
  }> = [];

  $("article[class*='block-ticket']").each((index, element) => {
    const article = $(element);
    const containerText = normalizeText(article.text());
    if (!/受付|抽選|発売|チケット/.test(containerText)) {
      return;
    }
    const applicationAnchor = article
      .find("a, button")
      .filter((_anchorIndex, anchor) => /お申込み|申込み|申込む|次へ/.test(normalizeText($(anchor).text())) || $(anchor).attr("data-toggle") === "modal-agree" || $(anchor).attr("value") === "販売ページ")
      .first();
    const href = applicationAnchor.length ? absoluteUrl(baseUrl, applicationAnchor.attr("href")) ?? onclickUrl(baseUrl, applicationAnchor.attr("onclick")) : undefined;
    const status = containerText.match(/受付中|受付前|受付終了|予定枚数終了|販売終了|抽選受付中/)?.[0];
    const dayMarker = containerText.match(/[＜<]\s*(DAY1|DAY2|第一日|第二日)\s*[＞>]/iu)?.[1]?.toUpperCase();
    const label =
      (dayMarker ? `${dayMarker} ` : "") + (
      normalizeText(article.find("h3, h4, .block-ticket__title, .block-ticket-0__title").first().text()) ||
      containerText.match(/(抽選|先行|プレオーダー|一般発売|受付)[^。]{0,80}/)?.[0] ||
      `受付 ${index + 1}`);
    const key = `${label}|${href ?? `article-${index}`}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    applications.push({
      id: optionId("application", label, applications.length + 1),
      label,
      href,
      status,
      selectorHint: href ? undefined : `article.block-ticket:nth-of-type(${index + 1})`
    });
  });

  $("a, button").each((index, element) => {
    const current = $(element);
    const text = normalizeText(current.text());
    const href = element.tagName === "a" ? absoluteUrl(baseUrl, current.attr("href")) : onclickUrl(baseUrl, current.attr("onclick"));
    const isApplication =
      (/お申込み|申込み|申込む/.test(text) || current.attr("data-toggle") === "modal-agree" || current.attr("value") === "販売ページ") &&
      !/履歴|確認方法|新規会員登録|登録確認/.test(text) &&
      !(current.attr("name") === "action" && current.attr("value") === "moushikomi");
    if (!isApplication) {
      return;
    }

    const article = current.closest("article[class*='block-ticket']");
    if (article.length) {
      return;
    }
    const containerText = normalizeText((article.length ? article : current.parent()).text());
    const sessionMatch = text.match(/＜(.+?)＞お申込み/);
    const dayMarker = containerText.match(/[＜<]\s*(DAY1|DAY2|第一日|第二日)\s*[＞>]/iu)?.[1]?.toUpperCase();
    const status =
      containerText.match(/受付中|受付前|受付終了|予定枚数終了|販売終了|抽選受付中/)?.[0] ||
      text.match(/受付中|受付前|受付終了|予定枚数終了|販売終了|抽選受付中/)?.[0];
    const label =
      (dayMarker ? `${dayMarker} ` : "") + (sessionMatch?.[1] ||
      containerText.match(/(プレオーダー|先行抽選|一般発売|抽選受付|受付)[^。<]{0,80}/)?.[0] ||
      text ||
      `申込み ${index + 1}`);
    const key = `${label}|${href ?? ""}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    applications.push({
      id: optionId("application", label, applications.length + 1),
      label,
      href,
      status,
      sessionName: sessionMatch?.[1] ?? dayMarker,
      selectorHint: sessionMatch ? `link-text:＜${sessionMatch[1]}＞お申込み` : undefined
    });
  });

  return applications;
}

export function parseEplusPage(sourceUrl: string, html: string): ParsedEplusPage {
  const $ = cheerio.load(html);
  const bodyText = normalizeText($("body").text());
  const jsonLd = extractJsonLd($);
  const eventLd = jsonLd.find((item) => item["@type"] === "Event");
  const location = eventLd?.location && typeof eventLd.location === "object" ? eventLd.location as Record<string, unknown> : undefined;
  const canonicalCandidate =
    $("link[rel='canonical']").attr("href") ||
    getMeta($, "og:url") ||
    sourceUrl;
  const title =
    normalizeText($(".s4-main-title").first().text()) ||
    normalizeText($(".page-header__title").first().text()) ||
    String(eventLd?.name ?? "") ||
    getMeta($, "og:title") ||
    normalizeText($("title").first().text()) ||
    sourceUrl;
  const venue =
    (typeof location?.name === "string" ? location.name : undefined) ||
    bodyText.match(/会場[:：]?\s*([^。]+?)(?:\s|$)/)?.[1];
  const startDate = typeof eventLd?.startDate === "string" ? eventLd.startDate : undefined;
  const scheduleText =
    startDate ||
    normalizeText($(".block-irregular__date").first().text()) ||
    getMeta($, "description");
  const quantityRange = parseQuantityRange(bodyText);
  const serialInput = $("input[placeholder*='シリアル'], input[name*='ninsho'], input[id*='ninsho']").first();
  const serialRequired =
    serialInput.length > 0 ||
    /シリアル(?:No\.?|ナンバー|番号)?|抽選コード|応募コード|認証キー|ninsho_key/.test(bodyText) ||
    new URL(sourceUrl).searchParams.has("P6");
  // Serial entry pages often point their canonical tag at the underlying
  // event detail page. The entry URL is the actionable page and must be kept
  // as the task target, otherwise the run opens a page without the code form.
  const canonicalUrl = serialRequired ? sourceUrl : absoluteUrl(sourceUrl, canonicalCandidate) ?? sourceUrl;
  const applications = parseApplications($, canonicalUrl);
  const looksLikeStandardDetail = $(".s4-main-title").length > 0 || $("#dvcGamenId").val() === "S4";
  const sourceKind = serialRequired ? "serial-code" : applications.length || looksLikeStandardDetail ? "standard-detail" : "unknown";
  const options: EventOption[] = [];
  const ticketOption = buildTicketOptions(applications);
  if (ticketOption) options.push(ticketOption);
  if (quantityRange) {
    options.push({
      id: "quantity",
      label: "枚数",
      kind: "quantity",
      required: true,
      values: Array.from({ length: quantityRange.max - quantityRange.min + 1 }, (_item, index) => {
        const value = quantityRange.min + index;
        return { id: String(value), label: `${value}枚` };
      })
    });
  }
  options.push(...buildRuntimeOptions(html));

  const notes: string[] = [];
  const availableDays = Array.from(new Set(applications.flatMap((application) => /DAY1|第一日/iu.test(application.label) ? ["day1" as const] : /DAY2|第二日/iu.test(application.label) ? ["day2" as const] : [])));
  if (serialRequired) {
    notes.push("检测到シリアルナンバー/抽选码流程；每个账号运行前需要提供公共或账号专用抽选码。");
  }
  if (bodyText.includes("電話番号認証が必要")) {
    notes.push("页面包含电话认证提示文案；仅当实际出现电话/SMS输入控件时才判定为电话验证挑战。");
  }
  if (bodyText.includes("受付は終了")) {
    notes.push("页面显示受付已结束；任务可保存但不应提交。");
  }
  if (applications.length === 0) {
    notes.push("未发现可点击的申込み入口；可能是受付前/结束、页面结构变化，或入口由脚本动态生成。");
  }

  const rawFormSchema: EplusRawFormSchema = {
    sourceKind,
    options,
    applicationLinks: applications,
    quantityRange,
    serialCode: {
      required: serialRequired,
      label: serialRequired ? "シリアルナンバー / 抽选码" : "抽选码",
      placeholder: serialInput.attr("placeholder"),
      errorSelectors: [
        "div[name='ninsho_key_whole_error_info'] p",
        "div[name^='ninsho_key_error_info']"
      ],
      knownErrorMessages: [
        { code: "UsedCode", text: "利用回数を超えたためお申込みできません。" },
        { code: "InvalidCode", text: "申し込み情報が正しくありません。" }
      ],
      ...(availableDays.length > 0 ? { availableDays, daySelectionRequired: availableDays.length > 1 } : {})
    },
    selectorHints: {
      serialInput: "input[name^='ninsho_key'], input[placeholder*='シリアル'], input[id*='ninsho']",
      codeSubmitButton: "button[name='action'][value='moushikomi'], button:has-text('お申込みへ')",
      loginButton: "#login-bt a, #login, a:has-text('ログイン画面へ')",
      cautionNextButton: "button[data-title='★ 必ずお読みください ★']",
      finalConsentButton: "#apply-button-area a:has-text('同意して申込み')"
    },
    requiresManualInspection:
      sourceKind === "unknown" ||
      applications.length === 0 ||
      bodyText.includes("受付は終了"),
    notes
  };

  return {
    sourceUrl,
    canonicalUrl,
    title,
    venue: venue ? normalizeText(venue) : undefined,
    scheduleText,
    applicationDeadline: parseDeadline(bodyText),
    rawFormSchema,
    pageFingerprint: createHash("sha256")
      .update(`${canonicalUrl}|${title}|${rawFormSchema.sourceKind}|${applications.map((item) => item.label).join("|")}`)
      .digest("hex")
      .slice(0, 16)
  };
}

export function parsedPageToSnapshot(parsed: ParsedEplusPage): EventSnapshot {
  return {
    id: randomUUID(),
    sourceUrl: parsed.sourceUrl,
    canonicalUrl: parsed.canonicalUrl,
    title: parsed.title,
    venue: parsed.venue,
    scheduleText: parsed.scheduleText,
    applicationDeadline: parsed.applicationDeadline,
    fetchedAt: new Date().toISOString(),
    rawFormSchema: parsed.rawFormSchema,
    pageFingerprint: parsed.pageFingerprint
  };
}
