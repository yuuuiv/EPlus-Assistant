import type { PaymentDiscoveryCheckpoint, PaymentOptionGroup, RuntimePaymentOption } from "./types.js";

export function isSelectableOption(option: RuntimePaymentOption): boolean {
  return option.enabled && option.supported && !option.ambiguous;
}

export function selectableGroups(groups: readonly PaymentOptionGroup[]): PaymentOptionGroup[] {
  return groups.filter((group) => group.options.some(isSelectableOption));
}

export function selectableCandidateGroups(checkpoint: PaymentDiscoveryCheckpoint): PaymentOptionGroup[] {
  return selectableGroups(checkpoint.groups);
}
