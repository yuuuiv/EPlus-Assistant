# Payment and Device Contract

This document is the single source of truth for the payment lifecycle, runtime parser/adapter boundary, device registry, and evidence fixtures defined by the eplus-payment-device-generalization project. Every implementation module must conform to the contracts in this document. Any deviation requires a plan amendment.

**Plan reference**: `.omo/plans/eplus-payment-device-generalization.md` (contract lock, lines 47-116)
**Implementation base**: `60d2e01d0f5c2e5359c723eeb620477cf0101c82`
**Recorded at**: `2026-07-21T00:00:00.000Z`

---

## Payment Lifecycle Contract

### PaymentRunState

Every account run carries a typed nested `PaymentRunState`. It is never encoded in an untyped checkpoint.

| State | Meaning |
|-------|---------|
| `Idle` | No payment work has started. Required when the top-level run status is `Pending`, `LoggingIn`, or `AwaitingEmailCode`. |
| `PaymentDiscoveryPending` | The browser is ready to discover payment controls on the page. Allowed only when the top-level run status is `FillingForm`. |
| `PaymentSelectionPending` | Payment controls have been discovered and the system is waiting for selection (automatic match or manual). Allowed only when the top-level run status is `FillingForm`. |
| `PaymentSelectionApplied` | A selection has been persisted and verified. Allowed under `FillingForm` or required under `AwaitingSubmitConfirmation`. |
| `Submitting` | The atomic dispatch gate has been passed and final submission is in progress. Requires an issued authorization and dispatch lease. Allowed only when top-level run status is `Submitting`. |
| `UnknownSubmissionState` | Recovery state after a crash, timeout, or lost response during submission. Read-only reconciliation. Allowed only when top-level run status is `UnknownSubmissionState`. |

### Payment sub-state transitions

```text
FillingForm -> PaymentDiscoveryPending | AwaitingManualAction | Failed | Cancelled
PaymentDiscoveryPending -> PaymentSelectionPending | AwaitingManualAction | Failed | Cancelled
PaymentSelectionPending -> PaymentSelectionApplied | AwaitingManualAction | Failed | Cancelled
PaymentSelectionApplied -> top-level AwaitingSubmitConfirmation | AwaitingManualAction | Failed | Cancelled
top-level AwaitingSubmitConfirmation + PaymentSelectionApplied -> top-level Submitting + Submitting | AwaitingManualAction | Failed | Cancelled
AwaitingManualAction -> PaymentDiscoveryPending | PaymentSelectionPending | Cancelled | Failed
Submitting -> Submitted | UnknownSubmissionState | Failed | Cancelled
UnknownSubmissionState -> Submitted | AlreadyApplied | Failed
```

The top-level state machine must not permit `AwaitingManualAction -> Submitting`. Only the atomic `AwaitingSubmitConfirmation -> Submitting` dispatch gate may enter submission. Every manual resume and orchestrator/queue resume path must inspect the persisted payment state and call `validatePaymentCheckpointForTransition()` before discovery, selection, review, or submission.

`Submitting -> UnknownSubmissionState` is the only recovery entry after a crash, timeout, or lost response. Startup recovery first acquires the run row with `BEGIN IMMEDIATE`, increments `submissionRecoveryRevision`, sets a `recoveryFenceToken`, revokes every dispatch lease for that run, commits, and only then closes/quarantines the browser context and profile lock. Every worker action checks the fence token before navigation, mutation, and final dispatch. If the process crashes between database fencing and context closure, the next startup sees the committed fence and quarantines/reclaims the context before read-only reconciliation. `UnknownSubmissionState` may resolve only to `Submitted`, `AlreadyApplied`, or `Failed`; it may never return to `Submitting`, `PaymentSelectionApplied`, or `AwaitingManualAction` without a new task/run.

### Top-level status requirements

| Top-level AccountRunStatus | Required PaymentRunState |
|---------------------------|-------------------------|
| `Pending` | `Idle` |
| `LoggingIn` | `Idle` |
| `AwaitingEmailCode` | `Idle` |
| `FillingForm` | `PaymentDiscoveryPending`, `PaymentSelectionPending`, or `PaymentSelectionApplied` |
| `AwaitingSubmitConfirmation` | `PaymentSelectionApplied` |
| `Submitting` | `Submitting` |
| `UnknownSubmissionState` | `UnknownSubmissionState` |
| `AwaitingManualAction` | Any (interruption overlay; the persisted payment state is the recorded state at interruption) |
| `Submitted`, `AlreadyApplied`, `Failed`, `Cancelled` | Any (terminal/recovery; payment state is read-only) |

### Manual-action reasons

`AwaitingManualAction` is an interruption overlay. Resume may return only to the recorded payment state after checkpoint validation. The following conditions always produce manual action:

- CAPTCHA presence
- Device verification prompt
- Card number, CVV, or expiry field detection
- Unknown page structure (controls inside frames, shadow roots, or ambiguous nested browsing contexts)
- Manual payment selection requested (no deterministic preference match)
- Ambiguous or duplicate candidate matches
- Conflict between legacy `paymentMethodId` and new semantic preference

### PaymentDiscoveryCheckpoint

Persisted with every checkpoint record:

| Field | Type | Description |
|-------|------|-------------|
| `taskId` | string | Owning task |
| `runId` | string | Owning account run |
| `checkpointId` | string | Unique checkpoint identifier |
| `checkpointRevision` | number | Monotonic revision counter |
| `pageFingerprint` | string | SHA-256 of canonical URL plus visible text and relevant form control descriptors |
| `controlFingerprint` | string | SHA-256 of ordered group/control descriptors |
| `contextGeneration` | number | Browser context generation counter |
| `orderedGroups` | string[] | Ordered payment group keys discovered on the page |
| `candidateIds` | string[] | All discovered candidate option IDs |
| `groupKeys` | Record<string, string[]> | Group key to candidate ID mapping |
| `domValues` | Record<string, string> | Candidate ID to exact DOM value |
| `labels` | Record<string, string> | Candidate ID to display label |
| `enabled` | Record<string, boolean> | Candidate ID to enabled flag |
| `supported` | Record<string, boolean> | Candidate ID to supported flag |
| `selectorEvidence` | SelectorEvidence | Closed selector evidence for each control |
| `discoveredAt` | string | ISO-8601 discovery timestamp |
| `deviceProfileKey` | string | Device profile used during discovery |

Every path from manual action or selection to `PaymentSelectionApplied` must call `validatePaymentCheckpointForTransition()` and re-read the live page. Matching page/control fingerprints, context generation, checkpoint revision, run ID, device profile key, candidate IDs, and enabled/supported status are required. Mismatch invalidates the checkpoint and returns to `PaymentDiscoveryPending`.

---

## Runtime Parser/Adapter Boundary

### Static vs. live boundary

Static Cheerio parsing may provide hints, but live interaction must use Playwright DOM locators/evaluation returning a constrained serializable runtime option shape:

| Field | Type | Description |
|-------|------|-------------|
| `groupKey` | string | Payment group identifier (e.g. `"delivery"`, `"payment"`) |
| `groupOrder` | number | Zero-based display order within the page |
| `controlType` | `"select" \| "input" \| "button"` | DOM control element type |
| `groupSelectorEvidence` | SelectorEvidence | Evidence for locating the group container |
| `optionSelectorEvidence` | SelectorEvidence | Evidence for locating each option within the group |
| `domValue` | string | Exact DOM value attribute |
| `label` | string | User-visible display label |
| `enabled` | boolean | Whether the option is enabled |
| `supported` | boolean | Whether the option type is supported by the adapter |
| `ambiguous` | boolean | Whether the option could not be uniquely resolved |

### SelectorEvidence

```typescript
interface SelectorEvidence {
  scope: "document";
  tag: "select" | "input" | "button";
  groupOrdinal: number;
  optionOrdinal: number;
  allowedAttributes: {
    id?: string;
    name?: string;
    type?: string;
    role?: string;
    dataPaymentGroup?: string;
  };
  contextGeneration: string;
}
```

The TypeScript field `dataPaymentGroup` maps to the DOM attribute `data-payment-group`. No other attribute name mapping is defined.

### Allowed attributes

The approved attribute allowlist is exactly: `id`, `name`, `type`, `role`, `data-payment-group`.

No other attribute, arbitrary CSS selector, XPath, script, `onclick`, or escaped selector syntax is accepted. Fixed IDs such as `i12` or `i8` must never be used as identity; they are not present in production selector evidence.

The minimum evidence required to uniquely identify a group/control: at least one allowed attribute is required. Empty `allowedAttributes` is permitted only when `tag + groupOrdinal + optionOrdinal` alone uniquely resolves to a single DOM node within the top-level document, verified by counting matching nodes and rejecting `!= 1`.

Only the top-level document is supported. Controls inside frames, shadow roots, or ambiguous nested browsing contexts are reported as unsupported and trigger manual action.

### Locator algorithm

The locator algorithm: first locates the unique tag/group/option ordinal in the top-level document within the same context generation, verifies all supplied allowed attributes and option ordinal/value, and rejects duplicate nodes. Button/radio options are verified by checked/aria-pressed/selected state plus the exact allowed attribute set. Select options are verified by selected value.

### Fingerprint definitions

**pageFingerprint**: SHA-256 of canonical URL plus visible text and relevant form control descriptors (tag, name, type, role, option count, option values/labels, data-payment-group attributes, and group ordinals). Excludes timestamps, nonce-like IDs, dynamic asset URLs, cookies, auth tokens, and query string values.

**controlFingerprint**: SHA-256 of ordered group/control descriptors. For each group: group key, group ordinal, option count, and per-option tag, ordinal, allowed attributes, DOM value, and label. Option disabled state is included. Dynamic or volatile attributes are excluded.

---

## Device Registry Contract

### Approved DeviceProfileKey values

| Key | Source | Description |
|-----|--------|-------------|
| `desktop-chrome` | `playwright-core` `devices["Desktop Chrome"]` | Default profile. Full desktop viewport, standard UA, no touch emulation. |
| `iphone-13` | `playwright-core` `devices["iPhone 13"]` | Mobile profile. 390x844 viewport, iOS Safari UA, 3x device scale, touch enabled. |
| `pixel-7` | `playwright-core` `devices["Pixel 7"]` | Mobile profile. 412x915 viewport, Chrome Android UA, 2.625x device scale, touch enabled. |

Each key maps to an explicit descriptor snapshot and SHA-256 registry digest committed in `src/main/engines/deviceProfiles.ts`. The registry source is the exact installed `playwright-core` version recorded in `package-lock.json`.

Arbitrary user-agent strings, viewport dimensions, screen sizes, device scale factors, locale overrides, timezone overrides, touch flags, or mobile flags are rejected at IPC and service boundaries. Only the three approved keys above are permitted.

### Context ownership and lock mechanism

A browser context is owned by one run and carries an immutable device profile.

**Persistent storage key**: `profiles/<accountId>/<deviceProfileKey>/`

**Owner lock file**: contains `accountId`, `runId`, `deviceProfileKey`, `contextGeneration`, `ownerPid`, `ownerProcessStartTime`, and `heartbeatAt`.

**Lock acquisition**: atomic exclusive file create. Reject any active lock younger than 30 seconds.

**Heartbeat**: refreshed during every browser step.

**Stale lock reconciliation**: a lock older than 30 seconds is reconciled by checking both `ownerPid` and `ownerProcessStartTime`. Only a matching dead process may be reclaimed, using an atomic compare-and-replace of the lock file.

**Reuse**: allowed only when stored profile key and registry digest match. Same-account/same-profile concurrent runs are rejected.

**Context creation contract**: `taskId`, `runId`, and `deviceProfileKey` are passed into context creation. The device profile is applied via the complete Playwright descriptor at `launchPersistentContext()` call only. Changing a profile after context creation is rejected. Two tasks with distinct profiles do not share context settings.

---

## Evidence Matrix

Each fixture must produce its documented expected JSON result. Test commands and artifact paths are recorded in the matrix below.

### Todo 1 evidence observations

- Source capture was pre-login only. The public detail page title and canonical route were observed through Playwright without authentication; fixture canonicalization removes query values and volatile markup.
- Synthetic controls model ordered `delivery` then `payment` groups, enabled and disabled options, and an unsupported wallet option. They use semantic `data-payment-group`, names, types, and values only.
- Approved mobile descriptors remain `iphone-13` (390x844) and `pixel-7` (412x915); no arbitrary viewport or user-agent is persisted in fixtures.
- Evidence gap: public pre-login HTML cannot establish login-gated payment controls or submission behavior. Those remain synthetic until separately captured under the explicit live-smoke safety gate.
- Verification record: `2026-07-21`; affected modules are `scripts/sanitize-har.mjs`, `scripts/capture-public-fixture.mjs`, `scripts/live-smoke.mjs`, `src/main/fixtures/paymentDeviceContract.test.ts`, and `tests/fixtures/`. No browser screenshot, trace, credential, raw HAR body, or authenticated HTML was retained.

### Offline Route Normalization

When an offline HAR response has no exact approved route/content class, the sanitizer may recognize only successful decoded HTML or JSON structure and normalize it to the closed `detail` or `application-entry` evidence class. This is offline evidence normalization, never production routing. It discards the entire decoded source body and retains only a fixed public-response marker for HTML; JSON bodies are never retained. The projection emits at most one record per closed normalized route class. Retained allowlisted bodies still receive the strict sensitive-output scan, and the serialized output is scanned again before write.

The historical raw-HAR sanitizer run produced `tests/fixtures/sanitized-payment-device.har` plus its SHA-256 manifest. The committed artifact contains exactly two normalized groups, `detail` and `application-entry`, and no source URL, query value, header, cookie, request body, response body, or private identifier. This normalized evidence does not establish source-specific payment controls; the synthetic fixtures remain the generalized parser contract.
- Network evidence limitation: this retry did not use external capture because the prior public-source attempt encountered certificate verification failure. TLS verification was not disabled or bypassed. The committed pre-login fixture is a deterministic minimal public-structure artifact; its title and route are intentionally generalized, and login-gated payment controls remain unverified.
- Approved policy amendment: offline raw HAR metadata is redacted and discarded rather than causing blanket rejection. The sanitizer classifies routes from URL paths without query values, discards request/response headers, cookies, query values, post bodies, and opaque payloads, then emits only the allowlisted projection. A sensitive field/value in a retained approved HTML or JSON payload, malformed data, unsupported encoding, or unsafe volatility still fails closed before output.
- Raw-HAR verification after the amendment: the structural fallback normalizes successful HTML and JSON responses whose route does not match an exact approved class to `detail` or `application-entry` evidence classes. The historical run wrote the sanitized artifact with SHA-256 `f3a3350a5c739dbee20c31facc029d110f8d93816cfc176f2e13bca5366014c6`. No source URL, query value, header, cookie, request body, response body, or private identifier is retained. The raw HAR path is excluded from Git tracking, tests, and production imports; only the committed sanitized fixture and hash manifest are consumed.

| Fixture | Expected ordered groups/values | Expected device profile | Test Command | Artifact Path |
|---------|-------------------------------|-------------------------|--------------|---------------|
| `sanitized-payment-device.har` | `detail`, `application-entry`; no retained source body/metadata | `desktop-chrome`, `iphone-13`, `pixel-7` registry validated separately | `npx vitest run src/main/fixtures/paymentDeviceContract.test.ts -t "sanitized|repeatable"` | `tests/fixtures/sanitized-payment-device.har` and `.sha256` manifest |
| `eplus-lisa-0534530001-detail.html` | `[]`; `payment_unavailable` at runtime (pre-login fixture) | `desktop-chrome` | `npx vitest run src/main/fixtures/paymentDeviceContract.test.ts -t "generalized runtime discovery"` | `tests/fixtures/eplus-lisa-0534530001-detail.html` |
| `payment-delivery-and-methods.html` | `delivery`, `payment`; `delivery-mobile`, `delivery-paper`, `payment-card`, `payment-convenience`, `payment-wallet`; disabled `payment-card-disabled` | `desktop-chrome` | `npx vitest run src/main/fixtures/paymentDeviceContract.test.ts src/main/services/runtimePaymentDiscovery.test.ts -t "generalized runtime discovery|delivery.*payment"` | `tests/fixtures/payment-delivery-and-methods.html` |
| `payment-only.html` | `payment`; `payment-card`, `payment-convenience` | `iphone-13` | `npx vitest run src/main/fixtures/paymentDeviceContract.test.ts -t "generalized runtime discovery"` | `tests/fixtures/payment-only.html` |
| `no-payment-control.html` | `[]`; `payment_unavailable` | `pixel-7` | `npx vitest run src/main/fixtures/paymentDeviceContract.test.ts -t "generalized runtime discovery"` | `tests/fixtures/no-payment-control.html` |
| `payment-delayed-controls.html` | `[]`; `payment_delayed` | `desktop-chrome` | `npx vitest run src/main/fixtures/paymentDeviceContract.test.ts -t "generalized runtime discovery"` | `tests/fixtures/payment-delayed-controls.html` |
| `payment-reordered-groups.html` | `payment`, `delivery`; no positional inference | `iphone-13` | `npx vitest run src/main/fixtures/paymentDeviceContract.test.ts src/main/services/runtimePaymentDiscovery.test.ts -t "generalized runtime discovery|reordered groups"` | `tests/fixtures/payment-reordered-groups.html` |
| `payment-custom-labels.html` | `payment`; exact values classify support despite labels | `pixel-7` | `npx vitest run src/main/fixtures/paymentDeviceContract.test.ts src/main/services/runtimePaymentDiscovery.test.ts -t "generalized runtime discovery|custom labels"` | `tests/fixtures/payment-custom-labels.html` |
| `payment-duplicate-labels.html` | `payment`; `manual` ambiguous-control | `desktop-chrome` | `npx vitest run src/main/fixtures/paymentDeviceContract.test.ts src/main/services/runtimePaymentDiscovery.test.ts -t "generalized runtime discovery|duplicate labels"` | `tests/fixtures/payment-duplicate-labels.html` |
| `payment-duplicate-values.html` | `payment`; `manual` ambiguous-control | `iphone-13` | `npx vitest run src/main/fixtures/paymentDeviceContract.test.ts src/main/services/runtimePaymentDiscovery.test.ts -t "generalized runtime discovery|duplicate values"` | `tests/fixtures/payment-duplicate-values.html` |
| `har-sensitive-fixture.har` | rejected with exit `1`; no output | not applicable | `node scripts/sanitize-har.mjs --offline-evidence-input tests/fixtures/har-sensitive-fixture.har tests/fixtures/rejected.har` | `tests/fixtures/har-sensitive-fixture.har` |
| `volatile-public-fixture.html` | rejected with exit `1`; no output | not applicable | `node scripts/capture-public-fixture.mjs --fixture tests/fixtures/volatile-public-fixture.html --out tests/fixtures/rejected.html --canonicalize` | `tests/fixtures/volatile-public-fixture.html` |

### Fixture descriptions

1. **eplus-lisa-0534530001-detail.html**: Public pre-login detail page for the Lisa concert case. Captured from `https://eplus.jp/sf/detail/0534530001-P0030221P021001?P1=0175` and canonicalized. Contains no payment controls in pre-login state; returns `payment_unavailable`.

2. **payment-delivery-and-methods.html**: Synthetic page with two ordered groups (`delivery` then `payment`), three enabled delivery options, two enabled payment options, one disabled known payment option, and one unknown payment option. Exercises the full grouped extraction contract.

3. **payment-only.html**: Synthetic page with a single `payment` group containing two enabled card and convenience-store options. No delivery group present.

4. **no-payment-control.html**: Synthetic page with a valid form but no payment-related controls. Produces `payment_unavailable`.

5. **payment-delayed-controls.html**: Synthetic page where payment controls are present in the DOM but appear only after a user action (e.g., selecting a ticket type). Before the action completes, the state is `payment_delayed`.

6. **har-sensitive-fixture.har**: HAR file containing cookies, authorization headers, and credential data. The sanitizer must detect and reject it with exit code `1`.

7. **volatile-public-fixture.html**: HTML fixture containing non-deterministic tokens (timestamps, nonce-like IDs, dynamic URLs) that the canonicalizer cannot remove deterministically. The canonicalizer must exit `1`.

### Post-fixture verification commands

```text
# Positive fixtures: all six pass
npx vitest run src/main/fixtures/paymentDeviceContract.test.ts -t "pre-login|delivery.*payment|payment.only|no.payment|delayed"

# Parser/discovery semantic-control contract: exact groups, DOM values, and closed evidence
npx vitest run src/main/services/eplusPageParser.test.ts src/main/services/runtimePaymentDiscovery.test.ts -t "delivery.*payment|group"

# Parser/discovery failure contract: no positional, label-only, or first-option fallback
npx vitest run src/main/services/eplusPageParser.test.ts src/main/services/runtimePaymentDiscovery.test.ts -t "reordered groups|custom labels|missing selector|disabled target|unknown label|duplicate labels|duplicate values|delayed controls"

# Sanitized HAR: contract test verifies hashes, groups, viewport metadata
npx vitest run src/main/fixtures/paymentDeviceContract.test.ts -t "sanitized|repeatable"

# Rejection: negative fixtures produce exit 1
node scripts/sanitize-har.mjs --offline-evidence-input tests/fixtures/har-sensitive-fixture.har tests/fixtures/rejected.har
# Expected: exit 1, no output file, report naming the rejected sensitive field class

node scripts/capture-public-fixture.mjs --fixture tests/fixtures/volatile-public-fixture.html --out tests/fixtures/rejected.html --canonicalize
# Expected: exit 1 or volatile markers removed
```

---

## Safety Contract

The following actions are prohibited in all production code, tests, and scripts (except where explicitly allowed by an offline-only tool with an explicit flag):

### Prohibited automation

- **Card/CVV/expiry automation**: No production or test code may locate, read, fill, or submit card number, CVV, expiry date, or cardholder name fields. Detection of any such field must immediately pause for manual takeover.
- **CAPTCHA/device-verification bypass**: No production or test code may attempt to solve, dismiss, or bypass CAPTCHA challenges, device verification prompts, sliders, or unknown consent controls.
- **eval(onclick)**: No production or test code may evaluate page `onclick` attributes, inline event handlers, or embedded scripts to derive selectors or behavior.
- **HAR replay by production code**: The raw `sp.gesicht.eplus.jp.har` file is an excluded source artifact. It is never imported by tests or production code. Only `scripts/sanitize-har.mjs` may read it, and only with the explicit `--offline-evidence-input` flag.
- **First-option payment selection**: The system must never select the first available payment option without an explicit match against a persisted preference or manual user confirmation.

### Sanitization requirements

- All fixture HTML files must be byte-scanned for cookies, authorization headers, credentials, tokens, card data, and personal data before commit.
- `scripts/sanitize-har.mjs` must exit `1` if a retained approved payload has unsupported decoding, malformed data, or a recursive sensitive-field detector match. Sensitive raw request/response metadata is discarded before projection and never copied to output.
- The sanitized HAR output must be scanned again after serialization. If any suspicious value is found, the command exits nonzero and writes no output.
- `.env` is never committed, included in HAR/HTML/screenshots, or used by unit tests.
- Real credentials appear only in `.env` (gitignored). The main-process environment loader redacts values before reports.

### Approved route classes

For sanitized HAR output, the only approved route classes are `detail`, `application-entry`, and `static-public`. Approved content types are `text/html` and `application/json`. All other routes, content types, query values, post bodies, opaque/binary bodies, cookies, auth headers, and unapproved metadata are discarded.

---

## Authorization and Dispatch Contract

### Selection authorization flow

1. Persist discovery candidates.
2. Accept only a main-process validated selection containing candidate IDs, `taskId`, `runId`, checkpoint ID, and expected control fingerprint.
3. Persist normalized selected group/value pairs and the device profile key.
4. Recompute the review digest and issue or refresh immutable final submission authorization.
5. Include selected groups, exact DOM values, device profile key, page/control fingerprint, task ID, run ID, preference, and acknowledgement version in the final digest.

### Dispatch gate

The `AwaitingSubmitConfirmation -> Submitting` operation is the final dispatch gate. It is a single `BEGIN IMMEDIATE` transaction that atomically validates all bindings including lease eligibility and, on success, changes the run status, marks authorization consumed, and issues a one-shot dispatch lease.

Binding check compares: run ID, task ID, `run.status === "AwaitingSubmitConfirmation"`, authorization revision, one-time nonce, `revokedAt IS NULL`, `consumedAt IS NULL`, no currently issued dispatch lease exists for this run, no stale lease heartbeat with a potentially still-live worker, recovery revision, recovery fence token, context-owner token, page/control fingerprints, device profile key/registry digest, and checkpoint revision.

If any binding mismatch occurs, the transaction atomically leaves the run in `AwaitingSubmitConfirmation` or moves it to `AwaitingManualAction` (legal transitions only). It must not create `Submitting` or `UnknownSubmissionState`.

### Lease heartbeat

Every browser action during `Submitting` carries the lease identity (lease ID + issued-at timestamp) and checks a live lease heartbeat refreshed every 5 seconds. If the heartbeat is stale (older than 15 seconds) or the attached lease identity does not match the persisted issued lease, the worker must cancel the action, return the run to `UnknownSubmissionState`, and revoke the lease.

---

## Legacy Payment Compatibility

Legacy `paymentMethodId` is a readable historical field only. Preserved unchanged on read. New writes use `PaymentPreference` and runtime candidate IDs.

If both legacy and new fields exist, the new semantic preference is not allowed to override a conflicting legacy value silently. An exact discovered candidate match is required for both. A legacy value may match only an exact discovered candidate value inside the correct group. It must never be converted into a guessed group or accepted merely because it is non-empty.

---

## Quality Gate

The checked runner `scripts/run-quality-gate.mjs` executes the following commands sequentially and exits `1` on the first nonzero exit code:

```text
npm run typecheck
npm test
npm run build
npx vitest run src/main/fixtures/paymentDeviceContract.test.ts src/main/services/eplusPageParser.test.ts src/main/services/runtimePaymentDiscovery.test.ts src/main/services/taskService.test.ts src/main/adapters/eplusAdapter.test.ts src/main/engines/browserSessionEngine.test.ts tests/renderer/workflow.test.ts
node scripts/scan-payment-device-policy.mjs --production src --fixtures tests/fixtures --evidence .omo/reviews --exclude tests/fixtures/har-sensitive-fixture.har --exclude tests/fixtures/volatile-public-fixture.html
node scripts/validate-device-profiles.mjs --package-version-from package-lock.json --expected desktop-chrome,iphone-13,pixel-7
```

Receipt is written to `--out` path. The fixture contract validates the committed sanitized HAR/hash instead of requiring the excluded raw HAR. The optional live smoke command `node scripts/live-smoke.mjs --env-file .env --allow-live-credentials --final-submit=false` is recorded separately and is never a prerequisite for unit-test success when `.env` is absent.
