import type { AccountInput, ImportReport } from "../../shared/types.js";

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,;|]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function parseBool(value: unknown, fallback = true): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "enabled", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "disabled", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let current = "";
  let row: string[] = [];
  let quoted = false;

  const pushCell = () => {
    row.push(current);
    current = "";
  };
  const pushRow = () => {
    if (row.length > 1 || row[0]?.trim()) {
      rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === "\"") {
      if (quoted && next === "\"") {
        current += "\"";
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (!quoted && char === ",") {
      pushCell();
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") {
        i += 1;
      }
      pushCell();
      pushRow();
      continue;
    }
    current += char;
  }

  pushCell();
  pushRow();
  if (rows.length === 0) {
    return [];
  }
  const headers = rows[0].map((item) => item.trim());
  return rows.slice(1).map((cells) => {
    const entry: Record<string, string> = {};
    headers.forEach((header, index) => {
      entry[header] = cells[index]?.trim() ?? "";
    });
    return entry;
  });
}

function normalizeInput(row: Record<string, unknown>): AccountInput & { mailConfig?: Record<string, unknown> } {
  const eplusEmail = String(row.eplusEmail ?? row.eplus_email ?? row.email ?? "").trim();
  if (!eplusEmail) {
    throw new Error("Missing eplusEmail/email.");
  }
  const password = String(row.password ?? row.eplusPassword ?? row.eplus_password ?? "").trim();
  if (!password) {
    throw new Error(`Missing password for ${eplusEmail}.`);
  }
  const rawMailConfig = row.mailConfig ?? row.mail_config ?? row.mail_api_config ?? "{}";
  const mailConfig =
    typeof rawMailConfig === "string"
      ? JSON.parse(rawMailConfig || "{}")
      : (rawMailConfig as Record<string, unknown>);

  return {
    label: row.label ? String(row.label).trim() : undefined,
    eplusEmail,
    password,
    mailProviderId: row.mailProviderId ? String(row.mailProviderId) : String(row.mail_provider_id ?? "manual"),
    mailConfig,
    tags: parseTags(row.tags),
    enabled: parseBool(row.enabled, true)
  };
}

export function parseAccountImport(kind: "csv" | "json", text: string): AccountInput[] {
  if (!text.trim()) {
    return [];
  }
  if (kind === "json") {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error("JSON import must be an array of account objects.");
    }
    return parsed.map((row) => normalizeInput(row));
  }
  return parseCsv(text).map((row) => normalizeInput(row));
}

export function summarizeImportRows(rows: AccountInput[]): ImportReport {
  return {
    inserted: rows.length,
    updated: 0,
    skipped: 0,
    errors: []
  };
}

