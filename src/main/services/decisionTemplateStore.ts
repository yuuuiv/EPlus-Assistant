import type { PaymentOptionGroup } from "../../shared/types.js";
import { isSelectableOption, selectableGroups } from "../../shared/paymentOptions.js";

export interface DecisionTemplateEntry {
  readonly groupKey: string;
  readonly domValue: string;
  readonly label: string;
}

export interface SettingsStore {
  getSetting<T>(key: string): T | undefined;
  setSetting(key: string, value: unknown): void;
}

function settingKey(taskId: string, templateKey: string): string {
  return `decision-template:${taskId}:${templateKey}`;
}

/**
 * Persists which runtime-discovered candidate a human picked for a given task + entry/day,
 * so later runs of the same task (Day2, other serial codes, other accounts) can auto-apply
 * the same choice instead of pausing for a human every time. Matching is by (groupKey,
 * domValue) - the stable DOM value/label pair - never by the per-run ephemeral candidateId.
 */
export class DecisionTemplateStore {
  constructor(private readonly db: SettingsStore) {}

  save(taskId: string, templateKey: string, selections: readonly DecisionTemplateEntry[]): void {
    this.db.setSetting(settingKey(taskId, templateKey), selections);
  }

  match(taskId: string, templateKey: string, groups: readonly PaymentOptionGroup[]): readonly string[] | undefined {
    const template = this.db.getSetting<DecisionTemplateEntry[]>(settingKey(taskId, templateKey));
    if (!template || template.length === 0) return undefined;
    const candidates = selectableGroups(groups);
    if (candidates.length === 0) return undefined;
    const candidateIds: string[] = [];
    for (const group of candidates) {
      const entry = template.find((item) => item.groupKey === group.groupKey);
      if (!entry) return undefined;
      const matches = group.options.filter((option) => option.domValue === entry.domValue && isSelectableOption(option));
      if (matches.length !== 1) return undefined;
      const match = matches[0];
      if (!match) return undefined;
      candidateIds.push(match.candidateId);
    }
    return candidateIds;
  }
}
