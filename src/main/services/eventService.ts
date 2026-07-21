import { randomUUID, createHash } from "node:crypto";
import type { EventSnapshotInput } from "../../shared/ipc.js";
import type { EplusRawFormSchema, EventSnapshot } from "../../shared/types.js";
import type { AppDatabase } from "../storage/database.js";
import type { BrowserSessionEngine } from "../engines/browserSessionEngine.js";
import { parseEplusPage } from "./eplusPageParser.js";

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

  async discoverFromUrl(sourceUrl: string): Promise<EventSnapshotInput> {
    const canonicalSource = canonicalizeUrl(sourceUrl);
    const response = await fetch(canonicalSource, {
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ja,en-US;q=0.9,en;q=0.8"
      }
    });
    if (!response.ok) {
      throw new Error(`Eplus page fetch failed: HTTP ${response.status}`);
    }
    const html = await response.text();
    const parsed = parseEplusPage(canonicalSource, html);
    return {
      sourceUrl: parsed.sourceUrl,
      canonicalUrl: parsed.canonicalUrl,
      title: parsed.title,
      venue: parsed.venue,
      scheduleText: parsed.scheduleText,
      applicationDeadline: parsed.applicationDeadline,
      pageFingerprint: parsed.pageFingerprint,
      rawFormSchemaJson: JSON.stringify(parsed.rawFormSchema, null, 2)
    };
  }

  async discoverFromLiveBrowser(engine: BrowserSessionEngine, sourceUrl: string): Promise<EventSnapshot> {
    const canonicalSource = canonicalizeUrl(sourceUrl);
    await engine.navigate(canonicalSource);
    const parsed = parseEplusPage(engine.getCurrentUrl(), await engine.getCurrentHtml());
    return {
      id: randomUUID(),
      sourceUrl: parsed.sourceUrl,
      canonicalUrl: canonicalizeUrl(parsed.canonicalUrl),
      title: parsed.title,
      ...(parsed.venue ? { venue: parsed.venue } : {}),
      ...(parsed.scheduleText ? { scheduleText: parsed.scheduleText } : {}),
      ...(parsed.applicationDeadline ? { applicationDeadline: parsed.applicationDeadline } : {}),
      fetchedAt: new Date().toISOString(),
      rawFormSchema: parsed.rawFormSchema,
      pageFingerprint: parsed.pageFingerprint
    };
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
        ? normalizeSchema(JSON.parse(input.rawFormSchemaJson))
        : ({
            sourceKind: "unknown",
            options: [],
            applicationLinks: [],
            serialCode: {
              required: false,
              label: "抽选码",
              errorSelectors: [],
              knownErrorMessages: []
            },
            selectorHints: {},
            requiresManualInspection: true,
            notes: ["No parser configured yet. Enter the discovered options manually before running tasks."]
          } satisfies EplusRawFormSchema);
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

function normalizeSchema(input: any): EplusRawFormSchema {
  const sourceKind =
    input.sourceKind === "standard-detail" || input.sourceKind === "serial-code" ? input.sourceKind : "unknown";
  return {
    sourceKind,
    options: input.options ?? [],
    applicationLinks: input.applicationLinks ?? [],
    quantityRange: input.quantityRange,
    serialCode: input.serialCode ?? {
      required: false,
      label: "抽选码",
      errorSelectors: [],
      knownErrorMessages: []
    },
    selectorHints: input.selectorHints ?? {},
    requiresManualInspection: Boolean(input.requiresManualInspection),
    notes: input.notes ?? []
  };
}
