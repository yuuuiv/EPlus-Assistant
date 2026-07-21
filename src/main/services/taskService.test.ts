import { describe, expect, it } from "vitest";
import { validateConfirmationPolicy, validateTaskInput } from "./taskService.js";
import type { CreateTaskInput, EventSnapshot } from "../../shared/types.js";

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
});
