# Eplus Assistant

<p align="center"><b><a href="README.md">English</a> | <a href="README_zh.md">简体中文</a></b></p>

Eplus Assistant is actually two small tools:

- **A browser userscript** (`userscript/eplus-collector.user.js`) that runs on eplus.jp while you're browsing normally. It reads your phone number, name/gender/address, credit card summary, companion list, and lottery application history off the pages you visit, and exports them to a JSON file.
- **A local desktop app** (this repository) that imports that JSON file so you can browse the collected data, and manages plain login credentials for your Eplus accounts.

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

You don't need to visit every page, and you don't need to do it in one sitting — the script remembers what it's already collected between page loads, so you can spread this across a few visits and export whenever you're ready.

## Fill in your login details automatically

Type your email and password into the panel's **账号** section once. **记住密码** (remember password) is on by default, which stores the password in your userscript manager's own storage as plain text; turn it off if you'd rather retype it each session.

A **一键填写登录信息** (fill in login details) button appears on eplus.jp's login page and on the login pop-up on the homepage. It fills the email and password fields for you — you still click the site's own login button.

## Check your current IP

The panel's **当前 IP / 来源地** section shows your public IP, country, region, and city, using [ip-api.com](http://ip-api.com) (falling back to [ipwho.is](https://ipwho.is/) if that's unreachable). This is for your own reference only — it isn't written to the exported file.

## Install and run the desktop app

You need Windows 10 or later and Node.js with npm.

```powershell
npm install
npm run dev
```

This builds the Electron main process, starts Vite, and opens the app. Changes under `src/renderer/` hot-reload; changes under `src/main/` need a full restart of `npm run dev` to take effect.

For a production build instead:

```powershell
npm run build
npm start
```

## Add accounts

Open **账号列表** (accounts) and either:

- fill in the **新增账号** (add account) form with an email, password, and label, or
- paste a CSV or JSON list into **批量导入登录名单** (bulk import):

  ```csv
  eplusEmail,password,label,tags,enabled
  user@example.com,secret,Tokyo-01,"tokyo,day1",true
  ```

Passwords are encrypted with Electron's `safeStorage` before they touch disk.

## Import a collection file

Click **选择采集文件** (choose collection file) and pick a JSON file the userscript exported. The app matches it to an existing account by email; if none exists, it creates one for you with no real password, since you logged in manually and never gave the userscript one.

Open an account's **详情** (details) to see its profile, companions, credit cards, and lottery applications. The applications table has a status filter.

## Repository layout

| Path | What's there |
| --- | --- |
| `userscript/eplus-collector.user.js` | The browser userscript. Self-contained, no build step. |
| `src/main/` | Electron main process: IPC handlers, the accounts/profiles/lottery-records database, encrypted secret storage. |
| `src/renderer/` | The desktop UI, built with React. |
| `src/shared/` | Types and the IPC contract shared between main and renderer. |

## Test, typecheck, and build

```powershell
npm run typecheck
npm test
npm run build
```
