import { contextBridge, ipcRenderer } from "electron";
import type { ElectronApi } from "../shared/ipc.js";

const api: ElectronApi = {
  getState: () => ipcRenderer.invoke("app:get-state"),
  addAccount: (input) => ipcRenderer.invoke("account:add", input),
  importAccounts: (input) => ipcRenderer.invoke("account:import", input),
  importHarvest: (input) => ipcRenderer.invoke("account:import-harvest", input),
  deleteAccount: (id) => ipcRenderer.invoke("account:delete", id),
  revealPassword: (accountId) => ipcRenderer.invoke("account:reveal-password", accountId),
  listProfiles: (accountId) => ipcRenderer.invoke("profile:get", accountId),
  listLotteryRecords: (accountId) => ipcRenderer.invoke("profile:list-lottery-records", accountId),
  getAccountsOverview: () => ipcRenderer.invoke("stats:get-overview"),
  openDataFolder: () => ipcRenderer.invoke("app:open-data-folder")
};

contextBridge.exposeInMainWorld("eplusApi", api);
