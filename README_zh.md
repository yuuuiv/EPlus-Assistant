# Eplus 抽选助手

<p align="center"><b><a href="README.md">English</a> | <a href="README_zh.md">简体中文</a></b></p>

本项目是一个本地优先的 Windows Electron 工作台，用于管理 Eplus 抽选账号、演出快照、任务、运行状态和审计信息。React renderer 只通过受限 IPC 调用主进程；账号密码、邮箱读取凭证和网络控制器密钥只保存在本机加密存储中。

这不是无人值守的购票或支付工具。它会在受限边界内协助浏览器工作流，并把付款选择、最终提交和异常页面留给人工确认。

## 在 Windows 上安装和启动

前置条件：

- Windows 10 或更高版本
- 安装了 npm 的 Node.js
- 使用浏览器引擎时需要兼容 Chromium 的浏览器。应用会解析 Chrome/Edge 或显式配置的 `EPLUS_BROWSER_EXECUTABLE`；不会把 Electron 可执行文件误当作浏览器后备路径

安装依赖并启动开发版桌面应用：

```powershell
npm install
npm run dev
```

`npm run dev` 会构建 Electron 主进程，在 `127.0.0.1:5173` 上启动 Vite，等待它就绪，清除 `ELECTRON_RUN_AS_NODE`，然后打开 Electron。

Vite 只会热更新渲染器。`src/main/` 下的任何改动（IPC 处理、服务、引擎）都需要完全停止并重新运行 `npm run dev` 才会生效——否则正在运行的 Electron 进程仍在用旧的编译代码做校验，看起来会像是一个已经修好的 IPC 或设置 bug 又出现了。

构建并运行本地生产包：

```powershell
npm run build
npm start
```

`npm start` 会在 Electron 打开前重新构建打包。`dist/` 和 `dist-electron/` 是生成的输出文件，已被有意忽略。

## 配置本地环境变量

在执行实时冒烟测试前，先复制占位模板。不要提交 `.env`，也不要将其内容粘贴到日志、issue、截图、fixture 或技术支持请求中。

```powershell
Copy-Item .env.example .env
```

模板支持以下变量：

| 变量 | 用途 |
| --- | --- |
| `EPLUS_TEST_URL` | 显式配置的冒烟环境目标 URL |
| `EPLUS_TEST_EMAIL` | 测试账号邮箱 |
| `EPLUS_TEST_PASSWORD` | 测试账号密码 |
| `EPLUS_CERISE_BOUQUET_JWT` | 可选的邮箱 API 凭证 |
| `EPLUS_CERISE_BOUQUET_ADMIN_AUTH` | 当邮箱部署使用 `x-admin-auth` 时，由主进程使用的可选管理员 bridge 凭证 |
| `EPLUS_CERISE_BOUQUET_ENDPOINT` | 可选的 cerise 邮箱 API endpoint，默认 `https://temp-mail.lianminglai.workers.dev`；`mail.cerise-bouquet.xyz` 若只是前端页面则不能填写 |
| `EPLUS_BROWSER_EXECUTABLE` | 可选的本地 Chrome 可执行文件路径 |
| `EPLUS_DEVICE_PROFILE` | 已批准的设备档案之一，见下方“创建并排队任务” |
| `EPLUS_ALLOW_FINAL_SUBMIT` | 保持 `false`；它不会覆盖命令行确认门控 |
| `EPLUS_TEST_DATA_DIR` | 可选的独立测试数据目录 |

应用不会将 `.env` 值发送到渲染器。其本地数据库、浏览器 profile、工件和运行时日志位于已被忽略的运行时目录中，如 `data/`、`profiles/` 和 `artifacts/`。

## 创建账号

在桌面应用中打开 **Accounts**，添加 Eplus 邮箱、密码、标签、备注和可选的账号专属邮件配置。密码和账号邮件配置在存入本地数据库前会通过 Electron `safeStorage` 加密。

你也可以在导入面板中粘贴 CSV 或 JSON。

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

示例和测试数据中请使用占位符。创建账号时，界面不需要任何原始 HAR、浏览器 cookie 或复制浏览器 profile。

## 发现演出并保存快照

1. 打开 **Events**。
2. 在 **Source URL** 中粘贴 Eplus 演出 URL。
3. 选择 **Parse page**。
4. 检查标题、场地、日程、申込截止日期、检测到的申込み入口、表单选项和抽选码要求。
5. 如需修正安全描述性字段，请在修正后选择 **Save snapshot**。

静态解析是规划辅助工具。需要登录的表单、延迟控件、已关闭的受付页面、抽选码歧义、电话认证和未知页面结构需要人工检查而非推理。

**Events** 页面还会列出所有已保存的快照及其页面类型和解析时间。快照过期或解析有误时可以删除后重新解析同一来源 URL；只要还有未完结的任务在引用该快照，删除就会被拒绝。

## 配置验证码邮箱访问

打开 **Mailbox** 并选择一种支持的模式：

- `manual`：应用不自动读取邮件
- `temp-mail-forwarder`：HTTP JSON 邮箱读取服务
- `auth-mailbox`：需要 provider/app ID 的认证邮箱服务
- `cerise-bouquet`：使用 Cerise/Temp-Mail Worker API；界面只要求填写邮箱地址。使用 `EPLUS_CERISE_BOUQUET_ADMIN_AUTH` 时，主进程会按 `auth-main` bridge 流程先取得地址 JWT，再读取解析后的邮件

设置收件邮箱、发件人白名单、主题匹配规则、轮询间隔和超时。默认值针对 Eplus 邮件（`eplus.co.jp`）和常见的日文验证码主题。运行前使用 **Test configuration**，并只在查询已配置邮箱时使用 **Read verification code**。

当恰好找到一个匹配候选时，**Read verification code** 可以将其返回给已配置的邮箱。浏览器运行仍会在邮件验证码归因时暂停，以便你在真实浏览器中确认并输入验证码。无匹配、多匹配、凭证过期、超时或不支持的提供商均会产生人工操作结果。已保存的密码和 API token 均经过加密，界面不会在你重新打开设置时回显已有密钥。

## 人工浏览器接管、切换 IP 和账号资料

登录步骤由主进程自动填写账号和密码；大多数 eplus 页面的登录表单藏在一个“ログイン画面へ”触发按钮后面，字段还不可见时程序会先点它，再填写显示出来的表单并提交。如果 Eplus 返回邮箱验证码，主进程按本次登录触发时间、当前账号转发来源和邮件规则自动读取并填写。“必ずお読みください”“同意して申込み”这类过场通知使用的是已验证的确定性选择器，程序也会自动点过去。

刷新账号资料时，程序会先访问 eplus.jp 主站，再访问任何 member.eplus.jp 页面——不经过主站直接冷启动访问会员页面，正是触发 eplus 的 Akamai 网关直接拒绝请求（而不是正常显示登录页）的原因。

只有 CAPTCHA、设备验证、卡片敏感字段或真正无法识别的页面才需要人工在真实浏览器中处理；这些情况下可见的 Chrome/Edge 窗口会保持打开，接管前会先保存一份快照。条款/同意勾选框会走下文运行时发现机制的“尽力而为”版本，匹配不确定时仍会安全回退到人工接管。

任务监控现在会区分运行为什么在等待：

- **网络租约需要人工接管**：代理（或直连模式下本机自身的网络）未能通过“要求国家”校验，因此根本没有打开浏览器——在未经校验的网络下打开浏览器有暴露账号真实 IP 的风险。卡片会直接链接到 **Network** 面板，并在你修好配置后提供重试。
- **浏览器验证挑战**：真实浏览器窗口已经打开，正在等待 CAPTCHA、设备验证或未知页面。

提交抽选后，运行不会仅凭页面跳转标记为完成。系统必须在本次提交开始时间之后收到当前账号转发来源的邮件，且原始发件人严格为 `info@eplus.co.jp`，正文同时包含 `申込み完了・抽選結果確認期間のご案内`、申请记录链接和申请记录文字，才会进入 `Submitted`。没有匹配邮件时显示 `AwaitingCompletionEmail`，不会重复提交。

**Network** 面板现在支持三种控制器模式：

- **Clash Verge / Clash** 与 **sing-box Clash API**：实际驱动轮换的是哪一个真实 Clash 代理组，由程序自动确定——你不需要命名或选择它。第一次需要时（保存、检测 IP、读取线路），程序优先复用之前已解析出的分组；否则向正在运行的控制器询问它的分组列表（`GET /proxies`，只保留带成员列表的条目）并取第一个。你真正需要命名和管理的是 **节点方案**——点 **读取线路** 拉取自动解析出的分组的真实成员，勾选想要的节点，再在 **方案名称** 里起一个名字保存。方案会被保存，各自保留自己的节点列表，用 **当前方案** 下拉菜单切换；默认全部不勾选，不勾选任何节点就表示“不限制，轮换该分组的全部节点”。下方可折叠的 **导入代理配置** 只用于从一份粘贴的 YAML 或 JSON 控制器配置中引导出主机、端口和密钥；之后不再需要它，分组和节点发现全部通过实时控制器完成。程序还会读取 Clash `/configs` 的 `mixed-port`/`port`，把浏览器显式接到该端口，避免只切了节点但浏览器仍走原出口。
- **直连**：适用于本机真实网络已经在目标地区、完全不需要代理的情况。所有账号可以安全地共用这一个真实 IP——跨账号身份复用的防护只针对代理轮换场景，用来发现轮换其实并没有真正切换出口 IP 的情况。

**检测 IP** 显示 IP、国家和地区；**切换 IP**（仅 Clash/sing-box 模式）调用本机控制器切换代理。每个抽选 run 在打开账号会话前都会轮换（直连模式下是空操作）、通过同一路径检测出口并校验一次网络租约。

每个 run 完成后，主进程会自动刷新账号资料；账号详情也可以手动刷新。采集入口包括手机号、姓名、性别、出生年份/生日、地址、当前及历史同行者、`https://eplus.jp/jyoukyou` 申请记录和抽选状态。刷新失败或部分成功时现在会显示具体原因（网络租约问题、登录/CAPTCHA 挑战，或某个具体字段缺失），不再只显示一个状态码。信用卡仅保存品牌和末四位，完整卡号、CVV、有效期不会保存。申请记录和抽选结果支持筛选。

完整的本地 IPC 合约见 [docs/api.md](docs/api.md)。

## 创建并排队任务

**创建任务** 页面按填写顺序分成几个区块：

1. **演出与申请入口**：选择一个已保存的演出快照、申请入口和票数。
2. **设备与提交策略**：选择一个已批准的设备档案，然后是最终确认策略和自动化风险声明。
   - `desktop-chrome`：桌面档案，1920x1080 屏幕
   - `desktop-edge`：桌面档案，1920x1080 屏幕
   - `iphone-13`：移动端档案，390x844 视口
   - `iphone-15`：移动端档案，393x852 视口
   - `iphone-se`：移动端档案，375x667 视口
   - `pixel-7`：移动端档案，412x915 视口
   - `pixel-8`：移动端档案，412x915 视口
   - `galaxy-s24`：移动端档案，384x832 视口
   - `ipad-gen7`：平板档案，810x1080 视口
3. **付款偏好（可选）**：可选地选择一个语义付款偏好。留空意味着运行时发现将在稍后呈现候选方案——后续运行会发生什么见下文“运行时选择候选项”。不要输入假设的 DOM 付款 ID。
4. **抽选码分配**（仅当演出需要抽选码时）：在批量输入框中逐行粘贴抽选码，解析后用 **分配所选抽选码** 把每个码分配给一个账号、申请入口和场次（可单选或多选），也可以用 **按账号平均生成方案** 把批量码平均分配。这里没有公共/共享抽选码字段——每个码在 Eplus 那边都有自己的使用次数限制，所以每个码只能分配给一个账号。
5. **参与账号**：为本次任务选择账号。
6. **预览与确认**：检查每个账号的“抽选码 / 浏览器运行”预览，确认自动操作风险声明，然后选择 **创建任务**。

一个码分配到一个场次会创建 1 次浏览器运行；分配到两个场次会拆成 2 次独立运行、分别打开浏览器并分别选择对应场次。入口和码可以相同，但两个场次绝不会在同一个浏览器窗口里一次提交完。全程显示的场次/入口标签（分配器、每账号预览）优先使用演出本身解析出的真实文字（例如 `<DAY1>シリアル先行`），只有演出没有暴露自己的标签时才回退为普通的 "Day 1"/"Day 2"。

打开 **Task monitor**，当任务就绪时选择 **Queue task**。

所选设备档案来自已安装的 `playwright-core` 注册表白名单，且每次运行不可更改。浏览器 profile 目录按账号和设备档案隔离；同一 profile 的并发占用将被拒绝。

批量分配的 IPC 数据结构和旧字段兼容规则见 [docs/api.md](docs/api.md) 的 **Serial-code task contract**。新任务优先使用 `preference.serialCodeAllocations[accountId]`，每个元素包含 `code`、可选 `daySelection`、可选 `applicationLinkId` 和可选逐码票务方案。

## 运行时选择候选项

票种、票数、申请入口和付款方式都不能仅凭演出快照信任。浏览器到达受支持的表单后，主进程会发现每一个显式的顶级控件分组并保存带指纹的检查点。

当运行暂停以进行候选选择时：

1. 打开 **Task monitor**。
2. 检查每个显示的分组和已启用且受支持的候选。
3. 为每个必需的组选择恰好一个候选。
4. 选择 **Submit selected payment**。
5. 等待已审核的运行进入 **Awaiting final confirmation**。

渲染器只发送候选 ID 以及任务、运行、检查点版本和控件指纹。主进程从存储的检查点解析确切的 DOM 值，重新验证运行和设备绑定，并拒绝过期、已禁用、不受支持、歧义、重复、跨运行或已重新排序的候选。系统绝不会仅仅因为某个选项可用就选择第一个选项。

这第一次的选择会被记住——按分组和 DOM 值记忆，绝不会用只在这次运行内有效的候选 ID——用于同一任务、同一场次/入口下的其余每一次运行。下一次运行的检查点会自动与它比对：如果每个分组都能解析出一个已启用、无歧义的候选，该运行就会直接继续而不暂停；只要有任何一项对不上（页面变了、某个候选消失了），就会像第一次运行一样暂停等待人工处理。Day1 和 Day2（或不同的申请入口）会各自保留独立的选择，因为它们的表单可能不一样。

## 确认或接管运行

**Task monitor** 中的决策中心只公开与状态匹配的操作：

- **Awaiting final confirmation**：检查账号、已选候选和页面状态。仅当申请信息正确时才选择 **Confirm and submit**。这是唯一的最终提交路径。
- **Awaiting manual action**：仅在 CAPTCHA、设备验证、卡号/CVV/有效期等敏感字段、未知控件或其他确实无法自动处理的情况下使用真实浏览器——参见上文“网络租约”与“浏览器验证挑战”的区分。登录和邮箱验证码在能安全归属当前账号时由程序自动完成。如果不应该继续，请取消运行或任务。
- **Unknown submission state**：选择 **Reconcile submission status**。对账是只读的，可能解析为已提交、已申请或失败。它绝不会自动重试提交。

应用在卡号、CVV、有效期、持卡人、CAPTCHA、滑块、电话或设备验证输入前会暂停。它不会绕过验证挑战、伪造任意设备身份、重放 HAR 流量、执行页面 `onclick` 代码或提交未知同意控件。最终派发还需要当前的一次性授权、付款检查点、profile 绑定和派发租约。

任务一旦进入 **Completed**、**Failed** 或 **Cancelled**，其所在行会显示 **删除任务** 而不是 **取消任务**——删除会把该任务及其所有运行从本地存储中移除。仍在运行或排队中的任务需要先取消。

## Fixture 模式和实时冒烟防护

使用 fixture 模式进行确定性的、无凭证冒烟验证：

```powershell
node scripts/live-smoke.mjs --fixture tests/fixtures/eplus-lisa-0534530001-detail.html --final-submit=false
```

Fixture 模式接受相对于项目的静态文件，拒绝包含敏感内容的 fixture，不启动浏览器，不进行认证，并输出脱敏的 JSON 回执。

独立的实时模式验证显式提供的本地 `.env` 配置：

```powershell
node scripts/live-smoke.mjs --env-file .env --allow-live-credentials --final-submit=false
```

切勿将 `--fixture` 与 `--allow-live-credentials` 混用。脚本要求一个明确的模式，并拒绝不完整的实时凭证。其当前契约在输出脱敏的预导航/实时配置回执后即停止；它不是人工浏览器检查的替代品。

`--final-submit=false` 是默认值。请求 `--final-submit=true` 还需要 `--confirm-final-submit`，但当前防护有意拒绝最终提交授权，因此无法用此脚本绕过应用内审核过的派发流程。

## 测试、构建和质量检查

运行常规项目检查：

```powershell
npm run typecheck
npm test -- --run
npm run build
```

包的测试脚本已对 `src` 运行 Vitest；额外的 `-- --run` 用于请求的非监视模式调用。

运行付款/设备回归测试子集：

```powershell
npx vitest run src/main/fixtures/paymentDeviceContract.test.ts src/main/services/eplusPageParser.test.ts src/main/services/runtimePaymentDiscovery.test.ts src/main/services/taskService.test.ts src/main/adapters/eplusAdapter.test.ts src/main/engines/browserSessionEngine.test.ts tests/renderer/workflow.test.ts
```

质量门禁运行器按顺序执行类型检查、源测试、构建、回归子集、策略扫描和设备档案验证：

```powershell
node scripts/run-quality-gate.mjs --out .omo/reviews/eplus-payment-device-quality-gate.md
```

运行器通过 fixture 契约测试验证已提交的 `tests/fixtures/sanitized-payment-device.har` 和 `tests/fixtures/sanitized-payment-device.har.sha256`。原始文件 `sp.gesicht.eplus.jp.har` 已被有意从 Git 中排除，不得还原、复制或提交。

## 常见本地问题排查

| 症状 | 检查项 |
| --- | --- |
| Electron 打开但无渲染器 | 运行 `npm run build`，然后运行 `npm start`。应用加载 `dist-electron/` 和 `dist/`，两者均由脚本重新生成 |
| Electron 行为像 Node | 运行 `npm run dev` 或 `npm start`；两者都在启动 Electron 前清除了 `ELECTRON_RUN_AS_NODE` |
| 浏览器无法启动 | 验证 `EPLUS_BROWSER_EXECUTABLE` 指向已安装的 Chrome/Edge/Chromium，或安装兼容浏览器；应用不会把 Electron 当作浏览器可执行文件 |
| 候选选择不可用 | 确认浏览器已到达受支持的顶级表单。已禁用、未知、延迟、嵌入或歧义的控件故意要求人工处理 |
| **检测 IP** 明明正常，运行的网络租约却总是失败 | 检测 IP 和获取网络租约不是同一项检查。如果你用 `npm run dev` 迭代，确认改动主进程代码后重启过它（见上文）——`npm start` 每次都会重新构建，不受这个影响。Clash/sing-box 模式下，确认配置的主机/端口/密钥能真正连到正在运行的控制器（这样代理组才能自动解析出来），并确认“读取线路”确实返回了成员。直连模式下，确认“要求国家”和“检测 IP”实际返回的国家一致 |
| 导入 Clash 配置报错“未找到有效的 Clash API external-controller” | 解析器能容忍带引号的值和行尾的 `# 注释`，但仍然需要一个纯粹的 `host:port`（或 `[ipv6]:port`）地址。如果一直失败，直接在“代理控制器”里手动填写主机/端口/密钥即可——这条路径不依赖解析成功 |
| 设备档案已被使用 | 停止或取消所属运行，等待其浏览器上下文关闭。按账号和档案的锁定机制防止并发重用 |
| 邮箱测试失败 | 检查模式、端点、收件地址、provider/app ID、发件人/主题规则和加密凭证值。当不适合自动读取时，手动模式是有效选择 |
| 运行处于未知提交状态 | 使用只读对账。不要将同一运行排队进行第二次提交 |
| 无法删除任务或演出快照 | 任务需要先进入 Completed、Failed 或 Cancelled。只要还有未完结的任务在引用某个快照，该快照就无法删除 |

## 仓库规范

仓库保留源代码、测试、脚本、文档、脱敏后的付款/设备 fixture 及其 SHA-256 清单。它忽略且不应提交 `.env`、原始 HAR 文件、浏览器数据、截图、trace、本地代理设置、运行时日志、导出文件和生成的打包文件。

当需要重置本地输出时，只移除本地生成的目录：

```powershell
Remove-Item -LiteralPath dist -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath dist-electron -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath data -Recurse -Force -ErrorAction SilentlyContinue
```

不要对仓库使用宽泛的清理命令。特别注意保留 `src/`、`tests/`、`scripts/`、`docs/`、`.env.example`、包清单、脱敏后的 fixture 以及 `.omo` 计划和审查记录。

如需更深入的架构和证据细节，请阅读[用户指南](docs/eplus-assistant-user-guide.md)和[付款与设备契约](docs/implementation-evidence/payment-device-contract.md)。
