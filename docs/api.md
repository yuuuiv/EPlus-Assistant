# Local API / IPC Contract

本项目是桌面应用，不提供公网 HTTP API。Renderer 通过 `contextBridge` 暴露的 `window.eplusApi` 调用主进程；主进程再通过 Electron IPC 访问数据库、浏览器、邮箱和本机网络控制器。

## 约定

- 所有 channel 都校验 `senderFrame.url`，非当前窗口的调用会被拒绝。
- payload 使用 Zod 严格校验；未知字段会被拒绝。
- 密码、邮箱凭证、代理密钥只在主进程处理。密码只通过一次性 `revealPassword` 会话短暂返回，并在 UI 5 秒后隐藏。
- 浏览器截图和 HTML 快照写入数据库数据目录下的 `artifacts/`，并创建 `artifact_manifests` 记录。快照会隐藏密码、卡号、CVV、有效期等字段；信用卡资料只保存品牌和末四位。

## Renderer API

| `window.eplusApi` 方法 | 主进程 channel | 输入/输出 |
| --- | --- | --- |
| `getState()` | `app:get-state` | 返回账号、事件、任务、运行、日志、邮箱、网络和数据目录 |
| `addAccount(input)` | `account:add` | `eplusEmail`、`password`、可选 `label/tags/mailConfig` |
| `importAccounts(input)` | `account:import` | `{ kind: "csv" | "json", text }` |
| `deleteAccount(id)` | `account:delete` | 账号 ID |
| `discoverEvent(input)` | `event:discover` | `{ sourceUrl }`；返回事件快照输入 |
| `saveEventSnapshot(input)` | `event:save` | 事件快照描述 |
| `createTask(input)` / `createTaskV2(input)` | `task:create` / `task:create-v2` | 事件、账号、抽选偏好和设备档案 |
| `enqueueTask(taskId)` | `queue:enqueue-task` | 任务 ID |
| `pauseQueue()` / `resumeQueue()` | `queue:pause` / `queue:resume` | 无输入 |
| `cancelRun(runId)` / `cancelTask(taskId)` | `queue:cancel-run` / `queue:cancel-task` | ID |
| `performManualAction(input)` | `run:manual-action` | `{ runId, action, verificationCode? }` |
| `selectPaymentOptions(input)` | `run:select-payment-options` | 检查点版本、候选 ID、控件指纹 |
| `dispatchSubmission(input)` | `run:dispatch-submission` | 一次性授权版本、nonce |
| `revealPassword(accountId)` | `account:reveal-password` | 返回短时 plaintext，不写日志 |
| `harvestProfile(input)` / `refreshProfile(accountId)` | `profile:harvest` / `profile:refresh` | 读取会员资料、手机号、地址、同行者、卡片摘要 |
| `refreshApplicationRecords(accountId)` | `profile:refresh-application-records` | 读取 `https://eplus.jp/jyoukyou` 的申请记录 |
| `refreshLotteryResults(accountId)` | `profile:refresh-lottery-results` | 读取抽选结果并归一化为 `中選/落選/待通知/取消` |
| `listProfiles(accountId)` | `profile:get` | 返回已保存账号资料 |
| `listCompanions(accountId)` | `profile:list-companions` | 返回当前/历史同行者 |
| `listApplicationRecords(accountId)` | `profile:list-application-records` | 返回申请记录 |
| `listLotteryResults(accountId)` | `profile:list-lottery-results` | 返回抽选结果 |
| `saveVerificationMailbox(input)` | `settings:save-verification-mailbox` | 邮箱配置；cerise 模式可只填地址 |
| `testVerificationMailbox()` | `settings:test-verification-mailbox` | 返回 `{ ok, message }` |
| `readVerificationCode(input?)` | `settings:read-verification-code` | 只读取开始时间之后、收件人/转发来源匹配、发件人白名单和主题匹配的验证码邮件 |
| `getNetworkSettings()` / `saveNetworkSettings(input)` | `settings:get-network` / `settings:save-network` | 控制器、地址、端口、代理组、国家策略 |
| `importNetworkConfig(input)` | `settings:import-network` | `{ controller: "clash" | "sing-box", text }`；解析 YAML/JSON |
| `detectIp()` / `rotateIp()` | `network:detect` / `network:rotate` | 查询地区或轮换本机控制器代理 |
| `openDataFolder()` | `app:open-data-folder` | 打开本地数据目录 |

## Serial-code task contract

需要 serial 抽选的任务可以通过 `preference.serialCodeAllocations` 表达多码、多账号和逐码场次方案：

```ts
serialCodeAllocations: {
  [accountId]: [
    { code: "CODE-001", daySelection: ["day1"] },
    { code: "CODE-002", daySelection: ["day1", "day2"], applicationLinkId: "application-day-entry" }
  ]
}
```

- 一个 `SerialCodePlan` 代表一个码的方案；`code` 必须非空，且一个码不能被分配给多个方案。
- `daySelection` 可选 Day1、Day2 或两者。选择两者时，数据库会展开为两个 `AccountRun`，每个 run 只带一个 day，并分别启动独立浏览器会话；不会在一个浏览器窗口中一次性完成两天。
- `applicationLinkId` 和 `entries` 可逐码覆盖任务默认入口/票务方案；入口链接相同不影响 run 拆分。
- `AccountRun.serialCode` 和 `AccountRun.serialPlan` 是本次运行的确定性输入，队列按 run 排队，不按账号去重。
- 旧的 `serialCode`、`serialCodesByAccountId`、`daySelectionByAccountId` 仍可读取；新任务优先使用 `serialCodeAllocations`。数据库 schema migration 8/9 增加 run 级 serial code 和 serial plan。

serial 入口解析会保留可执行的 source URL，即使页面 canonical 指向普通 detail URL；live 页面中的 `input[name^='ninsho_key']` 与 `button[name='action'][value='moushikomi']` 会作为受保护的提交控件。提交后重新分类页面状态，再继续登录后表单、人工接管、邮箱验证码和付款检查点流程。

## 人工接管与快照

`AwaitingManualAction`、`AwaitingEmailCode`、`AwaitingSubmitConfirmation` 都保持可见浏览器会话，不会在 orchestrator 的 `finally` 中立即关闭。登录和邮箱验证码默认由主进程自动处理；只有 CAPTCHA/设备验证/未知控件才需要人工接管。提交后的 `AwaitingCompletionEmail` 是不可重复提交的邮件确认状态：

1. 操作者在真实浏览器中完成 CAPTCHA、电话验证、卡片输入或未知页面操作。
2. UI 调用 `performManualAction({ runId, action: "continue", verificationCode? })`。
3. 主进程先把验证码填入当前页面（如有），再捕获人工接管快照，恢复相同账号/run 的 session，并重新验证付款检查点。

`AwaitingCompletionEmail` 通过 `run:await-completion-email` 重新轮询邮件。只有当前账号转发来源、原始发件人 `info@eplus.co.jp`、时间下限和申请完成正文全部通过才转为 `Submitted`。

浏览器 executable 的解析顺序为 `EPLUS_BROWSER_EXECUTABLE`、常见 Chrome/Edge 路径、`playwright-core` 的 Chromium 路径；找不到时会给出明确错误，不会误用 Electron executable。

## cerise-bouquet 邮箱模式

`mode: "cerise-bouquet"` 的默认 API endpoint 是 `https://temp-mail.lianminglai.workers.dev`，读取路径为 `/api/parsed_mails?limit=100&offset=0`，并按收件地址、发件人白名单、主题正则和时间范围归因。`mail.cerise-bouquet.xyz` 若部署的是前端页面，不能作为 API endpoint；可通过 `EPLUS_CERISE_BOUQUET_ENDPOINT` 覆盖。

前端只需要输入 `user@cerise-bouquet.xyz`。但 HTTP 服务仍然必须完成认证，因此主进程启动时需要以下任一环境变量：

- `EPLUS_CERISE_BOUQUET_JWT`：地址 JWT，发送 `Authorization: Bearer ...`。
- `EPLUS_CERISE_BOUQUET_ADMIN_AUTH`：部署方提供的管理员 bridge 凭证。主进程会按 `auth-main` 的流程调用 `/admin/users`、`/admin/users/bind_address/{user_id}`、`/admin/show_password/{address_id}`，然后用返回的地址 JWT 调用 `/api/parsed_mails`。

“只填邮箱”表示 UI 不要求用户复制 JWT，不表示远程 HTTP API 可以无认证读取邮件。管理员模式的 endpoint 应指向 mail Worker 基地址；若部署的 `auth-main`/Worker 改了路径或 header，应在设置中调整 endpoint/后端适配层，而不是把凭证放进 renderer。

## 网络配置导入

Clash Verge YAML 需要包含 `external-controller`、`secret` 和至少一个 `proxy-groups[].name`；sing-box JSON/YAML 需要包含 `experimental.clash_api.external_controller`（或等价字段）、`secret` 和 selector/default mode。两者均通过兼容 Clash API 的 `/proxies/{group}` 控制轮换。

每个 lottery run 在获取网络租约前轮换并检测一次 IP；租约期间会校验出口 IP 指纹和国家策略。UI 的“检测 IP”会调用 `ip-api.com` 获取地区信息；“切换 IP”只调用本机控制器。

## 资料采集页面

登录后自动资料归档和手动刷新使用这些入口：

- `/telnumber-ninsho`：手机号
- `/update-member`：姓名、性别、出生年份/生日
- `/update-shippingaddress`：地址
- `/update-dokosha`：当前及历史同行者
- `/update-creditcard`：仅保存品牌和末四位
- `https://eplus.jp/jyoukyou`：申请记录和抽选状态

页面结构变化时，采集结果会标记 `Partial` 并保留以前成功采集的值；验证码、CAPTCHA 或二次登录会返回人工接管状态。
