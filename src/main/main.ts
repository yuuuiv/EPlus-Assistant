import { app, BrowserWindow } from "electron";
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { AppDatabase } from "./storage/database.js";
import { SecretStore } from "./storage/secretStore.js";
import { registerIpc } from "./ipc.js";
type ElectronBrowserWindow = InstanceType<typeof BrowserWindow>;

let mainWindow: ElectronBrowserWindow | undefined;
let servicesPromise: Promise<{ db: AppDatabase; secretStore: SecretStore }> | undefined;
let ipcRegistered = false;

function writeRuntimeLog(message: string): void {
  try {
    const dataDir = path.join(process.cwd(), "data");
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    appendFileSync(path.join(dataDir, "runtime.log"), `[${new Date().toISOString()}] ${message}\n`);
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
        <pre style="white-space:pre-wrap;color:#f0a445;line-height:1.5;">${detail.replace(/[<>&]/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[char]!)}</pre>
        <p style="color:#8892a4;">详细日志：data/runtime.log</p>
      </main>
    </body>
  </html>`;
}

function createWindow(): ElectronBrowserWindow {
  const window = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1200,
    minHeight: 780,
    backgroundColor: "#f3efe7",
    webPreferences: {
      preload: path.join(process.cwd(), "dist-electron", "main", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    writeRuntimeLog(`renderer console level=${level} ${sourceId}:${line} ${message}`);
  });
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    const detail = `URL: ${validatedUrl}\n错误码: ${errorCode}\n错误: ${errorDescription}`;
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
    const detail = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    writeRuntimeLog(`bootstrap failed ${detail}`);
    const window = mainWindow ?? createWindow();
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(errorHtml("应用启动失败", detail))}`);
  }
}

app.whenReady().then(() => {
  void bootstrap();
});

process.on("uncaughtException", (error) => {
  writeRuntimeLog(`uncaughtException ${error.stack ?? error.message}`);
});

process.on("unhandledRejection", (reason) => {
  writeRuntimeLog(`unhandledRejection ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
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
