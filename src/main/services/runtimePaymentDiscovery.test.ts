import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverRuntimePaymentOptions } from "./runtimePaymentDiscovery.js";

describe("runtime payment discovery", () => {
  it("discovers ordered delivery and payment groups with exact DOM values and closed evidence", async () => {
    const discovery = discoverRuntimePaymentOptions(await fixture("payment-delivery-and-methods.html"));

    expect(discovery).toMatchObject({ status: "ready" });
    expect(discovery.groups.map((group) => [group.groupKey, group.groupOrder, group.controlType])).toEqual([
      ["delivery", 0, "input"],
      ["payment", 1, "input"]
    ]);
    expect(discovery.groups.flatMap((group) => group.options.map((option) => option.domValue))).toEqual([
      "delivery-mobile",
      "delivery-paper",
      "payment-card",
      "payment-convenience",
      "payment-card-disabled",
      "payment-wallet"
    ]);
    expect(discovery.groups[1]?.options.map((option) => [option.label, option.enabled, option.supported, option.ambiguous])).toEqual([
      ["Credit card", true, true, false],
      ["Convenience store", true, true, false],
      ["Unavailable card", false, true, false],
      ["Wallet", true, false, false]
    ]);
    expect(discovery.groups[1]?.selectorEvidence).toEqual({
      scope: "document",
      tag: "input",
      groupOrdinal: 1,
      optionOrdinal: 0,
      allowedAttributes: { id: "payment-card", name: "payment", type: "radio", dataPaymentGroup: "payment" },
      contextGeneration: "static-hint"
    });
    expect(discovery.groups[1]?.options[3]?.selectorEvidence).toEqual({
      scope: "document",
      tag: "input",
      groupOrdinal: 1,
      optionOrdinal: 3,
      allowedAttributes: { id: "payment-wallet", name: "payment", type: "radio", dataPaymentGroup: "payment" },
      contextGeneration: "static-hint"
    });
  });

  it("preserves reordered groups instead of inferring a payment position", async () => {
    const discovery = discoverRuntimePaymentOptions(await fixture("payment-reordered-groups.html"));

    expect(discovery.groups.map((group) => group.groupKey)).toEqual(["payment", "delivery"]);
    expect(discovery.groups[0]?.options.map((option) => option.domValue)).toEqual(["payment-card", "payment-convenience"]);
  });

  it("preserves custom labels while classifying support from the exact DOM value", async () => {
    const discovery = discoverRuntimePaymentOptions(await fixture("payment-custom-labels.html"));

    expect(discovery).toMatchObject({ status: "ready" });
    expect(discovery.groups[0]?.options.map((option) => [option.domValue, option.label, option.supported])).toEqual([
      ["payment-card", "Pay with a saved method", true],
      ["payment-convenience", "Pay at a local shop", true]
    ]);
  });

  it("marks a disabled target and unknown label unsupported without fallback selection", async () => {
    const discovery = discoverRuntimePaymentOptions(await fixture("payment-delivery-and-methods.html"));
    const payment = discovery.groups.find((group) => group.groupKey === "payment");

    expect(payment?.options.find((option) => option.domValue === "payment-card-disabled")).toMatchObject({ enabled: false, supported: true });
    expect(payment?.options.find((option) => option.domValue === "payment-wallet")).toMatchObject({ enabled: true, supported: false });
  });

  it("returns manual for duplicate labels rather than guessing a target", async () => {
    const discovery = discoverRuntimePaymentOptions(await fixture("payment-duplicate-labels.html"));

    expect(discovery).toMatchObject({ status: "manual", reason: "ambiguous-control" });
    expect(discovery.groups[0]?.options.every((option) => option.ambiguous && !option.supported)).toBe(true);
  });

  it("returns manual for duplicate values rather than selecting the first option", async () => {
    const discovery = discoverRuntimePaymentOptions(await fixture("payment-duplicate-values.html"));

    expect(discovery).toMatchObject({ status: "manual", reason: "ambiguous-control" });
    expect(discovery.groups[0]?.options.map((option) => option.candidateId)).toEqual(["payment:payment-card:0", "payment:payment-card:1"]);
  });

  it("returns manual when the semantic group has no supported control selector", () => {
    const discovery = discoverRuntimePaymentOptions("<fieldset data-payment-group='payment'><input type='checkbox' value='payment-card'></fieldset>");

    expect(discovery).toEqual({ status: "manual", groups: [], reason: "unsupported-control" });
  });

  it("returns explicit unavailable and delayed discovery gaps", async () => {
    const unavailable = discoverRuntimePaymentOptions(await fixture("no-payment-control.html"));
    const delayed = discoverRuntimePaymentOptions(await fixture("payment-delayed-controls.html"));

    expect(unavailable).toEqual({ status: "payment_unavailable", groups: [] });
    expect(delayed).toEqual({ status: "payment_delayed", groups: [] });
  });
});

async function fixture(name: string): Promise<string> {
  return readFile(path.resolve("tests/fixtures", name), "utf8");
}
