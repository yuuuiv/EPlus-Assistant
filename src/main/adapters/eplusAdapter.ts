import * as cheerio from "cheerio";
import type { ApplicationRecord, CreditCardSummary, EventOption, LotteryResultRecord, PaymentOptionGroup, PaymentSelection, RuntimePaymentOption, SelectorEvidence } from "../../shared/types.js";
import { BrowserEngineFailure, BrowserSessionEngine } from "../engines/browserSessionEngine.js";
import { defaultSelectorHints, type PageState } from "../engines/pageStateClassifier.js";
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

const EPLUS_HOME_URL = "https://eplus.jp";
const PHONE_NUMBER_URL = "https://member.eplus.jp/telnumber-ninsho";
const MEMBER_PROFILE_URL = "https://member.eplus.jp/update-member";
const SHIPPING_ADDRESS_URL = "https://member.eplus.jp/update-shippingaddress";
const CREDIT_CARD_URL = "https://member.eplus.jp/update-creditcard";
const COMPANION_MANAGEMENT_URL = "https://member.eplus.jp/update-dokosha";
const APPLICATION_HISTORY_URL = "https://eplus.jp/jyoukyou";
const LOTTERY_RESULTS_URL = "https://eplus.jp/jyoukyou";

// The login form itself is hidden behind a "ログイン画面へ" trigger on most eplus pages
// (event application pages, member pages) and only becomes fillable after clicking it.
const LOGIN_TRIGGER_SELECTOR = "#login-bt a";
const LOGIN_EMAIL_SELECTOR = "#loginId, input[name='loginId'], input[type='email'], input[name='login_id'], input[name*='login'], input[name*='mail'], input[id*='mail'], input[placeholder*='メールアドレス']";
const LOGIN_PASSWORD_SELECTOR = "#loginPassword, input[type='password']";
const LOGIN_SUBMIT_SELECTOR = "#idPwLogin, button[type='submit'], input[type='submit']";
const EMAIL_CODE_SELECTOR = "input[name*='verification'], input[name*='code'], input[id*='code']";
const EMAIL_CODE_SUBMIT_SELECTOR = "button[type='submit'], input[type='submit']";
const SERIAL_CODE_SELECTOR = "input[name^='ninsho_key'], input[placeholder*='シリアル'], input[id*='ninsho']";
const SERIAL_CODE_SUBMIT_SELECTOR = "button[name='action'][value='moushikomi'], button:has-text('お申込みへ'), input[type='submit']";
const CARD_FIELD_SELECTOR = "input[autocomplete='cc-number'], input[autocomplete='cc-csc'], input[name*='card'], input[name*='cvv'], input[name*='expiry']";
const SUPPORTED_PAYMENT_VALUE_SEGMENTS = ["card", "convenience", "familymart", "seven", "pay-easy", "atm", "bank"] as const;
const APPROVED_SUBMIT_SELECTOR = "#apply-button-area a";
const CONSENT_CHECKBOX_SELECTOR = "input[type='checkbox']";
const { cautionNextButton: CAUTION_NEXT_SELECTOR, finalConsentButton: FINAL_CONSENT_SELECTOR } = defaultSelectorHints();

interface ConsentControlSnapshot {
  readonly label: string;
  readonly checked: boolean;
  readonly id: string | null;
  readonly name: string | null;
}

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

  /**
   * Visits the main eplus.jp site before a member-area page. Landing on a
   * member.eplus.jp page cold (no prior visit to the main domain) is what
   * triggers Akamai's "Access Denied" block on the sp.atom.eplus.jp login
   * gateway a real browsing session would normally reach with referrer/cookie
   * context already established.
   */
  async openHome(): Promise<void> {
    await this.engine.navigate(EPLUS_HOME_URL);
  }

  async login(email: string, password: string): Promise<void> {
    const state = await this.requireAutomatableState();
    if (state !== "Login") {
      throw new BrowserEngineFailure("ProhibitedAction", `Login is not permitted while the page is ${state}.`);
    }
    await this.engine.executeStep("login", {
      execute: async (page) => {
        // The login form is hidden behind a "ログイン画面へ" trigger until clicked.
        const passwordField = page.locator(LOGIN_PASSWORD_SELECTOR).first();
        if (!(await passwordField.isVisible().catch(() => false))) {
          const trigger = page.locator(LOGIN_TRIGGER_SELECTOR).first();
          if (await trigger.count() > 0) await trigger.click();
        }
        await page.locator(LOGIN_EMAIL_SELECTOR).first().fill(email);
        await passwordField.fill(password);
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

  /**
   * Re-applies every verified runtime selection for this run (ticket, quantity, entry,
   * delivery, payment — whatever data-payment-group controls the page declares), each
   * bound to its group by (groupKey, domValue) rather than a fixed set of known fields.
   */
  async applyPreference(selections: readonly PaymentSelection[]): Promise<void> {
    const state = await this.requireAutomatableState();
    if (state !== "LotteryForm" && state !== "DaySelection") {
      throw new BrowserEngineFailure("ProhibitedAction", `Preferences cannot be applied while the page is ${state}.`);
    }
    if (selections.length === 0) {
      throw new BrowserEngineFailure("ManualTakeoverRequired", "No verified runtime selection is available to apply.");
    }
    const inspection = await this.inspectDeclaredPaymentGroups();
    if (inspection.unsafePaymentFields) {
      throw new BrowserEngineFailure("ManualTakeoverRequired", "Card payment details require manual entry.");
    }
    const candidates = exactPreferenceCandidates(inspection.groups, selections);
    if (candidates.status !== "selected") {
      throw new BrowserEngineFailure("ManualTakeoverRequired", "A verified runtime control is missing, disabled, unsupported, ambiguous, or changed.");
    }
    await this.selectCandidates(candidates.candidates);
  }

  /** Clicks through a deterministic, already-verified interstitial notice (e.g. "必ずお読みください" / "同意して申込み"). */
  async acknowledgeInterstitial(): Promise<void> {
    const state = await this.requireAutomatableState();
    if (state !== "InterstitialConsent") {
      throw new BrowserEngineFailure("ProhibitedAction", `Interstitial acknowledgement is not permitted while the page is ${state}.`);
    }
    await this.engine.executeStep("acknowledge-interstitial", {
      execute: async (page) => {
        const button = page.locator(`${CAUTION_NEXT_SELECTOR}, ${FINAL_CONSENT_SELECTOR}`);
        const count = await button.count();
        if (count === 0) throw new BrowserEngineFailure("SelectorNotFound", "No verified interstitial acknowledgement control found on the page.");
        if (count > 1) throw new BrowserEngineFailure("ProhibitedAction", "Multiple interstitial acknowledgement controls found; ambiguous automation is prohibited.");
        await button.first().click();
      }
    });
  }

  /** Enumerates unchecked terms/consent checkboxes on a CheckboxGate page for candidate-matching, mirroring payment-group discovery. */
  async discoverConsentControls(): Promise<PaymentOptionGroup[]> {
    const state = await this.requireAutomatableState();
    if (state !== "CheckboxGate") {
      throw new BrowserEngineFailure("ProhibitedAction", `Consent controls cannot be read while the page is ${state}.`);
    }
    const controls = await this.inspectConsentControls();
    return controls
      .filter((control) => !control.checked && control.label.trim().length > 0)
      .map((control, index) => consentGroup(control, index));
  }

  /** Checks the consent boxes matched by a previously discovered/templated selection, re-verifying each is still unchecked before acting. */
  async applyConsentSelections(candidateIds: readonly string[]): Promise<void> {
    const groups = await this.discoverConsentControls();
    const candidates = candidateIds.map((candidateId) => groups.flatMap((group) => group.options).find((option) => option.candidateId === candidateId));
    if (candidates.some((candidate) => candidate === undefined)) {
      throw new BrowserEngineFailure("ManualTakeoverRequired", "A verified consent control is missing or changed.");
    }
    await this.checkConsentBoxes(candidates.filter((candidate): candidate is RuntimePaymentOption => candidate !== undefined));
  }

  /** Best-effort: after a human manually resolves a CheckboxGate, confirms which candidate labels are now checked, for template capture. */
  async confirmConsentChecked(candidates: readonly { groupKey: string; domValue: string; label: string }[]): Promise<readonly { groupKey: string; domValue: string; label: string }[]> {
    const controls = await this.inspectConsentControls();
    return candidates.filter((candidate) => controls.some((control) => control.checked && normalizeLabel(control.label) === normalizeLabel(candidate.label)));
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

  private async inspectConsentControls(): Promise<ConsentControlSnapshot[]> {
    return this.engine.inspectPage({
      inspect: async (page) =>
        page.evaluate(() => {
          const boxes = Array.from(document.querySelectorAll<HTMLInputElement>("input[type='checkbox']"));
          return boxes.map((box) => {
            const label = box.id
              ? document.querySelector(`label[for="${CSS.escape(box.id)}"]`)?.textContent?.trim()
              : box.closest("label")?.textContent?.trim();
            return { label: label ?? "", checked: box.checked, id: box.id || null, name: box.getAttribute("name") };
          });
        })
    });
  }

  private async checkConsentBoxes(candidates: readonly RuntimePaymentOption[]): Promise<void> {
    await this.engine.executeStep("check-consent-boxes", {
      execute: async (page) => {
        const boxes = page.locator(CONSENT_CHECKBOX_SELECTOR);
        for (const candidate of candidates) {
          const box = boxes.nth(candidate.groupOrder);
          if ((await box.count()) !== 1 || (await box.isChecked())) {
            throw new BrowserEngineFailure("ManualTakeoverRequired", "Consent checkbox is missing or already in an unexpected state.");
          }
          await box.check();
          if (!(await box.isChecked())) {
            throw new BrowserEngineFailure("ManualTakeoverRequired", "Consent checkbox could not be confirmed checked.");
          }
        }
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
  if (groups.length === 0) return { status: "payment_unavailable", groups: [] };
  if (groups.some((group) => group.options.length === 0)) return { status: "manual", groups, reason: "unsupported-control" };
  if (groups.some((group) => group.options.some((option) => option.ambiguous))) return { status: "manual", groups, reason: "ambiguous-control" };
  return { status: "ready", groups };
}

function consentGroup(control: ConsentControlSnapshot, index: number): PaymentOptionGroup {
  const groupKey = `consent-${index}`;
  const domValue = normalizeLabel(control.label);
  const selectorEvidence: SelectorEvidence = {
    scope: "document",
    tag: "input",
    groupOrdinal: index,
    optionOrdinal: 0,
    allowedAttributes: {
      ...(control.id && !/^i\d+$/iu.test(control.id) ? { id: control.id } : {}),
      ...(control.name ? { name: control.name } : {}),
      type: "checkbox",
      dataPaymentGroup: groupKey
    },
    contextGeneration: "live"
  };
  return {
    groupKey,
    groupOrder: index,
    controlType: "input",
    selectorEvidence,
    options: [{ candidateId: `${groupKey}:${domValue}`, groupKey, groupOrder: index, optionOrder: 0, controlType: "input", domValue, label: control.label, enabled: true, supported: true, ambiguous: false, selectorEvidence }]
  };
}

function normalizeLabel(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
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

function exactPreferenceCandidates(groups: readonly PaymentOptionGroup[], selections: readonly PaymentSelection[]) {
  const candidateIds: string[] = [];
  for (const selection of selections) {
    const group = groups.find((candidate) => candidate.groupKey === selection.groupKey);
    const matches = group?.options.filter((option) => option.domValue === selection.domValue) ?? [];
    if (matches.length !== 1) return { status: "manual" as const, reason: "missing-candidate" as const, groups };
    const match = matches[0];
    if (match) candidateIds.push(match.candidateId);
  }
  return selectedCandidates(groups, candidateIds);
}
