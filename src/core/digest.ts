import { createHash } from "node:crypto";
import type { LotteryPreference } from "../shared/types.js";

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function makeConfirmationDigest(input: {
  canonicalUrl: string;
  preference: LotteryPreference;
  accountIds: string[];
  confirmationPolicy?: "required" | "disabled";
  automationRiskAcknowledgementVersion?: number;
}): string {
  const confirmationInput = {
    canonicalUrl: input.canonicalUrl,
    preference: input.preference,
    accountIds: [...input.accountIds].sort(),
    ...(input.confirmationPolicy === undefined ? {} : { confirmationPolicy: input.confirmationPolicy }),
    ...(input.automationRiskAcknowledgementVersion === undefined
      ? {}
      : { automationRiskAcknowledgementVersion: input.automationRiskAcknowledgementVersion })
  };

  return createHash("sha256")
    .update(stableJson(confirmationInput))
    .digest("hex");
}

export function makeIdempotencyKey(input: {
  accountId: string;
  canonicalUrl: string;
  preference: LotteryPreference;
}): string {
  return createHash("sha256")
    .update(stableJson(input))
    .digest("hex");
}

export function makePreferencesEqual(left: LotteryPreference, right: LotteryPreference): boolean {
  return stableJson(left) === stableJson(right);
}
