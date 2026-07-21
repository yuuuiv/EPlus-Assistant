import type { Page } from "playwright-core";

export type BrowserEngineError =
  | "BrowserUnavailable"
  | "NavigationTimeout"
  | "SelectorNotFound"
  | "SessionExpired"
  | "ProhibitedAction"
  | "ManualTakeoverRequired"
  | "ContextQuarantined";

export interface BrowserEngineConfig {
  readonly executablePath: string;
  readonly profilesDir: string;
  readonly navigationTimeoutMs: number;
  readonly retryLimit: number;
  readonly retryDelayMs: number;
}

export interface BrowserStep {
  readonly beforeState: string;
  readonly action: string;
  readonly afterState: string;
  readonly screenshotRef?: string;
  readonly htmlRef?: string;
}

export interface SessionCheckpoint {
  readonly url: string;
  readonly state: string;
  readonly stepIndex: number;
  readonly artifacts: readonly string[];
}

export interface ArtifactPage {
  screenshot(): Promise<Buffer>;
  prepareForArtifact(options: { readonly maskSelectors: readonly string[]; readonly knownAccountValues: readonly string[] }): Promise<void>;
}

export interface BrowserArtifactWriter {
  captureScreenshot(page: ArtifactPage, manifestId: string): Promise<{ readonly filePath?: string; readonly id?: string }>;
  captureHtmlSnapshot(html: string, manifestId: string): Promise<{ readonly filePath?: string; readonly id?: string }>;
}

export interface BrowserActionExecutor {
  execute(page: Page): Promise<void>;
}

export class BrowserEngineFailure extends Error {
  readonly name = "BrowserEngineFailure";

  constructor(readonly code: BrowserEngineError, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}
