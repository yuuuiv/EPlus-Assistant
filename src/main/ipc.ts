import path from "node:path";
import { writeFile } from "node:fs/promises";
import { dialog, shell, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import type { AppDatabase } from "./storage/database.js";
import type { SecretStore } from "./storage/secretStore.js";
import { AccountService } from "./services/accountService.js";

const idSchema = z.string().trim().min(1).max(128);
const emptySchema = z.undefined();

const creditCardSchema = z
  .object({
    creditCardId: z.string().optional(),
    brand: z.string().optional(),
    last4: z.string(),
    holder: z.string().optional(),
    expireMonth: z.string().optional(),
    expireYear: z.string().optional(),
    updatedAt: z.string().optional()
  })
  .strict();

const companionSchema = z
  .object({
    companionId: z.string().optional(),
    name: z.string(),
    relationship: z.string().optional(),
    memberId: z.string().optional(),
    maskedEmail: z.string().optional(),
    boundAt: z.string().optional(),
    approvedAt: z.string().optional(),
    unboundAt: z.string().optional()
  })
  .strict();

const lotteryRecordSchema = z
  .object({
    orderId: z.string().min(1),
    tourName: z.string().min(1),
    eventDatetime: z.string().optional(),
    venueName: z.string().optional(),
    receptionName: z.string().optional(),
    orderDatetime: z.string().optional(),
    status: z.string(),
    statusDetail: z.string().optional(),
    detailUrl: z.string().optional()
  })
  .strict();

const setPasswordSchema = z.object({ accountId: idSchema, password: z.string().min(1) }).strict();

const saveExportSchema = z
  .object({
    suggestedFileName: z.string().trim().min(1).max(255),
    data: z.string(),
    encoding: z.enum(["base64", "utf8"]),
    filterName: z.string().trim().min(1).max(100),
    filterExtensions: z.array(z.string().trim().min(1).max(10)).min(1).max(5)
  })
  .strict();

const filePathSchema = z.string().trim().min(1).max(4096);

const importHarvestSchema = z
  .object({
    payload: z
      .object({
        schemaVersion: z.literal(1),
        eplusEmail: z.string().email(),
        collectedAt: z.string(),
        profile: z
          .object({
            phone: z.string().optional(),
            name: z.string().optional(),
            nameKana: z.string().optional(),
            gender: z.string().optional(),
            birthYear: z.string().optional(),
            address: z.string().optional()
          })
          .strict(),
        creditCards: z.array(creditCardSchema),
        companions: z.array(companionSchema),
        lotteryRecords: z.array(lotteryRecordSchema)
      })
      // Not .strict(): the userscript's export also carries a `harvestedPages` progress map
      // (userscript/eplus-collector.user.js) that this app has no use for. Unknown keys are
      // dropped rather than rejected so that field doesn't fail every single import.
  })
  .strict();

type Handler<T> = (value: T) => unknown | Promise<unknown>;

export function validateSender(event: IpcMainInvokeEvent, window: BrowserWindow): void {
  if (!event.senderFrame || event.senderFrame.url !== event.sender.getURL() || event.sender !== window.webContents) {
    throw new Error("Unauthorized IPC sender.");
  }
}

function sanitizedError(error: unknown): Error {
  if (error instanceof z.ZodError) return new Error("Invalid IPC payload.");
  if (error instanceof Error) return new Error(error.message.replace(/[A-Za-z]:\\[^\n ]+|\/[^^\n ]+/g, "[redacted]").slice(0, 500));
  return new Error("Handler failed.");
}

function registerHandler<T>(channel: string, window: BrowserWindow, schema: z.ZodType<T>, handler: Handler<T>): void {
  ipcMain.handle(channel, async (event, payload: unknown) => {
    validateSender(event, window);
    try {
      return await handler(schema.parse(payload));
    } catch (error) {
      throw sanitizedError(error);
    }
  });
}

export function registerIpc(window: BrowserWindow, db: AppDatabase, secretStore: SecretStore): void {
  const accountService = new AccountService(db, secretStore);

  registerHandler("app:get-state", window, emptySchema, () => ({
    accounts: accountService.listAccounts(),
    logs: db.listLogs(),
    dataDir: db.getDataDir()
  }));
  registerHandler("account:import-harvest", window, importHarvestSchema, (input) => accountService.importHarvest(input.payload));
  registerHandler("account:delete", window, idSchema, (id) => accountService.deleteAccount(id));
  registerHandler("account:set-password", window, setPasswordSchema, (input) => accountService.setPassword(input.accountId, input.password));
  ipcMain.handle("account:reveal-password", async (event, payload: unknown) => {
    validateSender(event, window);
    try {
      const id = idSchema.parse(payload);
      return accountService.revealPassword(id, String(event.sender.id));
    } catch (error) {
      throw sanitizedError(error);
    }
  });
  registerHandler("profile:get", window, idSchema, (accountId) => accountService.listProfile(accountId));
  registerHandler("profile:list-lottery-records", window, idSchema, (accountId) => accountService.listLotteryRecords(accountId));
  registerHandler("stats:get-overview", window, emptySchema, () => accountService.getAccountsOverview());
  registerHandler("app:open-data-folder", window, emptySchema, () => shell.openPath(path.resolve(db.getDataDir())));
  registerHandler("app:save-export", window, saveExportSchema, async (input) => {
    const result = await dialog.showSaveDialog(window, {
      defaultPath: input.suggestedFileName,
      filters: [{ name: input.filterName, extensions: input.filterExtensions }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await writeFile(result.filePath, Buffer.from(input.data, input.encoding));
    return { canceled: false, filePath: result.filePath };
  });
  registerHandler("app:show-in-folder", window, filePathSchema, (filePath) => shell.showItemInFolder(filePath));

  window.webContents.once("did-finish-load", () => {
    db.addLog({ level: "info", message: "Renderer loaded.", metadata: {} });
  });
}
