import { randomUUID, createHash } from "node:crypto";
import type { EventSnapshot } from "../../shared/types.js";
import type { AppDatabase } from "../storage/database.js";

function canonicalizeUrl(input: string): string {
  const url = new URL(input);
  if (!/(^|\.)eplus\.jp$/i.test(url.hostname)) {
    throw new Error("Only eplus.jp URLs are accepted for lottery snapshots.");
  }
  url.hash = "";
  return url.toString();
}

function makeFingerprint(payload: string): string {
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export class EventService {
  constructor(private readonly db: AppDatabase) {}

  listEvents(): EventSnapshot[] {
    return this.db.listEvents();
  }

  saveSnapshot(input: {
    sourceUrl: string;
    canonicalUrl?: string;
    title: string;
    venue?: string;
    scheduleText?: string;
    applicationDeadline?: string;
    pageFingerprint?: string;
    rawFormSchemaJson?: string;
  }): EventSnapshot {
    const canonicalUrl = input.canonicalUrl ? canonicalizeUrl(input.canonicalUrl) : canonicalizeUrl(input.sourceUrl);
    const rawFormSchema =
      input.rawFormSchemaJson?.trim()
        ? JSON.parse(input.rawFormSchemaJson)
        : {
            options: [],
            requiresManualInspection: true,
            notes: ["No parser configured yet. Enter the discovered options manually before running tasks."]
          };
    const snapshot: EventSnapshot = {
      id: randomUUID(),
      sourceUrl: input.sourceUrl,
      canonicalUrl,
      title: input.title,
      venue: input.venue,
      scheduleText: input.scheduleText,
      applicationDeadline: input.applicationDeadline,
      fetchedAt: new Date().toISOString(),
      rawFormSchema,
      pageFingerprint: input.pageFingerprint ?? makeFingerprint(`${canonicalUrl}|${input.title}`)
    };
    return this.db.saveEventSnapshot(snapshot);
  }
}
