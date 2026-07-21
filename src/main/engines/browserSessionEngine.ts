import { stat } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { classifyPageState, defaultSelectorHints, type ClassificationResult } from "./pageStateClassifier.js";
import type { NetworkLease } from "../../shared/types.js";
import type { NetworkService } from "../services/networkService.js";
import {
  BrowserEngineFailure,
  type BrowserActionExecutor,
  type BrowserArtifactWriter,
  type BrowserEngineConfig,
  type BrowserEngineError,
  type BrowserStep,
  type SessionCheckpoint
} from "./browserSessionTypes.js";
import { createPlaywrightArtifactPage } from "./playwrightArtifactPage.js";

export { BrowserEngineFailure } from "./browserSessionTypes.js";
export type {
  BrowserActionExecutor,
  BrowserArtifactWriter,
  BrowserEngineConfig,
  BrowserEngineError,
  BrowserStep,
  SessionCheckpoint
} from "./browserSessionTypes.js";

const MANUAL_STATES = new Set(["CaptchaSliderDevice", "CheckboxGate", "ReceptionClosed", "Unknown"]);
const LOGIN_PATH = /\/login(?:[/?#]|$)/iu;

export class BrowserSessionEngine {
  private static readonly activeProfileDirs = new Set<string>();
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private accountId: string | undefined;
  private profileDir: string | undefined;
  private checkpoint: SessionCheckpoint | undefined;
  private manualContinuation: Promise<void> | undefined;
  private resolveManualContinuation: (() => void) | undefined;
  private rejectManualContinuation: ((reason: Error) => void) | undefined;
  private quarantined = false;
  private networkLease: NetworkLease | undefined;

  constructor(
    private readonly config: BrowserEngineConfig,
    private readonly artifactWriter: BrowserArtifactWriter,
    private readonly networkService?: NetworkService
  ) {}

  async startSession(accountId: string): Promise<void> {
    if (this.networkService) {
      throw new BrowserEngineFailure("ContextQuarantined", "A network lease is required before browser launch.");
    }
    await this.launchSession(accountId);
  }

  private async launchSession(accountId: string): Promise<void> {
    if (this.context || this.page) {
      throw new BrowserEngineFailure("ContextQuarantined", "A browser session is already active for this engine.");
    }
    if (!(await this.validateExecutable())) {
      throw new BrowserEngineFailure("BrowserUnavailable", "The configured browser executable is unavailable.");
    }
    const profileDir = path.join(this.config.profilesDir, accountId);
    if (BrowserSessionEngine.activeProfileDirs.has(profileDir)) {
      throw new BrowserEngineFailure("ContextQuarantined", "This account profile is already active.");
    }
    BrowserSessionEngine.activeProfileDirs.add(profileDir);
    try {
      this.context = await chromium.launchPersistentContext(profileDir, {
        executablePath: this.config.executablePath,
        headless: false
      });
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      this.accountId = accountId;
      this.profileDir = profileDir;
    } catch (error) {
      BrowserSessionEngine.activeProfileDirs.delete(profileDir);
      throw error;
    }
  }

  async startNetworkSession(input: { readonly accountId: string; readonly runId: string; readonly contextId: string }): Promise<boolean> {
    if (!this.networkService) {
      throw new BrowserEngineFailure("ContextQuarantined", "Network service is required before browser launch.");
    }
    const lease = await this.networkService.acquireLease(input);
    if (lease === "manual-takeover") {
      this.quarantined = true;
      return false;
    }
    try {
      await this.launchSession(input.accountId);
      this.networkLease = lease;
      return true;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async validateExecutable(): Promise<boolean> {
    try {
      const executable = await stat(this.config.executablePath);
      return executable.isFile();
    } catch {
      return false;
    }
  }

  async navigate(url: string): Promise<string> {
    const page = this.requirePage();
    this.ensureUsable();
    await this.validateNetworkLease();
    await this.withRetries(async () => {
      const response = await page.goto(url, { timeout: this.config.navigationTimeoutMs, waitUntil: "networkidle" });
      if (response?.status() === 429 || response?.status() === 503) {
        throw new BrowserEngineFailure("NavigationTimeout", `Eplus throttled navigation with HTTP ${response.status()}.`);
      }
    }, "NavigationTimeout");
    return page.url();
  }

  async evaluateState(): Promise<ClassificationResult> {
    const page = this.requirePage();
    this.ensureUsable();
    const classification = classifyPageState({
      url: page.url(),
      html: await page.content(),
      selectors: defaultSelectorHints()
    });
    if (MANUAL_STATES.has(classification.state)) {
      this.quarantined = true;
    }
    return classification;
  }

  async executeStep(action: string, executor?: BrowserActionExecutor): Promise<BrowserStep> {
    const page = this.requirePage();
    await this.validateNetworkLease();
    const before = await this.evaluateState();
    if (before.requiresManualTakeover || this.quarantined) {
      throw new BrowserEngineFailure("ManualTakeoverRequired", `Automation is paused on ${before.state}.`);
    }
    if (!executor) {
      throw new BrowserEngineFailure("ProhibitedAction", `No approved executor is registered for ${action}.`);
    }
    await this.withRetries(() => executor.execute(page), "SelectorNotFound");
    const after = await this.evaluateState();
    const stepIndex = (this.checkpoint?.stepIndex ?? 0) + 1;
    const manifestId = `${this.accountId ?? "session"}-${stepIndex}`;
    const [screenshot, html] = await Promise.all([
      this.artifactWriter.captureScreenshot(createPlaywrightArtifactPage(page), manifestId),
      this.artifactWriter.captureHtmlSnapshot(await page.content(), manifestId)
    ]);
    const artifacts = [screenshot.filePath ?? screenshot.id, html.filePath ?? html.id].filter(
      (artifact): artifact is string => Boolean(artifact)
    );
    this.checkpoint = { url: page.url(), state: after.state, stepIndex, artifacts };
    return {
      beforeState: before.state,
      action,
      afterState: after.state,
      ...(screenshot.filePath ?? screenshot.id ? { screenshotRef: screenshot.filePath ?? screenshot.id } : {}),
      ...(html.filePath ?? html.id ? { htmlRef: html.filePath ?? html.id } : {})
    };
  }

  async reuseSession(): Promise<boolean> {
    const checkpointUrl = this.checkpoint?.url;
    if (!checkpointUrl) {
      return false;
    }
    const currentUrl = await this.navigate(checkpointUrl);
    return !LOGIN_PATH.test(currentUrl);
  }

  async manualTakeover(): Promise<void> {
    this.requirePage();
    if (!this.manualContinuation) {
      this.manualContinuation = new Promise<void>((resolve, reject) => {
        this.resolveManualContinuation = resolve;
        this.rejectManualContinuation = reject;
      });
    }
    return this.manualContinuation;
  }

  resumeManualTakeover(): void {
    this.quarantined = false;
    this.resolveManualContinuation?.();
    this.clearManualContinuation();
  }

  cancelManualTakeover(): void {
    this.rejectManualContinuation?.(new BrowserEngineFailure("ManualTakeoverRequired", "Manual takeover was cancelled."));
    this.clearManualContinuation();
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    this.accountId = undefined;
    if (this.profileDir) {
      BrowserSessionEngine.activeProfileDirs.delete(this.profileDir);
    }
    this.profileDir = undefined;
    this.checkpoint = undefined;
    this.networkLease = undefined;
    this.quarantined = false;
    this.cancelManualTakeover();
    await context?.close();
  }

  isSessionActive(): boolean {
    return Boolean(this.context && this.page && !this.context.isClosed());
  }

  getCurrentHtml(): Promise<string> {
    return this.requirePage().content();
  }

  getCurrentUrl(): string {
    return this.requirePage().url();
  }

  getCheckpoint(): SessionCheckpoint | undefined {
    return this.checkpoint;
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new BrowserEngineFailure("BrowserUnavailable", "No active browser page is available.");
    }
    return this.page;
  }

  private ensureUsable(): void {
    if (this.quarantined) {
      throw new BrowserEngineFailure("ContextQuarantined", "The browser context is quarantined pending manual takeover.");
    }
  }

  private async withRetries(operation: () => Promise<void>, code: BrowserEngineError): Promise<void> {
    let failure: unknown;
    for (let attempt = 0; attempt <= this.config.retryLimit; attempt += 1) {
      try {
        await operation();
        return;
      } catch (error) {
        failure = error;
        if (attempt === this.config.retryLimit) {
          break;
        }
        const delay = Math.min(this.config.retryDelayMs * 2 ** attempt, 60_000);
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
    }
    if (failure instanceof BrowserEngineFailure) {
      throw failure;
    }
    throw new BrowserEngineFailure(code, "Browser operation failed after bounded retries.", { cause: failure });
  }

  private async validateNetworkLease(): Promise<void> {
    if (!this.networkLease) return;
    const result = await this.networkService?.validateLease(this.networkLease, this.networkLease.runId);
    if (!result || result === "valid") return;
    await this.close();
    this.quarantined = true;
    throw new BrowserEngineFailure("ContextQuarantined", `Network lease is ${result}.`);
  }

  private clearManualContinuation(): void {
    this.manualContinuation = undefined;
    this.resolveManualContinuation = undefined;
    this.rejectManualContinuation = undefined;
  }

}
