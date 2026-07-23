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
