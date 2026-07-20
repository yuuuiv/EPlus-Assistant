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
| 页面状态检测（登录/验证码/CAPTCHA/粉色按钮/勾选） | 待定 |
| 多账号管理终端（档案/同行者/申请记录/中落选记录+筛选） | 待定 |
| 邮箱验证码源（cerise-bouquet + Cloudflare + 手动） | 待定 |
| 每账号 IP 轮换（Clash 控制器 + ip-api 检测 + 切换按钮） | 待定 |
| 抽选码日别选择（day1/day2/两天） | 待定 |

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

## 4.x 浏览器会话引擎（Live Browser Session Engine）【规划中】

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

## 5. 核心领域模型

### 5.1 Account

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

### 5.2 EventSnapshot

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

### 5.3 LotteryPreference

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

### 5.4 LotteryTask 与 AccountRun

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

## 6. 账号导入、修改与备份

### 6.1 首次 Excel 导入

支持 `.xlsx`、`.xls`、`.csv`。导入向导可让用户将 Excel 列映射到以下字段：

| 必填列 | 可选列 |
| --- | --- |
| `eplus_email` | `label`、`password`、`tags`、`enabled` |
| `password` | `mail_provider`、`mail_target`、`mail_api_config` |

流程：文件选择 -> 表头预览 -> 列映射 -> 格式校验 -> 重复账号处理策略（跳过/更新/新增） -> 加密写入 -> 导入报告。

密码不会在导入预览或错误报告中展示。导入完成后应提示用户删除含明文密码的临时 Excel 副本，应用自身不复制该文件。

### 6.2 后续维护

- 账号列表支持搜索、标签分组、启用/停用、逐项编辑与批量更新邮件服务配置。
- 删除账号只删除本地数据和自动化 profile，不影响 Eplus 账号本身。
- 支持导出仅含元数据的 CSV，以及采用用户口令加密的完整备份包。

## 7. 邮箱验证码架构

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

建议实现两个适配器：

1. `TempMailForwarderAdapter`：面向 `temp-mail` 项目暴露的邮件查询接口，按转发目标邮箱检索新到邮件。
2. `AuthMailboxAdapter`：面向 `auth` 项目提供的认证或邮箱读取接口。

验证码提取规则应由邮件正文 DOM/HTML 解析后匹配，至少校验发件人域名、接收时间晚于任务开始时间和邮件主题。不得仅以任意六位数字正则匹配。匹配失败时转为人工输入验证码。

邮件服务不可用、超时或发现多封候选邮件时，`AccountRun` 进入 `AwaitingManualAction`，浏览器保留在验证码输入页，用户可在 UI 中输入验证码后继续。

## 8. Eplus 浏览器适配器

### 8.1 浏览器隔离

- 每个账号使用独立的持久化浏览器 profile：`profiles/<account-id>/`。
- 默认串行执行账号任务，避免会话串扰、重复申请和不必要的高频访问。
- 不注入隐藏自动化脚本，不规避站点安全机制；使用正常页面交互、显式等待与合理退避。
- 每个页面跳转和最终提交前保存截图；含个人数据的截图按访问权限保存在本机。

### 8.2 页面模型

将站点交互拆成可测试步骤，每步都先读状态再动作：

```text
openEvent(url)
discoverApplicationForm()
login(email, password)
detectChallenge()
enterEmailCode(code)
readAvailableOptions()
applyPreference(preference)
readReviewPage()
submitApplication()
readReceipt()
```

`detectChallenge()` 应区分：邮箱验证码、CAPTCHA/滑块、站点设备确认、登录失败、临时限流、页面结构未知。除邮箱验证码外的验证统一人工接管。

### 8.3 幂等与重复申请保护

提交前必须进行以下检查：

1. 读取确认页并与 `LotteryPreference` 逐字段比对。
2. 查询页面是否显示该账号对此演出的既有申请记录。
3. 计算 `account_id + canonical_event_id + preference` 的幂等键，并检查本地是否已成功提交。
4. 只有用户确认的任务可进入最终提交；批量任务的首次最终提交须逐账号记录确认页摘要。

提交按钮点击后不立即认为成功，必须读取站点回执页的申请编号或明确成功文案。网络中断则标记为 `UnknownSubmissionState`，恢复时先查询申请历史，禁止盲目重试。

## 9. 任务状态机与人工接管

```text
Draft -> AwaitingConfirmation -> Queued -> Running
Running -> AwaitingEmailCode -> FillingForm -> AwaitingSubmitConfirmation
AwaitingSubmitConfirmation -> Submitting -> Submitted
Running/* -> AwaitingManualAction -> Running
Running/* -> Failed | Cancelled
Submitting -> UnknownSubmissionState -> Submitted | Failed
```

人工接管触发条件：CAPTCHA、异常安全验证、站点提示不支持的页面、验证码歧义、付款相关二次确认、页面字段与快照不一致。界面应显示当前账号、原因、浏览器窗口状态和“继续/取消此账号/取消整个任务”操作。

## 10. 用户界面流程

### 10.1 主导航

- `任务`：查看运行中、待人工处理、已完成和失败任务。
- `新建抽选`：创建向导。
- `账号`：导入、编辑、分组、验证邮件服务。
- `设置`：数据目录、备份、日志保留期、并发数（默认 1）。

### 10.2 新建抽选向导

1. 输入 Eplus URL，验证域名为 `eplus.jp`，打开页面并读取演出/申请信息。
2. 展示实际解析到的票档、可选枚数、希望顺位和付款方式；不自行猜测缺失选项。
3. 选择账号，可按标签筛选并提供“全选当前筛选结果”。
4. 生成汇总预览：演出、账号数、每个希望顺位、付款方式、截至时间和风险提示。
5. 用户确认后创建并排队。若需要，每个账号在最终页面再次由用户批准，或由设置中明确启用的“已确认批量提交”策略处理。

## 11. 数据安全与隐私

- 密码、邮箱 API token 和验证码仅在内存中短暂以明文存在；数据库存密文。
- 应用启动需由 Windows 当前用户解锁；可选设置独立主密码。
- 所有日志进行字段级脱敏：邮箱显示为 `ab***@example.com`，申请号可保留后四位，密码和验证码永不记录。
- `artifacts/` 文件设置访问限制并可从 UI 一键清理；默认保留 30 天。
- 禁止将 profile、数据库、截图或日志提交到 Git；提供 `.gitignore` 模板。

## 12. 错误处理与恢复

| 情况 | 处理 |
| --- | --- |
| 邮箱验证码超时 | 暂停该账号，允许手工输入或稍后重试 |
| 密码错误/账号锁定提示 | 标记账号不可用，不自动重复登录 |
| 页面结构改变 | 保存脱敏 HTML 快照和截图，停止提交，提示更新适配器 |
| 单账号失败 | 继续队列内其他账号，并在任务页汇总失败原因 |
| 应用崩溃/系统重启 | 基于 `resume_checkpoint` 恢复；提交未知状态先查历史 |
| 站点限流/维护 | 全局暂停、指数退避并需要用户手动恢复 |

## 13. 目录与配置建议

```text
eplus-assistant/
  apps/desktop/                 # Tauri + React UI
  packages/core/                # 领域模型、状态机、用例
  packages/eplus-adapter/       # Playwright 页面适配器
  packages/mail-adapters/       # temp-mail/auth 适配器
  packages/shared/              # DTO、验证、脱敏工具
  data/                         # 默认不进入版本控制
    app.db
    profiles/<account-id>/
    artifacts/<task-id>/
  docs/
```

运行期配置使用 `config.json` 保存非敏感项，例如数据目录、浏览器路径、验证码超时和日志等级；任何 token、密码、会话 cookie 都不进入该文件。

## 14. 实施阶段

### Phase 0：验证前置条件

- 审阅 `temp-mail` 与 `auth` 的 API、认证方式、邮件检索延迟和错误语义。
- 以单一测试账号手动走通登录、邮箱验证码和一个抽选确认页，记录页面字段及稳定选择器。
- 确认 Eplus 允许的正常使用范围与需要人工介入的验证类型。

### Phase 1：本地账号与邮件能力

- 创建桌面项目、SQLite schema、DPAPI 密钥封装与 Excel 导入。
- 实现账号管理、标签、加密备份和邮件服务连通性测试。
- 为 MailProvider 增加模拟实现和单元测试。

### Phase 2：单账号登录与表单读取

- 实现隔离 profile、登录、邮箱验证码等待、人工接管和截图归档。
- 实现 URL 解析、演出快照和申请选项读取，只读不提交。
- 针对已记录页面快照编写适配器回归测试。

### Phase 3：单账号提交与恢复

- 实现偏好填写、确认页比对、明确提交、回执提取和幂等保护。
- 实现异常退出恢复及 `UnknownSubmissionState` 查询策略。

### Phase 4：批量编排与可用性

- 加入账号选择/全选、串行队列、汇总预览、任务页和失败重试。
- 增加端到端测试、脱敏审计、备份恢复和可配置数据保留策略。

## 15. 验收标准

1. 用户可从给定 Excel 导入账号，重启应用后仍能安全读取并编辑元数据。
2. 用户粘贴 Eplus 抽选 URL 后，只能从实际页面解析出的选项中选择票档、枚数、希望顺位和付款方式。
3. 测试账号登录时，邮件验证码可从配置的邮件适配器获得；失败时可人工继续。
4. 单账号抽选提交前后都有可审计的确认页摘要和回执结果，程序不会因超时盲目重复提交。
5. 多账号任务可全选、串行执行、单账号隔离、失败不中断其他账号，并可在中断后恢复。
6. 密码、验证码、完整邮箱服务令牌不出现在界面日志、数据库明文或导出文件中。

## 16. 开发前待确认项

- `temp-mail` 与 `auth` 实际提供的调用方式、鉴权方式以及可稳定查询的邮件字段。
- Eplus 登录与抽选页面的真实 HTML、验证码邮件格式、页面语言与付款方式差异。
- 希望顺位是否需要支持多个场次/日期组合，以及每场的账号申请限制。
- 最终提交策略：每个账号人工确认，还是在总览确认后由程序依次提交。
