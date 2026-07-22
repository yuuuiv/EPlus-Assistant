import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const expected = ["--production", "src", "--fixtures", "tests/fixtures", "--evidence", ".omo/reviews", "--exclude", "tests/fixtures/har-sensitive-fixture.har", "--exclude", "tests/fixtures/volatile-public-fixture.html"];
if (process.argv.slice(2).join("\u0000") !== expected.join("\u0000")) process.exit(1);

const root = process.cwd();
const excluded = new Set(expected.filter((argument, index) => expected[index - 1] === "--exclude"));
const prohibited = [/\beval\s*\(/u, /\bonclick\s*=/u, /sp\.gesicht\.eplus\.jp\.har/u];
const sensitive = [/\b(?:authorization|cookie)\b\s*[:=]/iu, /\bbearer\s+[A-Za-z0-9._-]+/iu, /\beyJ[A-Za-z0-9_-]{10,}/u, /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/u, /\b(?:\d[ -]?){12,19}\b/u];
const productionFiles = collect(resolve(root, "src"), (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
const fixtureFiles = collect(resolve(root, "tests", "fixtures"), (file) => !excluded.has(relative(root, file).replaceAll("\\", "/")));
const prohibitedViolations = productionFiles.flatMap((file) => {
  const content = readFileSync(file, "utf8");
  return prohibited.flatMap((pattern) => pattern.test(content) ? [`${relative(root, file)}:${pattern.source}`] : []);
});
const sensitiveMatches = fixtureFiles.flatMap((file) => {
  const content = readFileSync(file, "utf8");
  return sensitive.flatMap((pattern) => pattern.test(content) ? [`${relative(root, file)}:${pattern.source}`] : []);
});
const report = [
  "# Payment Device Policy Scan",
  "",
  `Production files scanned: ${productionFiles.length}`,
  `Fixture files scanned: ${fixtureFiles.length}`,
  `Excluded negative fixtures: ${[...excluded].join(", ")}`,
  `SENSITIVE_MATCHES=${sensitiveMatches.length}`,
  `PROHIBITED_AUTOMATION_MATCHES=${prohibitedViolations.length}`,
  "",
  "## Sensitive Matches",
  ...(sensitiveMatches.length === 0 ? ["None"] : sensitiveMatches),
  "",
  "## Prohibited Automation Matches",
  ...(prohibitedViolations.length === 0 ? ["None"] : prohibitedViolations),
  ""
].join("\n");
writeFileSync(resolve(root, ".omo/reviews/payment-device-policy-scan.md"), report, "utf8");
process.stdout.write(`SENSITIVE_MATCHES=${sensitiveMatches.length}\nPROHIBITED_AUTOMATION_MATCHES=${prohibitedViolations.length}\n`);
if (sensitiveMatches.length > 0 || prohibitedViolations.length > 0) process.exit(1);

function collect(directory, include) {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? collect(path, include) : include(path) ? [path] : [];
  });
}
