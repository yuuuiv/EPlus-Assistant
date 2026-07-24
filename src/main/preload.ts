import { contextBridge, ipcRenderer } from "electron";
import type { ElectronApi } from "../shared/ipc.js";

const api: ElectronApi = {
  getState: () => ipcRenderer.invoke("app:get-state"),
  importHarvest: (input) => ipcRenderer.invoke("account:import-harvest", input),
  deleteAccount: (id) => ipcRenderer.invoke("account:delete", id),
  setAccountPassword: (input) => ipcRenderer.invoke("account:set-password", input),
  revealPassword: (accountId) => ipcRenderer.invoke("account:reveal-password", accountId),
  listProfiles: (accountId) => ipcRenderer.invoke("profile:get", accountId),
  listLotteryRecords: (accountId) => ipcRenderer.invoke("profile:list-lottery-records", accountId),
  getAccountsOverview: () => ipcRenderer.invoke("stats:get-overview"),
  openDataFolder: () => ipcRenderer.invoke("app:open-data-folder"),
  saveExport: (input) => ipcRenderer.invoke("app:save-export", input),
  showInFolder: (filePath) => ipcRenderer.invoke("app:show-in-folder", filePath)
};

contextBridge.exposeInMainWorld("eplusApi", api);
