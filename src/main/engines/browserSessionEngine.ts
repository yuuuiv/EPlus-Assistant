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
  type BrowserPageInspector,
  type BrowserStep,
  type SessionCheckpoint
} from "./browserSessionTypes.js";
import { createPlaywrightArtifactPage } from "./playwrightArtifactPage.js";
import { DEVICE_REGISTRY_DIGEST, getDeviceProfile } from "./deviceProfiles.js";
import { DeviceProfileLock, DeviceProfileLockError } from "./deviceProfileLock.js";
import type { BrowserSessionOwnership } from "./browserSessionTypes.js";

export { BrowserEngineFailure } from "./browserSessionTypes.js";
export type {
  BrowserActionExecutor,
  BrowserArtifactWriter,
  BrowserEngineConfig,
  BrowserEngineError,
  BrowserPageInspector,
  BrowserStep,
  SessionCheckpoint
} from "./browserSessionTypes.js";

const MANUAL_STATES = new Set(["CaptchaSliderDevice", "CheckboxGate", "ReceptionClosed", "Unknown"]);
const LOGIN_PATH = /\/login(?:[/?#]|$)/iu;

export class BrowserSessionEngine {
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
  private profileLock: DeviceProfileLock | undefined;
  private ownership: Readonly<Required<BrowserSessionOwnership>> | undefined;

  constructor(
    private readonly config: BrowserEngineConfig,
    private readonly artifactWriter: BrowserArtifactWriter,
    private readonly networkService?: NetworkService
  ) {}

  async startSession(accountId: string, ownership: BrowserSessionOwnership = { taskId: accountId, runId: accountId }): Promise<void> {
    if (this.networkService) {
      const started = await this.startNetworkSession({ accountId, runId: ownership.runId, contextId: ownership.runId, taskId: ownership.taskId, deviceProfileKey: ownership.deviceProfileKey });
      if (!started) throw new BrowserEngineFailure("ManualTakeoverRequired", "网络控制器需要人工处理后才能打开浏览器。");
      return;
    }
    await this.launchSession(accountId, ownership);
  }

  private async launchSession(accountId: string, requestedOwnership: BrowserSessionOwnership, launchGuard?: () => void): Promise<void> {
    if (this.context || this.page) {
      throw new BrowserEngineFailure("ContextQuarantined", "A browser session is already active for this engine.");
    }
    if (!(await this.validateExecutable())) {
      throw new BrowserEngineFailure("BrowserUnavailable", "The configured browser executable is unavailable.");
    }
    const deviceProfileKey = requestedOwnership.deviceProfileKey ?? "desktop-chrome";
    const ownership = { taskId: requestedOwnership.taskId, runId: requestedOwnership.runId, deviceProfileKey } as const;
    const profileDir = path.join(this.config.profilesDir, accountId, deviceProfileKey);
    const profileLock = new DeviceProfileLock(profileDir);
    let launchedContext: BrowserContext | undefined;
    try {
      launchGuard?.();
      await profileLock.acquire({ accountId, runId: ownership.runId, deviceProfileKey, registryDigest: DEVICE_REGISTRY_DIGEST, contextGeneration: 1 });
      launchGuard?.();
      const descriptor = getDeviceProfile(deviceProfileKey);
      launchedContext = await chromium.launchPersistentContext(profileDir, {
        executablePath: this.config.executablePath,
        headless: false,
        ...descriptor
      });
      const launchedPage = launchedContext.pages()[0] ?? (await launchedContext.newPage());
      if (typeof launchedPage.bringToFront === "function") await launchedPage.bringToFront().catch(() => undefined);
      launchGuard?.();
      this.context = launchedContext;
      this.page = launchedPage;
      this.accountId = accountId;
      this.profileDir = profileDir;
      this.profileLock = profileLock;
      this.ownership = ownership;
    } catch (error) {
      await launchedContext?.close();
      await profileLock.release();
      if (error instanceof DeviceProfileLockError) {
        throw new BrowserEngineFailure("ContextQuarantined", error.message, { cause: error });
      }
      throw error;
    }
  }
  async startNetworkSession(input: { readonly accountId: string; readonly runId: string; readonly contextId: string; readonly taskId?: string; readonly deviceProfileKey?: BrowserSessionOwnership["deviceProfileKey"]; readonly launchGuard?: () => void }): Promise<boolean> {
    if (!this.networkService) {
      throw new BrowserEngineFailure("ContextQuarantined", "Network service is required before browser launch.");
    }
    if (this.isSessionActive()) {
      if (this.ownership?.runId !== input.runId || this.accountId !== input.accountId) {
        throw new BrowserEngineFailure("ContextQuarantined", "另一个运行正在占用浏览器会话。");
      }
      await this.validateNetworkLease();
      return true;
    }
    const lease = await this.networkService.acquireLease(input);
    if (lease === "manual-takeover") {
      this.quarantined = true;
      return false;
    }
    try {
      await this.launchSession(input.accountId, { taskId: input.taskId ?? input.contextId, runId: input.runId, deviceProfileKey: input.deviceProfileKey }, input.launchGuard);
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
    await this.profileLock?.heartbeat();
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

  async inspectPage<Result>(inspector: BrowserPageInspector<Result>): Promise<Result> {
    const page = this.requirePage();
    await this.profileLock?.heartbeat();
    await this.validateNetworkLease();
    const state = await this.evaluateState();
    if (state.requiresManualTakeover || this.quarantined) {
      throw new BrowserEngineFailure("ManualTakeoverRequired", `Automation is paused on ${state.state}.`);
    }
    return inspector.inspect(page);
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

  async captureManualSnapshot(): Promise<readonly string[]> {
    const page = this.requirePage();
    const runId = this.ownership?.runId ?? this.accountId ?? "session";
    const stepIndex = (this.checkpoint?.stepIndex ?? 0) + 1;
    const manifestId = `${runId}:manual-${stepIndex}`;
    const [screenshot, html] = await Promise.all([
      this.artifactWriter.captureScreenshot(createPlaywrightArtifactPage(page), manifestId),
      this.artifactWriter.captureHtmlSnapshot(await page.content(), manifestId)
    ]);
    this.checkpoint = { url: page.url(), state: "ManualTakeover", stepIndex, artifacts: [screenshot.filePath ?? screenshot.id, html.filePath ?? html.id].filter((item): item is string => Boolean(item)) };
    return this.checkpoint.artifacts;
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
    this.profileDir = undefined;
    this.checkpoint = undefined;
    this.networkLease = undefined;
    await this.profileLock?.release();
    this.profileLock = undefined;
    this.ownership = undefined;
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
