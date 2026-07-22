import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestPrefix = "npx vitest run ";

const exactCommands = new Set([
  "npm run typecheck",
  "npm test",
  "npm run build",
  "node scripts/scan-payment-device-policy.mjs --production src --fixtures tests/fixtures --evidence .omo/reviews --exclude tests/fixtures/har-sensitive-fixture.har --exclude tests/fixtures/volatile-public-fixture.html",
  "node scripts/validate-device-profiles.mjs --package-version-from package-lock.json --expected desktop-chrome,iphone-13,pixel-7"
]);

const commands = [
  ["npm", ["run", "typecheck"]],
  ["npm", ["test"]],
  ["npm", ["run", "build"]],
  ["npx", ["vitest", "run", "src/main/fixtures/paymentDeviceContract.test.ts", "src/main/services/eplusPageParser.test.ts", "src/main/services/runtimePaymentDiscovery.test.ts", "src/main/services/taskService.test.ts", "src/main/adapters/eplusAdapter.test.ts", "src/main/engines/browserSessionEngine.test.ts", "tests/renderer/workflow.test.ts"]],
  ["node", ["scripts/scan-payment-device-policy.mjs", "--production", "src", "--fixtures", "tests/fixtures", "--evidence", ".omo/reviews", "--exclude", "tests/fixtures/har-sensitive-fixture.har", "--exclude", "tests/fixtures/volatile-public-fixture.html"]],
  ["node", ["scripts/validate-device-profiles.mjs", "--package-version-from", "package-lock.json", "--expected", "desktop-chrome,iphone-13,pixel-7"]]
];

function commandName(executable, argumentsList) {
  return [executable, ...argumentsList].join(" ");
}

function isAllowedCommand(command) {
  if (exactCommands.has(command)) {
    return true;
  }

  if (command.startsWith(vitestPrefix)) {
    const testPaths = command.slice(vitestPrefix.length).split(" ");
    return testPaths.length > 0 && testPaths.every((testPath) => testPath.length > 0 && !testPath.startsWith("-"));
  }

  return false;
}

function outputPathFrom(argumentsList) {
  const outFlagCount = argumentsList.filter((argument) => argument === "--out").length;
  if (argumentsList.length !== 2 || argumentsList[0] !== "--out" || outFlagCount !== 1 || argumentsList[1].startsWith("-")) {
    return undefined;
  }

  const outputPath = argumentsList[1];
  if (isAbsolute(outputPath)) {
    return undefined;
  }

  const resolvedPath = resolve(projectRoot, outputPath);
  const pathFromRoot = relative(projectRoot, resolvedPath);
  return pathFromRoot && !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot) ? resolvedPath : undefined;
}

function stdoutSummary(stdout) {
  const summary = stdout.trim();
  return summary.length > 500 ? `${summary.slice(0, 500)}...` : summary;
}

function stripAnsi(text) {
  return text.replace(new RegExp("\\x1b\\[[0-9;]*m", "g"), "");
}

/**
 * Detect whether a Vitest run passed but skipped every test.
 * Returns an error message string, or null if the run is valid.
 */
function vitestAllSkippedError(output) {
  const clean = stripAnsi(output);
  // File-level: test file marked as skipped (no tests matched)
  if (/Test Files\s+\d+\s+skipped/.test(clean)) {
    return "Vitest run passed but all test files were skipped (no test names matched the filter).";
  }
  // Test-level: all tests skipped, zero passed
  if (/Tests\s+0\s+passed/.test(clean) || (!/Tests\s+\d+\s+passed/.test(clean) && /Tests\s+\d+\s+skipped/.test(clean))) {
    return "Vitest run passed but all tests were skipped (zero assertions executed).";
  }
  return null;
}


function spawnCommand(executable, argumentsList) {
  if (process.platform !== "win32" || (executable !== "npm" && executable !== "npx")) {
    return spawnSync(executable, argumentsList, { cwd: projectRoot, encoding: "utf8", shell: false });
  }
  return spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", [executable, ...argumentsList].join(" ")], { cwd: projectRoot, encoding: "utf8", shell: false });
}

function receiptMarkdown(results) {
  const passed = results.every((result) => result.exitCode === 0);
  const lines = [
    "# Quality Gate Receipt",
    "",
    `Total: **${passed ? "PASS" : "FAIL"}**`,
    "",
    "## Expected Artifacts",
    "",
    "- `tests/fixtures/sanitized-payment-device.har`",
    "- `tests/fixtures/sanitized-payment-device.har.sha256`",
    "- `.omo/reviews/payment-device-policy-scan.md`",
    "- `.omo/reviews/device-profile-validation.md`",
    ""
  ];

  for (const result of results) {
    lines.push(`## \`${result.command}\``, "", `Exit code: ${result.exitCode}`, "", "Stdout summary:", "", "```text", result.stdout || "(no stdout)", "```", "");
  }

  return `${lines.join("\n")}\n`;
}

function writeReceipt(outputPath, results) {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, receiptMarkdown(results), "utf8");
}

const outputPath = outputPathFrom(process.argv.slice(2));
if (!outputPath) {
  process.exitCode = 1;
} else {
  const results = [];
  writeReceipt(outputPath, results);

  for (const [executable, argumentsList] of commands) {
    const command = commandName(executable, argumentsList);
    if (!isAllowedCommand(command)) {
      results.push({ command, exitCode: 1, stdout: "Command is not in the quality-gate allowlist." });
      break;
    }

    const result = spawnCommand(executable, argumentsList);
    let exitCode = result.status ?? 1;
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`;

    // Fail-closed: reject Vitest commands where all tests were skipped
    const skippedError = vitestAllSkippedError(output);
    if (exitCode === 0 && skippedError) {
      exitCode = 1;
      results.push({ command, exitCode, stdout: `${stdoutSummary(output)}\n\nQUALITY_GATE_REJECTED: ${skippedError}` });
      break;
    }

    results.push({ command, exitCode, stdout: stdoutSummary(output) });

    if (exitCode !== 0) {
      break;
    }
  }

  writeReceipt(outputPath, results);
  process.exitCode = results.every((result) => result.exitCode === 0) ? 0 : 1;
}
