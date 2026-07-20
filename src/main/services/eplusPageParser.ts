import { createHash, randomUUID } from "node:crypto";
import * as cheerio from "cheerio";
import type { EplusRawFormSchema, EventOption, EventSnapshot } from "../../shared/types.js";

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

const KNOWN_PAYMENT_LABELS = [
  "クレジットカード",
  "ファミリーマート",
  "セブンイレブン",
  "その他コンビニ",
  "ペイジー",
  "ATM",
  "ネットバンキング"
];

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

function buildPaymentOption(labels: string[]): EventOption | undefined {
  if (labels.length === 0) {
    return undefined;
  }
  return {
    id: "payment-method",
    label: "付款方式",
    kind: "payment",
    required: true,
    values: labels.map((label, index) => ({
      id: optionId("payment", label, index),
      label
    }))
  };
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

function findPaymentLabels($: cheerio.CheerioAPI, bodyText: string): string[] {
  const labels = new Set<string>();
  $(".block-irregular__boxes-title").each((_index, element) => {
    const text = normalizeText($(element).text());
    if (KNOWN_PAYMENT_LABELS.some((label) => text.includes(label))) {
      labels.add(text);
    }
  });
  if (labels.size === 0) {
    $("th, dt, h3, h4").each((_index, element) => {
      const text = normalizeText($(element).text());
      const sectionText = normalizeText($(element).closest("section, article, div").text());
      if (sectionText.includes("お支払い方法") && KNOWN_PAYMENT_LABELS.some((label) => text.includes(label))) {
        labels.add(text);
      }
    });
  }
  if (labels.size === 0 && bodyText.includes("お支払い方法")) {
    for (const label of KNOWN_PAYMENT_LABELS) {
      if (bodyText.includes(label)) {
        labels.add(label);
      }
    }
  }
  return [...labels];
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
      .find("a")
      .filter((_anchorIndex, anchor) => /お申込み|申込み|申込む/.test(normalizeText($(anchor).text())))
      .first();
    const href = applicationAnchor.length ? absoluteUrl(baseUrl, applicationAnchor.attr("href")) : undefined;
    const status = containerText.match(/受付中|受付前|受付終了|予定枚数終了|販売終了|抽選受付中/)?.[0];
    const label =
      normalizeText(article.find("h3, h4, .block-ticket__title, .block-ticket-0__title").first().text()) ||
      containerText.match(/(抽選|先行|プレオーダー|一般発売|受付)[^。]{0,80}/)?.[0] ||
      `受付 ${index + 1}`;
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
    const href = element.tagName === "a" ? absoluteUrl(baseUrl, current.attr("href")) : undefined;
    const isApplication =
      /お申込み|申込み|申込む/.test(text) &&
      !/履歴|確認方法|新規会員登録|登録確認/.test(text);
    if (!isApplication) {
      return;
    }

    const article = current.closest("article[class*='block-ticket']");
    if (article.length) {
      return;
    }
    const containerText = normalizeText((article.length ? article : current.parent()).text());
    const sessionMatch = text.match(/＜(.+?)＞お申込み/);
    const status =
      containerText.match(/受付中|受付前|受付終了|予定枚数終了|販売終了|抽選受付中/)?.[0] ||
      text.match(/受付中|受付前|受付終了|予定枚数終了|販売終了|抽選受付中/)?.[0];
    const label =
      sessionMatch?.[1] ||
      containerText.match(/(プレオーダー|先行抽選|一般発売|抽選受付|受付)[^。<]{0,80}/)?.[0] ||
      text ||
      `申込み ${index + 1}`;
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
      sessionName: sessionMatch?.[1],
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
  const canonicalUrl =
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
  const applications = parseApplications($, canonicalUrl);
  const paymentLabels = findPaymentLabels($, bodyText);
  const quantityRange = parseQuantityRange(bodyText);
  const serialInput = $("input[placeholder*='シリアル'], input[name*='ninsho'], input[id*='ninsho']").first();
  const serialRequired =
    serialInput.length > 0 ||
    /シリアル(?:No\.?|ナンバー|番号)?|抽選コード|応募コード|認証キー|ninsho_key/.test(bodyText) ||
    new URL(sourceUrl).searchParams.has("P6");
  const looksLikeStandardDetail = $(".s4-main-title").length > 0 || $("#dvcGamenId").val() === "S4";
  const sourceKind = serialRequired ? "serial-code" : applications.length || looksLikeStandardDetail ? "standard-detail" : "unknown";
  const options: EventOption[] = [];
  const ticketOption = buildTicketOptions(applications);
  const paymentOption = buildPaymentOption(paymentLabels);
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
  if (paymentOption) options.push(paymentOption);

  const notes: string[] = [];
  if (serialRequired) {
    notes.push("检测到シリアルナンバー/抽选码流程；每个账号运行前需要提供公共或账号专用抽选码。");
  }
  if (bodyText.includes("電話番号認証が必要")) {
    notes.push("页面提示需要电话认证；自动化运行时应进入人工接管。");
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
      errorSelectors: ["div[name='ninsho_key_whole_error_info'] p"],
      knownErrorMessages: [
        { code: "UsedCode", text: "利用回数を超えたためお申込みできません。" },
        { code: "InvalidCode", text: "申し込み情報が正しくありません。" }
      ]
    },
    selectorHints: {
      serialInput: "input[placeholder*='シリアル'], input[name*='ninsho'], input[id*='ninsho']",
      codeSubmitButton: "button:has-text('お申込みへ')",
      loginButton: "#login-bt a, #login, a:has-text('ログイン画面へ')",
      cautionNextButton: "button[data-title='★ 必ずお読みください ★']",
      finalConsentButton: "#apply-button-area a:has-text('同意して申込み')"
    },
    requiresManualInspection:
      sourceKind === "unknown" ||
      applications.length === 0 ||
      bodyText.includes("電話番号認証が必要") ||
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
