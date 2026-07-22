import * as http from "node:http";
import * as https from "node:https";
import type { NetworkNode } from "../../shared/types.js";
export type { NetworkNode } from "../../shared/types.js";

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

export interface BrowserProxy {
  readonly server: string;
}

type NodeInfo = NetworkNode;

export interface NetworkRotationProvider {
  detectIp(): Promise<IpInfo>;
  rotate(): Promise<void>;
  getBrowserProxy?(): Promise<BrowserProxy>;
  listNodes?(): Promise<readonly NodeInfo[]>;
  selectNode?(name: string): Promise<void>;
}

type Fetcher = typeof fetch;

export class ClashControllerProvider implements NetworkRotationProvider {
  private browserProxy: BrowserProxy | undefined;

  constructor(
    private readonly config: ClashConfig,
    private readonly fetcher: Fetcher = fetch
  ) {
    validateConfig(config);
  }

  async detectIp(): Promise<IpInfo> {
    if (!this.browserProxy && this.fetcher === fetch) await this.getBrowserProxy();
    const url = "http://ip-api.com/json/?fields=query,country,regionName,city";
    const payload = this.browserProxy
      ? await requestJsonThroughProxy(url, this.browserProxy)
      : await this.fetcher(url, { signal: AbortSignal.timeout(5_000) }).then(async (response) => {
        if (!response.ok) throw new Error(`IP detection failed: HTTP ${response.status}`);
        return response.json();
      });
    return parseIpInfo(payload);
  }

  async getBrowserProxy(): Promise<BrowserProxy> {
    const response = await this.fetcher(this.configUrl(), { headers: this.headers(), signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Clash config query failed: HTTP ${response.status}`);
    const config = await response.json();
    if (!isRecord(config)) throw new Error("Clash config response is invalid");
    const mixedPort = readPositivePort(config, "mixed-port");
    const httpPort = readPositivePort(config, "port");
    const socksPort = readPositivePort(config, "socks-port");
    const proxy = mixedPort
      ? { server: `http://${this.config.host}:${mixedPort}` }
      : httpPort
        ? { server: `http://${this.config.host}:${httpPort}` }
        : socksPort
          ? { server: `socks5://${this.config.host}:${socksPort}` }
          : undefined;
    if (!proxy) throw new Error("Clash config has no usable mixed-port, port, or socks-port.");
    this.browserProxy = proxy;
    return proxy;
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

  async selectNode(name: string): Promise<void> {
    const group = await this.fetchGroup();
    const nodes = readStringArray(group, "all");
    if (!nodes.includes(name)) throw new Error("Requested proxy node is not available in the configured group.");
    const response = await this.fetcher(this.groupUrl(), {
      method: "PUT",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(5_000)
    });
    if (!response.ok) throw new Error(`Clash node selection failed: HTTP ${response.status}`);
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

  private configUrl(): string {
    return `http://${this.config.host}:${this.config.port}/configs`;
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

function readPositivePort(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  const port = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function readArray(record: Record<string, unknown>, key: string): readonly unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function readStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  return readArray(record, key).filter((value): value is string => typeof value === "string" && Boolean(value.trim()));
}

function requestJsonThroughProxy(url: string, proxy: BrowserProxy): Promise<unknown> {
  const target = new URL(url);
  const proxyUrl = new URL(proxy.server);
  if (proxyUrl.protocol !== "http:" && proxyUrl.protocol !== "https:") {
    throw new Error(`IP detection does not support proxy protocol ${proxyUrl.protocol}; configure Clash mixed-port.`);
  }
  const transport = proxyUrl.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      hostname: proxyUrl.hostname,
      port: Number(proxyUrl.port || (proxyUrl.protocol === "https:" ? 443 : 80)),
      method: "GET",
      path: target.toString(),
      headers: { Accept: "application/json", Host: target.host },
      timeout: 5_000
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          reject(new Error(`IP detection through Clash failed: HTTP ${response.statusCode ?? "unknown"}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`IP detection response is not JSON: ${error instanceof Error ? error.message : String(error)}`));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("IP detection through Clash timed out.")));
    request.on("error", reject);
    request.end();
  });
}
