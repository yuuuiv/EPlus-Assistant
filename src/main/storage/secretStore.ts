import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";

const REVEAL_SESSION_DURATION_MS = 5_000;

export interface RevealSession {
  readonly id: string;
  readonly accountId: string;
  readonly requestId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

interface ActiveRevealSession extends RevealSession {
  readonly encryptedPassword: string;
  readonly senderWindowId: string;
  consumed: boolean;
}

export class SecretStore {
  private readonly revealSessions = new Map<string, ActiveRevealSession>();
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

  createRevealSession(accountId: string, encryptedPassword: string, senderWindowId: string): RevealSession {
    this.invalidateExpiredSessions();
    const createdAt = new Date();
    const session: ActiveRevealSession = {
      id: randomUUID(),
      accountId,
      requestId: randomUUID(),
      senderWindowId,
      encryptedPassword,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + REVEAL_SESSION_DURATION_MS).toISOString(),
      consumed: false
    };
    this.revealSessions.set(session.requestId, session);
    return toRevealSession(session);
  }

  consumeRevealSession(requestId: string, senderWindowId: string): { plaintext: string } | null {
    this.invalidateExpiredSessions();
    const session = this.revealSessions.get(requestId);
    if (!session || session.senderWindowId !== senderWindowId || session.consumed) {
      return null;
    }
    session.consumed = true;
    return { plaintext: this.decryptString(session.encryptedPassword) };
  }

  invalidateExpiredSessions(): void {
    const now = Date.now();
    for (const [requestId, session] of this.revealSessions) {
      if (Date.parse(session.expiresAt) <= now) {
        this.revealSessions.delete(requestId);
      }
    }
  }
}

function toRevealSession(session: ActiveRevealSession): RevealSession {
  return {
    id: session.id,
    accountId: session.accountId,
    requestId: session.requestId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt
  };
}
