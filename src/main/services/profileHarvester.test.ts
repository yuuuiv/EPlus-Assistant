import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EplusBrowserAdapter } from "../adapters/eplusAdapter.js";
import { BrowserEngineFailure, BrowserSessionEngine } from "../engines/browserSessionEngine.js";
import { AppDatabase } from "../storage/database.js";
import { ProfileHarvester } from "./profileHarvester.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ProfileHarvester", () => {
  it("harvests mocked member pages into profile, companions, and application records", async () => {
    const { database, accountId } = await fixture();
    const { engine, adapter } = browserFixture();
    vi.spyOn(adapter, "readMemberProfile").mockResolvedValue({ name: "Test User", email: "member@example.test", phone: "08012345678", gender: "other", birthday: "2000-01-01", address: "Tokyo" });
    vi.spyOn(adapter, "readCompanions").mockResolvedValue({ companions: [{ name: "Current" }], pastCompanions: [{ name: "Past" }] });
    vi.spyOn(adapter, "readApplicationHistory").mockResolvedValue([{ eventTitle: "Concert", appliedAt: "2026-07-21T00:00:00.000Z", ticketType: "General", quantity: 2, applicationId: "application-1", status: "Pending" }]);

    const result = await new ProfileHarvester(engine, adapter, database).harvest({ accountId, existingSession: true });

    expect(result.status).toBe("Ok");
    expect(database.getProfile(accountId)).toMatchObject({ name: "Test User", phone: "08012345678", companions: [{ name: "Current" }] });
    expect(database.listApplicationRecords(accountId)).toMatchObject([{ eventTitle: "Concert", applicationId: "application-1" }]);
  });

  it("preserves prior good profile values when a field is absent", async () => {
    const { database, accountId } = await fixture();
    database.upsertProfile({ accountId, eplusEmail: "member@example.test", encryptedPassword: "encrypted", revealSupported: false, name: "Prior Name", phone: "08099999999", companions: [], pastCompanions: [], harvestedAt: "2026-01-01T00:00:00.000Z", harvestStatus: "Ok" });
    const { engine, adapter } = browserFixture();
    vi.spyOn(adapter, "readMemberProfile").mockResolvedValue({ email: "member@example.test", phone: "08012345678" });
    vi.spyOn(adapter, "readCompanions").mockResolvedValue({ companions: [], pastCompanions: [] });
    vi.spyOn(adapter, "readApplicationHistory").mockResolvedValue([]);

    const result = await new ProfileHarvester(engine, adapter, database).harvest({ accountId, existingSession: true });

    expect(result.status).toBe("Partial");
    expect(database.getProfile(accountId)).toMatchObject({ name: "Prior Name", phone: "08012345678" });
  });

  it("records awaiting manual action when a CAPTCHA interrupts harvesting", async () => {
    const { database, accountId } = await fixture();
    const { engine, adapter } = browserFixture();
    vi.spyOn(adapter, "openMemberProfile").mockRejectedValue(new BrowserEngineFailure("ManualTakeoverRequired", "CAPTCHA"));

    const result = await new ProfileHarvester(engine, adapter, database).harvest({ accountId, existingSession: true });

    expect(result.status).toBe("AwaitingManualAction");
    expect(database.getProfileHarvestRun(result.runId)?.status).toBe("AwaitingManualAction");
  });

  it("returns partial data without discarding profile values when a member page is missing", async () => {
    const { database, accountId } = await fixture();
    database.upsertProfile({ accountId, eplusEmail: "member@example.test", encryptedPassword: "encrypted", revealSupported: false, address: "Prior address", companions: [], pastCompanions: [], harvestedAt: "2026-01-01T00:00:00.000Z", harvestStatus: "Ok" });
    const { engine, adapter } = browserFixture();
    vi.spyOn(adapter, "openMemberProfile").mockRejectedValue(new Error("Member page missing"));
    vi.spyOn(adapter, "readCompanions").mockResolvedValue({ companions: [], pastCompanions: [] });
    vi.spyOn(adapter, "readApplicationHistory").mockResolvedValue([]);

    const result = await new ProfileHarvester(engine, adapter, database).harvest({ accountId, existingSession: true });

    expect(result.status).toBe("Partial");
    expect(database.getProfile(accountId)?.address).toBe("Prior address");
  });

  it("does not contain site-password extraction behavior", async () => {
    const source = await readFile(path.join(process.cwd(), "src", "main", "services", "profileHarvester.ts"), "utf8");

    expect(source).not.toContain("revealSitePassword");
    expect(source).not.toContain("sitePassword");
  });

  it("persists a completed harvest run", async () => {
    const { database, accountId } = await fixture();
    const { engine, adapter } = browserFixture();
    vi.spyOn(adapter, "readMemberProfile").mockResolvedValue({ name: "Test User", email: "member@example.test", phone: "08012345678", gender: "other", birthday: "2000-01-01", address: "Tokyo" });
    vi.spyOn(adapter, "readCompanions").mockResolvedValue({ companions: [], pastCompanions: [] });
    vi.spyOn(adapter, "readApplicationHistory").mockResolvedValue([]);

    const result = await new ProfileHarvester(engine, adapter, database).harvest({ accountId, existingSession: true });

    expect(database.getProfileHarvestRun(result.runId)).toMatchObject({ status: "Completed", harvestedFields: expect.arrayContaining(["name", "applicationRecords"]) });
  });
});

async function fixture(): Promise<{ database: AppDatabase; accountId: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eplus-profile-harvester-"));
  directories.push(directory);
  const database = new AppDatabase(directory);
  await database.open();
  const account = database.upsertAccount({ eplusEmail: "member@example.test", password: "unused", encryptedPassword: "encrypted", encryptedMailConfig: "mail" });
  return { database, accountId: account.id };
}

function browserFixture(): { engine: BrowserSessionEngine; adapter: EplusBrowserAdapter } {
  const engine = Object.create(BrowserSessionEngine.prototype) as BrowserSessionEngine;
  vi.spyOn(engine, "isSessionActive").mockReturnValue(true);
  vi.spyOn(engine, "reuseSession").mockResolvedValue(true);
  const adapter = Object.create(EplusBrowserAdapter.prototype) as EplusBrowserAdapter;
  vi.spyOn(adapter, "openMemberProfile").mockResolvedValue();
  vi.spyOn(adapter, "openCompanionManagement").mockResolvedValue();
  vi.spyOn(adapter, "openApplicationHistory").mockResolvedValue();
  return { engine, adapter };
}
