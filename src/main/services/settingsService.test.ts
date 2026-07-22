import { describe, expect, it, vi } from "vitest";
import { SettingsService } from "./settingsService.js";
import { parseNetworkControllerConfig } from "./settingsService.js";

describe("network controller config import", () => {
  it("parses Clash Verge YAML", () => {
    expect(parseNetworkControllerConfig("clash", "external-controller: 127.0.0.1:9090\nsecret: abc\nproxy-groups:\n  - name: Auto\n    type: select")).toEqual({ host: "127.0.0.1", port: 9090, secret: "abc", proxyGroup: "Auto", proxyGroups: ["Auto"] });
  });

  it("parses sing-box Clash API JSON", () => {
    expect(parseNetworkControllerConfig("sing-box", JSON.stringify({ experimental: { clash_api: { external_controller: "127.0.0.1:9097", secret: "xyz", default_mode: "select" } } }))).toEqual({ host: "127.0.0.1", port: 9097, secret: "xyz", proxyGroup: "select", proxyGroups: ["select"] });
  });
});

describe("cerise mailbox defaults", () => {
  it("uses the account address and process-only endpoint for cerise mode", () => {
    const previousJwt = process.env.EPLUS_CERISE_BOUQUET_JWT;
    const previousEndpoint = process.env.EPLUS_CERISE_BOUQUET_ENDPOINT;
    process.env.EPLUS_CERISE_BOUQUET_JWT = "process-only-test-token";
    process.env.EPLUS_CERISE_BOUQUET_ENDPOINT = "https://mail.example.test";
    try {
      const service = Object.create(SettingsService.prototype) as SettingsService;
      vi.spyOn(service, "getVerificationMailbox").mockReturnValue({
        providerId: "manual",
        mailboxAddress: "",
        mode: "manual",
        senderAllowlist: ["eplus.co.jp"],
        subjectMatchers: ["コード"],
        pollingIntervalMs: 5000,
        timeoutMs: 30000,
        secretConfigured: false
      });
      const resolved = (service as unknown as { resolveMailboxSettings: (recipient: string) => { mode: string; mailboxAddress: string; endpoint?: string; secretConfigured: boolean } }).resolveMailboxSettings("account@cerise-bouquet.xyz");
      expect(resolved).toMatchObject({ mode: "cerise-bouquet", mailboxAddress: "account@cerise-bouquet.xyz", endpoint: "https://mail.example.test", secretConfigured: true });
    } finally {
      if (previousJwt === undefined) delete process.env.EPLUS_CERISE_BOUQUET_JWT;
      else process.env.EPLUS_CERISE_BOUQUET_JWT = previousJwt;
      if (previousEndpoint === undefined) delete process.env.EPLUS_CERISE_BOUQUET_ENDPOINT;
      else process.env.EPLUS_CERISE_BOUQUET_ENDPOINT = previousEndpoint;
    }
  });
});
