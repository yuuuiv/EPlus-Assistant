import type { HarvestImportPayload } from "../../shared/types.js";

/** Normalizes the JSON exported by userscript/eplus-collector.user.js's "导出采集文件" button.
 *  Shape/field validation already happened via the zod schema at the IPC boundary (main/ipc.ts);
 *  this only trims strings and drops fully-empty optional fields before it reaches storage. */
export function normalizeHarvestImport(payload: HarvestImportPayload): HarvestImportPayload {
  const trimmedOrUndefined = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };
  return {
    schemaVersion: 1,
    eplusEmail: payload.eplusEmail.trim(),
    collectedAt: payload.collectedAt,
    profile: {
      phone: trimmedOrUndefined(payload.profile.phone),
      name: trimmedOrUndefined(payload.profile.name),
      nameKana: trimmedOrUndefined(payload.profile.nameKana),
      gender: trimmedOrUndefined(payload.profile.gender),
      birthYear: trimmedOrUndefined(payload.profile.birthYear),
      address: trimmedOrUndefined(payload.profile.address)
    },
    creditCards: payload.creditCards.filter((card) => card.last4),
    companions: payload.companions.filter((companion) => companion.name),
    lotteryRecords: payload.lotteryRecords.filter((record) => record.orderId && record.tourName)
  };
}
