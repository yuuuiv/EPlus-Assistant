import { describe, expect, it } from "vitest";
import { attributeVerificationCode } from "./mailAttribution.js";

const recipient = "shared@example.com";
const trigger = (accountId: string, triggeredAt: string) => ({ accountId, triggeredAt, recipient });
const candidate = (overrides: Partial<{
  code: string;
  receivedAt: string;
  sender: string;
  subject: string;
  body: string;
}> = {}) => ({
  code: "246810",
  receivedAt: "2026-07-20T10:01:00Z",
  sender: "no-reply@eplus.co.jp",
  subject: "Eplus 認証コード",
  ...overrides
});
const input = (accountTriggers: ReturnType<typeof trigger>[], candidates: ReturnType<typeof candidate>[]) => ({
  accountTriggers,
  candidates,
  senderAllowlist: ["eplus.co.jp"],
  subjectMatchers: [/認証/]
});

describe("mailAttribution", () => {
  it("selects one unambiguous candidate and returns its code", () => {
    expect(attributeVerificationCode(input([
      trigger("account-a", "2026-07-20T10:00:00Z")
    ], [candidate()]))).toEqual([{
      accountId: "account-a",
      code: "246810",
      confidence: "medium",
      reason: "候选邮件仅匹配一个触发时间窗口。",
      manualActionRequired: false
    }]);
  });

  it("two overlapping candidates produce no fill action and both return ambiguous", () => {
    const results = attributeVerificationCode(input([
      trigger("account-a", "2026-07-20T10:00:00Z"),
      trigger("account-b", "2026-07-20T10:00:30Z")
    ], [candidate(), candidate({ code: "135790", receivedAt: "2026-07-20T10:02:00Z" })]));

    expect(results).toMatchObject([
      { accountId: "account-a", confidence: "ambiguous", manualActionRequired: true },
      { accountId: "account-b", confidence: "ambiguous", manualActionRequired: true }
    ]);
    expect(results.some((result) => "code" in result)).toBe(false);
  });

  it("time-window matching is deterministic", () => {
    const results = attributeVerificationCode(input([
      trigger("account-a", "2026-07-20T10:00:00Z"),
      trigger("account-b", "2026-07-20T10:02:00Z")
    ], [candidate({ receivedAt: "2026-07-20T10:01:00Z" })]));

    expect(results).toMatchObject([
      { accountId: "account-a", code: "246810", manualActionRequired: false },
      { accountId: "account-b", manualActionRequired: true }
    ]);
  });

  it("account-marker matching works when body contains an account email identifier", () => {
    const results = attributeVerificationCode(input([
      trigger("first@example.com", "2026-07-20T10:00:00Z"),
      trigger("second@example.com", "2026-07-20T10:00:30Z")
    ], [candidate({ body: "Verification requested for first@example.com" })]));

    expect(results).toMatchObject([
      { accountId: "first@example.com", code: "246810", confidence: "high", manualActionRequired: false },
      { accountId: "second@example.com", manualActionRequired: true }
    ]);
  });

  it("latest-unclaimed priority works correctly", () => {
    const results = attributeVerificationCode(input([
      trigger("account-a", "2026-07-20T10:00:00Z"),
      trigger("account-b", "2026-07-20T10:00:30Z")
    ], [candidate()]));

    expect(results).toMatchObject([
      { accountId: "account-a", manualActionRequired: true },
      { accountId: "account-b", code: "246810", reason: "按最新未认领触发时间归属。", manualActionRequired: false }
    ]);
  });

  it("raw candidate code and body values are absent from ambiguous returned results", () => {
    const results = attributeVerificationCode(input([
      trigger("account-a", "2026-07-20T10:00:00Z"),
      trigger("account-b", "2026-07-20T10:00:30Z")
    ], [
      candidate({ code: "246810", body: "sensitive body content" }),
      candidate({ code: "135790", receivedAt: "2026-07-20T10:02:00Z", body: "second sensitive body" })
    ]));

    expect(JSON.stringify(results)).not.toContain("sensitive body content");
    expect(JSON.stringify(results)).not.toContain("second sensitive body");
    expect(JSON.stringify(results)).not.toContain("246810");
    expect(JSON.stringify(results)).not.toContain("135790");
    expect(Object.keys(results[0] ?? {})).not.toContain("body");
  });

  it("sender allowlist filtering works", () => {
    const results = attributeVerificationCode(input([
      trigger("account-a", "2026-07-20T10:00:00Z")
    ], [candidate({ sender: "no-reply@untrusted.example" })]));

    expect(results[0]).toMatchObject({ confidence: "ambiguous", manualActionRequired: true });
  });

  it("subject matcher filtering works", () => {
    const results = attributeVerificationCode({
      ...input([trigger("account-a", "2026-07-20T10:00:00Z")], [candidate({ subject: "Unrelated notice" })]),
      subjectMatchers: [/認証/]
    });

    expect(results[0]).toMatchObject({ confidence: "ambiguous", manualActionRequired: true });
  });
});
