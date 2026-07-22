import { describe, expect, it } from "vitest";
import { makeConfirmationDigest, makeIdempotencyKey, makePaymentAuthorizationDigest, makePreferencesEqual } from "./digest.js";
import type { LotteryPreference } from "../shared/types.js";

const preference: LotteryPreference = {
  entries: [{ rank: 1, ticketTypeId: "ticket-a", quantity: 2 }],
  paymentMethodId: "payment-a",
  serialCode: "serial-a",
  consentFlags: { terms: true },
  daySelectionByAccountId: { "account-a": ["day1"] }
};

describe("lottery preference digests", () => {
  it("changes confirmation digest when confirmation policy changes", () => {
    const required = makeConfirmationDigest({
      canonicalUrl: "https://eplus.jp/event",
      preference,
      accountIds: ["account-a"],
      confirmationPolicy: "required",
      automationRiskAcknowledgementVersion: 1
    });
    const disabled = makeConfirmationDigest({
      canonicalUrl: "https://eplus.jp/event",
      preference,
      accountIds: ["account-a"],
      confirmationPolicy: "disabled",
      automationRiskAcknowledgementVersion: 1
    });

    expect(required).not.toBe(disabled);
  });

  it("changes confirmation digest when acknowledgement version changes", () => {
    const firstAcknowledgement = makeConfirmationDigest({
      canonicalUrl: "https://eplus.jp/event",
      preference,
      accountIds: ["account-a"],
      automationRiskAcknowledgementVersion: 1
    });
    const renewedAcknowledgement = makeConfirmationDigest({
      canonicalUrl: "https://eplus.jp/event",
      preference,
      accountIds: ["account-a"],
      automationRiskAcknowledgementVersion: 2
    });

    expect(firstAcknowledgement).not.toBe(renewedAcknowledgement);
  });

  it("changes digests when a per-account day selection changes", () => {
    const dayOne = makeIdempotencyKey({
      accountId: "account-a",
      canonicalUrl: "https://eplus.jp/event",
      preference
    });
    const dayTwo = makeIdempotencyKey({
      accountId: "account-a",
      canonicalUrl: "https://eplus.jp/event",
      preference: { ...preference, daySelectionByAccountId: { "account-a": ["day2"] } }
    });

    expect(dayOne).not.toBe(dayTwo);
  });

  it("changes digests when a serial code changes", () => {
    const original = makeConfirmationDigest({
      canonicalUrl: "https://eplus.jp/event",
      preference,
      accountIds: ["account-a"]
    });
    const changed = makeConfirmationDigest({
      canonicalUrl: "https://eplus.jp/event",
      preference: { ...preference, serialCode: "serial-b" },
      accountIds: ["account-a"]
    });

    expect(original).not.toBe(changed);
  });

  it("compares preference JSON independent of object field order", () => {
    const persistedPreference = JSON.parse(
      '{"paymentMethodId":"payment-a","entries":[{"ticketTypeId":"ticket-a","quantity":2,"rank":1}],"consentFlags":{"terms":true},"serialCode":"serial-a"}'
    );

    expect(makePreferencesEqual(preference, persistedPreference)).toBe(false);
    const preferenceWithoutDaySelection: LotteryPreference = {
      entries: preference.entries,
      paymentMethodId: preference.paymentMethodId,
      serialCode: preference.serialCode,
      consentFlags: preference.consentFlags
    };

    expect(makePreferencesEqual(preferenceWithoutDaySelection, persistedPreference)).toBe(true);
  });

  it("changes final authorization digest when selected payment or device profile changes", () => {
    const base = { taskId: "task", runId: "run", preference, selectedOptions: [{ groupKey: "payment", candidateId: "candidate-a", domValue: "store" }], deviceProfileKey: "desktop-chrome" as const, deviceRegistryDigest: "registry", pageFingerprint: "page", controlFingerprint: "control", reviewDigest: "review", acknowledgementVersion: 1, authorizationRevision: 1, nonce: "nonce" };
    expect(makePaymentAuthorizationDigest(base)).not.toBe(makePaymentAuthorizationDigest({ ...base, selectedOptions: [{ groupKey: "payment", candidateId: "candidate-b", domValue: "card" }] }));
    expect(makePaymentAuthorizationDigest(base)).not.toBe(makePaymentAuthorizationDigest({ ...base, deviceProfileKey: "iphone-13" }));
    expect(makePaymentAuthorizationDigest(base)).not.toBe(makePaymentAuthorizationDigest({ ...base, reviewDigest: "changed-review" }));
  });
});
