import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsService } from "./settingsService.js";
import { parseNetworkControllerConfig } from "./settingsService.js";
import { AppDatabase } from "../storage/database.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("network settings migration", () => {
  it("migrates a legacy flat selectedNodes field into nodeSelectionsByGroup and never leaks the retired key back out", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-settings-"));
    directories.push(directory);
    const db = new AppDatabase(directory);
    await db.open();
    const secretStore = { encryptString: vi.fn((value: string) => value), decryptString: vi.fn((value: string) => value), encryptJson: vi.fn(), decryptJson: vi.fn() };
    const service = new SettingsService(db, secretStore as never);
    // Simulate a settings row saved under the old schema, before nodeSelectionsByGroup existed.
    db.setSetting("network", { controller: "clash", host: "127.0.0.1", port: 9090, proxyGroup: "Proxies", requiredCountry: "Japan", policy: "required", secretConfigured: true, selectedNodes: ["node-a", "node-b"] });

    const settings = service.getNetworkSettings();

    expect(settings.nodeSelectionsByGroup).toEqual({ Proxies: ["node-a", "node-b"] });
    expect(settings).not.toHaveProperty("selectedNodes");
  });
});

describe("network controller config import", () => {
  it("parses Clash Verge YAML", () => {
    expect(parseNetworkControllerConfig("clash", "external-controller: 127.0.0.1:9090\nsecret: abc\nproxy-groups:\n  - name: Auto\n    type: select")).toEqual({ host: "127.0.0.1", port: 9090, secret: "abc", proxyGroup: "Auto", proxyGroups: ["Auto"], availableNodes: [] });
  });

  it("parses sing-box Clash API JSON", () => {
    expect(parseNetworkControllerConfig("sing-box", JSON.stringify({ experimental: { clash_api: { external_controller: "127.0.0.1:9097", secret: "xyz", default_mode: "select" } } }))).toEqual({ host: "127.0.0.1", port: 9097, secret: "xyz", proxyGroup: "select", proxyGroups: ["select"], availableNodes: [] });
  });

  it("ignores a trailing inline comment on the external-controller line", () => {
    const result = parseNetworkControllerConfig("clash", "external-controller: 127.0.0.1:9090  # do not change\nsecret: abc\nproxy-groups:\n  - name: Auto\n    type: select");
    expect(result).toEqual({ host: "127.0.0.1", port: 9090, secret: "abc", proxyGroup: "Auto", proxyGroups: ["Auto"], availableNodes: [] });
  });

  it("accepts IPv6 bracket notation for the controller address", () => {
    const result = parseNetworkControllerConfig("clash", "external-controller: '[::1]:9090'\nsecret: abc\nproxy-groups:\n  - name: Auto\n    type: select");
    expect(result).toEqual({ host: "::1", port: 9090, secret: "abc", proxyGroup: "Auto", proxyGroups: ["Auto"], availableNodes: [] });
  });

  it("reports the unrecognized address value instead of a generic not-found message", () => {
    expect(() => parseNetworkControllerConfig("clash", "external-controller: not-an-address\nproxy-groups:\n  - name: Auto")).toThrow("not-an-address");
  });

  it("keeps individual proxy server names out of the proxy-group dropdown (block-style proxies section)", () => {
    const yaml = [
      "external-controller: 127.0.0.1:9090",
      "secret: abc",
      "proxies:",
      "  - name: JP-Node-1",
      "    type: ss",
      "    server: jp1.example.test",
      "  - name: JP-Node-2",
      "    type: ss",
      "    server: jp2.example.test",
      "proxy-groups:",
      "  - name: Auto",
      "    type: select",
      "    proxies:",
      "      - JP-Node-1",
      "      - JP-Node-2"
    ].join("\n");

    const result = parseNetworkControllerConfig("clash", yaml);

    expect(result.proxyGroups).toEqual(["Auto"]);
    expect(result.proxyGroup).toBe("Auto");
    expect(result.availableNodes).toEqual(["JP-Node-1", "JP-Node-2"]);
  });

  it("keeps individual proxy server names out of the proxy-group dropdown (flow-style proxies section)", () => {
    const yaml = [
      "external-controller: 127.0.0.1:9090",
      "secret: abc",
      "proxies:",
      "  - {name: JP-Node-1, type: ss, server: jp1.example.test, port: 443}",
      "  - {name: JP-Node-2, type: ss, server: jp2.example.test, port: 443}",
      "proxy-groups:",
      "  - name: Auto",
      "    type: select",
      "    proxies: [JP-Node-1, JP-Node-2]"
    ].join("\n");

    const result = parseNetworkControllerConfig("clash", yaml);

    expect(result.proxyGroups).toEqual(["Auto"]);
    expect(result.availableNodes).toEqual(["JP-Node-1", "JP-Node-2"]);
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
