import { describe, expect, it, vi } from "vitest";
import { EplusBrowserAdapter } from "./eplusAdapter.js";
import { BrowserSessionEngine } from "../engines/browserSessionEngine.js";

function engineFixture(state: "Login" | "LotteryForm" | "Receipt" = "Login") {
  const engine = Object.create(BrowserSessionEngine.prototype) as BrowserSessionEngine;
  vi.spyOn(engine, "evaluateState").mockResolvedValue({ state, confidence: 1, reason: "fixture", safeActionHints: [], requiresManualTakeover: false });
  vi.spyOn(engine, "executeStep").mockResolvedValue({ beforeState: state, action: "fixture", afterState: state });
  vi.spyOn(engine, "getCurrentHtml").mockResolvedValue("<select><option value='ticket-a'>Ticket A</option></select>");
  vi.spyOn(engine, "getCurrentUrl").mockReturnValue("https://eplus.jp/apply");
  vi.spyOn(engine, "navigate").mockResolvedValue("https://eplus.jp/apply");
  return engine;
}

describe("EplusBrowserAdapter", () => {
  it("delegates event navigation through the session engine", async () => {
    const engine = engineFixture();
    const adapter = new EplusBrowserAdapter(engine);

    await adapter.openEvent("https://eplus.jp/event");

    expect(engine.navigate).toHaveBeenCalledWith("https://eplus.jp/event");
  });

  it("executes the login state transition through a guarded browser step", async () => {
    const engine = engineFixture("Login");
    const adapter = new EplusBrowserAdapter(engine);

    await adapter.login("person@example.test", "secret");

    expect(engine.executeStep).toHaveBeenCalledWith("login", expect.any(Object));
  });

  it("reads a review page from the rendered browser content", async () => {
    const engine = engineFixture("LotteryForm");
    const adapter = new EplusBrowserAdapter(engine);

    await expect(adapter.readReviewPage()).resolves.toMatchObject({ state: "LotteryForm", url: "https://eplus.jp/apply" });
  });

  it("applies preferences through a guarded browser step", async () => {
    const engine = engineFixture("LotteryForm");
    const adapter = new EplusBrowserAdapter(engine);

    await adapter.applyPreference({ entries: [{ rank: 1, ticketTypeId: "ticket-a", quantity: 1 }], paymentMethodId: "card", consentFlags: {} });

    expect(engine.executeStep).toHaveBeenCalledWith("apply-preference", expect.any(Object));
  });
});
