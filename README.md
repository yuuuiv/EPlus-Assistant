# Eplus Assistant

<p align="center"><b><a href="README.md">English</a> | <a href="README_zh.md">简体中文</a></b></p>

Eplus Assistant is actually two small tools:

- **A browser userscript** (`userscript/eplus-collector.user.js`) that runs on eplus.jp while you're browsing normally. It reads your phone number, name/gender/address, credit card summary, companion list, and lottery application history off the pages you visit, and exports them to a JSON file.
- **A local desktop app** (this repository) that imports that JSON file so you can browse the collected data across all your Eplus accounts in one place.

Neither piece logs in for you, fills out a lottery entry, or buys anything. You browse and log in to eplus.jp yourself; the userscript only reads what's already on the page in front of you.

## Install the userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Open its dashboard, create a new script, and replace the contents with [`userscript/eplus-collector.user.js`](userscript/eplus-collector.user.js).
3. Save it.

A panel now appears in the bottom-right corner of any `eplus.jp`, `member.eplus.jp`, or `orderhistory.eplus.jp` page.

## Collect your account data

1. Log in to eplus.jp as you normally would. (The panel can fill your saved email and password into the login form — see [Fill in your login details automatically](#fill-in-your-login-details-automatically) — but you still submit it yourself.)
2. In the panel's **采集进度** (collection progress) section, click each item to jump to that page:

   | Panel label | Eplus page |
   | --- | --- |
   | 电话号码 | 携帯電話番号変更 |
   | 姓名&性别&住址 | 基本情報変更 |
   | 信用卡信息 | クレジットカード登録/変更 |
   | 同行者名单 | 同行者登録/解除 |
   | 抽选申请记录 | your order history, on `orderhistory.eplus.jp` |

3. Give each page a second or two. Its dot turns green once the script has read the fields — including "nothing here," which still counts as collected. On the order history page, the script clicks "もっと見る" automatically until every record has loaded, which can take a few seconds if you have a long history.
4. Click **导出采集文件** (export). Choose which lottery statuses to include, or leave everything checked, then download the JSON file.

You don't need to visit every page, and you don't need to do it in one sitting — the script remembers what it's already collected between page loads, so you can spread this across a few visits and export whenever you're ready. Re-exporting later only adds to or updates what the desktop app already has; a page you skip on a later pass never erases data you collected earlier.

## Fill in your login details automatically

Type your email and password into the panel's **账号** section once. **记住密码** (remember password) is on by default, which stores the password in your userscript manager's own storage as plain text; turn it off if you'd rather retype it each session.

A **一键填写登录信息** (fill in login details) button appears on eplus.jp's login page and on the login pop-up on the homepage. It fills the email and password fields for you — you still click the site's own login button.

## Check your current IP

The panel's **当前 IP / 来源地** section shows your public IP, country, region, and city, using [ip-api.com](http://ip-api.com) (falling back to [ipwho.is](https://ipwho.is/) if that's unreachable). This is for your own reference only — it isn't written to the exported file.

## Run the desktop app from source

You need Node.js with npm.

```bash
npm install
npm run dev
```

This builds the Electron main process, starts Vite, and opens the app. Changes under `src/renderer/` hot-reload; changes under `src/main/` need a full restart of `npm run dev` to take effect.

For a production build instead:

```bash
npm run build
npm start
```

## Build a standalone installer

```bash
npm run dist:win    # Windows: NSIS installer + a portable .exe, under release/
npm run dist:mac    # macOS: .dmg + .zip, under release/ (must run on macOS)
```

electron-builder can't produce a macOS build on Windows (or vice versa) — that's an Apple/electron-builder tooling limit, not something this project works around. If you're not on a Mac, push a `v*` tag (or trigger it manually from the Actions tab) and [`.github/workflows/release.yml`](.github/workflows/release.yml) builds both platforms on GitHub-hosted runners and attaches the installers to a release. Neither build is code-signed, so first launch needs an extra click through Windows SmartScreen or a right-click → Open on macOS.

## Import a collection file

Open **账号列表** (accounts) and click **选择采集文件** (choose collection file) — you can select more than one JSON file at once. The app matches each one to an existing account by email; if none exists, it creates one with no real password, since you logged in manually and never gave the userscript one. You can set a real password afterward from the account's **详情** (details) view so **显示密码** (show password) and the copy button next to it are actually useful.

The account list shows a running number, phone number, email, enabled/disabled status, and when the profile was last refreshed.

## Look at an account's details

Open an account's **详情** (details) to see its profile — name with furigana, phone, address, saved companions, and a credit card summary (network + last 4 digits only; card numbers, CVVs, and expiry are never collected) — plus its full lottery application history with a status filter.

## Check win rates across every account

The **账号总览** (overview) page aggregates every account: total accounts, cumulative wins, distinct performances drawn for, and overall win rate, plus:

- Gender and outcome breakdowns, switchable between a segmented bar and a donut chart
- A win-rate ranking across accounts, colored on a diverging scale centered on 50% (warmer above half, cooler below) so it also shows how far above or below the middle each account sits, not just its rank
- Recent lottery activity and the most-contested performances
- A sortable, filterable table of every account's stats, with a per-account modal listing every performance it's drawn for

Export the whole table to CSV from the button at the top of the page.

## Dig into strategy-level analytics

The **深度分析** (analytics) page goes past the basic overview into questions about how to actually run the tool:

- Monthly application volume and win-rate trend, bucketed by each show's date
- How the odds of at least one account winning a performance change as more accounts draw for it (observational, not a controlled experiment — accounts piling onto a performance may just mean it's popular)
- A dose-response curve for how re-applying to the same performance multiple times affects the odds
- A win-rate ranking re-scored with a Wilson confidence interval, so an account with one lucky draw doesn't outrank one with a long, genuinely strong track record
- Investment-return rankings (wins ÷ entries spent) at both the tour-series and single-performance level, filtered to series/performances with at least 3 entries
- A demand-vs-difficulty scatter plot, so a heavily-contested performance and a genuinely hard one can be told apart

## Repository layout

| Path | What's there |
| --- | --- |
| `userscript/eplus-collector.user.js` | The browser userscript. Self-contained, no build step. |
| `src/main/` | Electron main process: IPC handlers, the accounts/profiles/lottery-records database, encrypted secret storage. |
| `src/renderer/` | The desktop UI, built with React. |
| `src/shared/` | Types and the IPC contract shared between main and renderer. |
| `build/icon.png` | Source app icon; electron-builder generates the `.ico`/`.icns` from it. |
| `.github/workflows/release.yml` | Builds Windows and macOS installers on a tag push or manual dispatch. |

Account passwords are encrypted with Electron's `safeStorage` before they touch disk. The local database lives under `data/` when running from source, and under the OS's standard per-user app-data directory once installed.

## Test, typecheck, and build

```bash
npm run typecheck
npm test
npm run build
```
