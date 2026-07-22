# Eplus Lottery Assistant

<p align="center"><b><a href="README.md">English</a> | <a href="README_ZH.md">简体中文</a></b></p>

A local-first Windows Electron workbench for managing Eplus lottery accounts, event snapshots, tasks, run status, and audit information. The React renderer communicates with the main process exclusively through restricted IPC. Account passwords, mailbox reading credentials, and network controller keys are stored only in local encrypted storage.

This is not an unattended ticket-buying or payment tool. It assists browser workflows within guarded boundaries and leaves payment selection, final submission, and exception pages to human confirmation.

## Install and start on Windows

Prerequisites:

- Windows 10 or later
- Node.js with npm
- A Chromium-compatible browser when using the browser engine. The app resolves Chrome/Edge or a configured `EPLUS_BROWSER_EXECUTABLE`; it does not use the Electron executable as a browser fallback.

Install dependencies and start the development desktop app:

```powershell
npm install
npm run dev
```

`npm run dev` builds the Electron main process, starts Vite on `127.0.0.1:5173`, waits for it, clears `ELECTRON_RUN_AS_NODE`, and opens Electron.

Build and run the local production bundle:

```powershell
npm run build
npm start
```

`npm start` rebuilds the bundle before Electron opens it. `dist/` and `dist-electron/` are generated outputs and are intentionally ignored.

## Configure local environment values

Copy the placeholder template before an explicit live smoke check. Do not commit `.env`, and do not paste its contents into logs, issues, screenshots, fixtures, or support requests.

```powershell
Copy-Item .env.example .env
```

The template supports these values:

| Variable | Purpose |
| --- | --- |
| `EPLUS_TEST_URL` | Target URL for an explicitly configured smoke environment. |
| `EPLUS_TEST_EMAIL` | Test account email. |
| `EPLUS_TEST_PASSWORD` | Test account password. |
| `EPLUS_CERISE_BOUQUET_JWT` | Optional mailbox API credential. |
| `EPLUS_CERISE_BOUQUET_ADMIN_AUTH` | Optional main-process/admin bridge credential for deployments using `x-admin-auth`. |
| `EPLUS_CERISE_BOUQUET_ENDPOINT` | Optional cerise mailbox API endpoint; defaults to `https://temp-mail.lianminglai.workers.dev`. Use the Worker API, not a frontend-only `mail.cerise-bouquet.xyz` URL. |
| `EPLUS_BROWSER_EXECUTABLE` | Optional local Chrome executable path. |
| `EPLUS_DEVICE_PROFILE` | `desktop-chrome`, `iphone-13`, or `pixel-7`. |
| `EPLUS_ALLOW_FINAL_SUBMIT` | Kept `false`; it does not override the command-line confirmation gate. |
| `EPLUS_TEST_DATA_DIR` | Optional isolated test-data location. |

The app does not send `.env` values to the renderer. Its local database, browser profiles, artifacts, and runtime logs belong under ignored runtime directories such as `data/`, `profiles/`, and `artifacts/`.

## Create accounts

Open **Accounts** in the desktop app and add an Eplus email, password, label, tags, and an optional account-specific mail configuration. Passwords and account mail configuration are encrypted with Electron `safeStorage` before storage in the local database.

You can also paste CSV or JSON into the import panel.

```csv
eplusEmail,password,label,tags,enabled,mailProviderId,mailConfig
user@example.com,secret,Tokyo-01,"tokyo,day1",true,manual,{}
```

```json
[
  {
    "eplusEmail": "user@example.com",
    "password": "secret",
    "label": "Tokyo-01",
    "tags": ["tokyo", "day1"],
    "enabled": true,
    "mailProviderId": "manual",
    "mailConfig": {}
  }
]
```

Use placeholders in examples and test data. The UI never needs a raw HAR, browser cookie, or copied browser profile to create an account.

## Discover an event and save a snapshot

1. Open **Events**.
2. Paste an Eplus event URL in **Source URL**.
3. Select **Parse page**.
4. Review the title, venue, schedule, application deadline, detected application links, form options, and serial-code requirement.
5. Correct safe descriptive fields if needed, then select **Save snapshot**.

Static parsing is a planning aid. Login-gated forms, delayed controls, closed reception pages, serial-code ambiguity, phone verification, and unknown page structures require human inspection rather than inference.

## Configure verification mailbox access

Open **Mailbox** and choose one of the supported modes:

- `manual`: the app does not read mail automatically.
- `temp-mail-forwarder`: an HTTP JSON mailbox-reading service.
- `auth-mailbox`: an authenticated mailbox service with a provider/app ID.
- `cerise-bouquet`: the Cerise/Temp-Mail Worker API contract; the UI only asks for the mailbox address. With `EPLUS_CERISE_BOUQUET_ADMIN_AUTH`, the main process follows the `auth-main` bridge flow to obtain the address JWT before reading parsed mail.

Set the recipient mailbox, sender allowlist, subject matchers, polling interval, and timeout. The defaults target Eplus mail (`eplus.co.jp`) and common Japanese verification-code subjects. Use **Test configuration** before a run, and use **Read verification code** only to query the configured mailbox.

When exactly one matching candidate is found, **Read verification code** can return it for the configured mailbox. Browser runs still pause for email-code attribution so you can verify and enter the code in the real browser. No match, multiple matches, expired credentials, a timeout, or an unsupported provider produces a manual-action result. Saved passwords and API tokens are encrypted, and the UI does not echo an existing secret when you reopen settings.

## Manual browser takeover, IP rotation, and account profiles

Login is automated in the main process with the stored account credentials. If Eplus requests an email code, the main process reads and fills it using the current login trigger time and the account's forwarding source. Only CAPTCHA, device verification, sensitive card fields, or unknown controls require takeover; the visible Chrome/Edge window is kept open for those cases and snapshots are saved before resuming.

After submission, a run is not marked complete merely because the page navigated. It becomes `Submitted` only after a new message from the current account's forwarding source has been received, the original sender is exactly `info@eplus.co.jp`, and the message contains the `申込み完了・抽選結果確認期間のご案内` template plus the application-history link/text. Otherwise it remains `AwaitingCompletionEmail` and cannot be submitted again.

The **Network** panel supports Clash Verge/Clash and sing-box Clash API controllers. Paste a YAML or JSON controller configuration to import `external-controller`, `secret`, and the proxy group/selector, then review and save it. **Detect IP** shows IP/country/region; **Rotate IP** changes the controller group. Each lottery run rotates and validates its network lease before opening the account session.

After a completed run, the main process automatically refreshes the account profile. It reads the member pages for phone, name, gender, birthday, address, current/history companions, the application history at `https://eplus.jp/jyoukyou`, and lottery states. The Account detail view can refresh the profile manually and filter application/results tables. Credit cards are restricted to brand/last four digits; PAN, CVV and expiry are never persisted.

The complete local IPC contract is documented in [docs/api.md](docs/api.md).

## Create and queue a task

1. Open **Create task** and choose a saved event snapshot.
2. Select an application entry, ticket quantity, and participating accounts.
3. Optionally select a semantic payment preference. Leaving it empty means runtime discovery will present candidates later. Do not type an assumed DOM payment ID.
4. Select one approved device profile:
   - `desktop-chrome`: desktop profile, 1920x1080 screen.
   - `iphone-13`: mobile profile, 390x844 viewport.
   - `pixel-7`: mobile profile, 412x915 viewport.
5. For serial-code events, use the batch serial-code assignment window: paste one code per line, parse it, choose an account, entry, and Day1/Day2 (single or multiple), then select **分配所选抽选码**. **按账号平均生成方案** is also available.
6. A code assigned to Day1 creates one browser run. A code assigned to Day1+Day2 expands into two independent runs, opening separate browser sessions and selecting one day in each; the entry and code may be identical, but the two days are never submitted from one browser window.
7. Review the per-account code/run preview, acknowledge the automation-risk disclosure, and select **Create task**.
8. Open **Task monitor** and select **Queue task** when the task is ready.

The selected device profile is allowlisted from the installed `playwright-core` registry and is immutable for each run. The browser profile directory is isolated by account and device profile; concurrent ownership of the same profile is rejected.

The batch allocation IPC shape and legacy-field compatibility rules are documented in the **Serial-code task contract** section of [docs/api.md](docs/api.md). New tasks prefer `preference.serialCodeAllocations[accountId]`, where each item contains `code`, optional `daySelection`, optional `applicationLinkId`, and optional per-code ticket entries.

## Select payment candidates at runtime

Payment methods are not trusted from an event snapshot alone. After the browser reaches a supported form, the main process discovers explicit top-level payment controls and persists a fingerprinted checkpoint.

When a run pauses for payment selection:

1. Open **Task monitor**.
2. Review each displayed payment group and enabled supported candidate.
3. Select exactly one candidate for every required group.
4. Select **Submit selected payment**.
5. Wait for the reviewed run to enter **Awaiting final confirmation**.

The renderer sends only candidate IDs plus the task, run, checkpoint revision, and control fingerprint. The main process resolves exact DOM values from the stored checkpoint, revalidates the run and device binding, and rejects stale, disabled, unsupported, ambiguous, duplicate, cross-run, or reordered candidates. The system never chooses a first option merely because it is available.

## Confirm or take over a run

The decision center in **Task monitor** exposes only state-appropriate actions:

- **Awaiting final confirmation**: review the account, selected candidates, and page state. Select **Confirm and submit** only when the application is correct. This is the only final-submit route.
- **Awaiting manual action**: use the real browser only for CAPTCHA, device verification, card details, unknown controls, or other genuinely blocked conditions. Login and email-code prompts are handled automatically when the mailbox configuration can safely identify the current account.
- **Unknown submission state**: select **Reconcile submission status**. Reconciliation is read-only and may resolve to submitted, already applied, or failed. It never retries submission automatically.

The app pauses before card number, CVV, expiry, cardholder, CAPTCHA, slider, phone, or device-verification input. It does not bypass challenges, spoof arbitrary device identities, replay HAR traffic, evaluate page `onclick` code, or submit unknown consent controls. A final dispatch also requires a current one-time authorization, payment checkpoint, profile binding, and dispatch lease.

## Fixture mode and live-smoke guard

Use fixture mode for deterministic, credential-free smoke validation:

```powershell
node scripts/live-smoke.mjs --fixture tests/fixtures/eplus-lisa-0534530001-detail.html --final-submit=false
```

Fixture mode accepts a project-relative static file, rejects sensitive fixture content, does not launch a browser, does not authenticate, and prints a redacted JSON receipt.

The separate live mode validates an explicitly supplied local `.env` configuration:

```powershell
node scripts/live-smoke.mjs --env-file .env --allow-live-credentials --final-submit=false
```

Never combine `--fixture` with `--allow-live-credentials`. The script requires one explicit mode and rejects incomplete live credentials. Its current contract stops at a redacted pre-navigation/live configuration receipt; it is not a replacement for manual browser review.

`--final-submit=false` is the default. A request for `--final-submit=true` also requires `--confirm-final-submit`, but the current guard intentionally rejects final-submit authorization, so this script cannot be used to bypass the in-app reviewed dispatch flow.

## Test, build, and quality checks

Run the regular project checks:

```powershell
npm run typecheck
npm test -- --run
npm run build
```

The package test script already runs Vitest against `src`; the extra `-- --run` is accepted for the requested non-watch invocation.

For the payment/device regression subset:

```powershell
npx vitest run src/main/fixtures/paymentDeviceContract.test.ts src/main/services/eplusPageParser.test.ts src/main/services/runtimePaymentDiscovery.test.ts src/main/services/taskService.test.ts src/main/adapters/eplusAdapter.test.ts src/main/engines/browserSessionEngine.test.ts tests/renderer/workflow.test.ts
```

The quality-gate runner executes typecheck, source tests, build, the regression subset, policy scanning, and device-profile validation in sequence:

```powershell
node scripts/run-quality-gate.mjs --out .omo/reviews/eplus-payment-device-quality-gate.md
```

The runner validates the committed `tests/fixtures/sanitized-payment-device.har` and `tests/fixtures/sanitized-payment-device.har.sha256` through the fixture contract test. The raw `sp.gesicht.eplus.jp.har` is intentionally excluded from Git and must not be restored, copied, or committed.

## Troubleshoot common local issues

| Symptom | What to check |
| --- | --- |
| Electron opens with no renderer | Run `npm run build`, then `npm start`. The app loads `dist-electron/` and `dist/`, both regenerated by the scripts. |
| Electron behaves like Node | Run `npm run dev` or `npm start`; both clear `ELECTRON_RUN_AS_NODE` before launching Electron. |
| Browser cannot start | Verify `EPLUS_BROWSER_EXECUTABLE` points to an installed Chrome/Edge/Chromium binary, or install one; Electron is not used as the browser executable. |
| Payment selection is unavailable | Confirm the browser reached a supported, top-level payment form. Disabled, unknown, delayed, embedded, or ambiguous controls deliberately require manual action. |
| A device profile is already in use | Stop or cancel the owning run and wait for its browser context to close. The per-account/per-profile lock prevents concurrent reuse. |
| Mailbox test fails | Check mode, endpoint, recipient address, provider/app ID, sender/subject rules, and encrypted credential values. Manual mode is valid when automatic reading is not appropriate. |
| Run is in unknown submission state | Use read-only reconciliation. Do not queue the same run for a second submission. |

## Repository hygiene

The repository retains source, tests, scripts, documentation, the sanitized payment/device fixture, and its SHA-256 manifest. It ignores and should not commit `.env`, raw HAR files, browser data, screenshots, traces, local agent settings, runtime logs, exports, and generated bundles.

Remove only local generated directories when you need to reset local outputs:

```powershell
Remove-Item -LiteralPath dist -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath dist-electron -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath data -Recurse -Force -ErrorAction SilentlyContinue
```

Do not use broad cleanup commands against the repository. In particular, preserve `src/`, `tests/`, `scripts/`, `docs/`, `.env.example`, package manifests, sanitized fixtures, and `.omo` plan/review records.

For deeper architecture and evidence details, read [the user guide](docs/eplus-assistant-user-guide.md) and [the payment and device contract](docs/implementation-evidence/payment-device-contract.md).
