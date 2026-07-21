import type { EventOption, LotteryPreference } from "../../shared/types.js";
import { BrowserEngineFailure, BrowserSessionEngine } from "../engines/browserSessionEngine.js";
import type { PageState } from "../engines/pageStateClassifier.js";

export interface ReviewPageData {
  readonly state: PageState;
  readonly url: string;
  readonly text: string;
}

export interface ReceiptData {
  readonly url: string;
  readonly receiptText: string;
}

const LOGIN_EMAIL_SELECTOR = "input[type='email'], input[name*='mail'], input[id*='mail']";
const LOGIN_PASSWORD_SELECTOR = "input[type='password']";
const LOGIN_SUBMIT_SELECTOR = "button[type='submit'], input[type='submit'], #login-bt a";
const EMAIL_CODE_SELECTOR = "input[name*='verification'], input[name*='code'], input[id*='code']";
const EMAIL_CODE_SUBMIT_SELECTOR = "button[type='submit'], input[type='submit']";

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

  async readAvailableOptions(): Promise<EventOption[]> {
    const state = await this.requireAutomatableState();
    if (state !== "LotteryForm" && state !== "DaySelection") {
      throw new BrowserEngineFailure("ProhibitedAction", `Options cannot be read while the page is ${state}.`);
    }
    return this.engine.getCurrentHtml().then(parseOptions);
  }

  async applyPreference(preference: LotteryPreference): Promise<void> {
    const state = await this.requireAutomatableState();
    if (state !== "LotteryForm" && state !== "DaySelection") {
      throw new BrowserEngineFailure("ProhibitedAction", `Preferences cannot be applied while the page is ${state}.`);
    }
    await this.engine.executeStep("apply-preference", {
      execute: async (page) => {
        for (const entry of preference.entries) {
          await page.locator(`[value='${entry.ticketTypeId}']`).check();
          await page.locator("select").first().selectOption(String(entry.quantity));
        }
        await page.locator(`[value='${preference.paymentMethodId}']`).check();
      }
    });
  }

  async readReviewPage(): Promise<ReviewPageData> {
    const state = await this.requireAutomatableState();
    return { state, url: this.engine.getCurrentUrl(), text: stripHtml(await this.engine.getCurrentHtml()) };
  }

  async submitApplication(): Promise<ReceiptData> {
    const state = await this.requireAutomatableState();
    if (state !== "LotteryForm" && state !== "DaySelection") {
      throw new BrowserEngineFailure("ProhibitedAction", `Submission is not permitted while the page is ${state}.`);
    }
    await this.engine.executeStep("submit-application", {
      execute: async (page) => {
        await page.locator("button[type='submit'], input[type='submit'], #apply-button-area a").first().click();
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

  private async requireAutomatableState(): Promise<PageState> {
    const classified = await this.engine.evaluateState();
    if (classified.requiresManualTakeover) {
      throw new BrowserEngineFailure("ManualTakeoverRequired", `Manual takeover is required for ${classified.state}.`);
    }
    return classified.state;
  }
}

function stripHtml(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ").replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
}

function parseOptions(html: string): EventOption[] {
  const values = [...html.matchAll(/<(?:option|input)\b[^>]*\bvalue=["']([^"']+)["'][^>]*>([^<]*)/giu)].map((match, index) => ({
    id: match[1] ?? `option-${index + 1}`,
    label: (match[2] ?? match[1] ?? `Option ${index + 1}`).trim()
  }));
  return values.length === 0 ? [] : [{ id: "live-options", label: "Available options", kind: "unknown", values, required: false }];
}
