import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PaymentOptionGroup } from "../../shared/types.js";
import { EplusBrowserAdapter, parseOptions } from "./eplusAdapter.js";
import { BrowserSessionEngine } from "../engines/browserSessionEngine.js";

function engineFixture(state: "Login" | "SerialCode" | "LotteryForm" | "Receipt" | "InterstitialConsent" | "CheckboxGate" = "Login") {
  const engine = Object.create(BrowserSessionEngine.prototype) as BrowserSessionEngine;
  vi.spyOn(engine, "evaluateState").mockResolvedValue({ state, confidence: 1, reason: "fixture", safeActionHints: [], requiresManualTakeover: false });
  vi.spyOn(engine, "executeStep").mockResolvedValue({ beforeState: state, action: "fixture", afterState: state });
  vi.spyOn(engine, "getCurrentHtml").mockResolvedValue("<select><option value='ticket-a'>Ticket A</option></select>");
  vi.spyOn(engine, "getCurrentUrl").mockReturnValue("https://eplus.jp/apply");
  vi.spyOn(engine, "navigate").mockResolvedValue("https://eplus.jp/apply");
  vi.spyOn(engine, "inspectPage").mockResolvedValue({ groups: [paymentGroup()], unsafePaymentFields: false });
  return engine;
}

describe("EplusBrowserAdapter", () => {
  it("extracts electronic convenience payment candidates with exact group evidence while leaving delivery unknown", async () => {
    const groups = parseOptions(await fixture("payment-delivery-and-methods.html"));
    const payment = groups.find((group) => group.kind === "payment");
    const delivery = groups.find((group) => group.label === "delivery");

    expect(payment?.runtimeGroup?.options.map((option) => [option.candidateId, option.domValue, option.enabled, option.supported])).toEqual([
      ["payment:payment-card", "payment-card", true, true],
      ["payment:payment-convenience", "payment-convenience", true, true],
      ["payment:payment-card-disabled", "payment-card-disabled", false, true],
      ["payment:payment-wallet", "payment-wallet", true, true]
    ]);
    expect(delivery).toMatchObject({ kind: "unknown" });
    expect(delivery?.runtimeGroup).toBeUndefined();
  });

  it("returns every declared runtime option group, not just payment", async () => {
    const engine = engineFixture("LotteryForm");
    const adapter = new EplusBrowserAdapter(engine);
    vi.spyOn(engine, "inspectPage").mockResolvedValue({ groups: [deliveryGroup(), paymentGroup()], unsafePaymentFields: false });

    await expect(adapter.discoverPaymentOptions()).resolves.toEqual({ status: "ready", groups: [deliveryGroup(), paymentGroup()] });
  });

  it("selects electronic then convenience candidates in declared group order using exact values", async () => {
    const engine = engineFixture("LotteryForm");
    const adapter = new EplusBrowserAdapter(engine);
    vi.spyOn(engine, "inspectPage").mockResolvedValue({ groups: [deliveryGroup(), paymentGroup()], unsafePaymentFields: false });
    const selected: string[] = [];
    const page = selectionPage(selected);
    vi.spyOn(engine, "executeStep").mockImplementation(async (_action, step) => {
      if (!step) throw new Error("Expected browser step.");
      await step.execute(page as never);
      return { beforeState: "LotteryForm", action: "fixture", afterState: "LotteryForm" };
    });

    await adapter.applyPreference([{ groupKey: "delivery", candidateId: "delivery:delivery-mobile", domValue: "delivery-mobile" }, { groupKey: "payment", candidateId: "payment:payment-convenience", domValue: "payment-convenience" }]);

    expect(selected).toEqual(["delivery-mobile", "payment-convenience"]);
    expect(page.locator).toHaveBeenCalledWith("[data-payment-group]");
  });

  it("selects an exact candidate ID without accepting a caller supplied DOM value", async () => {
    const engine = engineFixture("LotteryForm");
    const adapter = new EplusBrowserAdapter(engine);
    vi.spyOn(engine, "inspectPage").mockResolvedValue({ groups: [paymentGroup()], unsafePaymentFields: false });
    const selected: string[] = [];
    const page = selectionPage(selected);
    vi.spyOn(engine, "executeStep").mockImplementation(async (_action, step) => {
      if (!step) throw new Error("Expected browser step.");
      await step.execute(page as never);
      return { beforeState: "LotteryForm", action: "fixture", afterState: "LotteryForm" };
    });

    await expect(adapter.selectPaymentCandidates(["payment:payment-convenience"])).resolves.toEqual({
      status: "selected",
      selections: [{ candidateId: "payment:payment-convenience", groupKey: "payment", domValue: "payment-convenience", label: "payment-convenience" }]
    });
    expect(selected).toEqual(["payment-convenience"]);
  });

  it("returns typed manual results for target absent disabled preference mismatch reordered controls and unknown group", async () => {
    const engine = engineFixture("LotteryForm");
    const adapter = new EplusBrowserAdapter(engine);
    vi.spyOn(engine, "inspectPage").mockResolvedValue({ groups: [deliveryGroup(), paymentGroup({ enabled: false })], unsafePaymentFields: false });

    await expect(adapter.selectPaymentCandidates(["payment:missing"])).resolves.toMatchObject({ status: "manual", reason: "missing-candidate" });
    await expect(adapter.selectPaymentCandidates(["payment:payment-convenience"])).resolves.toMatchObject({ status: "manual", reason: "disabled-candidate" });
    await expect(adapter.applyPreference([{ groupKey: "delivery", candidateId: "delivery:not-a-real-value", domValue: "not-a-real-value" }])).rejects.toThrow("missing, disabled, unsupported, ambiguous, or changed");
    expect(engine.executeStep).not.toHaveBeenCalledWith("select-runtime-payment-candidates", expect.anything());
  });

  it("returns manual before selection for card fields CAPTCHA and device verification", async () => {
    const engine = engineFixture("LotteryForm");
    const adapter = new EplusBrowserAdapter(engine);
    vi.spyOn(engine, "inspectPage").mockResolvedValue({ groups: [], unsafePaymentFields: true });

    await expect(adapter.discoverPaymentOptions()).resolves.toEqual({ status: "manual", groups: [], reason: "unsafe-payment-fields" });
    await expect(adapter.selectPaymentCandidates(["payment:payment-card"])).resolves.toEqual({ status: "manual", groups: [], reason: "unsafe-payment-fields" });
    expect(engine.executeStep).not.toHaveBeenCalled();
  });

  it("treats target absent delayed controls and unknown group text as unavailable", async () => {
    const delayed = parseOptions(await fixture("payment-delayed-controls.html"));
    const absent = parseOptions(await fixture("no-payment-control.html"));
    const unrelated = parseOptions("<form><p>payment</p><select name='tickets'><option value='one'>One</option></select></form>");

    expect(delayed.filter((group) => group.kind === "payment")).toEqual([]);
    expect(absent.filter((group) => group.kind === "payment")).toEqual([]);
    expect(unrelated).toEqual([]);
  });

  it("delegates navigation and guarded login through the session engine", async () => {
    const engine = engineFixture();
    const adapter = new EplusBrowserAdapter(engine);

    await adapter.openEvent("https://eplus.jp/event");
    await adapter.login("person@example.test", "secret");

    expect(engine.navigate).toHaveBeenCalledWith("https://eplus.jp/event");
    expect(engine.executeStep).toHaveBeenCalledWith("login", expect.any(Object));
  });

  it("visits the main eplus.jp site on openHome", async () => {
    const engine = engineFixture();
    const adapter = new EplusBrowserAdapter(engine);

    await adapter.openHome();

    expect(engine.navigate).toHaveBeenCalledWith("https://eplus.jp");
  });

  it("clicks the hidden login-form trigger before filling credentials when the password field isn't visible yet", async () => {
    const engine = engineFixture();
    const adapter = new EplusBrowserAdapter(engine);
    const filled: Record<string, string> = {};
    const clicked: string[] = [];
    const page = {
      locator: vi.fn((selector: string) => ({
        first: () => ({
          isVisible: async () => !selector.includes("loginPassword"),
          count: async () => 1,
          fill: async (value: string) => { filled[selector] = value; },
          click: async () => { clicked.push(selector); }
        })
      }))
    };
    vi.spyOn(engine, "executeStep").mockImplementation(async (_action, step) => {
      if (!step) throw new Error("Expected browser step.");
      await step.execute(page as never);
      return { beforeState: "Login", action: "login", afterState: "Login" };
    });

    await adapter.login("person@example.test", "secret");

    expect(clicked).toEqual(["#login-bt a", expect.stringContaining("idPwLogin")]);
    expect(Object.values(filled)).toEqual(["person@example.test", "secret"]);
  });

  it("does not click the login-form trigger when the password field is already visible", async () => {
    const engine = engineFixture();
    const adapter = new EplusBrowserAdapter(engine);
    const clicked: string[] = [];
    const page = {
      locator: vi.fn((selector: string) => ({
        first: () => ({
          isVisible: async () => true,
          count: async () => 1,
          fill: async () => undefined,
          click: async () => { clicked.push(selector); }
        })
      }))
    };
    vi.spyOn(engine, "executeStep").mockImplementation(async (_action, step) => {
      if (!step) throw new Error("Expected browser step.");
      await step.execute(page as never);
      return { beforeState: "Login", action: "login", afterState: "Login" };
    });

    await adapter.login("person@example.test", "secret");

    expect(clicked).not.toContain("#login-bt a");
  });

  it("fills and submits the live ninsho serial form", async () => {
    const engine = engineFixture("SerialCode");
    const adapter = new EplusBrowserAdapter(engine);
    const fill = vi.fn(async () => undefined);
    const click = vi.fn(async () => undefined);
    const page = { locator: vi.fn(() => ({ count: vi.fn(async () => 1), first: vi.fn(() => ({ fill })), click })) };
    vi.spyOn(engine, "executeStep").mockImplementation(async (_action, step) => {
      if (!step) throw new Error("Expected browser step.");
      await step.execute(page as never);
      return { beforeState: "SerialCode", action: "enter-serial-code", afterState: "LotteryForm" };
    });

    await adapter.enterSerialCode("AAAA1111");

    expect(fill).toHaveBeenCalledWith("AAAA1111");
    expect(click).toHaveBeenCalledOnce();
    expect(engine.executeStep).toHaveBeenCalledWith("enter-serial-code", expect.any(Object));
  });

  it("requires manual takeover instead of applying preferences with no verified runtime selection", async () => {
    const engine = engineFixture("LotteryForm");
    const adapter = new EplusBrowserAdapter(engine);

    await expect(adapter.applyPreference([])).rejects.toThrow("No verified runtime selection is available to apply");
    expect(engine.inspectPage).not.toHaveBeenCalled();
  });

  it("applies a ticket-type selection the same way as a payment selection, using only the verified group and DOM value", async () => {
    const engine = engineFixture("LotteryForm");
    const adapter = new EplusBrowserAdapter(engine);
    const ticketGroup = group("ticket", 0, "ticket-electronic", true, true);
    vi.spyOn(engine, "inspectPage").mockResolvedValue({ groups: [ticketGroup], unsafePaymentFields: false });
    const selected: string[] = [];
    const page = singleGroupPage("ticket", "ticket-electronic", selected);
    vi.spyOn(engine, "executeStep").mockImplementation(async (_action, step) => {
      if (!step) throw new Error("Expected browser step.");
      await step.execute(page as never);
      return { beforeState: "LotteryForm", action: "fixture", afterState: "LotteryForm" };
    });

    await adapter.applyPreference([{ groupKey: "ticket", candidateId: "ticket:ticket-electronic", domValue: "ticket-electronic" }]);

    expect(selected).toEqual(["ticket-electronic"]);
  });

  it("rejects submission when no approved submit element is found on the page", async () => {
    const engine = engineFixture("LotteryForm");
    const adapter = new EplusBrowserAdapter(engine);
    const mockPage = { locator: vi.fn().mockReturnValue({ count: vi.fn(async () => 0) }) };
    vi.spyOn(engine, "executeStep").mockImplementation(async (_action, step) => {
      if (!step) throw new Error("Expected browser step.");
      await step.execute(mockPage as never);
      return { beforeState: "LotteryForm", action: "submit", afterState: "LotteryForm" };
    });

    await expect(adapter.submitApplication()).rejects.toThrow("No approved submit element");
    expect(engine.executeStep).toHaveBeenCalledWith("submit-application", expect.any(Object));
  });

  it("rejects submission when multiple submit elements are found", async () => {
    const engine = engineFixture("LotteryForm");
    const adapter = new EplusBrowserAdapter(engine);
    const mockPage = { locator: vi.fn().mockReturnValue({ count: vi.fn(async () => 2) }) };
    vi.spyOn(engine, "executeStep").mockImplementation(async (_action, step) => {
      if (!step) throw new Error("Expected browser step.");
      await step.execute(mockPage as never);
      return { beforeState: "LotteryForm", action: "submit", afterState: "LotteryForm" };
    });

    await expect(adapter.submitApplication()).rejects.toThrow("Multiple submit elements");
    expect(engine.executeStep).toHaveBeenCalledWith("submit-application", expect.any(Object));
  });

  it("clicks submit when exactly one approved element is found and proceeds to receipt", async () => {
    const engine = engineFixture("LotteryForm");
    const adapter = new EplusBrowserAdapter(engine);
    let clickCalled = false;
    const mockPage = {
      locator: vi.fn().mockReturnValue({ count: vi.fn(async () => 1), click: vi.fn(async () => { clickCalled = true; }) })
    };
    vi.spyOn(engine, "executeStep").mockImplementation(async (_action, step) => {
      if (!step) throw new Error("Expected browser step.");
      await step.execute(mockPage as never);
      return { beforeState: "LotteryForm", action: "submit", afterState: "Receipt" };
    });
    vi.spyOn(adapter, "readReceipt").mockResolvedValue({ url: "https://eplus.jp/receipt", receiptText: "受付番号: EP12345678" });

    const result = await adapter.submitApplication();

    expect(clickCalled).toBe(true);
    expect(result).toEqual({ url: "https://eplus.jp/receipt", receiptText: "受付番号: EP12345678" });
  });

  it("clicks the verified interstitial acknowledgement control", async () => {
    const engine = engineFixture("InterstitialConsent");
    const adapter = new EplusBrowserAdapter(engine);
    const click = vi.fn(async () => undefined);
    const page = { locator: vi.fn(() => ({ count: vi.fn(async () => 1), first: vi.fn(() => ({ click })) })) };
    vi.spyOn(engine, "executeStep").mockImplementation(async (_action, step) => {
      if (!step) throw new Error("Expected browser step.");
      await step.execute(page as never);
      return { beforeState: "InterstitialConsent", action: "acknowledge-interstitial", afterState: "LotteryForm" };
    });

    await adapter.acknowledgeInterstitial();

    expect(click).toHaveBeenCalledOnce();
  });

  it("discovers unchecked consent checkboxes as single-option groups keyed by position and label", async () => {
    const engine = engineFixture("CheckboxGate");
    const adapter = new EplusBrowserAdapter(engine);
    vi.spyOn(engine, "inspectPage").mockResolvedValue([
      { label: "利用規約に同意する", checked: false, id: "terms", name: null },
      { label: "", checked: false, id: null, name: null },
      { label: "個人情報の取り扱いに同意する", checked: true, id: "privacy", name: null }
    ]);

    const groups = await adapter.discoverConsentControls();

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ groupKey: "consent-0", options: [{ candidateId: "consent-0:利用規約に同意する", domValue: "利用規約に同意する", label: "利用規約に同意する" }] });
  });

  it("checks the matched consent checkbox by its discovered ordinal position", async () => {
    const engine = engineFixture("CheckboxGate");
    const adapter = new EplusBrowserAdapter(engine);
    vi.spyOn(engine, "inspectPage").mockResolvedValue([{ label: "利用規約に同意する", checked: false, id: "terms", name: null }]);
    const checkedValues: string[] = [];
    const box = { count: vi.fn(async () => 1), isChecked: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true), check: vi.fn(async () => { checkedValues.push("terms"); }) };
    const page = { locator: vi.fn(() => ({ nth: vi.fn(() => box) })) };
    vi.spyOn(engine, "executeStep").mockImplementation(async (_action, step) => {
      if (!step) throw new Error("Expected browser step.");
      await step.execute(page as never);
      return { beforeState: "CheckboxGate", action: "check-consent-boxes", afterState: "CheckboxGate" };
    });

    await adapter.applyConsentSelections(["consent-0:利用規約に同意する"]);

    expect(checkedValues).toEqual(["terms"]);
    expect(box.check).toHaveBeenCalledOnce();
  });

  it("confirms which candidate labels are now checked on the live page, for template capture", async () => {
    const engine = engineFixture("LotteryForm");
    const adapter = new EplusBrowserAdapter(engine);
    vi.spyOn(engine, "inspectPage").mockResolvedValue([
      { label: "利用規約に同意する", checked: true, id: "terms", name: null },
      { label: "个人信息", checked: false, id: "privacy", name: null }
    ]);

    const confirmed = await adapter.confirmConsentChecked([
      { groupKey: "consent-0", domValue: "利用規約に同意する", label: "利用規約に同意する" },
      { groupKey: "consent-1", domValue: "个人信息", label: "个人信息" }
    ]);

    expect(confirmed).toEqual([{ groupKey: "consent-0", domValue: "利用規約に同意する", label: "利用規約に同意する" }]);
  });

  it("validates the lease at the action boundary before clicking submit", async () => {
    const engine = engineFixture("LotteryForm");
    const adapter = new EplusBrowserAdapter(engine);
    const validator = vi.fn();
    let clickCalled = false;
    let validatorCalledBeforeClick = false;
    const mockPage = {
      locator: vi.fn().mockReturnValue({
        count: vi.fn(async () => 1),
        click: vi.fn(async () => { clickCalled = true; })
      })
    };
    vi.spyOn(engine, "executeStep").mockImplementation(async (_action, step) => {
      if (!step) throw new Error("Expected browser step.");
      await step.execute(mockPage as never);
      return { beforeState: "LotteryForm", action: "submit", afterState: "Receipt" };
    });
    vi.spyOn(adapter, "readReceipt").mockResolvedValue({ url: "https://eplus.jp/receipt", receiptText: "受付番号: EP12345678" });
    validator.mockImplementation(() => { validatorCalledBeforeClick = !clickCalled; });

    await adapter.submitApplication(validator);

    expect(validator).toHaveBeenCalledOnce();
    expect(validatorCalledBeforeClick).toBe(true);
    expect(clickCalled).toBe(true);
  });
});

async function fixture(name: string): Promise<string> {
  return readFile(path.resolve("tests/fixtures", name), "utf8");
}

function paymentGroup(input: { readonly enabled?: boolean } = {}): PaymentOptionGroup {
  return group("payment", 1, "payment-convenience", input.enabled ?? true, true);
}

function deliveryGroup(): PaymentOptionGroup {
  return group("delivery", 0, "delivery-mobile", true, true);
}

function group(groupKey: string, groupOrder: number, domValue: string, enabled: boolean, supported: boolean): PaymentOptionGroup {
  const selectorEvidence = { scope: "document" as const, tag: "input" as const, groupOrdinal: groupOrder, optionOrdinal: 0, allowedAttributes: { name: groupKey, type: "radio", dataPaymentGroup: groupKey }, contextGeneration: "live" };
  return { groupKey, groupOrder, controlType: "input", selectorEvidence, options: [{ candidateId: `${groupKey}:${domValue}`, groupKey, groupOrder, optionOrder: 0, controlType: "input", domValue, label: domValue, enabled, supported, ambiguous: false, selectorEvidence }] };
}

function singleGroupPage(groupKey: string, domValue: string, selected: string[]) {
  const optionNode = { count: vi.fn(async () => 1), getAttribute: vi.fn(async () => domValue), isDisabled: vi.fn(async () => false), check: vi.fn(async () => { selected.push(domValue); }), isChecked: vi.fn(async () => true), evaluate: vi.fn(async () => domValue) };
  const groupNode = { getAttribute: vi.fn(async () => groupKey), locator: vi.fn(() => ({ nth: vi.fn(() => optionNode) })) };
  return { frames: () => [{}], locator: vi.fn((selector: string) => selector === "[data-payment-group]" ? { nth: vi.fn(() => groupNode) } : { count: vi.fn(async () => 0) }) };
}

function selectionPage(selected: string[]) {
  const option = (value: string) => ({ count: vi.fn(async () => 1), getAttribute: vi.fn(async () => value), isDisabled: vi.fn(async () => false), check: vi.fn(async () => { selected.push(value); }), isChecked: vi.fn(async () => true), evaluate: vi.fn(async () => value) });
  const group = (key: string, value: string) => ({ getAttribute: vi.fn(async () => key), locator: vi.fn(() => ({ first: vi.fn(() => ({ count: vi.fn(async () => 1), isDisabled: vi.fn(async () => false), locator: vi.fn(() => ({ nth: vi.fn(() => option(value)) })) })), nth: vi.fn(() => option(value)) })) });
  return { frames: () => [{}], locator: vi.fn((selector: string) => selector === "[data-payment-group]" ? { nth: vi.fn((index: number) => index === 0 ? group("delivery", "delivery-mobile") : group("payment", "payment-convenience")) } : { count: vi.fn(async () => 0) }) };
}
