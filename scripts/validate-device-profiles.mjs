import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---- argument parsing ----
const args = process.argv.slice(2);
const expected = ["--package-version-from", "package-lock.json", "--expected", "desktop-chrome,iphone-13,pixel-7"];
if (args.join("\u0000") !== expected.join("\u0000")) {
  process.exit(1);
}

// ---- load installed playwright-core ----
let installedVersion;
let devices;
try {
  installedVersion = require("playwright-core/package.json").version;
  devices = require("playwright-core").devices;
} catch {
  process.stderr.write("VALIDATOR_FAILED=missing-playwright-core\n");
  process.exit(1);
}

// ---- load lockfile version ----
let lockVersion;
try {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  lockVersion = lock.packages?.["node_modules/playwright-core"]?.version;
} catch {
  process.stderr.write("VALIDATOR_FAILED=unreadable-lockfile\n");
  process.exit(1);
}

if (typeof lockVersion !== "string") {
  process.stderr.write("VALIDATOR_FAILED=missing-lockfile-version\n");
  process.exit(1);
}

// ---- committed expected values (mirrors src/main/engines/deviceProfiles.ts) ----
const EXPECTED_VERSION = "1.61.1";
const EXPECTED_DIGEST = "bf01fed7710348d4ad9b520be86e4e98d76d3dcad4b55844b22fac467ec2691e";

const PROFILE_MAP = {
  "desktop-chrome": "Desktop Chrome",
  "iphone-13":     "iPhone 13",
  "pixel-7":       "Pixel 7"
};

/**
 * Mirrors descriptorFor() in src/main/engines/deviceProfiles.ts exactly.
 * The spread order of { ...descriptor, viewport: ..., screen: ... } determines
 * JSON key ordering, which affects the SHA-256 digest.
 */
function descriptorFor(name) {
  const descriptor = devices[name];
  if (!descriptor) throw new Error(`Missing installed Playwright device descriptor: ${name}`);
  const screen = name === "Desktop Chrome"
    ? { width: 1920, height: 1080 }
    : name === "iPhone 13"
      ? { width: 390, height: 844 }
      : { width: 412, height: 915 };
  return { ...descriptor, viewport: { ...descriptor.viewport }, screen: { ...screen } };
}

// ---- build profiles from installed descriptors ----
const installedProfiles = {};
for (const [key, playwrightName] of Object.entries(PROFILE_MAP)) {
  installedProfiles[key] = descriptorFor(playwrightName);
}

// ---- compute digest from installed state ----
const computedDigest = createHash("sha256")
  .update(JSON.stringify({ playwrightCore: installedVersion, profiles: installedProfiles }))
  .digest("hex");

// ---- validation results ----
const checks = [];

checks.push({
  check: "lockfile-version-matches-installed",
  passed: lockVersion === installedVersion,
  detail: { lockVersion, installedVersion }
});

checks.push({
  check: "installed-version-matches-committed",
  passed: installedVersion === EXPECTED_VERSION,
  detail: { installedVersion, expected: EXPECTED_VERSION }
});

checks.push({
  check: "registry-digest-matches-committed",
  passed: computedDigest === EXPECTED_DIGEST,
  detail: { computedDigest, expectedDigest: EXPECTED_DIGEST }
});

// validate each descriptor field per profile against installed playwright-core
for (const [key, playwrightName] of Object.entries(PROFILE_MAP)) {
  const installed = installedProfiles[key];
  const reference = devices[playwrightName];
  if (!reference) {
    checks.push({ check: `descriptor-${key}-exists`, passed: false, detail: `Playwright device "${playwrightName}" not found in installed registry` });
    continue;
  }

  const fields = [
    ["viewport.width",          installed.viewport.width,          reference.viewport.width],
    ["viewport.height",         installed.viewport.height,         reference.viewport.height],
    ["deviceScaleFactor",       installed.deviceScaleFactor,       reference.deviceScaleFactor],
    ["isMobile",                installed.isMobile,                reference.isMobile],
    ["hasTouch",                installed.hasTouch,                reference.hasTouch],
    ["defaultBrowserType",      installed.defaultBrowserType,      reference.defaultBrowserType],
    ["userAgent",               installed.userAgent,               reference.userAgent],
    ["screen.width",            installed.screen.width,            installed.screen.width > 0 ? installed.screen.width : null],
    ["screen.height",           installed.screen.height,           installed.screen.height > 0 ? installed.screen.height : null],
  ];

  for (const [field, actual, expected] of fields) {
    checks.push({
      check: `descriptor-${key}-${field}`,
      passed: actual === expected,
      detail: { actual, expected }
    });
  }
}

// ---- produce receipt ----
const allPassed = checks.every((c) => c.passed);

let receipt = "# Device Profile Validation\n\n";
receipt += `playwright-core (installed): ${installedVersion}\n`;
receipt += `playwright-core (lockfile): ${lockVersion}\n`;
receipt += `profiles: ${Object.keys(PROFILE_MAP).join(", ")}\n`;
receipt += `registry digest: ${computedDigest}\n`;
receipt += `digest match: ${computedDigest === EXPECTED_DIGEST ? "PASS" : "FAIL"}\n\n`;

receipt += "## Descriptor Snapshots\n\n";
for (const [key, playwrightName] of Object.entries(PROFILE_MAP)) {
  const p = installedProfiles[key];
  receipt += `### ${key} (playwright: "${playwrightName}")\n\n`;
  receipt += `- viewport: ${p.viewport.width}x${p.viewport.height}\n`;
  receipt += `- screen: ${p.screen.width}x${p.screen.height}\n`;
  receipt += `- deviceScaleFactor: ${p.deviceScaleFactor}\n`;
  receipt += `- isMobile: ${p.isMobile}\n`;
  receipt += `- hasTouch: ${p.hasTouch}\n`;
  receipt += `- defaultBrowserType: ${p.defaultBrowserType}\n`;
  receipt += `- userAgent: ${p.userAgent}\n\n`;
}

receipt += "## Checks\n\n";
receipt += checks.map((c) => `- ${c.passed ? "PASS" : "FAIL"} ${c.check}`).join("\n") + "\n";

receipt += `\nVerdict: ${allPassed ? "PASS" : "FAIL"}\n`;

if (!allPassed) {
  process.stderr.write(`VALIDATOR_FAILED=${checks.filter((c) => !c.passed).map((c) => c.check).join(",")}\n`);
  process.exit(1);
}

writeFileSync(".omo/reviews/device-profile-validation.md", receipt, "utf8");
process.exit(0);
