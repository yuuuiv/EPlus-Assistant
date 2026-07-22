import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argumentsList = process.argv.slice(2);
const valueAfter = (flag) => {
  const inline = argumentsList.find((argument) => argument.startsWith(`${flag}=`));
  if (inline) return inline.slice(flag.length + 1);
  const index = argumentsList.indexOf(flag);
  return index >= 0 ? argumentsList[index + 1] : undefined;
};
const fixture = valueAfter("--fixture");
const envFile = valueAfter("--env-file");
const allowLiveCredentials = argumentsList.includes("--allow-live-credentials");
const finalSubmit = valueAfter("--final-submit") ?? "false";
const confirmFinalSubmit = argumentsList.includes("--confirm-final-submit");
const recognized = new Set(["--fixture", "--env-file", "--allow-live-credentials", "--final-submit", "--confirm-final-submit", fixture, envFile, finalSubmit, `--final-submit=${finalSubmit}`]);
const unsupported = argumentsList.filter((argument) => !recognized.has(argument));
const fixtureMode = Boolean(fixture);
const liveMode = Boolean(envFile) || allowLiveCredentials;
const fail = (reason) => { process.stderr.write(`LIVE_SMOKE_REJECTED=${reason}\n`); process.exitCode = 1; };

if (unsupported.length > 0 || fixtureMode === liveMode || finalSubmit !== "true" && finalSubmit !== "false") {
  fail("mutually-exclusive-explicit-mode-required");
} else if (fixtureMode && allowLiveCredentials) {
  fail("fixture-mode-forbids-live-credentials");
} else if (liveMode && (!envFile || !allowLiveCredentials)) {
  fail("live-mode-requires-env-file-and-explicit-credential-flag");
} else if (finalSubmit === "true" && !confirmFinalSubmit) {
  fail("final-submit-requires-confirmation-gate");
} else if (finalSubmit === "true") {
  fail("final-submit-authorization-unavailable");
} else if (fixtureMode) {
  const fixturePath = resolve(projectRoot, fixture);
  const relativeFixture = relative(projectRoot, fixturePath);
  if (!relativeFixture || relativeFixture.startsWith("..")) fail("fixture-must-be-project-relative");
  else {
    const html = readFileSync(fixturePath, "utf8");
    if (/(?:password|authorization|cookie|token|@)/i.test(html)) fail("fixture-contains-sensitive-content");
    else process.stdout.write(JSON.stringify({ mode: "fixture", fixture: relativeFixture.replaceAll("\\", "/"), state: "payment_discovery_pending", finalSubmit: false, receipt: "redacted" }) + "\n");
  }
} else {
  const envPath = resolve(projectRoot, envFile);
  const relativeEnv = relative(projectRoot, envPath);
  if (!relativeEnv || relativeEnv.startsWith("..")) fail("env-file-must-be-project-relative");
  else {
    const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
    const values = new Map(lines.flatMap((line) => {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      return match ? [[match[1], match[2]]] : [];
    }));
    if (!values.get("EPLUS_TEST_URL") || !values.get("EPLUS_TEST_EMAIL") || !values.get("EPLUS_TEST_PASSWORD")) fail("live-credentials-incomplete");
    else process.stdout.write(JSON.stringify({ mode: "live", deviceProfile: values.get("EPLUS_DEVICE_PROFILE") ?? "desktop-chrome", state: "pre-navigation", finalSubmit: false, receipt: "redacted" }) + "\n");
  }
}
