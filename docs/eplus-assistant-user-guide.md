# Eplus 抽选助手使用说明

## 1. 启动

```powershell
npm install
npm run dev
```

开发环境如果设置了 `ELECTRON_RUN_AS_NODE=1`，脚本会在启动 Electron 前自动清空它。

## 2. 添加账号

在「新增账号」里逐项填写：

- 显示名：例如 `东京 Day1-01`
- Eplus 邮箱
- Eplus 密码
- 邮件适配器 ID：当前可用 `manual`
- 标签：逗号分隔
- 邮件配置 JSON：没有适配器时保留 `{}`

密码和邮件配置会用 Electron `safeStorage` 加密后写入本机 `data/app.db`。

## 3. 批量导入账号

支持 CSV / JSON。

CSV：

```csv
eplusEmail,password,label,tags,enabled,mailProviderId,mailConfig
user@example.com,secret,Tokyo-01,"tokyo,day1",true,manual,{}
```

JSON：

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

## 4. 解析 Eplus 页面

在「抽选快照」里粘贴 URL，然后点「解析页面」。

支持两类页面：

- 普通详情页：例如 `https://eplus.jp/sf/detail/0534530001-P0030221P021001?P1=0175`
- 抽选码页：例如 `https://eplus.jp/sf/detail/3035790001?P6=993#`

程序会自动读取：

- 演出标题
- 会场
- 场次/日程文本
- 受付/申込み入口
- 枚数上限
- 付款方式
- 是否需要 `シリアルナンバー` / 抽选码
- 电话认证、受付结束等需要人工检查的提示

解析结果会显示在页面摘要里；JSON 仍保留为高级检查和调试入口。

## 5. 配置验证码总邮箱

在「验证码总邮箱」里配置登录验证码的统一收件箱。触发 Eplus 邮箱验证码时，后续浏览器执行器会优先使用这里的配置读取邮件；如果读取失败、超时或出现多封候选邮件，任务会转入人工接管。

支持的配置模式：

- 手动输入：不自动读取邮箱
- IMAP 邮箱：保存邮箱地址、用户名、密码
- HTTP API：保存 endpoint 和 API token
- temp-mail forwarder：面向转发查询服务
- auth mailbox：面向已有 auth/mailbox 服务

建议默认值：

- 发件人域名白名单：`eplus.co.jp`
- 主题匹配：`認証`、`確認`、`コード`、`e+`
- 轮询间隔：`5000`
- 超时：`180000`

密码和 API token 会加密保存。界面不会回显已保存的密钥，留空保存表示沿用旧密钥。

「读取验证码」按钮会直接调用当前保存的邮箱配置轮询邮件。对 e+ 的常见格式，例如：

```text
【e+より】認証コード通知
認証コード：687670
```

会自动提取 `687670`。如果命中多封邮件、鉴权失败或超时，界面会提示人工接管。

## 6. 创建任务

保存快照后，在「创建任务」里选择：

- 快照
- 申込み入口
- 枚数
- 付款方式
- 账号

如果页面需要抽选码，可以填写：

- 公共抽选码：所有选中账号共用
- 账号专用抽选码：每行一个，格式为 `邮箱或显示名=抽选码`

示例：

```text
user1@example.com=SERIAL-CODE-1
东京 Day1-02=SERIAL-CODE-2
```

如果页面要求抽选码，但既没有公共码，也没有给每个账号填写专用码，程序会拒绝创建任务。

## 7. 运行边界

当前版本已经实现页面解析、账号管理、任务建模和状态管理，但还没有执行真实 Eplus 提交。

保留的自动化边界：

- 不绕过 CAPTCHA、滑块、人机检测、电话认证或设备验证
- 电话认证、页面结构不明、受付结束、抽选码歧义时进入人工检查
- 抽选码错误会按页面文案区分 `InvalidCode` 与 `UsedCode`，供后续浏览器适配器使用
- `UnknownSubmissionState` 不允许盲目重复提交

## 8. 黑屏与启动诊断

生产构建使用相对资源路径加载，不再从 `file:///assets` 读取资源。若界面仍启动失败，窗口会显示错误页而不是纯黑屏。

诊断位置：

- 主进程/渲染进程日志：`data/runtime.log`
- 应用数据库：`data/app.db`

常用验证命令：

```powershell
npm run typecheck
npm test
npm run build
npm start
```

## 9. 版本与数据

运行期数据在 `data/` 下，已被 `.gitignore` 排除。不要提交数据库、日志、浏览器 profile、截图或本地证据文件。
