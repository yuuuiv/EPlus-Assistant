export interface AttributionInput {
  accountTriggers: Array<{
    accountId: string;
    triggeredAt: string;
    recipient: string;
  }>;
  candidates: Array<{
    code: string;
    receivedAt: string;
    sender: string;
    subject: string;
    body?: string;
  }>;
  senderAllowlist: string[];
  subjectMatchers: RegExp[];
}

export interface AttributionResult {
  accountId: string;
  code?: string;
  confidence: "high" | "medium" | "ambiguous";
  reason: string;
  manualActionRequired: boolean;
}

type Trigger = AttributionInput["accountTriggers"][number] & { readonly timestamp: number };
type Candidate = AttributionInput["candidates"][number] & { readonly timestamp: number };

export function attributeVerificationCode(input: AttributionInput): AttributionResult[] {
  const triggers = input.accountTriggers
    .map((trigger) => ({ ...trigger, timestamp: Date.parse(trigger.triggeredAt) }))
    .filter((trigger): trigger is Trigger => Number.isFinite(trigger.timestamp))
    .sort(byTriggerThenAccountId);
  const results = new Map<string, AttributionResult>();
  const unclaimed = new Set(triggers.map((trigger) => trigger.accountId));
  const candidates = verifiedCandidates(input);

  for (const candidate of candidates) {
    const eligible = triggers.filter(
      (trigger) => unclaimed.has(trigger.accountId) && candidate.timestamp >= trigger.timestamp
    );
    const markerMatches = eligible.filter((trigger) => containsAccountMarker(candidate, trigger));
    const matches = markerMatches.length > 0 ? markerMatches : eligible;

    if (matches.length === 1) {
      const [match] = matches;
      if (match) {
        results.set(match.accountId, {
          accountId: match.accountId,
          code: candidate.code,
          confidence: markerMatches.length === 1 ? "high" : "medium",
          reason: markerMatches.length === 1 ? "邮件包含账号标识。" : "候选邮件仅匹配一个触发时间窗口。",
          manualActionRequired: false
        });
        unclaimed.delete(match.accountId);
      }
      continue;
    }

    if (matches.length > 1) {
      const overlappingCandidates = candidates.filter((otherCandidate) =>
        triggers.some((trigger) => otherCandidate.timestamp >= trigger.timestamp && matches.some((match) => match.accountId === trigger.accountId))
      );
      if (markerMatches.length === 0 && overlappingCandidates.length > 1) {
        for (const match of matches) {
          results.set(match.accountId, ambiguousResult(match.accountId));
          unclaimed.delete(match.accountId);
        }
        continue;
      }
      const latestTimestamp = Math.max(...matches.map((match) => match.timestamp));
      const latestMatches = matches.filter((match) => match.timestamp === latestTimestamp);
      if (markerMatches.length === 0 && latestMatches.length === 1) {
        const latest = latestMatches[0];
        if (latest) {
          results.set(latest.accountId, {
            accountId: latest.accountId,
            code: candidate.code,
            confidence: "medium",
            reason: "按最新未认领触发时间归属。",
            manualActionRequired: false
          });
          unclaimed.delete(latest.accountId);
        }
        continue;
      }
      for (const match of matches) {
        results.set(match.accountId, ambiguousResult(match.accountId));
      }
    }
  }

  return triggers.map((trigger) => results.get(trigger.accountId) ?? {
    accountId: trigger.accountId,
    confidence: "ambiguous",
    reason: "没有可安全归属的验证码邮件，请人工处理。",
    manualActionRequired: true
  });
}

function verifiedCandidates(input: AttributionInput): Candidate[] {
  return input.candidates
    .map((candidate) => ({ ...candidate, timestamp: Date.parse(candidate.receivedAt) }))
    .filter((candidate): candidate is Candidate => Number.isFinite(candidate.timestamp))
    .filter((candidate) => isAllowedSender(candidate.sender, input.senderAllowlist))
    .filter((candidate) => input.subjectMatchers.some((matcher) => matchesSubject(matcher, candidate.subject)))
    .sort((left, right) => left.timestamp - right.timestamp);
}

function containsAccountMarker(candidate: Candidate, trigger: Trigger): boolean {
  const content = `${candidate.subject}\n${candidate.body ?? ""}`.toLowerCase();
  return content.includes(trigger.accountId.toLowerCase());
}

function ambiguousResult(accountId: string): AttributionResult {
  return {
    accountId,
    confidence: "ambiguous",
    reason: "候选邮件对应多个重叠触发时间窗口，无法安全归属。",
    manualActionRequired: true
  };
}

function byTriggerThenAccountId(left: Trigger, right: Trigger): number {
  return left.timestamp - right.timestamp || left.accountId.localeCompare(right.accountId);
}

function isAllowedSender(sender: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) {
    return true;
  }
  const domain = sender.toLowerCase().split("@").pop()?.replace(/[>\s]/g, "") ?? "";
  return allowlist.some((allowed) => domain === allowed.toLowerCase() || domain.endsWith(`.${allowed.toLowerCase()}`));
}

function matchesSubject(matcher: RegExp, subject: string): boolean {
  matcher.lastIndex = 0;
  return matcher.test(subject);
}
