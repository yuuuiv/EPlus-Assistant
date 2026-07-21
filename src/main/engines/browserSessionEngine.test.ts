import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { launchPersistentContext } = vi.hoisted(() => ({ launchPersistentContext: vi.fn() }));

vi.mock("playwright-core", () => ({ chromium: { launchPersistentContext } }));

import { BrowserEngineFailure, BrowserSessionEngine } from "./browserSessionEngine.js";
import { NetworkService } from "../services/networkService.js";

const directories: string[] = [];

afterEach(async () => {
  launchPersistentContext.mockReset();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function pageFixture(html = "<form><input type='email'><input type='password'></form>", url = "https://eplus.jp/login") {
  let currentUrl = url;
  return {
    goto: vi.fn(async (nextUrl: string) => {
      currentUrl = nextUrl;
      return { status: () => 200 };
    }),
    url: () => currentUrl,
    content: vi.fn(async () => html),
    screenshot: vi.fn(async () => Buffer.from("masked")),
    evaluate: vi.fn(async () => undefined),
    locator: vi.fn()
  };
}

async function engineFixture(page = pageFixture()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-browser-engine-"));
  directories.push(directory);
  const executablePath = path.join(directory, "browser.exe");
  await writeFile(executablePath, "fixture");
  const context = { pages: () => [page], newPage: vi.fn(), isClosed: () => false, close: vi.fn(async () => undefined) };
  launchPersistentContext.mockResolvedValue(context);
  const config = { executablePath, profilesDir: directory, navigationTimeoutMs: 100, retryLimit: 1, retryDelayMs: 0 };
  const artifacts = {
    captureScreenshot: vi.fn(async (artifactPage) => {
      await artifactPage.prepareForArtifact({ maskSelectors: [], knownAccountValues: [] });
      return { filePath: "screenshot.png" };
    }),
    captureHtmlSnapshot: vi.fn(async () => ({ filePath: "snapshot.html" }))
  };
  return {
    page,
    artifacts,
    context,
    config,
    engine: new BrowserSessionEngine(config, artifacts)
  };
}

describe("BrowserSessionEngine", () => {
  it("validates the executable before launching an account profile", async () => {
    const { engine } = await engineFixture();

    await engine.startSession("account-1");

    expect(launchPersistentContext).toHaveBeenCalledOnce();
    expect(engine.isSessionActive()).toBe(true);
    await engine.close();
  });

  it("rejects an invalid executable without a launch attempt", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-browser-engine-"));
    directories.push(directory);
    const engine = new BrowserSessionEngine(
      { executablePath: path.join(directory, "missing.exe"), profilesDir: directory, navigationTimeoutMs: 100, retryLimit: 1, retryDelayMs: 0 },
      { captureScreenshot: vi.fn(), captureHtmlSnapshot: vi.fn() }
    );

    await expect(engine.startSession("account-1")).rejects.toMatchObject({ code: "BrowserUnavailable" });

    expect(launchPersistentContext).not.toHaveBeenCalled();
  });

  it("does not launch a browser when network lease acquisition requires manual takeover", async () => {
    const { config, artifacts } = await engineFixture();
    const network = new NetworkService(
      { rotate: vi.fn().mockRejectedValue(new Error("controller unavailable")), detectIp: vi.fn() },
      { getSetting: () => ({ host: "127.0.0.1", port: 9090, proxyGroup: "Auto", requiredCountry: "Japan", policy: "JP-only", secretConfigured: true }) }
    );
    const engine = new BrowserSessionEngine(config, artifacts, network);

    await expect(engine.startNetworkSession({ accountId: "account-1", runId: "run-1", contextId: "context-1" })).resolves.toBe(false);

    expect(launchPersistentContext).not.toHaveBeenCalled();
    expect(engine.isSessionActive()).toBe(false);
  });

  it("retries navigation failures with the configured bounded budget", async () => {
    const { engine, page } = await engineFixture();
    page.goto.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce({ status: () => 200 });
    await engine.startSession("account-1");

    await engine.navigate("https://eplus.jp/event");

    expect(page.goto).toHaveBeenCalledTimes(2);
    await engine.close();
  });

  it("detects session reuse when a checkpoint returns to login", async () => {
    const { engine, page } = await engineFixture();
    await engine.startSession("account-1");
    await engine.executeStep("login", { execute: async () => undefined });
    page.goto.mockImplementation(async () => ({ status: () => 200 }));

    await expect(engine.reuseSession()).resolves.toBe(false);
    await engine.close();
  });

  it("leaves the page untouched while manual takeover waits for resume", async () => {
    const { engine, page } = await engineFixture(pageFixture("<iframe src='https://captcha.example'></iframe>", "https://eplus.jp/apply"));
    await engine.startSession("account-1");
    const takeover = engine.manualTakeover();

    expect(page.locator).not.toHaveBeenCalled();
    engine.resumeManualTakeover();
    await expect(takeover).resolves.toBeUndefined();
    await engine.close();
  });

  it("rejects concurrent use of one account profile", async () => {
    const first = await engineFixture();
    const second = new BrowserSessionEngine(first.config, first.artifacts);
    await first.engine.startSession("account-1");

    await expect(second.startSession("account-1")).rejects.toMatchObject({ code: "ContextQuarantined" });

    await first.engine.close();
  });

  it("captures masked evidence for every permitted atomic step", async () => {
    const { engine, artifacts, page } = await engineFixture();
    await engine.startSession("account-1");

    const step = await engine.executeStep("login", { execute: async () => undefined });

    expect(artifacts.captureScreenshot).toHaveBeenCalledOnce();
    expect(artifacts.captureHtmlSnapshot).toHaveBeenCalledOnce();
    expect(page.evaluate).toHaveBeenCalledOnce();
    expect(step).toMatchObject({ beforeState: "Login", afterState: "Login", screenshotRef: "screenshot.png" });
    await engine.close();
  });

  it("does not execute an action on CAPTCHA", async () => {
    const { engine } = await engineFixture(pageFixture("<iframe src='https://captcha.example'></iframe>", "https://eplus.jp/apply"));
    await engine.startSession("account-1");
    const execute = vi.fn(async () => undefined);

    await expect(engine.executeStep("login", { execute })).rejects.toBeInstanceOf(BrowserEngineFailure);

    expect(execute).not.toHaveBeenCalled();
    await engine.close();
  });
});
