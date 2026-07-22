import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { launchPersistentContext } = vi.hoisted(() => ({ launchPersistentContext: vi.fn() }));

vi.mock("playwright-core", async (importOriginal) => ({ ...(await importOriginal<typeof import("playwright-core")>()), chromium: { launchPersistentContext } }));

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

  it("applies the complete desktop descriptor by default", async () => {
    const { engine } = await engineFixture();
    await engine.startSession("account-1", { taskId: "task-1", runId: "run-1" });
    expect(launchPersistentContext).toHaveBeenCalledWith(expect.stringContaining("desktop-chrome"), expect.objectContaining({ viewport: { width: 1280, height: 720 }, screen: { width: 1920, height: 1080 }, isMobile: false, hasTouch: false }));
    await engine.close();
  });

  it("applies a selected mobile descriptor without mutating it after creation", async () => {
    const { engine } = await engineFixture();
    await engine.startSession("account-1", { taskId: "task-1", runId: "run-1", deviceProfileKey: "iphone-13" });
    const options = launchPersistentContext.mock.calls[0][1] as { readonly viewport: { readonly width: number; readonly height: number } };
    expect(options.viewport).toEqual({ width: 390, height: 664 });
    expect(() => Object.defineProperty(options.viewport, "width", { value: 1 })).toThrow();
    await engine.close();
  });

  it("sizes the headed OS window to match the emulated device instead of a default desktop window", async () => {
    const { engine } = await engineFixture();
    await engine.startSession("account-1", { taskId: "task-1", runId: "run-1", deviceProfileKey: "iphone-13" });
    const options = launchPersistentContext.mock.calls[0][1] as { readonly args?: readonly string[] };
    expect(options.args).toEqual(["--window-size=390,844"]);
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
      { getSetting: () => ({ controller: "clash", host: "127.0.0.1", port: 9090, proxyGroup: "Auto", requiredCountry: "Japan", policy: "JP-only", secretConfigured: true }) }
    );
    const engine = new BrowserSessionEngine(config, artifacts, network);

    await expect(engine.startNetworkSession({ accountId: "account-1", runId: "run-1", contextId: "context-1" })).resolves.toBe(false);

    expect(launchPersistentContext).not.toHaveBeenCalled();
    expect(engine.isSessionActive()).toBe(false);
  });

  it("does not carry a stale quarantine flag into the next session after a lease failure that never opened a context", async () => {
    const { config, artifacts } = await engineFixture();
    let leaseAttempt = 0;
    const network = new NetworkService(
      {
        rotate: vi.fn().mockResolvedValue(undefined),
        detectIp: vi.fn(async () => { leaseAttempt += 1; return leaseAttempt === 1 ? { ip: "1.2.3.4", country: "United States", region: "NY" } : { ip: "5.6.7.8", country: "Japan", region: "Tokyo" }; })
      },
      { getSetting: () => ({ controller: "clash", host: "127.0.0.1", port: 9090, proxyGroup: "Auto", requiredCountry: "Japan", policy: "JP-only", secretConfigured: true }) }
    );
    const engine = new BrowserSessionEngine(config, artifacts, network);

    // First attempt: network lease is rejected (wrong country) before any browser opens.
    await expect(engine.startNetworkSession({ accountId: "account-1", runId: "run-1", contextId: "context-1" })).resolves.toBe(false);
    expect(engine.isSessionActive()).toBe(false);

    // Second attempt (e.g. a profile refresh retried after fixing network settings): the lease
    // now succeeds and a fresh browser opens. It must not immediately trip over a leftover
    // quarantine flag from the earlier, context-less failure.
    await engine.startSession("account-1", { taskId: "task-1", runId: "run-1" });
    await expect(engine.navigate("https://eplus.jp/mypage")).resolves.toBe("https://eplus.jp/mypage");
    await engine.close();
  });

  it("fences startup before page ownership and closes a raced context", async () => {
    const { config, artifacts } = await engineFixture();
    const network = new NetworkService({ rotate: vi.fn().mockResolvedValue(undefined), detectIp: vi.fn().mockResolvedValue({ ip: "1.2.3.4", country: "Japan", region: "Tokyo" }) }, { getSetting: () => ({ controller: "clash", host: "127.0.0.1", port: 9090, proxyGroup: "Auto", requiredCountry: "Japan", policy: "JP-only", secretConfigured: true }) });
    const engine = new BrowserSessionEngine(config, artifacts, network);
    let calls = 0;
    const launchGuard = vi.fn(() => { calls += 1; if (calls === 3) throw new Error("fenced"); });
    await expect(engine.startNetworkSession({ accountId: "account-1", runId: "run-1", contextId: "context-1", launchGuard })).rejects.toThrow("fenced");
    expect(launchGuard).toHaveBeenCalledTimes(3);
    expect(engine.isSessionActive()).toBe(false);
  });
  it("passes deviceProfileKey through startNetworkSession to launchPersistentContext", async () => {
    const { config, artifacts } = await engineFixture();
    const network = new NetworkService(
      { rotate: vi.fn().mockResolvedValue(undefined), detectIp: vi.fn().mockResolvedValue({ ip: "1.2.3.4", country: "Japan", region: "Tokyo" }) },
      { getSetting: () => ({ controller: "clash", host: "127.0.0.1", port: 9090, proxyGroup: "Auto", requiredCountry: "Japan", policy: "JP-only", secretConfigured: true }) }
    );
    const engine = new BrowserSessionEngine(config, artifacts, network);

    await engine.startNetworkSession({ accountId: "account-1", runId: "run-1", contextId: "context-1", taskId: "task-1", deviceProfileKey: "pixel-7" });

    expect(launchPersistentContext).toHaveBeenCalledWith(expect.stringContaining("pixel-7"), expect.objectContaining({ viewport: { width: 412, height: 839 }, isMobile: true, hasTouch: true }));
    await engine.close();
  });

  it("defaults to desktop-chrome when deviceProfileKey is omitted from startNetworkSession", async () => {
    const { config, artifacts } = await engineFixture();
    const network = new NetworkService(
      { rotate: vi.fn().mockResolvedValue(undefined), detectIp: vi.fn().mockResolvedValue({ ip: "1.2.3.4", country: "Japan", region: "Tokyo" }) },
      { getSetting: () => ({ controller: "clash", host: "127.0.0.1", port: 9090, proxyGroup: "Auto", requiredCountry: "Japan", policy: "JP-only", secretConfigured: true }) }
    );
    const engine = new BrowserSessionEngine(config, artifacts, network);

    await engine.startNetworkSession({ accountId: "account-1", runId: "run-1", contextId: "context-1" });

    expect(launchPersistentContext).toHaveBeenCalledWith(expect.stringContaining("desktop-chrome"), expect.objectContaining({ viewport: { width: 1280, height: 720 }, isMobile: false, hasTouch: false }));
    await engine.close();
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

  it("inspects the active top-level page without performing a browser action", async () => {
    const { engine, page } = await engineFixture(pageFixture("<form><p>お支払い方法</p><input type='radio' value='payment-convenience'></form>", "https://eplus.jp/apply"));
    await engine.startSession("account-1");

    const result = await engine.inspectPage({ inspect: async (activePage) => activePage.content() });

    expect(result).toContain("payment-convenience");
    expect(page.locator).not.toHaveBeenCalled();
    expect(engine.getCheckpoint()).toBeUndefined();
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
