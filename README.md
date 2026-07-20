# Eplus Lottery Assistant

Local-first desktop workbench for managing Eplus lottery accounts, event snapshots, task state, and audit evidence.

## Run

```powershell
npm install
npm run dev
```

`npm run dev` clears `ELECTRON_RUN_AS_NODE` before launching Electron because this shell may set it globally.

For a built local run:

```powershell
npm start
```

## Account Input

Accounts can be added explicitly in the UI, or imported as CSV/JSON.

CSV headers:

```csv
eplusEmail,password,label,tags,enabled,mailProviderId,mailConfig
user@example.com,secret,Tokyo-01,"tokyo,day1",true,manual,{}
```

JSON format:

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

Passwords and mail config are encrypted with Electron `safeStorage` before writing to `data/app.db`.

## Current Boundary

The MVP implements account management, CSV/JSON import, automatic Eplus page parsing, serial-code lottery modeling, global verification-mailbox settings, live verification-code reading against the configured mailbox bridge, task creation, conservative task/run state transitions, local SQLite persistence, redacted logs, and adapter interfaces. The live Eplus browser adapter is still isolated behind interfaces and intentionally does not submit real lotteries yet.

See [docs/eplus-assistant-user-guide.md](docs/eplus-assistant-user-guide.md) for the current operating manual, including automatic Eplus page parsing and serial-code lottery pages.
