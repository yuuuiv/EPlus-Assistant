import { describe, expect, it } from "vitest";
import type { PaymentOptionGroup, SelectorEvidence } from "../../shared/types.js";
import { DecisionTemplateStore, type SettingsStore } from "./decisionTemplateStore.js";

function evidence(): SelectorEvidence {
  return { scope: "document", tag: "input", groupOrdinal: 0, optionOrdinal: 0, allowedAttributes: { dataPaymentGroup: "group" }, contextGeneration: "live" };
}

function group(groupKey: string, domValue: string, options: { enabled?: boolean; ambiguous?: boolean }[] = [{}]): PaymentOptionGroup {
  return {
    groupKey,
    groupOrder: 0,
    controlType: "input",
    selectorEvidence: evidence(),
    options: options.map((option, index) => ({
      candidateId: `${groupKey}:${domValue}:${index}`,
      groupKey,
      groupOrder: 0,
      optionOrder: index,
      controlType: "input",
      domValue: index === 0 ? domValue : `${domValue}-alt-${index}`,
      label: index === 0 ? domValue : `${domValue}-alt-${index}`,
      enabled: option.enabled ?? true,
      supported: true,
      ambiguous: option.ambiguous ?? false,
      selectorEvidence: evidence()
    }))
  };
}

function memoryStore(): SettingsStore {
  const values = new Map<string, unknown>();
  return {
    getSetting: <T>(key: string) => values.get(key) as T | undefined,
    setSetting: (key: string, value: unknown) => { values.set(key, value); }
  };
}

describe("DecisionTemplateStore", () => {
  it("returns undefined when no template has been saved yet", () => {
    const store = new DecisionTemplateStore(memoryStore());

    expect(store.match("task-1", "day1", [group("payment", "convenience")])).toBeUndefined();
  });

  it("matches a saved payment-style selection by (groupKey, domValue) and returns the fresh candidateId", () => {
    const store = new DecisionTemplateStore(memoryStore());
    store.save("task-1", "day1", [{ groupKey: "payment", domValue: "convenience", label: "convenience" }]);

    const matched = store.match("task-1", "day1", [group("payment", "convenience")]);

    expect(matched).toEqual(["payment:convenience:0"]);
  });

  it("matches multiple selectable groups (e.g. ticket type and payment) at once, generalizing beyond payment", () => {
    const store = new DecisionTemplateStore(memoryStore());
    store.save("task-1", "day1", [
      { groupKey: "ticket", domValue: "electronic", label: "electronic" },
      { groupKey: "payment", domValue: "convenience", label: "convenience" }
    ]);

    const matched = store.match("task-1", "day1", [group("ticket", "electronic"), group("payment", "convenience")]);

    expect(matched).toEqual(["ticket:electronic:0", "payment:convenience:0"]);
  });

  it("falls back to undefined when a selectable group has no saved template entry", () => {
    const store = new DecisionTemplateStore(memoryStore());
    store.save("task-1", "day1", [{ groupKey: "payment", domValue: "convenience", label: "convenience" }]);

    const matched = store.match("task-1", "day1", [group("payment", "convenience"), group("ticket", "electronic")]);

    expect(matched).toBeUndefined();
  });

  it("falls back to undefined when the saved domValue is no longer present, disabled, or ambiguous", () => {
    const store = new DecisionTemplateStore(memoryStore());
    store.save("task-1", "day1", [{ groupKey: "payment", domValue: "convenience", label: "convenience" }]);

    expect(store.match("task-1", "day1", [group("payment", "card")])).toBeUndefined();
    expect(store.match("task-1", "day1", [group("payment", "convenience", [{ enabled: false }])])).toBeUndefined();
    expect(store.match("task-1", "day1", [group("payment", "convenience", [{ ambiguous: true }])])).toBeUndefined();
  });

  it("ignores fully-disabled groups that have no selectable option at all", () => {
    const store = new DecisionTemplateStore(memoryStore());
    store.save("task-1", "day1", [{ groupKey: "payment", domValue: "convenience", label: "convenience" }]);

    const matched = store.match("task-1", "day1", [group("payment", "convenience"), group("delivery", "unused", [{ enabled: false }])]);

    expect(matched).toEqual(["payment:convenience:0"]);
  });

  it("keeps templates independent per task and per template key (day/entry)", () => {
    const store = new DecisionTemplateStore(memoryStore());
    store.save("task-1", "day1", [{ groupKey: "payment", domValue: "convenience", label: "convenience" }]);
    store.save("task-1", "day2", [{ groupKey: "payment", domValue: "card", label: "card" }]);

    expect(store.match("task-1", "day1", [group("payment", "convenience")])).toEqual(["payment:convenience:0"]);
    expect(store.match("task-1", "day2", [group("payment", "convenience")])).toBeUndefined();
    expect(store.match("task-2", "day1", [group("payment", "convenience")])).toBeUndefined();
  });
});
