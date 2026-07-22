import { load } from "cheerio";
import type { ParsedEplusPage } from "../services/eplusPageParser.js";

export type PageState =
  | "Login"
  | "SerialCode"
  | "EmailCode"
  | "CaptchaSliderDevice"
  | "InterstitialConsent"
  | "CheckboxGate"
  | "LotteryForm"
  | "DaySelection"
  | "Receipt"
  | "ReceptionClosed"
  | "Unknown";

export interface ClassificationResult {
  readonly state: PageState;
  readonly confidence: number;
  readonly reason: string;
  readonly safeActionHints: readonly string[];
  readonly requiresManualTakeover: boolean;
  readonly manifestEntry?: {
    readonly selectorConfidence: Readonly<Record<string, boolean>>;
    readonly matchedPatterns: readonly string[];
  };
}

export interface ClassifierInput {
  readonly url: string;
  readonly html: string;
  readonly selectors: Readonly<Record<string, string>>;
}

const VERIFIED_SELECTOR_HINTS = {
  loginButton: "#login-bt a, #login, a:has-text('ログイン画面へ')",
  cautionNextButton: "button[data-title='★ 必ずお読みください ★']",
  finalConsentButton: "#apply-button-area a:has-text('同意して申込み')"
} as const;

const MANUAL_ACTION_HINTS: readonly string[] = [];
const LOGIN_ACTION_HINTS = ["fill email", "fill password", "click login"] as const;
const EMAIL_CODE_ACTION_HINTS = ["fill verification code", "submit verification code"] as const;
const SERIAL_CODE_ACTION_HINTS = ["fill serial code", "submit serial code"] as const;
const INTERSTITIAL_ACTION_HINTS = ["review notice", "click confirmation"] as const;
const CHECKBOX_GATE_ACTION_HINTS = ["request manual confirmation"] as const;
const DAY_SELECTION_ACTION_HINTS = ["select requested day"] as const;
const LOTTERY_FORM_ACTION_HINTS = ["select ticket options", "select payment method", "review before submission"] as const;

type ParserSelectorHints = ParsedEplusPage["rawFormSchema"]["selectorHints"];

function normalizeText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function hasInput(html: string, type: string): boolean {
  return new RegExp(`<input\\b[^>]*\\btype\\s*=\\s*["']${type}["'][^>]*>`, "iu").test(html);
}

function hasNamedInput(html: string, pattern: RegExp): boolean {
  return new RegExp(`<input\\b[^>]*(?:name|id|autocomplete)\\s*=\\s*["'][^"']*${pattern.source}[^"']*["'][^>]*>`, "iu").test(
    html
  );
}

function hasPhoneChallengeEvidence(html: string, text: string): boolean {
  const $ = load(html);
  const phoneInput = $("input, select, textarea").toArray().some((element) => {
    const type = $(element).attr("type")?.toLowerCase();
    const key = `${$(element).attr("name") ?? ""} ${$(element).attr("id") ?? ""} ${$(element).attr("autocomplete") ?? ""} ${$(element).attr("aria-label") ?? ""}`;
    return type !== "hidden" && /phone|tel|telephone|mobile|sms|電話|携帯/iu.test(key);
  });
  return phoneInput ||
    /電話番号を入力|携帯電話番号を入力|SMS.*(?:認証|コード)/iu.test(text);
}

function containsVerifiedSelectorMarkup(html: string, selector: string): boolean {
  if (selector === VERIFIED_SELECTOR_HINTS.cautionNextButton) {
    return /<button\b[^>]*\bdata-title\s*=\s*["']★ 必ずお読みください ★["'][^>]*>/iu.test(html);
  }
  if (selector === VERIFIED_SELECTOR_HINTS.finalConsentButton) {
    return /<[^>]+\bid\s*=\s*["']apply-button-area["'][^>]*>[\s\S]*?同意して申込み/iu.test(html);
  }
  if (selector === VERIFIED_SELECTOR_HINTS.loginButton) {
    return /\bid\s*=\s*["'](?:login-bt|login)["']/iu.test(html) || /ログイン画面へ/iu.test(html);
  }
  return false;
}

function selectorConfidence(input: ClassifierInput): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries(input.selectors).map(([name, selector]) => [name, containsVerifiedSelectorMarkup(input.html, selector)])
  );
}

function result(
  state: PageState,
  confidence: number,
  reason: string,
  safeActionHints: readonly string[],
  requiresManualTakeover: boolean
): ClassificationResult {
  return { state, confidence, reason, safeActionHints, requiresManualTakeover };
}

function unknownResult(input: ClassifierInput, matchedPatterns: readonly string[]): ClassificationResult {
  return {
    state: "Unknown",
    confidence: 0.2,
    reason: "No verified page-state pattern matched.",
    safeActionHints: MANUAL_ACTION_HINTS,
    requiresManualTakeover: true,
    manifestEntry: {
      selectorConfidence: selectorConfidence(input),
      matchedPatterns
    }
  };
}

export function defaultSelectorHints(): Readonly<ParserSelectorHints> {
  return VERIFIED_SELECTOR_HINTS;
}

export function classifyPageState(input: ClassifierInput): ClassificationResult {
  const text = normalizeText(input.html);

  if (/受付は終了/iu.test(text)) {
    return result("ReceptionClosed", 0.99, "Matched closed reception text: 受付は終了.", MANUAL_ACTION_HINTS, true);
  }

  if (/シリアル(?:コード|ナンバー|番号)?|抽選コード|応募コード/iu.test(text) && hasNamedInput(input.html, /ninsho|serial/iu)) {
    return result("SerialCode", 0.96, "Matched serial-code entry text and ninsho/serial input evidence.", SERIAL_CODE_ACTION_HINTS, false);
  }

  if (
    /<(?:iframe)\b[^>]*(?:recaptcha|hcaptcha)[^>]*>/iu.test(input.html) ||
    /(?:captcha[-_ ]?slider|slider[-_ ]?captcha)/iu.test(input.html) ||
    hasPhoneChallengeEvidence(input.html, text)
  ) {
    return result(
      "CaptchaSliderDevice",
      0.99,
      "Matched CAPTCHA, slider, or device-verification evidence.",
      MANUAL_ACTION_HINTS,
      true
    );
  }

  if (/受付番号|申込完了/iu.test(text)) {
    return result("Receipt", 0.97, "Matched receipt evidence: 受付番号 or 申込完了.", MANUAL_ACTION_HINTS, false);
  }

  if (/\/login(?:[/?#]|$)/iu.test(input.url) || ((hasInput(input.html, "email") || hasNamedInput(input.html, /login[_-]?id|login[_-]?email|メールアドレス/iu)) && hasInput(input.html, "password"))) {
    return result("Login", 0.95, "Matched login URL or email and password form fields.", LOGIN_ACTION_HINTS, false);
  }

  if (/認証コード|確認コード/iu.test(text) || hasNamedInput(input.html, /verification|code/iu)) {
    return result("EmailCode", 0.93, "Matched verification-code text or input field.", EMAIL_CODE_ACTION_HINTS, false);
  }

  const matchingConsentSelector = Object.values(input.selectors).find(
    (selector) =>
      selector === VERIFIED_SELECTOR_HINTS.cautionNextButton || selector === VERIFIED_SELECTOR_HINTS.finalConsentButton
  );
  if (matchingConsentSelector && containsVerifiedSelectorMarkup(input.html, matchingConsentSelector)) {
    return result("InterstitialConsent", 0.9, "Matched verified consent selector markup.", INTERSTITIAL_ACTION_HINTS, false);
  }

  if (
    hasInput(input.html, "checkbox") &&
    /利用規約|規約|同意|個人情報|確認事項/iu.test(text) &&
    !/<input\b[^>]*\btype\s*=\s*["']checkbox["'][^>]*\bchecked(?:\s|=|>)/iu.test(input.html)
  ) {
    return result(
      "CheckboxGate",
      0.88,
      "Matched unchecked terms or conditions checkbox gate.",
      CHECKBOX_GATE_ACTION_HINTS,
      false
    );
  }

  if (/(?:day\.?1|day\.?2|両日)/iu.test(text) && /<(?:input|button|select)\b/iu.test(input.html)) {
    return result("DaySelection", 0.87, "Matched day selection controls for Day1, Day2, or 両日.", DAY_SELECTION_ACTION_HINTS, false);
  }

  if (
    /<(?:select|input)\b/iu.test(input.html) &&
    /券種|枚数|お支払い方法|支払方法|抽選|申込み|申し込み/iu.test(text)
  ) {
    return result("LotteryForm", 0.82, "Matched ticket, payment, or lottery form evidence.", LOTTERY_FORM_ACTION_HINTS, false);
  }

  return unknownResult(input, []);
}
