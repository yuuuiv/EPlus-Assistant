export interface MailProvider {
  validate(config: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }>;
  waitForVerificationCode(input: {
    recipient: string;
    startedAt: Date;
    timeoutMs: number;
    senderAllowlist: string[];
    subjectMatchers: RegExp[];
  }): Promise<{ code?: string; manualActionRequired: boolean; reason: string }>;
}

export class ManualMailProvider implements MailProvider {
  async validate(config: Record<string, unknown>): Promise<{ ok: boolean; reason?: string }> {
    return { ok: typeof config === "object" };
  }

  async waitForVerificationCode(): Promise<{ code?: string; manualActionRequired: boolean; reason: string }> {
    return {
      manualActionRequired: true,
      reason: "Mail provider adapter not connected yet. Enter the code manually."
    };
  }
}

