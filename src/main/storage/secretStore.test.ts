import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretStore } from "./secretStore.js";

const mocks = vi.hoisted(() => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(value)),
    decryptString: vi.fn((value: Buffer) => value.toString())
  }
}));

vi.mock("electron", () => ({ safeStorage: mocks.safeStorage }));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.safeStorage.isEncryptionAvailable.mockReturnValue(true);
});

describe("SecretStore reveal sessions", () => {
  it("consumes an encrypted password once for the originating window", () => {
    const store = new SecretStore();
    const session = store.createRevealSession("account", store.encryptString("never-log-this"), "window-a");

    expect(store.consumeRevealSession(session.requestId, "window-a")).toEqual({ plaintext: "never-log-this" });
    expect(store.consumeRevealSession(session.requestId, "window-a")).toBeNull();
  });

  it("rejects requests from another window", () => {
    const store = new SecretStore();
    const session = store.createRevealSession("account", store.encryptString("never-log-this"), "window-a");

    expect(store.consumeRevealSession(session.requestId, "window-b")).toBeNull();
  });

  it("expires sessions after five seconds", () => {
    vi.useFakeTimers();
    const store = new SecretStore();
    const session = store.createRevealSession("account", store.encryptString("never-log-this"), "window-a");
    vi.advanceTimersByTime(5_001);

    expect(store.consumeRevealSession(session.requestId, "window-a")).toBeNull();
  });
});
