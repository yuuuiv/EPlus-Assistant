export type AccountStatus = "Unknown" | "Ok" | "PasswordError" | "Locked" | "MailError";

export interface Account {
  id: string;
  label: string;
  eplusEmail: string;
  mailProviderId: string;
  tags: string[];
  enabled: boolean;
  lastLoginAt?: string;
  lastLoginStatus: AccountStatus;
  createdAt: string;
  updatedAt: string;
  /** When this account's profile info was last refreshed via a harvest-file import
   *  (AccountProfile.harvestedAt). Undefined when the account has never been harvested -
   *  distinct from `updatedAt`, which only tracks the accounts-table row itself and doesn't
   *  move on a harvest import for an already-existing account. */
  profileUpdatedAt?: string;
}

export interface AccountInput {
  label?: string;
  eplusEmail: string;
  password: string;
  mailProviderId?: string;
  mailConfig?: Record<string, unknown>;
  tags?: string[];
  enabled?: boolean;
}

export interface PasswordRevealRequest {
  accountId: string;
  senderWindowId: string;
  requestId: string;
}

export type PasswordRevealHandle = PasswordRevealRequest;

export interface PasswordRevealResponse {
  plaintext: string;
  expiresAt: string;
}

export interface Companion {
  companionId?: string;
  name: string;
  relationship?: string;
  memberId?: string;
  maskedEmail?: string;
  boundAt?: string;
  approvedAt?: string;
  unboundAt?: string;
}

export interface CreditCardSummary {
  creditCardId?: string;
  brand?: string;
  /** Only non-sensitive card metadata is stored; PAN/CVV/expiry are never persisted. */
  last4: string;
  holder?: string;
  expireMonth?: string;
  expireYear?: string;
  updatedAt?: string;
}

export interface AccountProfile {
  accountId: string;
  eplusEmail: string;
  encryptedPassword: string;
  revealSupported: boolean;
  phone?: string;
  name?: string;
  nameKana?: string;
  gender?: string;
  birthYear?: string;
  address?: string;
  creditCards?: CreditCardSummary[];
  companions: Companion[];
  pastCompanions: Companion[];
  harvestedAt: string;
  harvestStatus: "Pending" | "Ok" | "Partial" | "Failed";
}

/** One 抽選 (lottery) application row from https://eplus.jp/jyoukyou, collected by the browser
 *  userscript (userscript/eplus-collector.user.js) - not automated login/harvest. `status`/
 *  `statusDetail` are the site's own free-text labels (e.g. 当選/落選/抽選前/無効), not a closed
 *  enum, since the real vocabulary is broader than what any fixed set could guess. */
export interface LotteryRecord {
  id: string;
  accountId: string;
  orderId: string;
  tourName: string;
  eventDatetime?: string;
  venueName?: string;
  receptionName?: string;
  orderDatetime?: string;
  status: string;
  statusDetail?: string;
  detailUrl?: string;
  harvestedAt: string;
}

export interface AuditLog {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ImportReport {
  inserted: number;
  updated: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
}

/** The JSON shape exported by userscript/eplus-collector.user.js's "导出采集文件" button. */
export interface HarvestImportPayload {
  schemaVersion: 1;
  eplusEmail: string;
  collectedAt: string;
  profile: {
    phone?: string;
    name?: string;
    nameKana?: string;
    gender?: string;
    birthYear?: string;
    address?: string;
  };
  creditCards: CreditCardSummary[];
  companions: Companion[];
  lotteryRecords: Array<{
    orderId: string;
    tourName: string;
    eventDatetime?: string;
    venueName?: string;
    receptionName?: string;
    orderDatetime?: string;
    status: string;
    statusDetail?: string;
    detailUrl?: string;
  }>;
}

export interface ImportHarvestResult {
  accountId: string;
  accountCreated: boolean;
  report: ImportReport;
}

export interface DashboardState {
  accounts: Account[];
  logs: AuditLog[];
  dataDir: string;
}

/** Whether a lottery record's free-text status reads as a win, a loss, or neither (still
 *  pending, invalidated, etc). Derived from the site's own vocabulary (当選/落選), not stored. */
export type LotteryOutcome = "won" | "lost" | "pending";

/** One performance (公演), grouped from all lottery records that share the same tour + event
 *  date/time. A two-day tour's two days are two separate groups since eventDatetime differs;
 *  the same performance can still carry multiple lottery records (repeat/extra applications). */
export interface PerformanceHistory {
  performanceKey: string;
  tourName: string;
  eventDatetime?: string;
  venueName?: string;
  receptionName?: string;
  records: LotteryRecord[];
  lastRecord: LotteryRecord;
  lastOutcome: LotteryOutcome;
  wonAtLeastOnce: boolean;
}

export interface AccountLotteryStats {
  /** Count of individual lottery records whose status reads as a win - i.e. how many times this
   *  account has actually won a drawing (a performance drawn for more than once can contribute
   *  more than one win here). */
  winCount: number;
  /** Count of distinct performances this account has ever drawn for. */
  distinctPerformanceCount: number;
  /** Count of distinct performances where at least one draw for it was a win. */
  wonPerformanceCount: number;
  /** wonPerformanceCount / distinctPerformanceCount, or null when the account has never drawn. */
  winRate: number | null;
  performances: PerformanceHistory[];
}

export interface AccountOverviewEntry {
  account: Account;
  gender?: string;
  stats: AccountLotteryStats;
}

/** One tour+event-date grouping aggregated across every account, for "which performances got
 *  drawn for the most" - distinct from PerformanceHistory, which is scoped to one account. */
export interface TopPerformanceEntry {
  performanceKey: string;
  tourName: string;
  eventDatetime?: string;
  totalDraws: number;
  accountCount: number;
}

export interface AccountsOverview {
  totalAccounts: number;
  genderBreakdown: Record<string, number>;
  totalWinCount: number;
  totalDistinctPerformances: number;
  totalWonPerformances: number;
  overallWinRate: number | null;
  /** Raw record counts (not deduped by performance) across every account, by outcome. */
  recordOutcomeBreakdown: Record<LotteryOutcome, number>;
  /** Most recent lottery records across every account, newest first. */
  recentActivity: LotteryRecord[];
  /** Performances drawn for the most, across every account, most-drawn first. */
  topPerformances: TopPerformanceEntry[];
  accounts: AccountOverviewEntry[];
}
