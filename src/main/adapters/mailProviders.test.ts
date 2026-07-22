import { describe, expect, it, vi } from "vitest";
import { createMailProvider, extractVerificationCodeFromMessage } from "./mailProviders.js";

const verificationInput = {
  recipient: "verify@example.com",
  startedAt: new Date("2026-07-19T00:00:00Z"),
  timeoutMs: 1000,
  senderAllowlist: ["eplus.co.jp"],
  subjectMatchers: [/認証/, /確認/, /コード/]
};

describe("mail providers", () => {
  it("validates the manual provider", async () => {
    const provider = createMailProvider("manual", {});

    await expect(provider.validate({})).resolves.toEqual({ ok: true, message: "当前为手动输入验证码模式。" });
    await expect(provider.waitForVerificationCode(verificationInput)).resolves.toMatchObject({ manualActionRequired: true });
  });

  it("validates the cerise-bouquet temp-mail forwarder and returns candidate metadata", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.toString()).toBe("https://worker.example/api/parsed_mails?limit=50&offset=0");
      expect(init?.headers).toMatchObject({ Authorization: "Bearer address-jwt", "x-custom-auth": "site-password" });
      return new Response(JSON.stringify({
        results: [{
          sender: "no-reply@eplus.co.jp",
          to: ["verify@example.com"],
          subject: "【Eplus】認証コード",
          text: "認証コードは 123456 です",
          created_at: "2026-07-20T00:00:00Z"
        }]
      }), { status: 200 });
    });
    const provider = createMailProvider("temp-mail-forwarder", {
      apiEndpoint: "https://worker.example",
      mailboxAddress: "verify@example.com",
      apiToken: "address-jwt",
      password: "site-password"
    }, fetcher);

    await expect(provider.validate({
      apiEndpoint: "https://worker.example",
      mailboxAddress: "verify@example.com",
      apiToken: "address-jwt"
    })).resolves.toMatchObject({ ok: true });
    await expect(provider.waitForVerificationCode(verificationInput)).resolves.toEqual({
      code: "123456",
      candidates: [{
        code: "123456",
        receivedAt: "2026-07-20T00:00:00.000Z",
        sender: "no-reply@eplus.co.jp",
        subject: "【Eplus】認証コード"
      }],
      manualActionRequired: false,
      reason: "已从验证码邮箱读取验证码。"
    });
  });

  it("validates the cerise-bouquet auth mailbox and reads known verification patterns", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://auth.example/api/temp-mail/mails?app_id=auth-app&limit=50&offset=0&address=verify%40example.com");
      return new Response(JSON.stringify({
        results: [{
          from: "Eplus <no-reply@eplus.co.jp>",
          to: "verify@example.com",
          subject: "Eplus 確認コード",
          html: "<p>コード: <strong>654321</strong></p>",
          created_at: "2026-07-20T00:00:00Z"
        }]
      }), { status: 200 });
    });
    const config = {
      apiEndpoint: "https://auth.example",
      providerId: "auth-app",
      mailboxAddress: "verify@example.com",
      apiToken: "auth-jwt"
    };
    const provider = createMailProvider("auth-mailbox", config, fetcher);

    await expect(provider.validate(config)).resolves.toMatchObject({ ok: true });
    await expect(provider.waitForVerificationCode(verificationInput)).resolves.toMatchObject({ code: "654321" });
  });

  it("uses the auth-main-compatible admin bridge to obtain an address JWT", async () => {
    const responses = [
      { results: [{ id: 7, user_email: "verify@example.com" }] },
      { results: [{ id: 42, address: "verify@example.com" }] },
      { jwt: "address-jwt" },
      { results: [{ from: "no-reply@eplus.co.jp", to: ["verify@example.com"], subject: "Eplus 認証コード", text: "コード: 778899", created_at: "2026-07-20T00:00:00Z" }] }
    ];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (fetcher.mock.calls.length < 4) expect(init?.headers).toMatchObject({ "x-admin-auth": "admin-secret" });
      return new Response(JSON.stringify(responses.shift()), { status: 200 });
    });
    const provider = createMailProvider("cerise-bouquet", { apiEndpoint: "https://worker.example", mailboxAddress: "verify@example.com", password: "admin-secret" }, fetcher);
    await expect(provider.waitForVerificationCode(verificationInput)).resolves.toMatchObject({ code: "778899" });
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual(["/admin/users", "/admin/users/bind_address/7", "/admin/show_password/42", "/api/parsed_mails"]);
    expect(fetcher.mock.calls[3]?.[1]?.headers).toMatchObject({ Authorization: "Bearer address-jwt" });
  });

  it("rejects IMAP and generic HTTP API provider modes", () => {
    expect(() => createMailProvider("imap", {})).toThrow("不支持 imap 邮箱模式");
    expect(() => createMailProvider("http-api", {})).toThrow("不支持 http-api 邮箱模式");
  });

  it("extracts verification code from subject and body", () => {
    expect(extractVerificationCodeFromMessage({
      from: "no-reply@eplus.co.jp",
      to: ["verify@example.com"],
      subject: "認証コード",
      receivedAt: new Date("2026-07-20T00:00:00Z"),
      text: "コード 112233 を入力してください"
    })).toBe("112233");
  });

  it("accepts a forwarded completion mail only when the original account recipient matches", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [{
      from: "E+ <info@eplus.co.jp>",
      to: ["temporary@example.test"],
      original_to: "account@example.test",
      subject: "＜ 申込み完了・抽選結果確認期間のご案内 ＞",
      text: "申込み履歴(申込み状況照会) https://eplus.jp/jyoukyou/",
      created_at: "2026-07-20T00:00:01Z"
    }] }), { status: 200 }));
    const provider = createMailProvider("temp-mail-forwarder", { apiEndpoint: "https://worker.example", mailboxAddress: "temporary@example.test", apiToken: "token" }, fetcher);
    await expect(provider.waitForApplicationConfirmation({ recipient: "account@example.test", startedAt: new Date("2026-07-20T00:00:00Z"), timeoutMs: 1000 })).resolves.toMatchObject({ confirmed: true });
  });

  it("rejects a completion mail forwarded from another account", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [{
      from: "info@eplus.co.jp",
      to: ["temporary@example.test"],
      original_to: "other@example.test",
      subject: "＜ 申込み完了・抽選結果確認期間のご案内 ＞",
      text: "申込み履歴(申込み状況照会) https://eplus.jp/jyoukyou/",
      created_at: "2026-07-20T00:00:01Z"
    }] }), { status: 200 }));
    const provider = createMailProvider("temp-mail-forwarder", { apiEndpoint: "https://worker.example", mailboxAddress: "temporary@example.test", apiToken: "token" }, fetcher);
    await expect(provider.waitForApplicationConfirmation({ recipient: "account@example.test", startedAt: new Date("2026-07-20T00:00:00Z"), timeoutMs: 1000 })).resolves.toMatchObject({ confirmed: false });
  });

  it("accepts a worker parsed mail whose scoped address is the account mailbox", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [{
      source: "info@eplus.co.jp",
      address: "account@example.test",
      subject: "＜ 申込み完了・抽選結果確認期間のご案内 ＞",
      text: "申込み履歴(申込み状況照会) https://eplus.jp/jyoukyou/",
      created_at: "2026-07-20T00:00:01Z"
    }] }), { status: 200 }));
    const provider = createMailProvider("temp-mail-forwarder", { apiEndpoint: "https://worker.example", mailboxAddress: "shared@example.test", apiToken: "token" }, fetcher);
    await expect(provider.waitForApplicationConfirmation({ recipient: "account@example.test", startedAt: new Date("2026-07-20T00:00:00Z"), timeoutMs: 1000 })).resolves.toMatchObject({ confirmed: true });
  });
});
