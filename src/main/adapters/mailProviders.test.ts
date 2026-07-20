import { describe, expect, it, vi } from "vitest";
import { createMailProvider, extractVerificationCodeFromMessage } from "./mailProviders.js";

describe("mail providers", () => {
  it("reads parsed mails from temp-mail worker", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.toString()).toBe("https://worker.example/api/parsed_mails?limit=50&offset=0");
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer address-jwt",
        "x-custom-auth": "site-password"
      });
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "m1",
              sender: "no-reply@eplus.co.jp",
              to: ["verify@example.com"],
              subject: "【Eplus】認証コード",
              text: "認証コードは 123456 です",
              created_at: "2026-07-20T00:00:00Z"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const provider = createMailProvider(
      "temp-mail-forwarder",
      {
        endpoint: "https://worker.example",
        mailboxAddress: "verify@example.com",
        apiToken: "address-jwt",
        password: "site-password",
        pollingIntervalMs: 1000
      },
      fetcher
    );
    const result = await provider.waitForVerificationCode({
      recipient: "verify@example.com",
      startedAt: new Date("2026-07-19T00:00:00Z"),
      timeoutMs: 5000,
      pollingIntervalMs: 1000,
      senderAllowlist: ["eplus.co.jp"],
      subjectMatchers: [/認証/, /コード/]
    });

    expect(result).toEqual({
      code: "123456",
      manualActionRequired: false,
      reason: "已从验证码邮箱读取验证码。"
    });
  });

  it("reads mails from auth bridge mailbox", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.toString()).toBe(
        "https://auth.example/api/temp-mail/mails?app_id=auth-app&limit=50&offset=0&address=verify%40example.com"
      );
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer auth-jwt"
      });
      return new Response(
        JSON.stringify({
          results: [
            {
              id: "m2",
              from: "Eplus <no-reply@eplus.co.jp>",
              to: "verify@example.com",
              subject: "Eplus 確認コード",
              html: "<p>コード: <strong>654321</strong></p>",
              created_at: "2026-07-20T00:00:00Z"
            }
          ]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const provider = createMailProvider(
      "auth-mailbox",
      {
        endpoint: "https://auth.example",
        providerId: "auth-app",
        mailboxAddress: "verify@example.com",
        apiToken: "auth-jwt",
        pollingIntervalMs: 1000
      },
      fetcher
    );
    const result = await provider.waitForVerificationCode({
      recipient: "verify@example.com",
      startedAt: new Date("2026-07-19T00:00:00Z"),
      timeoutMs: 5000,
      pollingIntervalMs: 1000,
      senderAllowlist: ["eplus.co.jp"],
      subjectMatchers: [/確認/, /コード/]
    });

    expect(result.code).toBe("654321");
  });

  it("extracts verification code from subject and body", () => {
    expect(
      extractVerificationCodeFromMessage({
        from: "no-reply@eplus.co.jp",
        to: ["verify@example.com"],
        subject: "認証コード",
        receivedAt: new Date("2026-07-20T00:00:00Z"),
        text: "コード 112233 を入力してください"
      })
    ).toBe("112233");
  });

  it("extracts code from a real eplus mail sample", () => {
    expect(
      extractVerificationCodeFromMessage({
        from: "eplus <info@eplus.co.jp>",
        to: ["osawarurino@cerise-bouquet.xyz"],
        subject: "【e+より】認証コード通知",
        receivedAt: new Date("2026-07-19T23:15:00Z"),
        text: [
          "認証コード：687670",
          "この番号を認証コード入力画面で入力してください。",
          "認証コードの有効期限は10分です。"
        ].join("\n")
      })
    ).toBe("687670");
  });
});
