const EMAIL_PATTERN = /([A-Z0-9._%+-]{1,3})[A-Z0-9._%+-]*(@[A-Z0-9.-]+\.[A-Z]{2,})/gi;
const CODE_PATTERN = /\b\d{4,8}\b/g;
const TOKEN_PATTERN = /\b[A-Za-z0-9_-]{24,}\b/g;

export function maskEmail(email: string): string {
  return email.replace(EMAIL_PATTERN, (_match, head: string, domain: string) => `${head}***${domain}`);
}

export function redactText(value: string): string {
  return value
    .replace(EMAIL_PATTERN, (_match, head: string, domain: string) => `${head}***${domain}`)
    .replace(CODE_PATTERN, "[code-redacted]")
    .replace(TOKEN_PATTERN, "[token-redacted]");
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

