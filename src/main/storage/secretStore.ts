import { safeStorage } from "electron";

export class SecretStore {
  encryptString(plainText: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS encryption is unavailable. Unlock the current Windows user session and restart.");
    }
    return safeStorage.encryptString(plainText).toString("base64");
  }

  decryptString(cipherText: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("OS encryption is unavailable. Unlock the current Windows user session and restart.");
    }
    return safeStorage.decryptString(Buffer.from(cipherText, "base64"));
  }

  encryptJson(value: unknown): string {
    return this.encryptString(JSON.stringify(value));
  }

  decryptJson<T>(cipherText: string): T {
    return JSON.parse(this.decryptString(cipherText)) as T;
  }
}
