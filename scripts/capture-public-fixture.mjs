import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sensitive = /(?:bearer\s+|basic\s+|eyJ[A-Za-z0-9_-]{10,}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:\d[ -]?){12,19}\b)/i;
const volatile = /(?:data-volatile|nonce-[A-Za-z0-9_-]+|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}|\b(?:timestamp|request-id|trace-id)\s*[=:])/i;

function safeProjectPath(value) {
  const resolved = resolve(projectRoot, value);
  const pathFromRoot = relative(projectRoot, resolved);
  return pathFromRoot && !pathFromRoot.startsWith("..") ? resolved : undefined;
}

function canonicalize(html) {
  if (volatile.test(html)) throw new Error("nondeterministic-public-html");
  const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "Public event detail";
  const title = rawTitle.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const canonical = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${title}</title></head><body><main data-public-fixture="detail"></main></body></html>\n`;
  if (sensitive.test(canonical)) throw new Error("sensitive-public-html");
  return canonical;
}

const argumentsList = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = argumentsList.indexOf(flag);
  return index >= 0 ? argumentsList[index + 1] : undefined;
};
const fixtureArgument = valueAfter("--fixture");
const urlArgument = valueAfter("--url");
const outputArgument = valueAfter("--out");
const canonicalizeRequested = argumentsList.includes("--canonicalize");
const expectedLength = fixtureArgument ? 5 : 5;
const allowed = canonicalizeRequested && argumentsList.length === expectedLength && Boolean(outputArgument) && Boolean(fixtureArgument) !== Boolean(urlArgument);
const outputPath = outputArgument && safeProjectPath(outputArgument);
if (!allowed || !outputPath) {
  process.stderr.write("CAPTURE_REJECTED=explicit-single-source-and-canonicalize-required\n");
  process.exitCode = 1;
} else {
  try {
    const html = fixtureArgument ? readFileSync(safeProjectPath(fixtureArgument) ?? "", "utf8") : await fetch(urlArgument).then(async (response) => {
      if (!response.ok) throw new Error("public-capture-failed");
      return response.text();
    });
    const canonical = canonicalize(html);
    writeFileSync(outputPath, canonical, "utf8");
    process.stdout.write(`PUBLIC_FIXTURE=${relative(projectRoot, outputPath).replaceAll("\\", "/")}\nSHA256=${createHash("sha256").update(canonical).digest("hex")}\n`);
  } catch (error) {
    process.stderr.write(`CAPTURE_REJECTED=${error instanceof Error ? error.message : "invalid-public-html"}\n`);
    process.exitCode = 1;
  }
}
