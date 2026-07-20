import * as cheerio from "cheerio";

const EMAIL_PATTERN = /([A-Z0-9._%+-]{1,3})[A-Z0-9._%+-]*(@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
const CODE_PATTERN = /\b\d{4,8}\b/g;
const TOKEN_PATTERN = /\b[A-Za-z0-9_-]{24,}\b/g;
const IP_PATTERN = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const PHONE_PATTERN = /\b\d{10,11}\b/g;

export function maskEmail(email: string): string {
  return email.replace(EMAIL_PATTERN, (_match, head: string, domain: string) => `${head}***${domain}`);
}

export function maskPhone(phone: string): string {
  return phone.length <= 7 ? "*".repeat(phone.length) : `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

export function maskIp(ip: string): string {
  const segments = ip.split(".");
  return segments.length === 4 ? `${segments[0]}.${segments[1]}.***.***` : "[ip-redacted]";
}

export function maskApplicationId(id: string): string {
  return id.length <= 4 ? "*".repeat(id.length) : `${"*".repeat(id.length - 4)}${id.slice(-4)}`;
}

export function maskName(name: string): string {
  return name.length <= 2 ? `${name.slice(0, 1)}${"*".repeat(Math.max(0, name.length - 1))}` : `${name.slice(0, 2)}***`;
}

export function sanitizeDom(html: string, maskSelectors: readonly string[] = []): string {
  const $ = cheerio.load(html);
  $("input").each((_index, element) => {
    $(element).removeAttr("value").removeAttr("checked");
  });
  $("textarea").text("");
  $("select").each((_index, element) => {
    $(element).removeAttr("value");
    $(element).find("option").removeAttr("selected");
  });
  for (const selector of maskSelectors) {
    const matches = $(selector);
    if (matches.length === 0) {
      throw new Error(`Artifact mask selector did not match: ${selector}`);
    }
    matches.text("[redacted]");
    if (matches.toArray().some((element) => $(element).text() !== "[redacted]")) {
      throw new Error(`Artifact mask selector could not be verified: ${selector}`);
    }
  }
  return redactText($.html());
}

export function redactAccountValues(text: string, values: readonly string[]): string {
  return values.filter((value) => value.length > 0).reduce((redacted, value) => redacted.replace(new RegExp(escapeRegExp(value), "g"), "[redacted]"), text);
}

export function redactText(value: string): string {
  return value
    .replace(EMAIL_PATTERN, (_match, head: string, domain: string) => `${head}***${domain}`)
    .replace(CODE_PATTERN, "[code-redacted]")
    .replace(TOKEN_PATTERN, "[token-redacted]")
    .replace(IP_PATTERN, "[ip-redacted]")
    .replace(PHONE_PATTERN, "[phone-redacted]");
}

export function redactObject<T>(input: T): T {
  if (typeof input === "string") {
    return redactText(input) as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactObject(item)) as T;
  }

  if (input && typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (/password|token|secret|code|cvv|card/i.test(key)) {
        output[key] = "[redacted]";
      } else {
        output[key] = redactObject(value);
      }
    }
    return output as T;
  }

  return input;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
