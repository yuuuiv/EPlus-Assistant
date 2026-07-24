import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const webContents = {
  on: vi.fn(),
  once: vi.fn(),
  setWindowOpenHandler: vi.fn(),
  getURL: vi.fn(() => "file:///app/index.html"),
  openDevTools: vi.fn()
};
const browserWindowOptions: Array<Record<string, unknown>> = [];

vi.mock("electron", () => ({
  app: { whenReady: () => new Promise<void>(() => undefined), on: vi.fn(), isPackaged: true, quit: vi.fn(), getAppPath: () => process.cwd(), getPath: () => process.cwd() },
  BrowserWindow: Object.assign(function MockBrowserWindow(options: Record<string, unknown>) {
    browserWindowOptions.push(options);
    return { webContents, loadURL: vi.fn(), loadFile: vi.fn() };
  }, { getAllWindows: vi.fn(() => []) }),
  session: { defaultSession: { webRequest: { onHeadersReceived: vi.fn() } } }
}));

import { contentSecurityPolicy, createWindow, isTrustedNavigation, sanitizeRuntimeDetail } from "./main.js";

describe("Electron Security", () => {
  it("creates a BrowserWindow with renderer isolation and sandboxing", () => {
    createWindow();

    const options = browserWindowOptions.at(-1);
    expect(options).toBeDefined();
    expect(options?.webPreferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true });
  });

  it("blocks remote navigation while allowing local resources and eplus", () => {
    expect(isTrustedNavigation("file:///app/index.html")).toBe(true);
    expect(isTrustedNavigation("http://127.0.0.1:5173")).toBe(true);
    expect(isTrustedNavigation("https://eplus.jp/event/123")).toBe(true);
    expect(isTrustedNavigation("https://evil.example/phishing")).toBe(false);

    createWindow();
    const navigationHandler = webContents.on.mock.calls.find(([event]) => event === "will-navigate")?.[1] as ((event: { preventDefault(): void }, url: string) => void) | undefined;
    if (!navigationHandler) throw new Error("Expected navigation handler.");
    const preventDefault = vi.fn();
    navigationHandler({ preventDefault }, "https://evil.example/phishing");
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(webContents.setWindowOpenHandler).toHaveBeenCalledWith(expect.any(Function));
  });

  it("defines a restrictive CSP in both the document and response policy", async () => {
    const indexHtml = await readFile(path.join(process.cwd(), "index.html"), "utf8");
    expect(indexHtml).toContain("http-equiv=\"Content-Security-Policy\"");
    expect(indexHtml).toContain("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;");
    expect(contentSecurityPolicy).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:");
  });

  it("redacts secret-like runtime details before persistence", () => {
    expect(sanitizeRuntimeDetail("token=top-secret\n\"password\": \"abc123\"")).toBe("token=[redacted] password=[redacted]");
  });

  it("keeps the preload bridge invoke-only and excludes renderer log injection", async () => {
    const preload = await readFile(path.join(process.cwd(), "src", "main", "preload.ts"), "utf8");
    expect(preload).toContain("contextBridge.exposeInMainWorld");
    expect(preload).toContain("ipcRenderer.invoke");
    expect(preload).not.toContain("ipcRenderer.on");
    expect(preload).not.toContain("addLog");
  });
});
