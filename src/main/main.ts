import { app, BrowserWindow } from "electron";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { AppDatabase } from "./storage/database.js";
import { SecretStore } from "./storage/secretStore.js";
import { registerIpc } from "./ipc.js";
type ElectronBrowserWindow = InstanceType<typeof BrowserWindow>;

let mainWindow: ElectronBrowserWindow | undefined;
let servicesPromise: Promise<{ db: AppDatabase; secretStore: SecretStore }> | undefined;
let ipcRegistered = false;

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
  const { db, secretStore } = await getServices();
  const window = createWindow();
  if (!ipcRegistered) {
    registerIpc(window, db, secretStore);
    ipcRegistered = true;
  }
  await loadRenderer(window);
}

app.whenReady().then(() => {
  void bootstrap();
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
