import { describe, expect, it, vi } from "vitest";
import { assertTaskPaymentBoundary, TaskService, validateConfirmationPolicy, validateDeviceProfileKey, validateTaskInput } from "./taskService.js";
import type { AppDatabase } from "../storage/database.js";
import type { CreateTaskInput, EventSnapshot } from "../../shared/types.js";
import { PaymentValidationError } from "../../shared/types.js";

const event: EventSnapshot = {
  id: "event", sourceUrl: "https://eplus.jp/source", canonicalUrl: "https://eplus.jp/event", title: "Event", fetchedAt: "2026-07-21T00:00:00.000Z", pageFingerprint: "fingerprint",
  rawFormSchema: { sourceKind: "serial-code", options: [{ id: "ticket", label: "Ticket", kind: "ticket", required: true, values: [{ id: "ticket-a", label: "A" }] }, { id: "payment", label: "Payment", kind: "payment", required: true, values: [{ id: "store", label: "Store" }] }], applicationLinks: [], serialCode: { required: true, label: "Code", errorSelectors: [], knownErrorMessages: [], availableDays: ["day1", "day2"], daySelectionRequired: true }, selectorHints: {}, requiresManualInspection: false, notes: [] }
};

const input: CreateTaskInput = { eventSnapshotId: event.id, accountIds: ["account"], preference: { entries: [{ rank: 1, ticketTypeId: "ticket-a", quantity: 1 }], paymentMethodId: "store", serialCode: "code", consentFlags: {}, daySelectionByAccountId: { account: ["day1"] } } };

describe("TaskService validation", () => {
  it("rejects missing or unsupported day selections", () => {
    expect(validateTaskInput({ ...input, preference: { ...input.preference, daySelectionByAccountId: { account: ["day2", "day1"] } } }, event)).toEqual([]);
    expect(validateTaskInput({ ...input, preference: { ...input.preference, daySelectionByAccountId: {} } }, event)).toContain("A supported day selection is required for account account.");
    expect(validateTaskInput({ ...input, preference: { ...input.preference, daySelectionByAccountId: { account: ["day1", "day3" as "day1"] } } }, event)).toContain("A supported day selection is required for account account.");
  });

  it("rejects missing serial codes", () => {
    expect(validateTaskInput({ ...input, preference: { ...input.preference, serialCode: "" } }, event)).toContain("A serial code is required for every selected account.");
  });

  it("requires an automation risk acknowledgement for both confirmation policies", () => {
    expect(validateConfirmationPolicy("required", undefined)).toBe(false);
    expect(validateConfirmationPolicy("disabled", undefined)).toBe(false);
    expect(validateConfirmationPolicy("disabled", { version: 1, acknowledgedAt: "2026-07-21T00:00:00.000Z", disclosureDigest: "digest" })).toBe(true);
  });

  it("permits without paymentMethodId and validates semantic preferences without guessing DOM values", () => {
    expect(validateTaskInput({ ...input, preference: { ...input.preference, paymentMethodId: undefined } }, event)).toEqual([]);
    expect(validateTaskInput({ ...input, preference: { ...input.preference, paymentMethodId: undefined, paymentPreference: { groupKey: "payment", value: "store" } } }, event)).toEqual([]);
    expect(() => validateTaskInput({ ...input, preference: { ...input.preference, paymentPreference: { groupKey: "payment", value: "card-number" } } }, event)).toThrow(PaymentValidationError);
    expect(() => assertTaskPaymentBoundary({ ...input, preference: { ...input.preference, paymentMethodId: "4111111111111111" } })).toThrow("Payment credential fields");
  });

  it("rejects disabled, unavailable, and conflicting payment preferences", () => {
    const disabledEvent = { ...event, rawFormSchema: { ...event.rawFormSchema, options: event.rawFormSchema.options.map((option) => option.kind === "payment" ? { ...option, values: [{ id: "store", label: "Store", disabled: true }] } : option) } };
    expect(() => validateTaskInput({ ...input, preference: { ...input.preference, paymentMethodId: undefined, paymentPreference: { groupKey: "payment", value: "store" } } }, disabledEvent)).toThrow("unavailable or disabled");
    expect(() => validateTaskInput({ ...input, preference: { ...input.preference, paymentMethodId: undefined, paymentPreference: { groupKey: "payment", value: "missing" } } }, event)).toThrow("unavailable or disabled");
    expect(() => validateTaskInput({ ...input, preference: { ...input.preference, paymentMethodId: "legacy-store", paymentPreference: { groupKey: "payment", value: "store" } } }, event)).toThrow("Legacy and semantic payment preferences conflict.");
  });

  it("rejects invalid device profiles with a typed error", () => {
    expect(validateDeviceProfileKey(undefined)).toBe("desktop-chrome");
    expect(() => validateDeviceProfileKey("custom" as never)).toThrow(PaymentValidationError);
    expect(() => validateDeviceProfileKey("custom" as never)).toThrow("Device profile is not approved");
  });

  it("creates a task without payment DOM data and persists Pending plus Idle runs", () => {
    const createTask = vi.fn();
    const service = new TaskService({ createTask, listAccounts: () => [{ id: "account" }], listTasks: () => [], listRuns: () => [], updateTaskStatus: vi.fn(), updateRun: vi.fn() } as unknown as AppDatabase);
    const { taskId } = service.createTask({ ...input, preference: { ...input.preference, paymentMethodId: undefined, paymentPreference: { groupKey: "payment", value: "store" } }, canonicalUrl: event.canonicalUrl });
    expect(taskId).toEqual(expect.any(String));
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ deviceProfileKey: "desktop-chrome", preference: expect.objectContaining({ paymentPreference: { groupKey: "payment", value: "store" } }) }));
  });
});
