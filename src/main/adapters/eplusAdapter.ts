import * as cheerio from "cheerio";
import type { ApplicationRecord, CreditCardSummary, EventOption, LotteryPreference, LotteryResultRecord, PaymentOptionGroup, RuntimePaymentOption, SelectorEvidence } from "../../shared/types.js";
import { BrowserEngineFailure, BrowserSessionEngine } from "../engines/browserSessionEngine.js";
import type { PageState } from "../engines/pageStateClassifier.js";
import { discoverRuntimePaymentOptions } from "../services/runtimePaymentDiscovery.js";
import {
  parseApplicationRecords,
  parseCompanions,
  parseCreditCards,
  parseLotteryResults,
  parseMemberProfile,
  type CompanionData,
  type MemberProfileData
} from "./eplusMemberPageParser.js";

export interface ReviewPageData {
  readonly state: PageState;
  readonly url: string;
  readonly text: string;
}

export interface ReceiptData {
  readonly url: string;
  readonly receiptText: string;
}

export type { CompanionData, MemberProfileData } from "./eplusMemberPageParser.js";

const PHONE_NUMBER_URL = "https://member.eplus.jp/telnumber-ninsho";
const MEMBER_PROFILE_URL = "https://member.eplus.jp/update-member";
const SHIPPING_ADDRESS_URL = "https://member.eplus.jp/update-shippingaddress";
const CREDIT_CARD_URL = "https://member.eplus.jp/update-creditcard";
const COMPANION_MANAGEMENT_URL = "https://member.eplus.jp/update-dokosha";
const APPLICATION_HISTORY_URL = "https://eplus.jp/jyoukyou";
const LOTTERY_RESULTS_URL = "https://eplus.jp/jyoukyou";

const LOGIN_EMAIL_SELECTOR = "input[type='email'], input[name='login_id'], input[name*='login'], input[name*='mail'], input[id*='mail'], input[placeholder*='メールアドレス']";
const LOGIN_PASSWORD_SELECTOR = "input[type='password']";
const LOGIN_SUBMIT_SELECTOR = "button[type='submit'], input[type='submit'], #login-bt a, a#login";
const EMAIL_CODE_SELECTOR = "input[name*='verification'], input[name*='code'], input[id*='code']";
const EMAIL_CODE_SUBMIT_SELECTOR = "button[type='submit'], input[type='submit']";
const SERIAL_CODE_SELECTOR = "input[name^='ninsho_key'], input[placeholder*='シリアル'], input[id*='ninsho']";
const SERIAL_CODE_SUBMIT_SELECTOR = "button[name='action'][value='moushikomi'], button:has-text('お申込みへ'), input[type='submit']";
const CARD_FIELD_SELECTOR = "input[autocomplete='cc-number'], input[autocomplete='cc-csc'], input[name*='card'], input[name*='cvv'], input[name*='expiry']";
const SUPPORTED_PAYMENT_VALUE_SEGMENTS = ["card", "convenience", "familymart", "seven", "pay-easy", "atm", "bank"] as const;
const APPROVED_SUBMIT_SELECTOR = "#apply-button-area a";

export type PaymentDiscoveryResult =
  | { readonly status: "ready"; readonly groups: readonly PaymentOptionGroup[] }
  | { readonly status: "payment_unavailable"; readonly groups: readonly [] }
  | { readonly status: "payment_delayed"; readonly groups: readonly [] }
  | { readonly status: "manual"; readonly groups: readonly PaymentOptionGroup[]; readonly reason: "ambiguous-control" | "unsupported-control" | "unsafe-payment-fields" };

export type PaymentSelectionResult =
  | { readonly status: "selected"; readonly selections: readonly { readonly candidateId: string; readonly groupKey: string; readonly domValue: string; readonly label: string }[] }
  | { readonly status: "manual"; readonly reason: "missing-candidate" | "disabled-candidate" | "unsupported-candidate" | "ambiguous-candidate" | "unsafe-payment-fields"; readonly groups: readonly PaymentOptionGroup[] };

interface LiveGroupSnapshot {
  readonly groupKey: string;
  readonly groupOrder: number;
  readonly controlType: "select" | "input" | "button";
  readonly control: {
    readonly id: string | null;
    readonly name: string | null;
    readonly type: string | null;
    readonly role: string | null;
  };
  readonly mixedControlTypes: boolean;
  readonly options: readonly {
    readonly domValue: string;
    readonly label: string;
    readonly enabled: boolean;
    readonly id: string | null;
    readonly name: string | null;
    readonly type: string | null;
    readonly role: string | null;
  }[];
}

export class EplusBrowserAdapter {
  constructor(private readonly engine: BrowserSessionEngine) {}

  async openEvent(url: string): Promise<void> {
    await this.engine.navigate(url);
    await this.requireAutomatableState();
  }

  async login(email: string, password: string): Promise<void> {
    const state = await this.requireAutomatableState();
    if (state !== "Login") {
      throw new BrowserEngineFailure("ProhibitedAction", `Login is not permitted while the page is ${state}.`);
    }
    await this.engine.executeStep("login", {
      execute: async (page) => {
        await page.locator(LOGIN_EMAIL_SELECTOR).first().fill(email);
        await page.locator(LOGIN_PASSWORD_SELECTOR).first().fill(password);
        await page.locator(LOGIN_SUBMIT_SELECTOR).first().click();
      }
    });
  }

  async detectChallenge(): Promise<PageState> {
    return (await this.engine.evaluateState()).state;
  }

  async enterEmailCode(code: string): Promise<void> {
    const state = await this.requireAutomatableState();
    if (state !== "EmailCode") {
      throw new BrowserEngineFailure("ProhibitedAction", `Verification code entry is not permitted while the page is ${state}.`);
    }
    await this.engine.executeStep("enter-email-code", {
      execute: async (page) => {
        await page.locator(EMAIL_CODE_SELECTOR).first().fill(code);
        await page.locator(EMAIL_CODE_SUBMIT_SELECTOR).first().click();
      }
    });
  }

  async enterSerialCode(code: string): Promise<void> {
    const state = await this.requireAutomatableState();
    if (state !== "SerialCode") {
      throw new BrowserEngineFailure("ProhibitedAction", `Serial code entry is not permitted while the page is ${state}.`);
    }
    if (!code.trim()) throw new BrowserEngineFailure("ProhibitedAction", "Serial code cannot be empty.");
    await this.engine.executeStep("enter-serial-code", {
      execute: async (page) => {
        const input = page.locator(SERIAL_CODE_SELECTOR);
        if (await input.count() === 0) throw new BrowserEngineFailure("SelectorNotFound", "No serial code input found on the page.");
        await input.first().fill(code.trim());
        const submit = page.locator(SERIAL_CODE_SUBMIT_SELECTOR);
        const submitCount = await submit.count();
        if (submitCount === 0) throw new BrowserEngineFailure("SelectorNotFound", "No serial code submit button found on the page.");
        if (submitCount > 1) throw new BrowserEngineFailure("ProhibitedAction", "Multiple serial code submit elements found; ambiguous submission is prohibited.");
        await submit.click();
      }
    });
  }

  async selectSerialDay(day: "day1" | "day2"): Promise<void> {
    const state = await this.requireAutomatableState();
    if (state !== "DaySelection" && state !== "LotteryForm") {
      throw new BrowserEngineFailure("ProhibitedAction", `Day selection is not permitted while the page is ${state}.`);
    }
    await this.engine.executeStep("select-serial-day", {
      execute: async (page) => {
        const marker = day === "day1" ? /<\s*DAY1\s*>|DAY1|第一日/iu : /<\s*DAY2\s*>|DAY2|第二日/iu;
        const cards = page.locator("article[class*='block-ticket']").filter({ hasText: marker });
        if (await cards.count() !== 1) throw new BrowserEngineFailure("SelectorNotFound", `Serial application card for ${day} was not found or is ambiguous.`);
        const card = cards.first();
        const next = card.locator("button[data-toggle='modal-agree'], a").filter({ hasText: /次へ|お申込み|申込み|申込む/iu });
        if (await next.count() !== 1) throw new BrowserEngineFailure("SelectorNotFound", "Serial application entry button was not found or is ambiguous.");
        await Promise.all([next.first().click(), page.waitForURL(/atom\.eplus\.jp/iu, { timeout: 15_000 }).catch(() => undefined)]);
      }
    });
  }

  async readAvailableOptions(): Promise<EventOption[]> {
    const state = await this.requireAutomatableState();
    if (state !== "LotteryForm" && state !== "DaySelection") {
      throw new BrowserEngineFailure("ProhibitedAction", `Options cannot be read while the page is ${state}.`);
    }
    return this.engine.getCurrentHtml().then(parseOptions);
  }

  async discoverPaymentOptions(): Promise<PaymentDiscoveryResult> {
    const state = await this.requireAutomatableState();
    if (state !== "LotteryForm" && state !== "DaySelection") {
      throw new BrowserEngineFailure("ProhibitedAction", `Payment controls cannot be read while the page is ${state}.`);
    }
    const inspection = await this.inspectDeclaredPaymentGroups();
    if (inspection.unsafePaymentFields) {
      return { status: "manual", groups: [], reason: "unsafe-payment-fields" };
    }
    return paymentDiscoveryFromGroups(inspection.groups);
  }

  async selectPaymentCandidates(candidateIds: readonly string[]): Promise<PaymentSelectionResult> {
    const state = await this.requireAutomatableState();
    if (state !== "LotteryForm" && state !== "DaySelection") {
      throw new BrowserEngineFailure("ProhibitedAction", `Payment controls cannot be selected while the page is ${state}.`);
    }
    const inspection = await this.inspectDeclaredPaymentGroups();
    if (inspection.unsafePaymentFields) {
      return { status: "manual", reason: "unsafe-payment-fields", groups: [] };
    }
    const discovery = paymentDiscoveryFromGroups(inspection.groups);
    if (discovery.status !== "ready") {
      return { status: "manual", reason: "missing-candidate", groups: discovery.groups };
    }
    const selected = selectedCandidates(discovery.groups, candidateIds);
    if (selected.status !== "selected") return selected;
    await this.selectCandidates(selected.candidates);
    return {
      status: "selected",
      selections: selected.candidates.map((candidate) => ({ candidateId: candidate.candidateId, groupKey: candidate.groupKey, domValue: candidate.domValue, label: candidate.label }))
    };
  }

  async applyPreference(preference: LotteryPreference): Promise<void> {
    const state = await this.requireAutomatableState();
    if (state !== "LotteryForm" && state !== "DaySelection") {
      throw new BrowserEngineFailure("ProhibitedAction", `Preferences cannot be applied while the page is ${state}.`);
    }
    if (preference.entries.length > 0) {
      throw new BrowserEngineFailure("ManualTakeoverRequired", "Ticket controls require explicit runtime evidence.");
    }
    const paymentValue = preference.paymentPreference?.groupKey === "payment" ? preference.paymentPreference.value : preference.paymentMethodId;
    if (!paymentValue || (preference.paymentPreference && preference.paymentPreference.groupKey !== "payment")) {
      throw new BrowserEngineFailure("ManualTakeoverRequired", "Payment selection requires an exact payment-group candidate.");
    }
    const inspection = await this.inspectDeclaredPaymentGroups();
    if (inspection.unsafePaymentFields) {
      throw new BrowserEngineFailure("ManualTakeoverRequired", "Card payment details require manual entry.");
    }
    const candidates = exactPreferenceCandidates(inspection.groups, preference.deliveryMethodId, paymentValue);
    if (candidates.status !== "selected") {
      throw new BrowserEngineFailure("ManualTakeoverRequired", "Payment control is missing, disabled, unsupported, or ambiguous.");
    }
    await this.selectCandidates(candidates.candidates);
  }

  async readReviewPage(): Promise<ReviewPageData> {
    const state = await this.requireAutomatableState();
    return { state, url: this.engine.getCurrentUrl(), text: stripHtml(await this.engine.getCurrentHtml()) };
  }

  async submitApplication(leaseValidator?: () => void): Promise<ReceiptData> {
    const state = await this.requireAutomatableState();
    if (state !== "LotteryForm" && state !== "DaySelection") {
      throw new BrowserEngineFailure("ProhibitedAction", `Submission is not permitted while the page is ${state}.`);
    }
    await this.engine.executeStep("submit-application", {
      execute: async (page) => {
        leaseValidator?.();
        const submitLocator = page.locator(APPROVED_SUBMIT_SELECTOR);
        const submitCount = await submitLocator.count();
        if (submitCount === 0) throw new BrowserEngineFailure("SelectorNotFound", "No approved submit element found on the page.");
        if (submitCount > 1) throw new BrowserEngineFailure("ProhibitedAction", "Multiple submit elements found; ambiguous submission is prohibited.");
        await submitLocator.click();
      }
    });
    return this.readReceipt();
  }

  async readReceipt(): Promise<ReceiptData> {
    const state = await this.requireAutomatableState();
    if (state !== "Receipt") {
      throw new BrowserEngineFailure("ProhibitedAction", `Receipt data is unavailable while the page is ${state}.`);
    }
    return { url: this.engine.getCurrentUrl(), receiptText: stripHtml(await this.engine.getCurrentHtml()) };
  }

  async openMemberProfile(): Promise<void> {
    await this.openMemberPage(MEMBER_PROFILE_URL);
  }

  async openPhoneNumber(): Promise<void> {
    await this.openMemberPage(PHONE_NUMBER_URL);
  }

  async readPhoneNumber(): Promise<string | undefined> {
    return parseMemberProfile(await this.engine.getCurrentHtml()).phone;
  }

  async openShippingAddress(): Promise<void> {
    await this.openMemberPage(SHIPPING_ADDRESS_URL);
  }

  async readShippingAddress(): Promise<string | undefined> {
    return parseMemberProfile(await this.engine.getCurrentHtml()).address;
  }

  async openCreditCard(): Promise<void> {
    await this.openMemberPage(CREDIT_CARD_URL);
  }

  async readCreditCards(): Promise<readonly CreditCardSummary[]> {
    return parseCreditCards(await this.engine.getCurrentHtml());
  }

  async openCompanionManagement(): Promise<void> {
    await this.openMemberPage(COMPANION_MANAGEMENT_URL);
  }

  async openApplicationHistory(): Promise<void> {
    await this.openMemberPage(APPLICATION_HISTORY_URL);
  }

  async openLotteryResults(): Promise<void> {
    await this.openMemberPage(LOTTERY_RESULTS_URL);
  }

  async readMemberProfile(): Promise<MemberProfileData> {
    return parseMemberProfile(await this.engine.getCurrentHtml());
  }

  async readCompanions(): Promise<CompanionData> {
    return parseCompanions(await this.engine.getCurrentHtml());
  }

  async readApplicationHistory(): Promise<readonly Omit<ApplicationRecord, "id" | "accountId" | "harvestedAt">[]> {
    return parseApplicationRecords(await this.engine.getCurrentHtml());
  }

  async readLotteryResults(): Promise<readonly Omit<LotteryResultRecord, "id" | "accountId" | "harvestedAt">[]> {
    return parseLotteryResults(await this.engine.getCurrentHtml());
  }

  private async openMemberPage(url: string): Promise<void> {
    await this.engine.navigate(url);
    const state = await this.engine.evaluateState();
    if (state.requiresManualTakeover) {
      const html = await this.engine.getCurrentHtml();
      if (/captcha|電話番号認証が必要/iu.test(html) || state.state !== "Unknown") {
        throw new BrowserEngineFailure("ManualTakeoverRequired", `Manual takeover is required for ${state.state}.`);
      }
    }
  }

  private async requireAutomatableState(): Promise<PageState> {
    const classified = await this.engine.evaluateState();
    if (classified.requiresManualTakeover) {
      throw new BrowserEngineFailure("ManualTakeoverRequired", `Manual takeover is required for ${classified.state}.`);
    }
    return classified.state;
  }

  private async inspectDeclaredPaymentGroups(): Promise<{ readonly groups: readonly PaymentOptionGroup[]; readonly unsafePaymentFields: boolean }> {
    return this.engine.inspectPage({
      inspect: async (page) => {
        if ((await page.locator(CARD_FIELD_SELECTOR).count()) > 0 || page.frames().length !== 1) {
          return { groups: [], unsafePaymentFields: true };
        }
        const snapshots = await page.evaluate(() => {
          const controls = document.querySelectorAll<HTMLElement>("[data-payment-group]");
          return Array.from(controls).flatMap((group, groupOrder) => {
            const groupKey = group.dataset.paymentGroup?.trim();
            if (!groupKey) return [];
            const allControls = Array.from(group.querySelectorAll<HTMLSelectElement | HTMLInputElement | HTMLButtonElement>("select, input[type='radio'], button[value]"));
            const control = allControls[0];
            if (!control || (control.tagName !== "SELECT" && control.tagName !== "INPUT" && control.tagName !== "BUTTON")) return [];
            const controlType: LiveGroupSnapshot["controlType"] = control.tagName === "SELECT" ? "select" : control.tagName === "INPUT" ? "input" : "button";
            const optionNodes = control instanceof HTMLSelectElement
              ? Array.from(control.querySelectorAll<HTMLOptionElement>("option[value]"))
              : controlType === "input"
                ? Array.from(group.querySelectorAll<HTMLInputElement>("input[type='radio'][value]"))
                : Array.from(group.querySelectorAll<HTMLButtonElement>("button[value]"));
            return [{
              groupKey,
              groupOrder,
              controlType,
              mixedControlTypes: allControls.some((candidate) => candidate.tagName.toLowerCase() !== controlType),
              control: { id: control.id || null, name: control.getAttribute("name"), type: control.getAttribute("type"), role: control.getAttribute("role") },
              options: optionNodes.map((option) => {
                const optionId = option.id;
                const label = controlType === "select"
                  ? option.textContent?.trim() || option.value
                  : group.querySelector(`label[for="${CSS.escape(optionId)}"]`)?.textContent?.trim() || option.value;
                return { domValue: option.value, label, enabled: !option.disabled && !control.disabled, id: option.id || null, name: option.getAttribute("name"), type: option.getAttribute("type"), role: option.getAttribute("role") };
              })
            }];
          });
        });
        return { groups: groupsFromSnapshots(snapshots), unsafePaymentFields: false };
      }
    });
  }

  private async selectCandidates(candidates: readonly RuntimePaymentOption[]): Promise<void> {
    await this.engine.executeStep("select-runtime-payment-candidates", {
      execute: async (page) => {
        if ((await page.locator(CARD_FIELD_SELECTOR).count()) > 0 || page.frames().length !== 1) {
          throw new BrowserEngineFailure("ManualTakeoverRequired", "Card payment details or nested browser context require manual entry.");
        }
        for (const candidate of candidates) {
          const groups = page.locator("[data-payment-group]");
          const group = groups.nth(candidate.groupOrder);
          if (await group.getAttribute("data-payment-group") !== candidate.groupKey) {
            throw new BrowserEngineFailure("ManualTakeoverRequired", "Declared payment group changed before selection.");
          }
          const controls = group.locator(candidate.controlType === "select" ? "select" : candidate.controlType === "input" ? "input[type='radio']" : "button[value]");
          const control = controls.nth(candidate.optionOrder);
          if ((await control.count()) !== 1 || (await control.getAttribute("value")) !== candidate.domValue || (await control.isDisabled())) {
            throw new BrowserEngineFailure("ManualTakeoverRequired", "Payment candidate is missing, disabled, or changed.");
          }
          if (candidate.controlType === "select") {
            await group.locator("select").selectOption(candidate.domValue);
            if ((await group.locator("select").inputValue()) !== candidate.domValue) {
              throw new BrowserEngineFailure("ManualTakeoverRequired", "Selected payment value could not be verified.");
            }
          } else if (candidate.controlType === "input") {
            await control.check();
            const selectedLabel = await control.evaluate((element) => element instanceof HTMLInputElement ? element.labels?.[0]?.textContent?.trim() || element.value : "");
            if (!(await control.isChecked()) || (await control.getAttribute("value")) !== candidate.domValue || selectedLabel !== candidate.label) {
              throw new BrowserEngineFailure("ManualTakeoverRequired", "Selected payment control could not be verified.");
            }
          } else {
            await control.click();
            if ((await control.getAttribute("aria-pressed")) !== "true" || (await control.textContent())?.trim() !== candidate.label) {
              throw new BrowserEngineFailure("ManualTakeoverRequired", "Selected payment button could not be verified.");
            }
          }
        }
      }
    });
  }
}

function stripHtml(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
}

export function parseOptions(html: string): EventOption[] {
  const $ = cheerio.load(html);
  const groups: EventOption[] = [];
  $("[data-payment-group]").each((groupOrder, group) => {
    const groupKey = $(group).attr("data-payment-group")?.trim();
    if (!groupKey) return;
    const control = $(group).find("input[type='radio'][value], select").first();
    if (!control.length) {
      groups.push({ id: `runtime-${groupOrder}`, label: groupKey, kind: "unknown", values: [], required: false });
      return;
    }
    const tag = control[0]?.tagName === "select" ? "select" : "input";
    const controlType = tag === "select" ? "select" : "input";
    const name = control.attr("name");
    const id = control.attr("id");
    const type = control.attr("type");
    const allowedAttributes = { ...(id ? { id } : {}), ...(name ? { name } : {}), ...(type ? { type } : {}), dataPaymentGroup: groupKey };
    const selectorEvidence: SelectorEvidence = { scope: "document", tag, groupOrdinal: groupOrder, optionOrdinal: 0, allowedAttributes, contextGeneration: "runtime" };
    const optionNodes = controlType === "select" ? control.find("option[value]") : $(group).find("input[type='radio'][value]");
    const options: RuntimePaymentOption[] = optionNodes.toArray().map((option, optionOrder) => {
      const value = $(option).attr("value") ?? "";
      const optionId = $(option).attr("id");
      const label = controlType === "select" ? $(option).text().trim() : $(group).find("label").filter((_index, labelNode) => $(labelNode).attr("for") === optionId).text().trim();
      const enabled = !$(option).is(":disabled") && !control.is(":disabled");
      return { candidateId: `${groupKey}:${value}`, groupKey, groupOrder, optionOrder, controlType, domValue: value, label: label || value, enabled, supported: groupKey === "payment" && value.length > 0, ambiguous: false, selectorEvidence: { ...selectorEvidence, optionOrdinal: optionOrder } };
    });
    const runtimeGroup: PaymentOptionGroup = { groupKey, groupOrder, controlType, selectorEvidence, options };
    groups.push({ id: `runtime-${groupOrder}`, label: groupKey, kind: groupKey === "payment" ? "payment" : "unknown", values: options.map((option) => ({ id: option.candidateId, label: option.label, disabled: !option.enabled })), required: groupKey === "payment", ...(groupKey === "payment" ? { runtimeGroup } : {}) });
  });
  return groups;
}

function groupsFromSnapshots(snapshots: readonly LiveGroupSnapshot[]): PaymentOptionGroup[] {
  return snapshots.map((snapshot) => {
    const values = snapshot.options.map((option) => option.domValue);
    const labels = snapshot.options.map((option) => option.label);
    const hasDuplicate = (items: readonly string[], item: string): boolean => items.filter((value) => value === item).length > 1;
    const selectorEvidence = evidenceFor(snapshot.groupKey, snapshot.groupOrder, snapshot.controlType, 0, snapshot.control);
    return {
      groupKey: snapshot.groupKey,
      groupOrder: snapshot.groupOrder,
      controlType: snapshot.controlType,
      selectorEvidence,
      options: snapshot.options.map((option, optionOrder) => {
        const ambiguous = snapshot.mixedControlTypes || hasDuplicate(values, option.domValue) || hasDuplicate(labels, option.label);
        return {
          candidateId: candidateId(snapshot.groupKey, option.domValue, optionOrder, values),
          groupKey: snapshot.groupKey,
          groupOrder: snapshot.groupOrder,
          optionOrder,
          controlType: snapshot.controlType,
          domValue: option.domValue,
          label: option.label,
          enabled: option.enabled,
          supported: snapshot.groupKey === "payment" && !ambiguous && SUPPORTED_PAYMENT_VALUE_SEGMENTS.some((segment) => option.domValue.toLowerCase().includes(segment)),
          ambiguous,
          selectorEvidence: evidenceFor(snapshot.groupKey, snapshot.groupOrder, snapshot.controlType, optionOrder, option)
        };
      })
    };
  });
}

function evidenceFor(
  groupKey: string,
  groupOrdinal: number,
  tag: "select" | "input" | "button",
  optionOrdinal: number,
  attributes: { readonly id: string | null; readonly name: string | null; readonly type: string | null; readonly role: string | null }
): SelectorEvidence {
  return {
    scope: "document",
    tag,
    groupOrdinal,
    optionOrdinal,
    allowedAttributes: {
      ...(attributes.id && !/^i\d+$/iu.test(attributes.id) ? { id: attributes.id } : {}),
      ...(attributes.name ? { name: attributes.name } : {}),
      ...(attributes.type ? { type: attributes.type } : {}),
      ...(attributes.role ? { role: attributes.role } : {}),
      dataPaymentGroup: groupKey
    },
    contextGeneration: "live"
  };
}

function candidateId(groupKey: string, domValue: string, optionOrder: number, values: readonly string[]): string {
  return values.filter((value) => value === domValue).length > 1 ? `${groupKey}:${domValue}:${optionOrder}` : `${groupKey}:${domValue}`;
}

function paymentDiscoveryFromGroups(groups: readonly PaymentOptionGroup[]): PaymentDiscoveryResult {
  const paymentGroups = groups.filter((group) => group.groupKey === "payment");
  if (paymentGroups.length === 0) return { status: "payment_unavailable", groups: [] };
  if (paymentGroups.some((group) => group.options.length === 0)) return { status: "manual", groups: paymentGroups, reason: "unsupported-control" };
  if (paymentGroups.some((group) => group.options.some((option) => option.ambiguous))) return { status: "manual", groups: paymentGroups, reason: "ambiguous-control" };
  return { status: "ready", groups: paymentGroups };
}

function selectedCandidates(groups: readonly PaymentOptionGroup[], candidateIds: readonly string[]):
  | { readonly status: "selected"; readonly candidates: readonly RuntimePaymentOption[] }
  | { readonly status: "manual"; readonly reason: "missing-candidate" | "disabled-candidate" | "unsupported-candidate" | "ambiguous-candidate"; readonly groups: readonly PaymentOptionGroup[] } {
  if (candidateIds.length === 0 || new Set(candidateIds).size !== candidateIds.length) return { status: "manual", reason: "missing-candidate", groups };
  const candidates = candidateIds.map((candidateId) => groups.flatMap((group) => group.options).find((option) => option.candidateId === candidateId));
  if (candidates.some((candidate) => candidate === undefined)) return { status: "manual", reason: "missing-candidate", groups };
  const resolved = candidates.filter((candidate): candidate is RuntimePaymentOption => candidate !== undefined);
  if (resolved.some((candidate) => !candidate.enabled)) return { status: "manual", reason: "disabled-candidate", groups };
  if (resolved.some((candidate) => !candidate.supported)) return { status: "manual", reason: "unsupported-candidate", groups };
  if (resolved.some((candidate) => candidate.ambiguous) || new Set(resolved.map((candidate) => candidate.groupKey)).size !== resolved.length) return { status: "manual", reason: "ambiguous-candidate", groups };
  return { status: "selected", candidates: [...resolved].sort((left, right) => left.groupOrder - right.groupOrder || left.optionOrder - right.optionOrder) };
}

function exactPreferenceCandidates(groups: readonly PaymentOptionGroup[], deliveryValue: string | undefined, paymentValue: string) {
  const candidateIds = groups
    .filter((group) => group.groupKey === "delivery" || group.groupKey === "payment")
    .flatMap((group) => group.options.filter((option) => option.domValue === (group.groupKey === "delivery" ? deliveryValue : paymentValue)).map((option) => option.candidateId));
  return selectedCandidates(groups, candidateIds);
}
