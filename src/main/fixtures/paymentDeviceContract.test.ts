import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverRuntimePaymentOptions } from "../services/runtimePaymentDiscovery.js";

const projectRoot = process.cwd();
const createdDirectories: string[] = [];

function fixture(name: string): string {
  return readFileSync(path.join(projectRoot, "tests", "fixtures", name), "utf8");
}

function command(script: string, argumentsList: readonly string[]): { readonly status: number | null; readonly stderr: string } {
  const result = spawnSync("node", [path.join(projectRoot, "scripts", script), ...argumentsList], { cwd: projectRoot, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr ?? "" };
}

async function temporaryFixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(projectRoot, "tests", "fixtures", ".tmp-payment-device-"));
  createdDirectories.push(directory);
  return directory;
}

afterEach(async () => { await Promise.all(createdDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("payment device evidence fixtures", () => {
  it("records the named fixture contract inputs", () => {
    const expected = {
      "eplus-lisa-0534530001-detail.html": { orderedGroups: [], options: {}, state: "payment_discovery_pending" },
      "payment-delivery-and-methods.html": { orderedGroups: ["delivery", "payment"], options: { delivery: ["delivery-mobile", "delivery-paper"], payment: ["payment-card", "payment-convenience", "payment-wallet"] }, disabled: { payment: ["payment-card-disabled"] }, unknown: ["payment-wallet"] },
      "payment-only.html": { orderedGroups: ["payment"], options: { payment: ["payment-card", "payment-convenience"] }, disabled: {}, unknown: [] },
      "no-payment-control.html": { orderedGroups: [], options: {}, state: "payment_unavailable" },
      "payment-delayed-controls.html": { orderedGroups: [], options: {}, state: "payment_delayed" }
    } as const;

    expect(fixture("eplus-lisa-0534530001-detail.html")).toContain('data-public-fixture="detail"');
    expect(fixture("payment-delivery-and-methods.html")).toContain('data-payment-group="delivery"');
    expect(fixture("payment-delivery-and-methods.html")).toContain('data-payment-group="payment"');
    expect(fixture("payment-only.html")).toContain('data-payment-group="payment"');
    expect(fixture("no-payment-control.html")).not.toContain("data-payment-group");
    expect(fixture("payment-delayed-controls.html")).toContain('data-payment-controls-state="delayed"');
    expect(expected).toMatchObject({ "payment-only.html": { orderedGroups: ["payment"] }, "payment-delayed-controls.html": { state: "payment_delayed" } });
  });

  it("executes every positive fixture through the generalized runtime discovery contract", () => {
    const expected = {
      "eplus-lisa-0534530001-detail.html": { status: "payment_unavailable", groups: [] },
      "payment-delivery-and-methods.html": { status: "ready", groups: ["delivery", "payment"] },
      "payment-only.html": { status: "ready", groups: ["payment"] },
      "no-payment-control.html": { status: "payment_unavailable", groups: [] },
      "payment-delayed-controls.html": { status: "payment_delayed", groups: [] },
      "payment-reordered-groups.html": { status: "ready", groups: ["payment", "delivery"] },
      "payment-custom-labels.html": { status: "ready", groups: ["payment"] },
      "payment-duplicate-labels.html": { status: "manual", groups: ["payment"] },
      "payment-duplicate-values.html": { status: "manual", groups: ["payment"] }
    } as const;

    for (const [name, expectation] of Object.entries(expected)) {
      const discovery = discoverRuntimePaymentOptions(fixture(name));
      expect({ status: discovery.status, groups: discovery.groups.map((group) => group.groupKey) }, name).toEqual(expectation);
    }
  });

  it("documents the committed sanitized fixture hash and public route metadata", () => {
    const sanitized = fixture("sanitized-payment-device.har");
    const manifest = JSON.parse(fixture("sanitized-payment-device.har.sha256"));
    const parsed = JSON.parse(sanitized);

    expect(manifest).toEqual({ algorithm: "sha256", fixture: "tests/fixtures/sanitized-payment-device.har", sha256: createHash("sha256").update(sanitized).digest("hex") });
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries.map((entry: { readonly routeClass: string }) => entry.routeClass)).toEqual(["detail", "application-entry"]);
    expect(parsed.entries.every((entry: { readonly viewport?: unknown }) => entry.viewport !== undefined)).toBe(true);
    expect(JSON.stringify(parsed)).not.toMatch(/https?:|\?|authorization|cookie|password|credential|token|jwt|cvv|cardholder|@[A-Za-z0-9._-]+/i);
  });

  it("keeps the raw HAR excluded while consuming committed sanitized evidence", () => {
    const rawHarPath = path.join(projectRoot, "sp.gesicht.eplus.jp.har");
    const ignoredPaths = readFileSync(path.join(projectRoot, ".gitignore"), "utf8");

    expect(existsSync(rawHarPath)).toBe(false);
    expect(ignoredPaths).toContain("sp.gesicht.eplus.jp.har");
    expect(fixture("sanitized-payment-device.har")).toContain('"format": "sanitized-payment-device-har-v1"');
  });

  it("accepts sanitized HAR and writes a repeatable manifest", async () => {
    const directory = await temporaryFixtureDirectory();
    const output = path.join(directory, "sanitized.har");
    const safeHar = path.join(directory, "safe.har");
    writeFileSync(safeHar, JSON.stringify({ log: { entries: [{ request: { url: "https://example.invalid/sf/detail/0534530001", method: "GET" }, response: { status: 200, content: { mimeType: "text/html", text: "<html><body>Public event</body></html>" } } }] } }), "utf8");

    expect(command("sanitize-har.mjs", ["--offline-evidence-input", safeHar, output]).status).toBe(0);
    const first = readFileSync(output, "utf8");
    expect(command("sanitize-har.mjs", ["--offline-evidence-input", safeHar, output]).status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(first);
    expect(JSON.parse(readFileSync(`${output}.sha256`, "utf8"))).toMatchObject({ algorithm: "sha256", sha256: createHash("sha256").update(first).digest("hex") });
  });

  it("rejects sensitive HAR without writing output", async () => {
    const directory = await temporaryFixtureDirectory();
    const output = path.join(directory, "rejected.har");
    const result = command("sanitize-har.mjs", ["--offline-evidence-input", path.join(projectRoot, "tests/fixtures/har-sensitive-fixture.har"), output]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("retained-payload-sensitive-field");
    expect(existsSync(output)).toBe(false);
  });

  it("discards sensitive request metadata before allowlist projection", async () => {
    const directory = await temporaryFixtureDirectory();
    const output = path.join(directory, "metadata-redacted.har");
    const input = path.join(directory, "metadata-redacted-input.har");
    writeFileSync(input, JSON.stringify({ log: { entries: [{ request: { url: "https://example.invalid/sf/detail/0534530001?private=value", method: "GET", headers: [{ name: "Authorization", value: "discarded" }], postData: { text: "discarded" } }, response: { status: 200, content: { mimeType: "text/html", text: "<html><body>Public event</body></html>" }, headers: [{ name: "Set-Cookie", value: "discarded" }] } }] } }), "utf8");

    const result = command("sanitize-har.mjs", ["--offline-evidence-input", input, output]);
    const sanitized = readFileSync(output, "utf8");

    expect(result.status).toBe(0);
    expect(sanitized).not.toMatch(/authorization|cookie|postdata|private=value/i);
    expect(JSON.parse(sanitized)).toMatchObject({ entries: [{ routeClass: "detail", method: "GET", contentType: "text/html" }] });
  });

  it("rejects unsupported payload encodings without writing output", async () => {
    const directory = await temporaryFixtureDirectory();
    const output = path.join(directory, "unsupported.har");
    const input = path.join(directory, "unsupported-input.har");
    writeFileSync(input, JSON.stringify({ log: { entries: [{ request: { url: "https://example.invalid/sf/detail/0534530001", method: "GET" }, response: { status: 200, content: { mimeType: "text/html", encoding: "gzip", text: "opaque" } } }] } }), "utf8");

    const result = command("sanitize-har.mjs", ["--offline-evidence-input", input, output]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown-encoding");
    expect(existsSync(output)).toBe(false);
  });

  it("canonicalizes repeatable fixture input and rejects volatile input", async () => {
    const directory = await temporaryFixtureDirectory();
    const output = path.join(directory, "public.html");
    const stableFixture = path.join(directory, "stable.html");
    writeFileSync(stableFixture, "<!doctype html><html lang=\"en\"><body><p>Public event</p></body></html>", "utf8");

    expect(command("capture-public-fixture.mjs", ["--fixture", stableFixture, "--out", output, "--canonicalize"]).status).toBe(0);
    const first = readFileSync(output, "utf8");
    expect(command("capture-public-fixture.mjs", ["--fixture", stableFixture, "--out", output, "--canonicalize"]).status).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(first);
    expect(command("capture-public-fixture.mjs", ["--fixture", "tests/fixtures/volatile-public-fixture.html", "--out", path.join(directory, "rejected.html"), "--canonicalize"]).status).toBe(1);
  });

  it("keeps fixture mode independent of credentials and redacts receipts", () => {
    const source = readFileSync(path.join(projectRoot, "scripts", "live-smoke.mjs"), "utf8");
    const result = command("live-smoke.mjs", ["--fixture", "tests/fixtures/no-payment-control.html", "--final-submit=false"]);

    expect(source).not.toContain("process.env");
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/password|credential|token/i);
  });

  it("enforces one smoke mode and the final-submit confirmation gate", () => {
    const mixedMode = command("live-smoke.mjs", ["--fixture", "tests/fixtures/no-payment-control.html", "--allow-live-credentials", "--final-submit=false"]);
    const unconfirmedSubmit = command("live-smoke.mjs", ["--fixture", "tests/fixtures/no-payment-control.html", "--final-submit=true"]);

    expect(mixedMode.status).toBe(1);
    expect(mixedMode.stderr).toContain("mutually-exclusive");
    expect(unconfirmedSubmit.status).toBe(1);
    expect(unconfirmedSubmit.stderr).toContain("final-submit-requires-confirmation-gate");
  });
});
