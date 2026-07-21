import { app, BrowserWindow, session } from "electron";
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { AppDatabase } from "./storage/database.js";
import { SecretStore } from "./storage/secretStore.js";
import { registerIpc } from "./ipc.js";
type ElectronBrowserWindow = InstanceType<typeof BrowserWindow>;

let mainWindow: ElectronBrowserWindow | undefined;
let servicesPromise: Promise<{ db: AppDatabase; secretStore: SecretStore }> | undefined;
let ipcRegistered = false;

export const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'";

export function isTrustedNavigation(url: string): boolean {
  try {
    const target = new URL(url);
    return (
      target.protocol === "file:" ||
      target.protocol === "data:" ||
      (target.protocol === "http:" && target.hostname === "127.0.0.1" && target.port === "5173") ||
      (target.protocol === "https:" && (target.hostname === "eplus.jp" || target.hostname.endsWith(".eplus.jp")))
    );
  } catch {
    return false;
  }
}

export function sanitizeRuntimeDetail(value: string): string {
  return value
    .replace(/["']?(password|token|secret|authorization)["']?\s*[:=]\s*["']?[^\s,;}"']+["']?/gi, "$1=[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 1_000);
}

function writeRuntimeLog(message: string): void {
  try {
    const dataDir = path.join(process.cwd(), "data");
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    appendFileSync(path.join(dataDir, "runtime.log"), `[${new Date().toISOString()}] ${sanitizeRuntimeDetail(message)}\n`);
  } catch {
    // Last-resort diagnostics should never crash the app.
  }
}

function errorHtml(title: string, detail: string): string {
  return `<!doctype html>
  <html lang="zh-CN">
    <meta charset="utf-8">
    <title>${title}</title>
    <body style="margin:0;background:#0c0f18;color:#e2e8f0;font-family:Segoe UI,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;">
      <main style="max-width:760px;padding:28px;border:1px solid rgba(255,255,255,.14);border-radius:14px;background:rgba(255,255,255,.05);">
        <h1 style="margin:0 0 10px;font-size:22px;">${title}</h1>
        <pre style="white-space:pre-wrap;color:#f0a445;line-height:1.5;">${detail.replace(/[<>&]/g, (char) => {
          if (char === "<") return "&lt;";
          if (char === ">") return "&gt;";
          return "&amp;";
        })}</pre>
        <p style="color:#8892a4;">详细日志：data/runtime.log</p>
      </main>
    </body>
  </html>`;
}

export function createWindow(): ElectronBrowserWindow {
  const window = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1200,
    minHeight: 780,
    backgroundColor: "#f3efe7",
    webPreferences: {
      preload: path.join(process.cwd(), "dist-electron", "main", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      experimentalFeatures: false
    }
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedNavigation(url)) {
      event.preventDefault();
      writeRuntimeLog(`blocked navigation url=${url}`);
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    writeRuntimeLog(`blocked popup url=${url}`);
    return { action: "deny" };
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    writeRuntimeLog(`renderer console level=${level} ${sourceId}:${line} ${message}`);
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    const detail = sanitizeRuntimeDetail(`URL: ${validatedUrl}\n错误码: ${errorCode}\n错误: ${errorDescription}`);
    writeRuntimeLog(`did-fail-load ${detail}`);
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml("页面加载失败", detail))}`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    writeRuntimeLog(`render-process-gone ${JSON.stringify(details)}`);
  });
  mainWindow = window;
  return window;
}

async function loadRenderer(window: ElectronBrowserWindow): Promise<void> {
  const loadBuiltRenderer = process.env.EPLUS_ASSISTANT_LOAD_DIST === "1";
  if (!app.isPackaged && !loadBuiltRenderer) {
    await window.loadURL("http://127.0.0.1:5173");
    window.webContents.openDevTools({ mode: "detach" });
    return;
  }
  await window.loadFile(path.join(process.cwd(), "dist", "index.html"));
}

async function getServices(): Promise<{ db: AppDatabase; secretStore: SecretStore }> {
  if (servicesPromise) {
    return servicesPromise;
  }
  servicesPromise = (async () => {
    const dataDir = path.join(process.cwd(), "data");
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    const db = new AppDatabase(dataDir);
    await db.open();
    return { db, secretStore: new SecretStore() };
  })();
  return servicesPromise;
}

async function bootstrap(): Promise<void> {
  try {
    const { db, secretStore } = await getServices();
    const window = createWindow();
    if (!ipcRegistered) {
      registerIpc(window, db, secretStore);
      ipcRegistered = true;
    }
    await loadRenderer(window);
  } catch (error) {
    const detail = sanitizeRuntimeDetail(error instanceof Error ? error.message : "Unexpected startup error.");
    writeRuntimeLog(`bootstrap failed ${detail}`);
    const window = mainWindow ?? createWindow();
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml("应用启动失败", detail))}`);
  }
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [contentSecurityPolicy]
      }
    });
  });
  void bootstrap();
});

process.on("uncaughtException", (error) => {
  writeRuntimeLog(`uncaughtException ${error.message}`);
});

process.on("unhandledRejection", (reason) => {
  writeRuntimeLog(`unhandledRejection ${reason instanceof Error ? reason.message : String(reason)}`);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void bootstrap();
  }
});
