# Eplus 登录与抽选助手架构设计

## 1. 目标与边界

本项目是一个本地运行的多账号管理终端与可复用的抽选工作台，面向拥有多个本人 Eplus 账号、需要统一管理账号档案并重复执行抽选申请的场景。

### 产品定位

**多账号管理终端**：登录每个账号后采集并持久化账号档案（昵称、注册信息等）、同行者列表、历史申请记录及中落选结果，形成统一的账号看板，支持检索、筛选与批量操作。

**可复用的抽选工作台**：一次解析演出/抽选页面后，可将同一份票档偏好批量应用到多个账号，程序串行执行每个账号的登录、邮箱验证码处理、表单填写与提交，并保存每步证据与最终结果。

用户的主要操作为：

1. 导入或手动添加账号资料（支持 CSV/JSON/手动输入），并可随时增删改或重新导入。
2. 粘贴一个 Eplus 演出详情或抽选页面 URL。
3. 在程序中选择票档、枚数、希望顺位、付款方式等可用选项。
4. 选择目标账号（支持全选），预览后提交任务。
5. 程序依次为每个账号登录、处理邮箱验证码、填写并提交抽选申请，保存每一步证据和最终结果。

### 需求 → 章节对照

| 需求 | 对应章节 |
| --- | --- |
| 页面状态检测（登录/验证码/CAPTCHA/粉色按钮/勾选） | §6 页面状态分类器 |
| 多账号管理终端（档案/同行者/申请记录/中落选记录+筛选） | §7 核心领域模型、§9 档案采集、§10 申请记录与中落选结果 |
| 邮箱验证码源（cerise-bouquet + Cloudflare + 手动） | §11 邮箱验证码架构 |
| 每账号 IP 轮换（Clash 控制器 + ip-api 检测 + 切换按钮） | §15 网络层 / IP 轮换 |
| 抽选码日别选择（day1/day2/两天） | §7.3 LotteryPreference、§12 Eplus 浏览器适配器 |

### 非目标

- 不绕过 CAPTCHA、滑块、人机检测、设备验证或电话认证，检测到即暂停等待人工接管（人工接管/manual takeover）。
- 出现需要人工完成的站点验证时，任务暂停并提示用户在受控浏览器窗口中操作。
- IP 轮换为尽力而为的账号隔离手段，一抽一个 IP，绝不用于规避站点安全机制或频率限制。
- 档案采集仅读取操作者本人账号数据。
- 不保存信用卡完整卡号、CVV 等支付敏感数据；付款方式只保存站点提供的选项标识。
- 不承诺 Eplus 页面结构、业务规则或可选项永久不变；页面适配器应可独立更新。

## 2. 关键原则

- **本地优先**：凭据、会话状态、邮箱验证码、任务证据和账号档案默认只存本机。
- **显式确认**：最终提交抽选前显示账号、演出、票档、枚数、希望顺位、付款方式和预计申请数，并要求一次确认。
- **可恢复**：每个账号任务、档案与同行者数据采集均有持久化状态。程序意外退出后可从最近安全检查点继续，避免重复提交。
- **低耦合**：Eplus 页面解析、邮件验证码获取、凭据仓库、浏览器执行器和界面分别实现。
- **可审计**：记录脱敏日志、页面截图、请求步骤和申请结果，不在日志中写入密码或验证码原文。
- **会话隔离与串行执行**：每个账号使用独立的持久化浏览器 profile，同一时间仅一个账号执行抽选流程，避免会话串扰和重复申请。

## 3. 推荐技术选型

| 层 | 推荐实现 | 原因 |
| --- | --- | --- |
| 桌面框架 | Electron 40（主进程 + preload + renderer，contextBridge IPC） | 成熟的跨平台桌面方案，提供安全的 IPC 通道与原生系统集成 |
| 前端 UI | React 19 + TypeScript | 组件化开发，严格类型检查 |
| 构建工具 | Vite | 快速的 HMR 与生产构建 |
| 本地数据库 | sql.js（SQLite compiled to WASM）+ Electron safeStorage 字段加密 | 零依赖、单文件数据库；safeStorage 利用 OS 原生密钥链保护凭据 |
| 浏览器自动化 | Playwright（`playwright-core` + Chromium）持久化 per-account context | 对现代 Web 页面、等待条件、截图和人工接管支持成熟；持久化 context 保留 cookie/会话状态 |
| 页面解析 | cheerio（离线 DOM 解析） | 用于解析 Playwright 捕获的 HTML 快照，提取表单选项和页面结构 |
| 网络层 | NetworkRotationProvider → Clash 控制器 API | 通过 Clash 外部控制器实现 per-account IP 轮换 |
| 邮箱验证码适配 | HTTP Client + mail.cerise-bouquet.xyz（temp-mail forwarder / auth mailbox） | 将邮件服务变化隔离在适配器内 |

当前实现即为 Electron + TypeScript 单体应用，全部依赖均在 `package.json` 中声明。

> **可选未来迁移**：若桌面体积或性能成为瓶颈，可评估迁移至 Tauri 2（Rust 后端）。当前架构已通过适配器接口保留此迁移路径，但 Tauri 并非当前或近期计划的技术栈。

## 4. 总体架构

```text
Electron 渲染进程 (Renderer) — React UI
    ├── 账号管理终端
    ├── 账号详情
    ├── 新建抽选
    └── 设置 + IP 管理
    |
    | contextBridge IPC
    v
Electron 主进程 (Main) — 应用服务层
    ├── Task Orchestrator           抽选任务编排及状态机
    ├── Account Service             账号、分组、加密凭据管理
    ├── Event/Flow Service          URL 校验、演出与申请表单发现
    ├── Verification Service        邮箱验证码轮询及人工验证协调
    ├── Audit Service               脱敏日志、截图、结果归档
    ├── Profile Harvester Service   档案/同行者/申请记录采集【规划中】
    └── Network Rotation Service    IP 轮换协调【规划中】
    |
    v
适配器层 (Adapters)
    ├── Live Browser Session Engine + 页面状态分类器【规划中】
    │                               Playwright 持久化 context + read→decide→act 循环
    ├── Mail Provider               邮箱验证码适配器
    ├── NetworkRotationProvider     Clash 外部控制器【规划中】
    └── Secret Store                safeStorage 密钥封装
    |
    v
本地数据层 (Local Data)
    ├── sql.js DB (accounts / profiles / records / tasks / runs / audit)
    ├── 加密凭据 (safeStorage)
    ├── artifacts/ (截图、HTML 快照、脱敏证据)
    └── profiles/<account-id>/ (per-account Playwright 持久化 context)
```

当前已实现的服务：Account Service、Event Service、Task Service、Settings Service（对应图中未标「规划中」的服务层模块）。Live Browser Session Engine、Page-State Classifier、Profile Harvester Service、Network Rotation Service 和 NetworkRotationProvider 为规划中的新增子系统。

## 5. 浏览器会话引擎（Live Browser Session Engine）【规划中】

### 引擎总览

浏览器会话引擎是抽选流程的实际执行层，驱动力从"单次 HTTP fetch"升级为"持久化浏览器会话 → 循环判定与操作"。每个 Eplus 账号持有一个独立的 Playwright 持久化浏览器上下文，存放于 `profiles/<account-id>/`。

引擎的核心执行模型是一个**读→判→动的步骤循环**（读状态 → 判定 → 执行 → 再读状态），贯穿整个抽选流程的每一跳：

1. **读状态**：从当前 LIVE 页面采集 DOM、URL、可见元素选区和可交互控件，生成结构化的页面状态描述。
2. **判定**：页面状态分类器（将在后续章节详细定义）根据 LIVE 页面输入返回当前所处阶段（未登录、登录页、验证码页、My 页面、抽选表单页、确认页、完成页、需人工接管等）。
3. **执行**：按阶段执行对应动作（填写邮箱密码 → 点击登录 → 等待验证码 → 填写验证码 → 导航至抽选页 → 选择票档 → 确认提交）。
4. **再读状态**：执行动作后立即重新读取页面，验证动作是否产生了预期跳转或状态变化；若未变化则重试或触发异常路径。

### 为每一步保存快照

引擎执行的每个原子步骤（每一次读→判→动→再读的完整周期）都会捕获两份证据：

- **截图**：Playwright 内置的 `page.screenshot()`，保存当前视口的完整像素画面。
- **脱敏 HTML 快照**：从 Playwright 的 LIVE 页面提取完整 DOM 结构，经脱敏层移除密码、验证码、Token 等敏感字段后保存为静态 HTML 文件。

所有截图和快照按 `{accountId}/{runId}/{stepId}` 路径归档至 `artifacts/`，确保整个抽选过程可回溯、可审计、可用于离线回归测试。快照的 HTML 部分后续由 `parseEplusPage()`（`src/main/services/eplusPageParser.ts`）做离线结构解析和表单字段提取。

### 会话生命周期与会话复用

每个账号的持久化浏览器上下文在首次运行时创建，后续运行直接复用。引擎不假设每次都需要重新登录，会话复用是默认路径：

1. **有效性探测**：每轮任务启动时，引擎首先导航至一个已知的 Eplus 已登录页面（建议使用 `https://eplus.jp/sys/main.jsp`，未登录状态下该页必然重定向至登录页），检查当前 URL 和页面特征。探测本身也是一次"读状态 → 判定"循环。
2. **会话有效 → 直接复用**：如果探测确认会话仍然活跃，跳过登录和验证码环节，直接从当前状态进入后续流程。这是大多数运行的实际路径，不是一次性的特殊优化。
3. **会话过期/缺失 → 回退登录**：仅在探测失败（跳转至登录页、cookie 丢失、session 超时）时，才触发完整的"邮箱 → 密码 → 邮箱验证码"登录流程。文档中提到的"通常需要多次登录"是兜底路径，不是默认假设。

会话复用由 Playwright 的持久化 context 天然支持：`profiles/<account-id>/` 下保存完整的浏览器 cookie、localStorage、sessionStorage 和浏览器缓存，关闭进程后重启仍可恢复。

### 为什么单次 fetch() 不够

当前 `EventService.discoverFromUrl`（`src/main/services/eventService.ts:27-53`）使用一次无状态的静态 `fetch()` 拉取页面 HTML，然后将原始 HTML 交给 `parseEplusPage()` 做 cheerio 解析。这个路径有结构性的缺陷：

- **无认证状态**：`fetch()` 不携带任何 cookie 或 session token，只能获取 Eplus 的公开页面（演出详情页在未登录状态下也可访问）。登录后的 My 页面、抽选申请表单、申请记录页都需要认证 session。
- **无 JavaScript 执行**：Eplus 大量使用客户端渲染与动态加载。`fetch()` 只拿到服务端返回的初始 HTML，不执行页面中的 JavaScript，也不触发后续的 XHR/CSR 渲染。
- **无多步导航**：从演出详情到确认提交之间涉及多次页面跳转（首页 → 登录页 → My 页面 → 抽选页 → 确认页 → 完成页），每一步都可能触发新的渲染、重定向或弹出验证。一次 `fetch()` 无法覆盖这个流程。

浏览器会话引擎用 Playwright 持久化 context 替代了静态 `fetch()`：Playwright 运行完整的浏览器内核，执行 JavaScript，维护 cookie 和 session 状态，处理重定向，并在每一步之后提供真实的 LIVE 页面供分类器判定。`ManualOnlyEplusAdapter`（`src/main/adapters/eplusAdapter.ts`）目前的全部方法均抛出异常，确认尚无任何浏览器自动化实现，本节描述的引擎为规划中的替代方案。

### 导航预算与退避

引擎为每个步骤设定合理的超时和重试限制：

- **页面导航超时**：单次 `page.goto()` 或点击触发的导航默认 30 秒超时，可针对特殊页面（如验证码等待页）单独配置。
- **步骤重试**：若"再读状态"判定步骤未达到预期结果（如点击登录后未跳转至 My 页面），引擎最多重试 3 次，每次重试前等待 2 秒。
- **速率限制退避**：Eplus 可能在短时间内拒绝过多请求。引擎对 429、503 等限制响应采用指数退避（1s → 2s → 4s → 8s），最大等待 60 秒后告警暂停。
- **网络错误处理**：连接超时、DNS 失败等网络层错误同样进入退避队列，不立即判定为账号异常。

### 人工接管集成

浏览器以**有头模式（headed）**运行，浏览器窗口始终可见，不是 headless。这样设计的原因是：

Eplus 的登录和抽选流程可能在任意环节弹出 CAPTCHA（reCAPTCHA/hCaptcha）、滑块验证、设备验证或电话认证。这些页面被页面状态分类器识别为一个特殊的"需人工接管"状态（`manual_takeover_required`）。

当分类器返回人工接管状态时：

1. 引擎立即暂停当前账号的自动化流程。
2. 浏览器窗口保持打开，不做任何自动操作。
3. 引擎通过 IPC 向渲染进程发送 `AwaitingManualAction` 事件，包含当前状态描述和截图。
4. 操作者直接在可见的浏览器窗口中手动完成验证。
5. 手动完成后，操作者在 UI 中点击"继续"，引擎从"再读状态"步骤恢复循环。

人工接管触发点包括但不限于：登录验证码、CAPTCHA 页面、异常 IP 警告页、设备验证页。

### 分类器输入约定（重要修正）

这里存在一个关键的输入边界问题，需要在架构文档中明确：

- 页面状态分类器（将在后续章节详细定义）的**输入来源是 LIVE Playwright 页面**，即 Playwright 的 `page` 对象提供的实时 DOM、当前 URL 和可见元素选择器。分类器直接读取 Playwright 的 live page handle，不做离线快照解析。这保证分类判定基于"浏览器当前实际看到的页面"，而非过期数据。
- `cheerio`（`src/main/services/eplusPageParser.ts` 中的 `parseEplusPage()`）的用途**仅限于**对已持久化的 HTML 快照做离线二次解析——例如提取表单字段结构、生成回归测试用例、对比历史页面结构变化。cheerio **绝不能**作为分类器的实时输入源，否则会出现"用一小时前的快照判定当前页面状态"的逻辑错误。

这一输入约定是架构正确性的硬约束：**分类器看 LIVE 页面，cheerio 看存档快照**。两者操作的是同一份 DOM 结构（均源于 Playwright 页面），但前者是实时的，后者是离线的。快照捕获发生在每次"读状态"步骤，捕获完成后 cheerio 可随时在离线环境中重新解析同一份快照。

### 会话复用与幂等性补充

- **有效性探测机制**：每轮启动时先探测，而不是直接走登录流程。探测失败后才触发完整登录，这是"通常需要多次登录"的前提边界。
- **轮换失败后的处理**：如果 IP 轮换（通过 NetworkRotationProvider）失败或切换后的 IP 仍被标记，引擎不会以旧 IP 继续执行。流程暂停，等待操作者手动确认或调整网络环境。
- **会话隔离**：不同账号的持久化 context 存储在不同目录（`profiles/<account-id>/`），彼此完全隔离，不存在 cookie 串扰或 session 污染的风险。

## 6. 页面状态分类器（Page-State Classifier）【规划中】

页面状态分类器是引擎循环中每次"读状态"步骤调用的核心判定模块。它接收 LIVE Playwright 页面作为输入（当前 URL、DOM 结构和可见元素），输出一个状态枚举值、置信度分数和下一步操作所需的选择器提示。分类器不做任何写操作，只做判定；引擎根据判定结果决定下一步是自动填写、暂停等待人工接管还是标记任务结束。

| 状态 | 枚举值 | 检测信号 | 动作 | 选择器来源 |
|---|---|---|---|---|
| 登录界面 | `Login` | URL 匹配 `/login`，或页面包含登录表单（邮箱 + 密码双输入框） | 自动填写邮箱密码，点击登录按钮 | `loginButton`: `#login-bt a, #login, a:has-text('ログイン画面へ')` — 来自 `eplusPageParser.ts` selectorHints |
| 验证码输入 | `EmailCode` | 页面出现 "認証コード"/"確認コード" 文本，或出现验证码输入框 | 调用 Verification Service 获取验证码并自动填入，或暂停等待人工输入 | 待核对 — 需实际登录后观察验证码输入页的 DOM 结构 |
| 人机验证 | `CaptchaSliderDevice` | 页面出现 reCAPTCHA/hCaptcha iframe，或滑块验证组件，或 "電話番号認証が必要" 文本 | **人工接管，永不自动解决**。引擎暂停，浏览器保持有头模式，操作者手动完成验证 | `電話番号認証が必要` 文本检测来自 `eplusPageParser.ts` notes（line 298）。具体 captcha/滑块 iframe 选择器待核对 |
| 粉色按钮/确认拦截 | `InterstitialConsent` | 页面出现粉色按钮，文本为 "次へ"、"OK"、"確認"、"同意して申込み" 等 | 自动点击匹配到的粉色/确认按钮继续流程 | `cautionNextButton`（`button[data-title='★ 必ずお読みください ★']`）和 `finalConsentButton`（`#apply-button-area a:has-text('同意して申込み')`）来自 `eplusPageParser.ts` selectorHints。"OK"/"確認" 的具体选择器待核对 |
| 勾选同意 | `CheckboxGate` | 页面要求勾选同意条款或选择席位种类（需勾选 checkbox/radio） | 自动勾选所有必选 checkbox，然后点击下一步 | 待核对 — 当前代码中无任何 checkbox 选择器，需在真实页面中确认选择器 |
| 标准抽选表单 | `LotteryForm` | 页面包含票档选择、枚数选择、希望顺位和付款方式选择等标准表单元素 | 按照 `LotteryPreference` 自动填写表单选项 | 表单字段结构由 `parseEplusPage()` 从页面快照解析（option kind + values），选择器来源为解析后的字段 ID |
| 日别选择 | `DaySelection` | 页面出现 "day1"/"day2"/"両日" 或对应日文日期选择界面 | 按账号的 `selectedDays` 配置自动选择，支持 day1/day2/两天 | 待核对 — 具体日别选择器的 DOM 结构需在实际抽选码页面中确认 |
| 回执/完成 | `Receipt` | 页面出现 "受付番号"、"申込完了" 或类似完成文本 | 提取受付番号，保存回执截图与快照，标记 AccountRun 为 `Submitted` | 待核对 — 需在实际提交后观察回执页的 DOM 结构 |
| 受付終了 | `ReceptionClosed` | 页面显示 "受付は終了" | 标记当前演出不可申请，任务结束 | "受付は終了" 文本检测来自 `eplusPageParser.ts` notes（line 301） |
| 未知状态 | `Unknown` | 页面结构不符合以上任何已知模式 | 暂停并标记为需人工检查 | — |

### 状态匹配优先级

分类器按固定顺序依次匹配状态，一旦命中即停止。匹配顺序设计为：先检测终止条件（`ReceptionClosed`、`CaptchaSliderDevice`），再检测需人工交互的拦截页面（`InterstitialConsent`、`CheckboxGate`），然后检测关键流程节点（`Login`、`EmailCode`、`LotteryForm`、`DaySelection`、`Receipt`），最后 fallback 到 `Unknown`。这一顺序确保高风险状态（如人机验证、受付終了）不会因被后匹配的通用状态覆盖而漏报。

### 状态转换路径

分类器状态之间可相互转换。以下是典型转换路径：

- **主路径**：`Login` → `EmailCode` → `InterstitialConsent` → `CheckboxGate` → `LotteryForm` → `DaySelection` → `Receipt`
- **分支路径**：任一状态均可跳转至 `CaptchaSliderDevice`（触发人机验证）或 `Unknown`（页面结构变化）。

实际执行中，同一轮"读状态"可能经历多次状态转换，直到到达终止状态（`Receipt`、`ReceptionClosed`、`CaptchaSliderDevice`、`Unknown`）。

### 分类器状态到 AccountRun 状态的映射

分类器输出的是页面级判定，引擎需将其转换为任务级 `AccountRun` 状态：

| 分类器状态 | AccountRun 状态 |
|---|---|
| `Login` / `EmailCode` | `LoggingIn` / `AwaitingEmailCode` |
| `CaptchaSliderDevice` | `AwaitingManualAction`（人工接管） |
| `InterstitialConsent` / `CheckboxGate` | `FillingForm`（自动处理） |
| `LotteryForm` / `DaySelection` | `FillingForm` |
| `Receipt` | `Submitted` |
| `ReceptionClosed` | `Failed` |
| `Unknown` | `AwaitingManualAction` |

## 7. 核心领域模型

### 7.0 领域模型总览

以下列出本系统涉及的全部领域实体及其当前状态：

- **Account**（已有）—— 账号基本凭据与邮件配置，详见 §7.1
- **AccountProfile**（规划中）—— 账号档案，采集自 Eplus 会員情報，详见 §7.1.1
- **Companion**（规划中）—— 同行者记录，分为当前绑定与曾绑定，详见 §7.1.1
- **EventSnapshot**（已有）—— 演出快照，包含页面解析结果与表单选项，详见 §7.2
- **LotteryPreference**（已有，已扩展 `daySelectionByAccountId`）—— 抽选偏好，支持每账号日别选择，详见 §7.3
- **LotteryTask / AccountRun**（已有，已扩展 `selectedDays` per-account）—— 抽选任务与单账号运行状态，详见 §7.4
- **ApplicationRecord**（规划中）—— 历史申请记录，由档案采集运行自动采集，详见 §10
- **LotteryResultRecord**（规划中）—— 中落选结果记录，通过手动刷新获取，详见 §10
- **ProfileHarvestRun**（规划中）—— 档案采集运行生命周期，复用浏览器会话引擎，详见 §7.1.2

### 7.1 Account

```text
Account
  id: UUID
  label: string                 # 显示名，例如 “东京场-01”
  eplus_email: string
  encrypted_eplus_password: bytes
  mail_provider_id: string      # 例如 temp-mail-forwarder
  encrypted_mail_config: bytes  # 收件箱/API 所需配置
  tags: string[]
  enabled: boolean
  last_login_at: datetime?
  last_login_status: enum
  created_at / updated_at
```

账号密码和邮件服务访问凭据均以每台机器独有的主密钥加密；导出时默认不含密码，需要用户输入导出密码才可生成加密备份。

### 7.1.1 AccountProfile

`AccountProfile` 是与 `Account` 一对一关联的档案实体。每个账号可零个或一个档案记录，在首次成功登录后由档案采集运行（`ProfileHarvestRun`）自动填充。

```text
AccountProfile
  accountId: UUID              # 1:1 关联至 Account
  eplusEmail: string           # 账号绑定的 Eplus 邮箱
  encryptedPassword: bytes     # Eplus 登录密码（safeStorage 加密）；支持按需 reveal
  revealSupported: boolean     # 站点是否支持"点击显示密码"功能
  phone: string?               # 绑定手机号（脱敏）
  name: string?                # 姓名（可在会員情報中获取）
  gender: string?              # 性别
  birthday: string?            # 生年月日
  address: string?             # 地址（可在会員情報中获取）
  companions: Companion[]      # 当前绑定的同行者
  pastCompanions: Companion[]  # 曾绑定但已解绑的同行者
  harvestedAt: datetime        # 最近一次采集时间
  harvestStatus: enum          # Pending | Ok | Partial | Failed
```

`harvestStatus` 含义：

| 值 | 含义 |
| --- | --- |
| `Pending` | 尚未执行过档案采集 |
| `Ok` | 本次采集成功，所有已知字段均已获取 |
| `Partial` | 部分字段获取成功（如邮箱、姓名获取成功，但同行者页面加载失败） |
| `Failed` | 采集完全失败（如登录后会话过期、页面结构不可识别） |

#### Companion

同行者（Companion）记录账号在 Eplus 站点上绑定的同行者信息，分为当前绑定和曾绑定两类。

```text
Companion
  name: string                 # 同行者姓名
  relationship?: string        # 关系（如 "友人"、"家族"）
  memberId?: string            # Eplus 会員 ID（如有）
  boundAt?: datetime           # 绑定时间
  unboundAt?: datetime         # 解绑时间（仅 pastCompanions）
```

> 同行者为**只读展示数据**。采集后显示在账号详情 UI 中供操作者参考，但不在抽选申请中自动分配或选择。同行者不属于 `LotteryPreference` 的可操作字段。同行者的绑定/解绑操作需操作者自行在 Eplus 站点上完成。

#### 档案数据来源说明

> **待核对** — 以上所有档案字段的来源均为需要登录后才能访问的 Eplus 会員ページ（My 页面、会員情報、同行者管理）。这些页面的确切 URL、DOM 结构、选择器和具体的数据提取路径目前均未知，文档中以 `待核对` 标记。实现者应在开发时通过 Eplus 帮助文档（ヘルプ）及首页/会員メニュー导航定位这些页面。
>
> **当前代码中的 `Account` 类型（`src/shared/types.ts:27-38`）不包含任何档案字段**，本节描述的 `AccountProfile` 及 `Companion` 均为规划中的新增实体，将在后续实现阶段新增独立的 `account_profiles` 和 `companions` 数据库表。

#### 加密与脱敏规则

档案中多个字段包含个人身份信息（PII），存储和日志输出须遵守以下规则：

- 密码字段 `encryptedPassword` 使用 Electron `safeStorage` 加密存储，永不写入日志或数据库明文列。
- `revealSupported` 标记站点是否提供"显示密码"功能；若支持，采集时可自动获取明文密码；否则标记为 `revealSupported: false`，密码字段仅加密存储。
- 明文密码仅在操作者主动点击"显示密码"时解密并在界面中短暂展示，不复制到剪贴板，不进入日志。
- 手机号以脱敏形式存储（如 `080****1234`），日志中完全替换为 `[PHONE]`。
- 姓名、性别、生年月日、地址等 PII 在日志中按字段级脱敏：姓名显示首字 + `*`（如 `张*`），其余字段替换为字段名标签（如 `[GENDER]`、``[BIRTHDAY]``、``[ADDRESS]``）。
- 同行者姓名同样适用姓名脱敏规则；`memberId` 和 `relationship` 保留完整值，不属于 PII 脱敏范围。

### 7.1.2 ProfileHarvestRun

`ProfileHarvestRun` 记录单次档案采集运行的生命周期。一次运行从登录成功后的页面遍历开始，到所有目标字段读取完成（或失败暂停）结束。

```text
ProfileHarvestRun
  id: UUID
  accountId: UUID
  status: enum
    Pending               # 等待执行
    LoggingIn             # 正在登录（复用已有会话或触发新登录）
    AwaitingEmailCode     # 等待邮箱验证码（登录阶段触发）
    AwaitingManualAction  # 等待人工接管（CAPTCHA、滑块等）
    Extracting            # 正在遍历页面并提取档案字段
    Completed             # 采集完成
    Failed                # 采集失败（会话过期、页面不可识别等）
  harvestedFields: string[]     # 本次成功采集的字段列表
  errorDetail?: string          # 脱敏后的错误描述
  startedAt: datetime
  completedAt: datetime?
```

`ProfileHarvestRun` 复用浏览器会话引擎（§5）和页面状态分类器（§6），其状态到引擎循环的映射与 `AccountRun` 类似：`LoggingIn` / `AwaitingEmailCode` 委托引擎执行登录流程，`Extracting` 委托引擎按预定义页面顺序读取各档案字段，`AwaitingManualAction` 暂停并通知操作者接管。

> 档案采集运行的流程快照仅记录访问过的页面状态序列，不记录决策点（详见 §12 流程快照章节中关于档案采集与抽选运行的决策点差异说明）。

### 7.2 EventSnapshot

```text
EventSnapshot
  id: UUID
  source_url: string
  canonical_url: string
  title: string
  venue: string?
  schedule_text: string?
  application_deadline: datetime?
  fetched_at: datetime
  raw_form_schema: JSON         # 页面解析出的可选项与字段约束
  page_fingerprint: string      # 用于发现页面结构变化
```

`raw_form_schema` 至少包含可申请席种、每个席种的枚数范围、希望顺位字段、付款方式、配送/取票字段及必填项。任何无法确认的字段都应要求用户在浏览器人工检查。

### 7.3 LotteryPreference

```text
LotteryPreference
  entries: [
    { rank: 1, ticket_type_id, quantity, optional_date_or_show_id }
  ]
  payment_method_id: string
  delivery_method_id: string?
  consent_flags: map<string, boolean>
```

这里使用站点字段 ID，而不只保存显示文本，以降低日文文案变化导致的错误提交风险。用户界面同时显示文本与限制条件。

演出快照解析时，`raw_form_schema` 中的 `serialCode` 字段记录该演出页面对抽选码的要求。当前代码中的 `SerialCodeRequirement` 接口（`src/shared/types.ts:67-73`）定义如下，并为支持日别选择扩展 `availableDays` 和 `daySelectionRequired` 字段：

```text
SerialCodeRequirement
  required: boolean
  label: string                          # 页面显示的标签文本
  placeholder?: string                   # 输入框占位文本
  errorSelectors: string[]               # 错误提示的选择器列表
  knownErrorMessages: [
    { code: "InvalidCode" | "UsedCode"; text: string }
  ]
  availableDays: ("day1" | "day2")[]     # 该抽选码页面支持的日别选项
  daySelectionRequired: boolean          # 是否必须在 day1/day2 中选择
```

`availableDays` 和 `daySelectionRequired` 由页面解析阶段（`parseEplusPage()`）从 Eplus 抽选码输入后的日别选择页面提取。

- 若页面同时展示 day1 和 day2 两个日期选项（通常伴随"両日"即两日都选的选项），`availableDays` 为 `["day1", "day2"]`，`daySelectionRequired` 为 `true`。
- 若页面仅有一个日期，`availableDays` 为 `["day1"]` 或 `["day2"]`，`daySelectionRequired` 为 `true`（仍需操作者确认）。
- 若页面不涉及日别选择（如非 serial 抽选），`availableDays` 为空数组 `[]`，`daySelectionRequired` 为 `false`。

"両日"（两天都选）不是 `availableDays` 中的独立枚举值。它表示操作者为某个账号同时勾选 day1 和 day2，对应 `selectedDays = ["day1", "day2"]`。

### 7.3.1 每账号日别选择

抽选偏好中的日别选择以**每账号**为粒度存储，不作为任务全局值。扩展后的 `LotteryPreference` 增加 `daySelectionByAccountId` 字段：

```text
LotteryPreference
  entries: [
    { rank: 1, ticket_type_id, quantity, optional_date_or_show_id }
  ]
  payment_method_id: string
  delivery_method_id: string?
  serialCode?: string
  serialCodesByAccountId?: Record<string, string>
  consent_flags: map<string, boolean>
  daySelectionByAccountId?: Record<string, ("day1" | "day2")[]>
```

`daySelectionByAccountId` 是一个可选映射，key 为账号 ID，value 为该账号选择的日别列表。例如：

- `{ "acc-1": ["day1"] }` — 账号 acc-1 仅选择 day1
- `{ "acc-2": ["day1", "day2"] }` — 账号 acc-2 选择两天都参加
- `{ "acc-3": ["day2"] }` — 账号 acc-3 仅选择 day2

此字段仅在 `SerialCodeRequirement.daySelectionRequired === true` 时有意义。若演出不需要日别选择，整个 `daySelectionByAccountId` 为 `undefined` 或空对象。

当 Eplus 抽选码页面要求选择 day1/day2/両日时，日别选择以每账号为粒度存储。具体机制：

- 演出快照解析时，`SerialCodeRequirement` 包含 `availableDays` 字段（如 `["day1", "day2"]`）和 `daySelectionRequired: boolean`
- 每个账号的日别选择存储在 `LotteryPreference.daySelectionByAccountId` 映射中，或作为 `AccountRun` 的扩展字段
- 若 `availableDays` 包含多个值（如同时支持 day1 和 day2），操作者可在快照时或运行时为每个账号选择仅 day1、仅 day2、或两日都选

**默认值策略**：若 `daySelectionRequired === true` 且 `availableDays` 包含多个值，在创建 `LotteryTask` 时可为所有选中账号设置一个统一的默认日别选择（如全部选择 day1），操作者在预览阶段可为单个账号覆盖此默认值。默认值不硬编码，由操作者在新建抽选向导的日别选择步骤中确认。

**运行时再确认**：即使操作者在快照时预设了 `selectedDays`，引擎在进入 `DaySelection` 状态时仍会读取该账号的当前配置并执行对应勾选。操作者可在任务提交前的预览阶段覆盖单个账号的选择。

### 7.3.2 DaySelection 拦截页

**DaySelection 拦截页（页面状态分类器中的 `DaySelection` 状态）**：

输入抽选码后，Eplus 可能展示一个日别选择页面，列出 day1、day2 或両日的选项。此页面被页面状态分类器（§6）识别为 `DaySelection` 状态。引擎在 `LotteryForm` 状态之前处理此状态，按账号的 `selectedDays` 配置自动选择对应选项，随后点击"进入抽选"或类似按钮，进入标准的 `LotteryForm` 抽选表单页。

引擎在 `DaySelection` 状态下的交互步骤：

1. 分类器返回 `DaySelection`，引擎获取当前账号在 `daySelectionByAccountId` 中的 `selectedDays`
2. 若 `selectedDays` 包含 `"day1"`，自动勾选 day1 对应的选项控件（待核对）
3. 若 `selectedDays` 包含 `"day2"`，自动勾选 day2 对应的选项控件（待核对）
4. 勾选完成后，自动点击页面上的"进入抽选"或等价导航按钮（待核对）
5. 引擎执行"再读状态"，验证已跳转至 `LotteryForm`

日别选择页面上的具体 DOM 结构（各日期选项的单选/复选控件和导航按钮的精确选择器）均标记为 待核对，需在实际抽选码页面中确认后填入 `eplusPageParser.ts` 的 selectorHints。

### 7.3.3 任务创建时的日别校验

若演出的 `daySelectionRequired === true` 且 `availableDays` 包含多个值，在创建 `LotteryTask` 时校验每个选中账号是否已设置 `selectedDays`。若存在未选择日别的账号，拒绝创建任务并提示操作者补全。

此校验规则遵循已有的抽选码必填校验模式（`src/main/ipc.ts:43-50`），在 `task:create` IPC handler 中实现：

- 检查 `event.rawFormSchema.serialCode?.daySelectionRequired`，若为 `true` 则遍历 `input.accountIds` 中的每个账号
- 对每个账号，检查 `input.preference.daySelectionByAccountId?.[accountId]` 是否存在且为非空数组
- 若任一账号缺少 `selectedDays`，抛出错误并提示操作者补全该账号的日别选择
- 错误信息示例：`"账号 {label} 尚未选择日别（day1/day2/両日），请在新建抽选向导中补全"`

本节仅描述该规则的设计意图和校验逻辑，不对 `ipc.ts` 做具体编辑。实际实现时，此校验块应紧接现有抽选码校验逻辑（`src/main/ipc.ts:43-50`）之后。

> **关联章节**：
> - §6 页面状态分类器：`DaySelection` 状态的定义及其在状态匹配优先级中位于 `LotteryForm` 之前
> - §12 流程快照决策点：day1/day2/両日的选择是抽选运行的可审计决策点，记录在 `flow-snapshot.json` 中

### 7.4 LotteryTask 与 AccountRun

```text
LotteryTask
  id: UUID
  event_snapshot_id: UUID
  preference: JSON
  account_ids: UUID[]
  status: Draft | AwaitingConfirmation | Queued | Running | Paused | Completed | Failed | Cancelled
  confirmation_digest: string

AccountRun
  id: UUID
  task_id: UUID
  account_id: UUID
  status: Pending | LoggingIn | AwaitingEmailCode | AwaitingManualAction |
          FillingForm | AwaitingSubmitConfirmation | Submitting |
          Submitted | AlreadyApplied | Failed | Cancelled
  external_application_id: string?
  resume_checkpoint: JSON
  error_code: string?
  error_detail_redacted: string?
```

## 8. 账号导入、修改与备份

### 8.1 首次 Excel 导入

支持 `.xlsx`、`.xls`、`.csv`。导入向导可让用户将 Excel 列映射到以下字段：

| 必填列 | 可选列 |
| --- | --- |
| `eplus_email` | `label`、`password`、`tags`、`enabled` |
| `password` | `mail_provider`、`mail_target`、`mail_api_config` |

流程：文件选择 -> 表头预览 -> 列映射 -> 格式校验 -> 重复账号处理策略（跳过/更新/新增） -> 加密写入 -> 导入报告。

密码不会在导入预览或错误报告中展示。导入完成后应提示用户删除含明文密码的临时 Excel 副本，应用自身不复制该文件。

### 8.2 后续维护

- 账号列表支持搜索、标签分组、启用/停用、逐项编辑与批量更新邮件服务配置。
- 删除账号只删除本地数据和自动化 profile，不影响 Eplus 账号本身。
- 支持导出仅含元数据的 CSV，以及采用用户口令加密的完整备份包。

## 9. 档案采集流程（Profile Harvesting）【规划中】

### 采集触发时机

档案采集（含基本档案、同行者列表、申请记录）在每次账号成功建立会话后自动触发。换句话说，任何导致该账号 session 变为 ready 的操作都会顺带触发一次档案采集：

- **主触发**：登录成功后（包括全新登录和会话复用探测通过）、抽选运行启动前。这意味着每次登录成功后档案采集会自动运行，最大化利用每次登录的会话窗口，减少重复登录次数。这是用户确认的设计决策。
- **次触发**：操作者在账号详情 UI 中手动点击"重新采集"按钮。

**例外**：中落选结果记录不在自动触发范围内。结果刷新由独立的"刷新结果"手动按钮控制，详见后续章节（Todo 9）。

### 采集流程

一次完整的档案采集运行按以下步骤顺序执行：

1. **会话准备**：复用有效会话（§5 引擎的会话探测 + 复用机制），或在无有效会话时执行完整登录（邮箱 + 密码 → 邮箱验证码 → 人工接管 captcha 等）。验证码环节走 Verification Service 的 `waitForVerificationCode` 接口，遇到 captcha 时暂停等待人工接管。
2. **导航至会員ページ**：登录后导航至 Eplus 会員マイページ。页面确切 URL 标记为 待核对，需通过 Eplus 帮助文档（ヘルプ）及首页导航定位。
3. **提取基本档案**：从会員情報页面提取 email、name、gender、birthday、address、phone 等字段。每个字段的 DOM 选择器均标记为 待核对。
4. **提取密码（点击显示）**：若 Eplus 会員情報页面提供"点击显示"或类似功能（点击后明文显示密码字段），引擎自动执行点击 → 读取 → 加密存储。若点击后触发 captcha 或额外验证，暂停等待人工接管。若页面不支持密码显示，标记 `revealSupported: false` 并跳过此步骤。此步骤为尽力而为（best-effort），失败时不影响其他字段采集。
5. **提取同行者**：导航至同行者管理页面，提取当前绑定同行者列表（`companions`）和曾绑定同行者列表（`pastCompanions`）。同行者管理页面的确切位置标记为 待核对，候选来源：会員メニュー → 同行者管理 / 同行者一覧。曾绑定同行者可能位于同行者管理页的历史 tab 或单独的履歴页面，具体位置 待核对。
6. **提取申请记录**：导航至申込履歴页面，逐条提取历史申请记录（eventTitle、appliedAt、sessionOrDay、ticketType、quantity、applicationId、status）。申込履歴页面确切 URL 和 DOM 选择器标记为 待核对。
7. **保存与结束**：将采集结果写入 sql.js 的 AccountProfile / ApplicationRecord 表，更新 `harvestedAt` 和 `harvestStatus`。

### 登录后页面的定位策略

以上全部采集步骤依赖的 Eplus 会員ページ、会員情報、同行者管理、申込履歴等页面均为登录后页面。这些页面的确切 URL、导航路径和 DOM 选择器在撰写本文档时尚未确定。实现者在开发构建阶段通过以下方式定位：

1. 查阅 Eplus 官方帮助文档（https://eplus.jp/ 的ヘルプ页面）
2. 手动登录测试账号后浏览会員メニュー导航树
3. 记录每个目标页面的 URL pattern、关键 DOM 选择器和数据提取逻辑

文档中所有标注 待核对 的 URL、选择器和提取路径均需按此流程确认，不得在未经验证的情况下编造。

### 多次登录

由于 Eplus 会话可能因超时、IP 切换或其他原因过期，单次完整的档案采集流程可能经历多次登录。引擎的会话生命周期管理（§5）已在架构层面处理此问题：每次流程启动前先探测会话有效性，若过期则重新登录。"多次登录"是指在长时间采集（如遍历多个页面）的过程中可能遭遇中途会话过期，引擎会检测到 `Login` 状态并自动重新执行登录，不会丢失已采集的数据。引擎的这一行为与抽选运行的登录重试逻辑完全一致。

### 本人账号约束

档案采集仅读取操作者本人的账号数据。不抓取其他用户的信息，不访问非本人账号的页面。密码获取仅在站点提供"点击显示"功能的页面中自动点击；密码不通过任何注入脚本或网络拦截方式窃取。

### 引擎与分类器复用

档案采集运行（`ProfileHarvestRun`）与抽选运行（`AccountRun`）共享同一个浏览器会话引擎（§5）和页面状态分类器（§6）。`ProfileHarvestRun` 的状态转换如下：

| 状态 | 含义 | 引擎行为 |
| --- | --- | --- |
| `Pending` | 等待执行 | — |
| `LoggingIn` | 正在登录 | 委托引擎执行会话探测或完整登录流程 |
| `AwaitingEmailCode` | 等待邮箱验证码 | 调用 Verification Service 获取验证码并自动填入，或暂停等待人工输入 |
| `AwaitingManualAction` | 等待人工接管 | 引擎暂停（captcha、滑块或未知页面），操作者在可见浏览器窗口中手动完成 |
| `Extracting` | 正在遍历页面提取档案 | 引擎按预定义页面顺序导航并提取各字段 |
| `Completed` | 采集完成 | 所有目标字段均已处理（部分字段可能标记为失败，不影响整体完成） |
| `Failed` | 采集失败 | 会话过期且重登录失败，或页面结构无法识别 |

### 幂等性

- 重复采集同一账号时，已存在的档案字段以新值覆盖旧值。
- `harvestedAt` 记录最近一次成功采集的时间。
- `harvestedFields` 记录本次实际更新的字段名称列表。
- 采集过程中途失败的字段不影响已采集成功的其他字段（best-effort）。

## 10. 申请记录与中落选结果 + 账号详情 UI【规划中】

### 10.1 ApplicationRecord（申请记录）

`ApplicationRecord` 记录账号在 Eplus 站点上的历史抽选申请。每条记录对应一次申込，由档案采集流程（§9）在步骤 6 中自动采集。

```text
ApplicationRecord
  id: UUID
  accountId: UUID              # 关联账号
  eventTitle: string           # 演出名称
  appliedAt: datetime          # 申请时间
  sessionOrDay: string?        # 场次/日期（如 "day1"、"第1公演"）
  ticketType: string           # 票档名称
  quantity: number             # 申请枚数
  applicationId: string?       # Eplus 申请编号
  status: string               # 申请状态（如 "申込完了"、"抽選待ち"）
  harvestedAt: datetime
```

来源：Eplus 会員ページ → 申込履歴。该页面为登录后页面，确切 URL 和 DOM 选择器均标记为 **待核对**，需通过 Eplus 帮助文档（ヘルプ）及首页/会員メニュー导航定位后确认。

采集方式：在档案采集运行（`ProfileHarvestRun`）的步骤 6 中，引擎导航至申込履歴页面并逐条提取历史申请记录。采集逻辑复用浏览器会话引擎（§5）的读→判→动循环，每条记录提取后立即写入本地数据库。

### 10.2 LotteryResultRecord（中落选结果记录）

`LotteryResultRecord` 记录账号在 Eplus 站点上的抽选结果。每条记录对应一次抽选的中选/落选/待通知/取消判定。

```text
LotteryResultRecord
  id: UUID
  accountId: UUID
  eventTitle: string
  resultKind: "中選" | "落選" | "待通知" | "取消"
  decidedAt: datetime?         # 结果确定时间
  paymentDeadline: datetime?   # 支付截止时间（中選时）
  applicationId: string?       # 关联的申请编号
  harvestedAt: datetime
```

来源：Eplus 会員ページ → 当選確認／抽選結果。该页面为登录后页面，确切 URL 和 DOM 选择器均标记为 **待核对**。

**刷新方式（用户确认）**：结果记录仅通过操作者手动点击 **"刷新结果"按钮** 触发刷新。不设后台轮询，不设定时任务。理由：结果更新频率低（按天/按周），自动轮询浪费会话和 IP 资源且无实际收益。刷新动作由引擎执行一次性的"导航至当選確認页面 → 读取结果列表 → 写入本地数据库"流程，完成后立即释放浏览器资源。

### 10.3 筛选器模型

定义一个组合筛选器，应用于账号详情 UI 中的申请记录表格和中落选结果表格。筛选器以 **账号 × 结果类型 × 日期** 为核心组合轴，支持以下维度自由组合（AND 逻辑）：

| 筛选维度 | 说明 | 类型 |
|---|---|---|
| 账号 | 按账号筛选（支持多选） | `accountId[]` |
| 结果类型 | 中選 / 落選 / 待通知 / 取消 | `resultKind[]` |
| 日期范围 | 按申请时间或结果确定时间筛选 | `dateFrom`, `dateTo` |
| 演出 | 按演出名称模糊搜索 | `eventTitle (string)` |
| 日别 | day1 / day2 / 両日 | `sessionOrDay` |

筛选维度可自由组合。例如"账号 A + 中選 + 最近 30 天"或"所有账号 + 落選 + 演出 X"均直接支持。

筛选逻辑在渲染层实现：从 sql.js 查询出当前账号（或所有账号）的完整记录后，在内存中按筛选条件过滤。不依赖外部 API，不发起网络请求。

`resultKind` 筛选维度仅对中落选结果表格生效，申请记录表格不展示该维度。`日别` 和 `日期范围` 对两个表格均生效。`演出` 对两个表格均生效。

### 10.4 账号详情 UI

账号详情界面是操作者点击账号列表中的某个账号后进入的二级页面，整合账号档案、同行者、申请记录和中落选结果四类信息，是查阅单账号数据的核心视图。

**布局结构**（从上到下）：

1. **账号档案卡片**：展示 `AccountProfile` 中的基本档案信息。包含姓名、邮箱、手机（脱敏显示）、性别、生年月日、地址。密码字段默认以 `******` 显示，旁边提供"显示密码"按钮（点击后临时解密并展示明文，5 秒后自动隐藏）。卡片底部显示最近采集时间（`harvestedAt`）和采集状态（`harvestStatus`）。

2. **同行者列表（只读）**：分为"当前绑定"和"曾绑定"两个 tab 或分组，各自以列表展示 `Companion` 信息（姓名、关系、绑定/解绑时间）。列表上方标注"只读展示，不在申请中自动分配"。同行者的绑定/解绑操作需操作者自行在 Eplus 站点上完成，本界面不提供任何分配、选择或修改同行者的控件。

3. **申请记录表格**：以表格形式列出该账号的 `ApplicationRecord` 列表。表头包含筛选控件：演出名称搜索框、日期范围选择器、日别下拉。表格列：演出名称、申请时间、场次/日期、票档、枚数、申请编号（脱敏显示）、状态。支持按申请时间正序/倒序排序，默认按申请时间倒序。表格上方显示总记录数。

4. **中落选结果表格**：以表格形式列出该账号的 `LotteryResultRecord` 列表。表头包含筛选控件：结果类型下拉（中選/落選/待通知/取消，支持多选）、日期范围选择器、演出名称搜索框。表格列：演出名称、结果类型（以颜色或标签区分四种结果）、结果确定时间、支付截止时间、申请编号（脱敏显示）。表格上方右侧放置 **"刷新结果"按钮**，点击后触发结果刷新流程（详见 §10.2）。表格上方左侧显示总记录数。

5. **操作按钮区**：页面底部提供两个操作按钮。"重新采集档案"按钮触发一次完整的档案采集运行（§9），采集完成后自动刷新页面中的档案卡片、同行者列表和申请记录表格。"返回账号列表"按钮导航回账号管理终端主视图。

### 10.5 持久化与脱敏

`ApplicationRecord` 和 `LotteryResultRecord` 分别对应 sql.js 中的两张新表，表结构由上述实体定义直接映射。

脱敏规则：

- 申请编号 (`applicationId`) 在日志中保留后四位，其余字符以 `*` 替代。例如 `EP2024123400012345` 显示为 `***************2345`。
- 演出名称不脱敏（公开信息，Eplus 站点上对所有访问者可见）。
- 支付截止时间不脱敏（操作者需要据此安排支付行动）。
- 其他字段（`appliedAt`、`sessionOrDay`、`ticketType`、`quantity`、`status`、`resultKind`、`decidedAt`）均不涉及 PII，不做脱敏处理。

结果刷新覆盖逻辑：每次手动刷新后，以新采集的结果记录覆盖该账号该演出的已有结果记录（按 `accountId + eventTitle + applicationId` 去重）。历史结果不做版本保留，仅保留最新一次刷新的数据。

## 11. 邮箱验证码架构

`MailProvider` 必须是明确接口，而不是由登录流程直接调用任意项目代码：

```ts
interface MailProvider {
  validate(config: MailConfig): Promise<ValidationResult>;
  waitForVerificationCode(input: {
    recipient: string;
    startedAt: Date;
    timeoutMs: number;
    senderAllowlist: string[];
    subjectMatchers: RegExp[];
  }): Promise<VerificationCodeResult>;
}
```

验证码邮件源的接入方式如下：

1. **cerise-bouquet Temp-Mail Forwarder**（`temp-mail-forwarder` 模式）：调用 `mail.cerise-bouquet.xyz` 的 `/api/parsed_mails` 端点（`agentParsedMails: true`）。对应 `HttpJsonMailProvider`，代码中已实现（`src/main/adapters/mailProviders.ts:79-203`）。引用仓库：`temp-mail` 项目提供邮件转发与解析服务。

2. **cerise-bouquet Auth Mailbox**（`auth-mailbox` 模式）：调用 `mail.cerise-bouquet.xyz` 的 `/api/temp-mail/mails?app_id=` 端点。对应 `AuthMailboxProvider`，代码中已实现（`src/main/adapters/mailProviders.ts:205-245`）。引用仓库：`auth` 项目提供统一邮箱认证服务，`ticketjam-watcher` 项目提供邮件监听。

3. **自建 Cloudflare Email**：Cloudflare Email Routing 规则或 Worker 将 Eplus 发来的验证码邮件**转发至 cerise-bouquet 邮箱**。对于应用程序而言，Cloudflare Email 是一个**邮件路由前台**，不是新的适配器——应用仍通过上述 cerise-bouquet 适配器读取验证码。操作者在 Cloudflare 控制面板配置 Email Routing 规则，将 Eplus 发件域名的邮件转发至 cerise-bouquet 的总邮箱地址。应用本身不感知 Cloudflare 的存在。

4. **手动输入**（`manual` 模式）：对应 `ManualMailProvider`（`src/main/adapters/mailProviders.ts:42-53`），要求操作者在 UI 中查看验证码邮件后手动输入。

> IMAP 邮箱和通用 HTTP API 邮箱模式（`imap`、`http-api`）已从支持的自动模式中移除。若操作者此前配置了这些模式，应迁移至上述 cerise-bouquet 或手动模式。

### 11.1 共享邮箱的验证码归属策略

所有 Eplus 账号的验证码邮件均发往**同一个** cerise-bouquet 总邮箱地址。由于应用无法为每个账号分配独立的收件别名，需要在收到验证码时判断该验证码属于哪个账号。

策略（按优先级）：

1. **时间窗口匹配**：记录每个账号触发发送验证码的时间戳。收到新邮件时，仅匹配在时间窗口内（邮件接收时间 >= 该账号最近一次触发时间）的账号。
2. **邮件内容匹配**：检查邮件正文或标题中是否包含特定 Eplus 账号/邮箱的引用。确切的匹配信号取决于 Eplus 在验证码邮件中填入的内容（待核对）。
3. **最新未认领优先**：若上述条件匹配到多个账号，取最新发送请求且尚未认领验证码的账号。
4. **歧义降级为人工**：当多个账号的时间窗口显著重叠且邮件内容无法区分时，暂停所有匹配账号的运行，在 UI 中提示操作者手动选择该验证码所属的账号。

该策略的实现细节（特别是步骤 2 的邮件内容匹配信号）标记为待核对，需在实际收到 Eplus 验证码邮件后确认邮件模板结构。

### 11.2 验证码提取规则

验证码提取由邮件正文 HTML 解析后匹配，至少校验以下条件：

- 发件人域名必须属于配置的允许列表。
- 邮件接收时间必须晚于任务开始时间。
- 邮件主题须匹配配置的主题正则表达式。

不得仅以任意六位数字正则匹配。优先按已知格式（`認証コード：123456`、`確認コード 123456` 等）提取；仅在以上格式均不匹配时才回退到通用六位数字模式。

### 11.3 异常处理

邮件服务不可用、超时或发现多封候选邮件且无法自动区分时，`AccountRun` 进入 `AwaitingManualAction`，浏览器保留在验证码输入页，操作者可在 UI 中输入验证码后继续。多封候选邮件优先尝试归属策略（§11.1）自动区分；仅当策略无法判定时触发人工接管。

## 12. Eplus 浏览器适配器

### 12.1 浏览器隔离

- 每个账号使用独立的持久化浏览器 profile：`profiles/<account-id>/`。此 profile 由浏览器会话引擎（文档 §5）统一管理，引擎在首次运行时自动创建，后续运行直接复用。
- 默认串行执行账号任务，避免会话串扰、重复申请和不必要的高频访问。
- 不注入隐藏自动化脚本，不规避站点安全机制；使用正常页面交互、显式等待与合理退避。
- 每个页面跳转和最终提交前保存截图与脱敏 HTML 快照。截图和快照的实际捕获由浏览器会话引擎的"为每一步保存快照"机制（文档 §5）统一负责，适配器本身不独立执行截图逻辑。

### 12.2 页面模型（基于引擎与分类器）

浏览器适配器的页面交互由一组可测试步骤构成。每步在浏览器会话引擎（文档 §5）上执行，并委托页面状态分类器（文档 §6）完成状态判定。引擎运行读→判→动→再读的步骤循环，分类器以 LIVE 页面为输入返回当前状态枚举；适配器根据分类器结果选择下一步操作。

步骤列表与分类器状态的对应关系：

```text
openEvent(url)              → 引擎导航至 url，分类器判定页面类型
login(email, password)      → 引擎填写邮箱密码，点击登录按钮（Login 状态自动处理）
detectChallenge()            → 委托给分类器的完整状态集判定：
                               - EmailCode → 自动/手动填写验证码
                               - CaptchaSliderDevice → 暂停，人工接管
                               - InterstitialConsent → 自动点击粉色/确认按钮
                               - CheckboxGate → 自动勾选必选项
enterEmailCode(code)         → 引擎填写验证码并继续（EmailCode 状态自动处理）
readAvailableOptions()       → 引擎读取已渲染的表单选项（LotteryForm 状态）
applyPreference(preference)  → 引擎按 LotteryPreference 填写表单（LotteryForm 状态）
readReviewPage()             → 引擎读取确认页（Receipt 的前序状态）
submitApplication()          → 驱动付款方式选择至 card/CVV 之前即提交
readReceipt()                → 引擎读取回执页（Receipt 状态）
```

`detectChallenge()` 不再自行判断验证类型，而是将 LIVE 页面提交给分类器后根据其返回的状态枚举分发处理。除 `EmailCode` 和流程拦截页（`InterstitialConsent`、`CheckboxGate`）由引擎自动处理外，`CaptchaSliderDevice` 和 `Unknown` 统一触发人工接管。

旧模型中一次运行只产生若干独立页面截图。新模型将适配器的执行过程记录为一条**流程快照**（flow snapshot）：一个有向的状态变迁图，包含每一步的访问状态、执行动作和决策点。

流程快照为每次步骤动作记录三项数据：分类器判定的当前页面状态、适配器执行的具体操作（填写、点击、选择或暂停）、以及引擎"再读"后的结果页面状态。引擎的读→判→动→再读循环保证每步的输入和输出状态均被捕获，整条快照可完整回溯一次运行的全程路径。

**决策点**（decision point）的定义因运行类型而不同：

- **抽选运行**（lottery run）的流程快照记录所有可操作的决策点：点击了哪个粉色按钮（`cautionNext` 还是 `finalConsent`）、勾选了哪些 checkbox、选择了 day1 还是 day2 还是两天。这些决策点直接影响申请结果，是整条流程快照中最关键的审计节点。
- **档案采集运行**（profile-harvest run）的流程快照仅记录访问过的页面状态序列，不记录决策点。采集运行只遍历页面、读取信息，不做任何选择，因此决策点概念不适用于采集上下文。

流程快照按 `{accountId}/{runId}/flow-snapshot.json` 归档，与引擎捕获的截图和 HTML 快照置于同一 `artifacts/` 目录下。

#### 提交边界

`applyPreference` 和 `submitApplication` 负责将 `LotteryPreference` 转为页面操作。对于付款方式字段，引擎根据 `LotteryPreference.paymentMethodId` 选择对应的付款方式（如"クレジットカード"、"ファミリーマート"等），但自动化在此停止，不下钻至卡片信息层。

如果 Eplus 流程在付款方式选择之后要求填写卡号、CVV、有效期等支付敏感字段，引擎不自动填充任何卡片数据，立即暂停当前账号并将 `AccountRun` 置为 `AwaitingManualAction`。操作者在可见的浏览器窗口中手动完成卡片信息填写后，点击"继续"恢复自动化。

同行者（companions）在提交过程中仅作只读展示，显示于确认页上。适配器不对同行者字段进行任何自动选择或填写。同行者不属于 `LotteryPreference` 的可操作字段，也不参与申请提交逻辑。

### 12.3 幂等与重复申请保护

提交前必须进行以下检查：

1. 读取确认页并与 `LotteryPreference` 逐字段比对。
2. 查询页面是否显示该账号对此演出的既有申请记录。
3. 计算 `account_id + canonical_event_id + preference` 的幂等键，并检查本地是否已成功提交。
4. 只有用户确认的任务可进入最终提交；批量任务的首次最终提交须逐账号记录确认页摘要。

此外，引擎在提交前查询该账号的申请历史记录（由档案采集运行采集并持久化至本地数据库，详见 §6 中关于申请记录采集的 Todo-8 章节），将既有申请记录作为额外的重复检查来源。若历史记录中已存在该演出的申请受付番号，提交直接标记为 `AlreadyApplied`，不再进行页面操作。

提交按钮点击后不立即认为成功，必须读取站点回执页的申请编号或明确成功文案。引擎根据分类器返回的 `Receipt` 状态确认提交是否完成；若 `Receipt` 状态中检测到"受付番号"，提取申请编号并标记 `AccountRun` 为 `Submitted`。

网络中断或提交后未获得明确回执的，标记为 `UnknownSubmissionState`。恢复时先查询申请历史与本地幂等键，禁止盲目重试。引擎不会对状态未知的 `AccountRun` 自动重新提交。

## 13. 任务状态机与人工接管

### 任务状态机

```text
Draft -> AwaitingConfirmation -> Queued -> Running
Running -> AwaitingEmailCode -> FillingForm -> AwaitingSubmitConfirmation
AwaitingSubmitConfirmation -> Submitting -> Submitted
Running/* -> AwaitingManualAction -> Running
Running/* -> Failed | Cancelled
Submitting -> UnknownSubmissionState -> Submitted | Failed
```

### AccountRun 状态流

AccountRun 是抽选任务中每个账号的运行实例，状态定义见 §7.4。单次 AccountRun 的典型状态转换路径：

```text
Pending → LoggingIn → AwaitingEmailCode → FillingForm → AwaitingSubmitConfirmation → Submitting → Submitted
                  ↘ AwaitingManualAction → FillingForm
                  ↘ Failed
```

引擎在 `FillingForm` 阶段按页面状态分类器（§6）返回的判定逐页处理，包括日别选择（`DaySelection`）、拦截页（`InterstitialConsent`、`CheckboxGate`）自动点击/勾选，以及 `LotteryForm` 表单填写。

### ProfileHarvestRun 状态流

`ProfileHarvestRun`（§7.1.2，规划中）的独立状态流：

```text
Pending → LoggingIn → AwaitingEmailCode → Extracting → Completed
                ↘ AwaitingManualAction → Extracting
                ↘ Failed
```

`ProfileHarvestRun` 与 `AccountRun` 共用同一浏览器会话引擎（§5）和页面状态分类器（§6）。触发时机为每次成功登录后自动执行（详见 §9）：登录完成后引擎自动启动一次档案采集运行，依次遍历会員情報、同行者管理和申込履歴等页面，提取各字段后写入本地数据库。

### 分类器状态到运行状态的映射

页面状态分类器（§6）输出的页面级判定需转换为任务级运行状态。以下为完整的映射关系：

| 分类器状态 | AccountRun 状态 | 说明 |
|---|---|---|
| `Login` / `EmailCode` | `LoggingIn` / `AwaitingEmailCode` | 登录与会话建立 |
| `DaySelection` | `FillingForm` | 按账号的 `selectedDays`（day1/day2/両日）自动勾选 |
| `InterstitialConsent` | `FillingForm` | 自动点击粉色/确认按钮继续流程 |
| `CheckboxGate` | `FillingForm` | 自动勾选必选 checkbox |
| `LotteryForm` | `FillingForm` | 按 `LotteryPreference` 填写票档、枚数、顺位、付款方式 |
| `Receipt` | `Submitted` | 提取受付番号，标记完成 |
| `CaptchaSliderDevice` | `AwaitingManualAction` | 人工接管，不自动解决 |
| `ReceptionClosed` | `Failed` | 演出受付已结束 |
| `Unknown` | `AwaitingManualAction` | 页面结构不可识别 |

`ProfileHarvestRun` 的 `Extracting` 阶段内部同样依赖分类器，但其映射较为简单：分类器仅用于判断当前页面是否为可提取页面（会員情報、同行者、申込履歴），不涉及表单填写。若分类器返回 `CaptchaSliderDevice` 或 `Unknown`，`ProfileHarvestRun` 同样进入 `AwaitingManualAction`。

### IP 轮换前置步骤

IP 轮换（§15，规划中）为每次 `AccountRun` 启动前的必需前置步骤，执行时机为引擎创建浏览器会话之前：

```text
每个 AccountRun 执行前：
  1. NetworkRotationProvider.rotate() → 切换至下一个代理节点
  2. NetworkRotationProvider.detectIp() → 通过 ip-api.com 验证新 IP 的归属地
  3. 若 rotate 或 detectIp 失败 → 暂停运行，不继续使用旧 IP，AccountRun 进入 AwaitingManualAction
  4. 验证通过 → 开始执行抽选/采集流程
```

这是“一抽一号”策略的实现入口。每个账号运行前完成 IP 切换与验证后，才启动浏览器会话引擎的会话探测与后续流程。失败时引擎绝不使用未经验证或复用旧 IP 继续执行。

### 人工接管触发条件

人工接管触发条件：CAPTCHA、滑块验证、设备验证、电话认证、异常安全验证、站点提示不支持的页面、验证码歧义（共享邮箱多账号匹配失败）、付款二次确认（card/CVV 输入）、页面字段与快照不一致、IP 轮换失败或切换后无法验证新 IP。

界面应显示当前账号、原因、浏览器窗口状态和“继续/取消此账号/取消整个任务”操作。

## 14. 用户界面流程

### 14.1 主导航

- `任务`：查看运行中、待人工处理、已完成和失败任务。
- `新建抽选`：创建向导。
- `账号`：导入、编辑、分组、验证邮件服务。
  - **账号列表**：表格展示全部账号，支持搜索、标签筛选、启用/停用、批量编辑邮件配置。
  - **账号详情**（点击列表中某个账号进入）：整合四类信息的二级页面：
    - **档案卡片**：展示 `AccountProfile` 中的基本档案信息（姓名、邮箱、手机（脱敏）、性别、生年月日、地址），密码字段以 `******` 显示，旁边提供"显示密码"按钮（点击后临时解密并展示明文，5 秒后自动隐藏）。卡片底部显示最近采集时间（`harvestedAt`）和采集状态（`harvestStatus`）。
    - **同行者列表（只读）**：分为"当前绑定"和"曾绑定"两个分组，各自以列表展示 `Companion` 信息（姓名、关系、绑定/解绑时间）。列表上方标注"只读展示，不在申请中自动分配"。同行者的绑定/解绑操作需操作者自行在 Eplus 站点上完成。
    - **申请记录表格**：以表格形式列出该账号的 `ApplicationRecord` 列表。表头包含筛选控件：演出名称搜索框、日期范围选择器、日别下拉。表格列：演出名称、申请时间、场次/日期、票档、枚数、申请编号（脱敏显示）、状态。支持按申请时间排序，默认倒序。表格上方显示总记录数。
    - **中落选结果表格**：以表格形式列出该账号的 `LotteryResultRecord` 列表。表头包含筛选控件：结果类型下拉（中選/落選/待通知/取消，支持多选）、日期范围选择器、演出名称搜索框。表格上方右侧放置 **"刷新结果"按钮**，点击后触发结果刷新流程（详见 §10.2）。表格上方左侧显示总记录数。
    - **操作按钮区**：页面底部提供"重新采集档案"按钮（触发一次完整的档案采集运行 §9）和"返回账号列表"按钮。
- `设置`：
  - **数据目录**：配置数据、artifacts、profiles 的存储路径。
  - **备份与恢复**：导出加密备份包、从备份恢复。
  - **日志保留期**：配置本地日志和 artifacts 的自动清理策略。
  - **IP 管理**：
    - **检测 IP（显示地区）按钮**：调用 `detectIp()` 并通过 ip-api.com 查询当前出口 IP 归属地，以卡片形式展示 IP 地址和地区信息。不触发节点切换，仅做查询。
    - **切换 IP 按钮**：调用 `rotate()` 触发 Clash 代理节点切换，切换后自动调用 `detectIp()` 验证新 IP 归属地，以 A → B 对比形式展示切换前后的 IP 和地区。切换失败时显示错误描述。
    - **节点列表**（若 `listNodes` 已实现）：展示 Clash 代理组中的可用节点及其当前活跃状态、延迟信息。
    - **Clash 控制器配置**：配置 Clash 外部控制器的 `host`、`port`、`secret` 和 `proxyGroup` 参数。`secret` 字段通过 `safeStorage` 加密存储，不在配置文件中明文保存。
  - **邮箱验证码源配置**：配置全局邮箱验证码服务的 provider（cerise-bouquet temp-mail forwarder / auth mailbox / 手动输入），以及对应的 API 端点与鉴权参数。

### 14.2 新建抽选向导

1. 输入 Eplus URL，验证域名为 `eplus.jp`，打开页面并读取演出/申请信息。
2. 展示实际解析到的票档、可选枚数、希望顺位和付款方式；不自行猜测缺失选项。
3. **日别选择**（仅在 `daySelectionRequired === true` 时展示）：为每个选中账号选择 day1 / day2 / 両日。支持批量设置默认值（如全部选择 day1），再逐账号覆盖。此步骤在解析到票档之后、最终提交前展示，确保操作者在提交前完成日别分配。
4. 选择账号，可按标签筛选并提供\u201c全选当前筛选结果\u201d。在此步骤操作者可进一步微调每个账号的日别选择、抽选码分配等 per-account 配置。
5. 生成汇总预览：演出、账号数、每个账号的日别选择（若有）、每个希望顺位、付款方式、截至时间和风险提示。
6. 用户确认后创建并排队。若需要，每个账号在最终页面再次由用户批准，或由设置中明确启用的\u201c已确认批量提交\u201d策略处理。

## 15. 网络层 / IP 轮换（Network Rotation）【规划中】

网络层负责在多个账号串行运行时为每个账号提供独立的出口 IP。它的唯一目的是账号隔离：不同账号从不同 IP 发起请求，避免 Eplus 将多个账号关联为同一操作者。这并非用于绕过站点安全机制、频率限制或 CAPTCHA。

当前选型为通过 Clash Verge 的外部控制器 API 切换代理节点，并用 ip-api.com 验证切换后的出口 IP 归属地。此子系统尚无任何代码实现，全部标记为规划中。

### 15.1 NetworkRotationProvider 接口

```ts
interface NetworkRotationProvider {
  /** 检测当前出口 IP 及其归属地 */
  detectIp(): Promise<{
    ip: string;
    region: string;   // 省份/州
    country: string;  // 国家
    city?: string;    // 城市（可选）
  }>;

  /** 切换到下一个 IP 节点 */
  rotate(): Promise<void>;

  /** 列出可用节点（可选实现，用于 UI 展示） */
  listNodes?(): Promise<NodeInfo[]>;
}

interface NodeInfo {
  name: string;
  type: string;       // 节点类型（如 Shadowsocks、VMess、Trojan）
  alive: boolean;     // 节点是否存活
  delay?: number;     // 延迟（ms）
}
```

`detectIp` 是旋转后的验证手段，`rotate` 是节点切换动作。两者在每次账号运行前组合调用：先 rotate，再 detectIp 验证。`listNodes` 为可选接口，仅在 UI 需要展示可用节点列表时使用。

### 15.2 Clash 控制器实现（ClashControllerProvider）

第一实现基于 Clash Verge 的外部控制器（external controller）REST API。Clash Verge 启动后默认在 `127.0.0.1:9090` 暴露一个 HTTP 控制接口，允许外部程序查询和切换代理节点。

**前提条件**：

- Clash Verge 已启动且外部控制器已开启（需操作者确认）
- 已配置一个或多个代理组（proxy-group），代理组内包含多个可用节点
- 客户端可访问控制器 HTTP API

**配置字段**（值取决于运行环境，标记为「待核对」）：

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `host` | 控制器地址 | `127.0.0.1`（待核对） |
| `port` | 控制器端口 | `9090`（待核对） |
| `secret` | 控制器密钥 | 由操作者提供（待核对） |
| `proxyGroup` | 代理组名称 | 由操作者提供（待核对） |

四个字段均为必填，缺少任一字段时 `ClashControllerProvider` 初始化失败。机制已固定，但具体取值取决于操作者的 Clash 配置，因此均标注为待核对。

**rotate() 实现流程**：

1. 调用 `GET /proxies/{proxyGroup}` 获取代理组的当前状态和节点列表。请求头携带 `Authorization: Bearer {secret}`。
2. 从返回的 `all` 数组中提取所有可用节点名称，与 `now` 字段比对确定当前活跃节点。
3. 在节点列表中按 round-robin 规则选择「下一个节点」：若当前节点为列表中的第 N 个，目标为第 N+1 个；若当前为最后一个，目标回到第一个。
4. 调用 `PUT /proxies/{proxyGroup}` 将选择切换至目标节点，请求体为 `{ "name": "<目标节点>" }`。
5. 切换完成后立即调用 `detectIp()` 验证新 IP 已生效。

**detectIp() 实现**：

调用 ip-api.com 免费 API，无需 token：

```
GET http://ip-api.com/json/?fields=query,country,regionName,city
```

返回示例：

```json
{
  "query": "203.0.113.45",
  "country": "Japan",
  "regionName": "Tokyo",
  "city": "Shinjuku"
}
```

免费层限制为 45 req/min，串行运行场景下远低于此阈值。

> **隐私注意**：此调用向 ip-api.com（第三方服务）披露当前出口 IP 地址，存在隐私泄露风险。操作者应知晓此风险。ip-api.com 端点可配置替换为自建服务，但替换需操作者自行完成。详见 §16 数据安全与隐私章节。

### 15.3 轮换策略

**一抽一号**：每个账号的每次抽选运行前，必须执行一次完整的 rotate → verify 流程。不允许跳过，不允许复用上一个账号的 IP。

**严格串行**：Clash 外部控制器同一时间只能选择一个全局活跃节点。这意味着无论应用如何设计，所有经过 Clash 的流量始终共享同一个出口 IP。账号任务必须串行执行的根本原因正在于此：并行运行会导致多个账号使用同一 IP，失去隔离效果。

**前置验证**：`rotate()` 完成后立即调用 `detectIp()` 验证新 IP 的归属地。验证结果记录到运行日志。若出现以下任一情况，暂停当前运行：

- 轮换失败（API 调用异常、节点不可用、代理组为空）
- 验证失败（detectIp 调用异常）
- IP 归属地与预期不符（如预期日本 IP 但实际为其他国家）

暂停时将 `AccountRun` 标记为 `AwaitingManualAction`，**不以旧 IP 继续执行**。操作者需手动检查 Clash 状态或网络环境，确认后恢复。

**不规避安全**：IP 轮换的目的始终限定为账号隔离（不同账号使用不同 IP 以防关联风控）。以下行为属于非目标：

- 用 IP 轮换规避 Eplus 的访问频率限制
- 用 IP 轮换绕过 reCAPTCHA 或其他人机验证
- 用 IP 轮换突破地域限制访问仅限日本的内容
- 在单次抽选运行中途切换 IP

### 15.4 UI 与操作界面

**设置页**：

- **「检测 IP（显示地区）」按钮**：调用 `detectIp()` 并展示当前出口 IP 的归属地（国家、省份、城市）。结果以卡片形式呈现，包含 IP 地址（完整显示）和地区信息。此按钮不触发节点切换，仅做查询。
- **「切换 IP」按钮**：调用 `rotate()` 并展示切换前后的 IP 和地区对比。切换前记录当前 IP，切换后再次检测，差异以 A → B 的对比形式展示。切换失败时显示错误描述。
- **节点列表（若 `listNodes` 已实现）**：展示 Clash 代理组中的可用节点，标注当前活跃节点和延迟信息。

**运行中状态**：每个 `AccountRun` 的执行面板中显示当前使用的 IP 和归属地。信息在 rotate → verify 完成后更新，保持与运行同步。

**轮换日志**：每次 rotate → verify 的结果记录至 Audit Log。日志中的 IP 字段脱敏处理：仅显示前两段和归属地，如 `203.0.***.*** (Tokyo, Japan)`。完整的未脱敏 IP 不进入任何日志文件。

### 15.5 非目标

- 不提供内置的代理节点获取功能。节点由操作者自行在 Clash 中配置和管理。
- IP 检测服务（ip-api.com）不在应用内提供替代方案。操作者如需替换端点，需修改配置或代码。
- 不实现多代理后端支持。第一版仅对接 Clash 外部控制器；后续可按 `NetworkRotationProvider` 接口扩展其他代理后端。
- 不检测 IP 是否被 Eplus 标记或封禁。此判断属于业务层而非网络层的职责。

## 16. 数据安全与隐私

- 密码、邮箱 API token 和验证码仅在内存中短暂以明文存在；数据库存密文。
- 应用启动需由 Windows 当前用户解锁；可选设置独立主密码。
- 所有日志进行字段级脱敏：邮箱显示为 `ab***@example.com`，申请号可保留后四位，密码和验证码永不记录。
- `artifacts/` 文件设置访问限制并可从 UI 一键清理；默认保留 30 天。
- 禁止将 profile、数据库、截图或日志提交到 Git；提供 `.gitignore` 模板。
- **档案 PII 保护**：`AccountProfile` 中的姓名、手机号、性别、生年月日、地址等 PII 字段在日志中按字段级脱敏。手机号仅保留前三位（如 `080****1234`），姓名仅保留首字（如 `张*`），其余字段替换为字段名标签（如 `[GENDER]`、`[BIRTHDAY]`、`[ADDRESS]`）。数据库中以明文存储（本地单机环境），但 `artifacts/` 中的截图和 HTML 快照在脱敏后才归档。
- **采集密码处理**：`encryptedPassword` 使用 Electron `safeStorage` 加密存储。明文密码仅在操作者主动点击\u201c显示密码\u201d按钮时解密并短暂展示（5 秒后自动隐藏），不复制到剪贴板，不写入日志。
- **Clash 控制器密钥**：Clash 外部控制器的 `secret` 字段通过 `safeStorage` 加密存储，不在 `config.json` 中明文保存。
- **ip-api.com 第三方 IP 披露**：`detectIp()` 调用 ip-api.com 免费 API 时，当前出口 IP 地址会发送至 ip-api.com（第三方服务）。操作者应知晓此隐私风险。ip-api.com 的端点可在设置中替换为自建服务或其他 IP 检测 API。详见 §15.1。
- **共享邮箱验证码**：所有 Eplus 账号的验证码邮件发往同一个 cerise-bouquet 邮箱。应用通过时间窗口 + 邮件内容匹配将验证码与账号关联。当关联失败时，暂停运行并由操作者人工确认。详见 §11。
- **支付边界**：`submitApplication` 仅选择付款方式至 card/CVV 输入之前。不自动填写卡号、CVV、有效期。不存储任何卡片数据。详见 §12.2。


## 17. 错误处理与恢复

| 情况 | 处理 |
| --- | --- |
| 邮箱验证码超时 | 暂停该账号，允许手工输入或稍后重试 |
| 密码错误/账号锁定提示 | 标记账号不可用，不自动重复登录 |
| 页面结构改变 | 保存脱敏 HTML 快照和截图，停止提交，提示更新适配器 |
| 单账号失败 | 继续队列内其他账号，并在任务页汇总失败原因 |
| 应用崩溃/系统重启 | 基于 `resume_checkpoint` 恢复；提交未知状态先查历史 |
| 站点限流/维护 | 全局暂停、指数退避并需要用户手动恢复 |
| 档案采集失败（部分字段） | 已成功采集的字段保留，失败的字段标记为 `null`，`harvestStatus` 设为 `Partial`。操作者可手动重新采集 |
| 多次登录 | 引擎的会话生命周期管理自动处理会话过期。若采集或抽选中途 session 超时，引擎检测到 `Login` 状态后自动重新登录，不丢失已采集/已填写的数据 |
| 会话复用失效 | 引擎探测到 session 过期后回退至完整登录流程（邮箱 → 密码 → 验证码），不视为错误 |
| IP 轮换失败 | 暂停当前账号运行并置为 `AwaitingManualAction`，不继续使用旧 IP 执行。操作者检查 Clash 控制器状态后手动恢复 |
| 切换 IP 后验证失败 | 新 IP 无法通过 ip-api.com 验证（如无网络、IP 被屏蔽）时，暂停运行。操作者可尝试手动切换 IP 或跳过本轮 |
| 共享邮箱验证码歧义 | 多个账号在相近时间触发验证码，邮件内容无法区分归属时，暂停所有关联账号并提示操作者手动指定 |
| 日别选择缺失 | 创建任务时若 `daySelectionRequired === true` 且某账号未设置 `selectedDays`，拒绝创建任务并提示 |
| 分类器返回 Unknown | 暂停运行，保存截图和 HTML 快照，标记为 `AwaitingManualAction`，提示操作者人工检查页面 |

## 18. 目录与配置建议

### 18.1 项目目录结构

```text
eplus-assistant/
  src/
    main/              # Electron 主进程（IPC、服务、适配器、数据库、密钥存储）
    renderer/          # React 渲染进程（UI 组件、页面、状态管理）
    shared/            # 共享类型定义（types.ts、IPC 契约）
    core/              # 领域逻辑（状态机、验证）
  data/                # 默认不进入版本控制
    app.db
    profiles/<account-id>/   # 每账号 Playwright 持久化 context
    artifacts/<task-id>/     # 截图、HTML 快照、流程快照
  docs/
```

### 18.2 运行期配置

运行期配置使用 `config.json` 保存非敏感项，例如数据目录、浏览器路径、验证码超时和日志等级；任何 token、密码、会话 cookie 都不进入该文件。

以下为新增配置项及其默认值：

| 配置项 | 说明 | 默认值 |
|---|---|---|
| `clash.controller.host` | Clash 外部控制器地址 | `127.0.0.1` |
| `clash.controller.port` | 控制器端口 | `9090` |
| `clash.controller.secret` | 控制器密钥（safeStorage 加密） | （无默认，需用户提供） |
| `clash.proxyGroup` | 代理组名称 | （无默认，需用户提供） |
| `network.ipLookupEndpoint` | IP 归属地查询 API 端点 | `http://ip-api.com/json/` |
| `mail.source` | 邮箱验证码来源 | `cerise-bouquet`（可选 `manual`） |


## 19. 实施阶段

### Phase 0：验证前置条件

- 审阅 `temp-mail` 与 `auth` 的 API、认证方式、邮件检索延迟和错误语义。
- 以单一测试账号手动走通登录、邮箱验证码和一个抽选确认页，记录页面字段及稳定选择器。
- 确认 Eplus 允许的正常使用范围与需要人工介入的验证类型。
- 使用 Playwright 持久化 context 替代静态 `fetch()` 作为页面读写基础。

### Phase 1：浏览器会话引擎 + 页面状态分类器

- 实现浏览器会话引擎（§5）：持久化 per-account context、读→判→动→再读循环、会话探测与复用、截图与脱敏 HTML 快照归档、导航预算与退避、人工接管集成。
- 实现页面状态分类器（§6）：11 种状态枚举（Login、EmailCode、CaptchaSliderDevice、InterstitialConsent、CheckboxGate、LotteryForm、DaySelection、Receipt、ReceptionClosed、Unknown）、状态匹配优先级、选择器来源配置。
- 编写引擎与分类器的集成测试，使用已记录的页面快照做回归验证。

### Phase 2：邮箱验证码与账号管理

- 实现 cerise-bouquet temp-mail forwarder 与 auth mailbox 适配器，替换 IMAP/通用 HTTP API 模式。
- 实现共享邮箱验证码归属策略：时间窗口匹配、邮件内容匹配、最新未认领优先、歧义降级为人工。
- 完成账号 CRUD、CSV/JSON 导入导出、标签筛选、加密凭据存储、安全备份。

### Phase 3：单账号登录与档案采集

- 实现单账号完整登录流程：邮箱 → 密码 → 邮箱验证码 → 人工接管（CAPTCHA/滑块）。
- 实现档案采集运行（§9）：导航至会員情報页面，自动提取姓名、手机、性别、生年月日、地址、密码（尽力而为）；导航至同行者管理页面，提取当前绑定与曾绑定同行者；导航至申込履歴页面，逐条提取历史申请记录。
- 采集失败的字段不影响其他字段，`harvestStatus` 准确反映采集完整性。

### Phase 4：IP 轮换与日别选择

- 实现 NetworkRotationProvider 接口（§15.1）与 Clash 控制器实现（§15.2）：通过 Clash 外部控制器 REST API 切换代理节点，通过 ip-api.com 验证新 IP 归属地，切换失败时暂停而不使用旧 IP。
- 实现每账号日别选择：在 `LotteryPreference` 中扩展 `daySelectionByAccountId`，在页面状态分类器中实现 `DaySelection` 状态自动勾选，在任务创建时校验日别选择完整性（§7.3.3）。
- 实现设置页 IP 管理面板：检测 IP、切换 IP、节点列表、Clash 控制器配置。

### Phase 5：单账号抽选提交与恢复

- 实现偏好填写（`LotteryForm` 状态自动填写票档、枚数、顺位、付款方式）、确认页比对、明确提交、回执提取和幂等保护。
- 实现异常退出恢复及 `UnknownSubmissionState` 查询策略。
- 实现付款边界：自动选择付款方式至 card/CVV 输入之前即停止，不自动填写卡片数据。

### Phase 6：批量编排与可用性

- 加入账号选择/全选、串行队列、汇总预览、任务页和失败重试。
- 每账号抽选前执行 IP 轮换前置步骤（rotate → detectIp → 验证通过 → 开始执行）。
- 增加端到端测试、脱敏审计、备份恢复和可配置数据保留策略。
- 实现账号详情 UI（§10.4）：档案卡片、同行者列表（只读）、申请记录表格（含筛选器）、中落选结果表格（含刷新按钮）。

## 20. 验收标准

1. 用户可从给定 Excel 导入账号，重启应用后仍能安全读取并编辑元数据。
2. 用户粘贴 Eplus 抽选 URL 后，只能从实际页面解析出的选项中选择票档、枚数、希望顺位和付款方式。
3. 测试账号登录时，邮件验证码可从配置的邮件适配器获得；失败时可人工继续。
4. 单账号抽选提交前后都有可审计的确认页摘要和回执结果，程序不会因超时盲目重复提交。
5. 多账号任务可全选、串行执行、单账号隔离、失败不中断其他账号，并可在中断后恢复。
6. 密码、验证码、完整邮箱服务令牌不出现在界面日志、数据库明文或导出文件中。
7. 页面状态分类器可正确识别登录、验证码、CAPTCHA/滑块（→人工接管）、粉色按钮和勾选拦截页面，并在人工接管时保留浏览器窗口供操作者操作。
8. 账号档案采集可自动获取 Eplus 会員情報中的姓名、手机、性别、生年月日、地址和同行者信息，采集失败字段不影响其他字段。
9. 邮箱验证码仅通过 mail.cerise-bouquet.xyz（temp-mail forwarder + auth mailbox）或手动输入获取，IMAP 和通用 HTTP API 模式不可用。
10. 每个账号执行抽选前自动通过 Clash 外部控制器切换至下一个代理节点，并通过 ip-api.com 验证新 IP 归属地，切换失败时暂停而不使用旧 IP。
11. 抽选码日别选择以每账号为粒度存储，支持 day1/day2/両日；创建任务时校验所有账号的日别选择完整。

## 21. 开发前待确认项

| 序号 | 待确认项 | 来源章节 | 说明 |
|---|---|---|---|
| 1 | 验证码输入页 DOM 结构 | §6 分类器 EmailCode 状态 | 需实际登录后确认选择器 |
| 2 | CAPTCHA/滑块 iframe 选择器 | §6 分类器 CaptchaSliderDevice 状态 | 需在实际人机验证页面确认 |
| 3 | OK/確認 按钮选择器 | §6 分类器 InterstitialConsent 状态 | 当前仅有 `cautionNextButton` 和 `finalConsentButton` 的真实选择器 |
| 4 | CheckboxGate 选择器 | §6 分类器 CheckboxGate 状态 | 当前代码中无任何 checkbox 选择器 |
| 5 | DaySelection 页面选择器 | §6 分类器 DaySelection 状态 | 需在实际抽选码日别选择页面确认 |
| 6 | Receipt 回执页 DOM 结构 | §6 分类器 Receipt 状态 | 需在实际提交后观察 |
| 7 | 会員情報页面 URL 及字段选择器 | §7.1.1 AccountProfile / §9 档案采集 | 需通过 Eplus 帮助文档/首页/会員メニュー定位 |
| 8 | 同行者管理页面 URL 及选择器 | §7.1.1 Companion / §9 档案采集 | 包括当前绑定和曾绑定同行者的具体位置 |
| 9 | 申込履歴页面 URL 及选择器 | §10 ApplicationRecord | 需通过 Eplus 帮助文档/首页/会員メニュー定位 |
| 10 | 当選確認页面 URL 及选择器 | §10 LotteryResultRecord | 同上 |
| 11 | 共享邮箱验证码邮件内容格式 | §11 邮箱验证码 | 确认 Eplus 验证码邮件中是否包含账号标识以支持自动归属 |
| 12 | Clash 控制器 host/port/secret/proxyGroup 值 | §15 IP 轮换 | 依赖于运行环境的实际 Clash 配置 |

