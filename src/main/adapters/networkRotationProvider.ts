export interface IpInfo {
  readonly ip: string;
  readonly region: string;
  readonly country: string;
  readonly city?: string;
}

export interface ClashConfig {
  readonly host: string;
  readonly port: number;
  readonly secret: string;
  readonly proxyGroup: string;
}

export interface NodeInfo {
  readonly name: string;
  readonly type: string;
  readonly alive: boolean;
  readonly delay?: number;
}

export interface NetworkRotationProvider {
  detectIp(): Promise<IpInfo>;
  rotate(): Promise<void>;
  listNodes?(): Promise<readonly NodeInfo[]>;
}

type Fetcher = typeof fetch;

export class ClashControllerProvider implements NetworkRotationProvider {
  constructor(
    private readonly config: ClashConfig,
    private readonly fetcher: Fetcher = fetch
  ) {
    validateConfig(config);
  }

  async detectIp(): Promise<IpInfo> {
    const response = await this.fetcher("http://ip-api.com/json/?fields=query,country,regionName,city", {
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new Error(`IP detection failed: HTTP ${response.status}`);
    return parseIpInfo(await response.json());
  }

  async rotate(): Promise<void> {
    const group = await this.fetchGroup();
    const nodes = readStringArray(group, "all");
    const current = readString(group, "now");
    if (nodes.length === 0 || !current) throw new Error("Clash proxy group has no active nodes");
    const currentIndex = nodes.indexOf(current);
    if (currentIndex < 0) throw new Error("Clash proxy group current node is unavailable");
    const target = nodes[(currentIndex + 1) % nodes.length];
    if (!target) throw new Error("Clash proxy group has no rotation target");
    const response = await this.fetcher(this.groupUrl(), {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ name: target }),
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new Error(`Clash rotation failed: HTTP ${response.status}`);
  }

  async listNodes(): Promise<readonly NodeInfo[]> {
    const group = await this.fetchGroup();
    const delays = new Map<string, number>();
    const history = readArray(group, "history");
    for (const entry of history) {
      if (!isRecord(entry)) continue;
      const name = readString(entry, "name");
      const delay = readNumber(entry, "delay");
      if (name && delay !== undefined) delays.set(name, delay);
    }
    return readStringArray(group, "all").map((name) => {
      const delay = delays.get(name);
      return delay === undefined ? { name, type: "proxy", alive: true } : { name, type: "proxy", alive: true, delay };
    });
  }

  private async fetchGroup(): Promise<Record<string, unknown>> {
    const response = await this.fetcher(this.groupUrl(), { headers: this.headers(), signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Clash proxy query failed: HTTP ${response.status}`);
    const data = await response.json();
    if (!isRecord(data)) throw new Error("Clash proxy response is invalid");
    return data;
  }

  private groupUrl(): string {
    return `http://${this.config.host}:${this.config.port}/proxies/${encodeURIComponent(this.config.proxyGroup)}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.secret}` };
  }
}

function validateConfig(config: ClashConfig): void {
  if (!config.host.trim()) throw new Error("Clash host is required");
  if (!Number.isInteger(config.port) || config.port <= 0) throw new Error("Clash port is required");
  if (!config.secret.trim()) throw new Error("Clash secret is required");
  if (!config.proxyGroup.trim()) throw new Error("Clash proxyGroup is required");
}

function parseIpInfo(value: unknown): IpInfo {
  if (!isRecord(value)) throw new Error("IP detection response is invalid");
  const ip = readString(value, "query");
  const country = readString(value, "country");
  const region = readString(value, "regionName");
  const city = readString(value, "city");
  if (!ip || !country || !region || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) throw new Error("IP detection response is invalid");
  return city ? { ip, country, region, city } : { ip, country, region };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readArray(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function readStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  return readArray(record, key).filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
}
