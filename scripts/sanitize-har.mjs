import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sensitiveKey = /(?:authorization|cookie|token|password|credential|secret|jwt|card|cvv|phone|email|verification|code)/i;
const sensitiveValue = /(?:bearer\s+|basic\s+|eyJ[A-Za-z0-9_-]{10,}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:\d[ -]?){12,19}\b)/i;
const approvedContentTypes = new Set(["text/html", "application/json"]);
const normalizedPublicHtml = "<main data-offline-evidence=\"public-response\"></main>";

function fail(reason) {
  process.stderr.write(`SANITIZER_REJECTED=${reason}\n`);
  process.exitCode = 1;
}

function safeProjectPath(value) {
  const resolved = resolve(projectRoot, value);
  const pathFromRoot = relative(projectRoot, resolved);
  return pathFromRoot && !pathFromRoot.startsWith("..") ? resolved : undefined;
}

function sensitiveClass(value) {
  if (typeof value === "string") {
    if (sensitiveKey.test(value)) return "sensitive-field";
    return sensitiveValue.test(value) ? "sensitive-value" : undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, nested] of Object.entries(value)) {
    if (sensitiveKey.test(key)) return "sensitive-field";
    if (key === "name" && typeof nested === "string" && sensitiveKey.test(nested)) return "sensitive-field";
    const nestedClass = sensitiveClass(nested);
    if (nestedClass) return nestedClass;
  }
  return undefined;
}

function classifyRoute(rawUrl) {
  const url = new URL(rawUrl);
  if (url.pathname.includes("/sf/detail/")) return "detail";
  if (url.pathname.includes("/application") || url.pathname.includes("/entry")) return "application-entry";
  if (/\.(?:css|js|png|jpg|jpeg|svg|webp)$/i.test(url.pathname)) return "static-public";
  return undefined;
}

function isJson(value) {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function structurallySafeFallback(entry) {
  const status = Number(entry.response?.status ?? 0);
  const content = entry.response?.content;
  if (status < 200 || status >= 300 || !content) return undefined;
  const decoded = decodeText(content);
  if (decoded === undefined) return undefined;
  const trimmed = decoded.trim();
  if (/^(?:<!doctype html[^>]*>\s*)?<html\b/i.test(trimmed)) return { routeClass: "detail", contentType: "text/html", publicHtmlFragment: normalizedPublicHtml };
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && isJson(trimmed)) return { routeClass: "application-entry", contentType: "application/json" };
  return undefined;
}

function decodeText(content) {
  if (typeof content?.text !== "string") return undefined;
  if (!content.encoding) return content.text;
  if (content.encoding !== "base64") throw new Error("unknown-encoding");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content.text)) throw new Error("invalid-base64");
  return Buffer.from(content.text, "base64").toString("utf8");
}

function sanitizeEntry(entry, inspection) {
  inspection.total += 1;
  const routeClass = classifyRoute(entry.request?.url ?? "");
  const contentType = String(entry.response?.content?.mimeType ?? "").split(";", 1)[0].toLowerCase();
  const fallback = !routeClass || !approvedContentTypes.has(contentType) ? structurallySafeFallback(entry) : undefined;
  if (!routeClass && !fallback) {
    inspection.unapprovedRoute += 1;
    return undefined;
  }
  if (!approvedContentTypes.has(contentType) && !fallback) {
    inspection.unapprovedContentType += 1;
    return undefined;
  }
  const decoded = fallback ? undefined : decodeText(entry.response?.content);
  const decodedClass = decoded === undefined ? undefined : sensitiveClass(decoded);
  if (decodedClass) throw new Error(`retained-payload-${decodedClass}`);
  const viewport = entry.pageref ? { pageRef: "public-page" } : undefined;
  const result = { method: String(entry.request?.method ?? "GET").toUpperCase(), routeClass: fallback?.routeClass ?? routeClass, status: Number(entry.response?.status ?? 0), contentType: fallback?.contentType ?? contentType };
  if (viewport) result.viewport = viewport;
  if (fallback?.publicHtmlFragment) result.publicHtmlFragment = fallback.publicHtmlFragment;
  else if (contentType === "text/html" && decoded !== undefined) result.publicHtmlFragment = decoded.replace(/\s+/g, " ").trim().slice(0, 2048);
  return result;
}

const [flag, inputArgument, outputArgument, ...unexpected] = process.argv.slice(2);
const inputPath = inputArgument && safeProjectPath(inputArgument);
const outputPath = outputArgument && safeProjectPath(outputArgument);
if (flag !== "--offline-evidence-input" || !inputPath || !outputPath || unexpected.length > 0) {
  process.stderr.write("SANITIZER_REJECTED=explicit-offline-arguments-required\n");
  process.exitCode = 1;
} else {
  try {
    const raw = readFileSync(inputPath, "utf8");
    const parsed = JSON.parse(raw);
    const entries = parsed.log?.entries;
    if (!Array.isArray(entries)) throw new Error("invalid-har-entries");
    const inspection = { total: 0, unapprovedRoute: 0, unapprovedContentType: 0 };
    const sanitizedEntries = [];
    const retainedRouteClasses = new Set();
    for (const entry of entries) {
      const sanitized = sanitizeEntry(entry, inspection);
      if (!sanitized || retainedRouteClasses.has(sanitized.routeClass)) continue;
      retainedRouteClasses.add(sanitized.routeClass);
      sanitizedEntries.push(sanitized);
    }
    if (sanitizedEntries.length === 0) throw new Error(`no-approved-public-entries(total=${inspection.total},route=${inspection.unapprovedRoute},content-type=${inspection.unapprovedContentType})`);
    const output = JSON.stringify({ format: "sanitized-payment-device-har-v1", entries: sanitizedEntries }, null, 2) + "\n";
    const outputDetected = sensitiveClass(output);
    if (outputDetected) throw new Error(outputDetected);
    writeFileSync(outputPath, output, "utf8");
    const sha256 = createHash("sha256").update(output).digest("hex");
    writeFileSync(`${outputPath}.sha256`, JSON.stringify({ algorithm: "sha256", fixture: relative(projectRoot, outputPath).replaceAll("\\", "/"), sha256 }, null, 2) + "\n", "utf8");
    process.stdout.write(`SANITIZED_HAR=${relative(projectRoot, outputPath).replaceAll("\\", "/")}\nSHA256=${sha256}\n`);
  } catch (error) {
    fail(error instanceof Error ? error.message : "invalid-har");
  }
}
