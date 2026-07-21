import path from "node:path";
import { shell, ipcMain, type BrowserWindow } from "electron";
import type { AppDatabase } from "./storage/database.js";
import type { SecretStore } from "./storage/secretStore.js";
import { AccountService } from "./services/accountService.js";
import { EventService } from "./services/eventService.js";
import { SettingsService } from "./services/settingsService.js";
import { TaskService } from "./services/taskService.js";
import type { ImportAccountsInput } from "../shared/ipc.js";

export function registerIpc(
  window: BrowserWindow,
  db: AppDatabase,
  secretStore: SecretStore
): void {
  const accountService = new AccountService(db, secretStore);
  const eventService = new EventService(db);
  const settingsService = new SettingsService(db, secretStore);
  const taskService = new TaskService(db);

  ipcMain.handle("app:get-state", () => ({
    accounts: accountService.listAccounts(),
    events: eventService.listEvents(),
    tasks: taskService.listTasks(),
    runs: taskService.listRuns(),
    logs: db.listLogs(),
    verificationMailbox: settingsService.getVerificationMailbox(),
    network: settingsService.getNetworkSettings(),
    dataDir: db.getDataDir()
  }));

  ipcMain.handle("account:add", (_event, input) => accountService.addAccount(input));
  ipcMain.handle("account:import", (_event, input: ImportAccountsInput) =>
    accountService.importAccounts(input.kind, input.text)
  );
  ipcMain.handle("account:delete", (_event, id: string) => accountService.deleteAccount(id));
  ipcMain.handle("event:discover", (_event, input) => eventService.discoverFromUrl(input.sourceUrl));
  ipcMain.handle("event:save", (_event, input) => eventService.saveSnapshot(input));
  ipcMain.handle("task:create", (_event, input) => {
    const event = db.getEvent(input.eventSnapshotId);
    if (!event) {
      throw new Error("Event snapshot not found.");
    }
    if (event.rawFormSchema.serialCode?.required) {
      const commonCode = String(input.preference.serialCode ?? "").trim();
      const perAccountCodes = input.preference.serialCodesByAccountId ?? {};
      const missingAccounts = input.accountIds.filter((accountId: string) => !commonCode && !perAccountCodes[accountId]);
      if (missingAccounts.length > 0) {
        throw new Error("该页面需要抽选码。请填写公共抽选码，或为每个选中账号填写专用抽选码。");
      }
    }
    return taskService.createTask({ ...input, canonicalUrl: event.canonicalUrl });
  });
  ipcMain.handle("task:update-status", (_event, taskId: string, status: string) =>
    taskService.updateTaskStatus(taskId, status as any)
  );
  ipcMain.handle("run:update-status", (_event, runId: string, status: string, note?: string) =>
    taskService.updateRunStatus(runId, status as any, note)
  );
  ipcMain.handle("settings:save-verification-mailbox", (_event, input) =>
    settingsService.saveVerificationMailbox(input)
  );
  ipcMain.handle("settings:test-verification-mailbox", () => settingsService.testVerificationMailbox());
  ipcMain.handle("settings:read-verification-code", (_event, input) =>
    settingsService.readVerificationCode(input)
  );
  ipcMain.handle("settings:get-network", () => settingsService.getNetworkSettings());
  ipcMain.handle("settings:save-network", (_event, input) => settingsService.saveNetworkSettings(input));
  ipcMain.handle("log:add", (_event, message: string, level = "info", metadata = {}) =>
    db.addLog({ message, level, metadata })
  );
  ipcMain.handle("app:open-data-folder", () => shell.openPath(path.resolve(db.getDataDir())));

  window.webContents.once("did-finish-load", () => {
    db.addLog({ level: "info", message: "Renderer loaded.", metadata: {} });
  });
}
