export interface EplusBrowserAdapter {
  canHandle(url: string): boolean;
  discoverPage(url: string): Promise<{ title: string; canonicalUrl: string; fingerprint: string }>;
  login(): Promise<void>;
  submitLottery(): Promise<void>;
}

export class ManualOnlyEplusAdapter implements EplusBrowserAdapter {
  canHandle(url: string): boolean {
    return /eplus\.jp/i.test(url);
  }

  async discoverPage(url: string): Promise<{ title: string; canonicalUrl: string; fingerprint: string }> {
    const parsed = new URL(url);
    return {
      title: parsed.hostname,
      canonicalUrl: parsed.toString(),
      fingerprint: "manual-inspection-required"
    };
  }

  async login(): Promise<void> {
    throw new Error("No browser automation is configured yet. Use the manual review flow.");
  }

  async submitLottery(): Promise<void> {
    throw new Error("No browser automation is configured yet. Use the manual review flow.");
  }
}

