# Eplus Assistant

<p align="center"><b><a href="README.md">English</a> | <a href="README_zh.md">简体中文</a></b></p>

Eplus Assistant 由两个小工具组成：

- **浏览器用户脚本**（`userscript/eplus-collector.user.js`）：在你正常浏览 eplus.jp 时运行，把手机号、姓名/性别/住址、信用卡摘要、同行者名单、抽选申请记录从当前页面读出来，导出成一个 JSON 文件。
- **本地桌面应用**：导入那个 JSON 文件，把你名下所有 Eplus 账号的资料集中在一个地方查看。

这两个工具都不会替你登录、替你填抽选表单，也不会替你下单。你自己在浏览器里正常浏览、登录 eplus.jp，用户脚本只读取你正在看的这个页面上已经有的信息。

## 安装用户脚本

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)。
2. 打开它的管理面板，新建一个脚本，把内容整个换成 [`userscript/eplus-collector.user.js`](userscript/eplus-collector.user.js)。
3. 保存。

之后打开任意 `eplus.jp`、`member.eplus.jp` 或 `orderhistory.eplus.jp` 页面，右下角就会出现一个悬浮面板。

## 采集账号数据

1. 像平时一样登录 eplus.jp。（面板可以帮你把保存好的邮箱密码填进登录框——见下面的[自动填写登录信息](#自动填写登录信息)——但登录按钮还是要你自己点。）
2. 面板的**采集进度**区块里，点每一项直接跳转到对应页面：

   | 面板上的名称 | 对应的 Eplus 页面 |
   | --- | --- |
   | 电话号码 | 携帯電話番号変更 |
   | 姓名&性别&住址 | 基本情報変更 |
   | 信用卡信息 | クレジットカード登録/変更 |
   | 同行者名单 | 同行者登録/解除 |
   | 抽选申请记录 | `orderhistory.eplus.jp` 上的申込み履歴 |

3. 每个页面停留一两秒，右边的圆点变绿就表示脚本已经读到了字段——哪怕这一项本来就是空的（比如没有同行者），也算作已采集。抽选申请记录页面比较特殊：脚本会自动点"もっと見る"直到把所有记录都展开，如果你的记录比较多，这一步会多花几秒钟。
4. 点**导出采集文件**，勾选想要包含的抽选状态（默认全选），下载 JSON 文件。

不需要把每个页面都访问一遍才能导出，也不需要一次性采集完——脚本会记住已经采集到的内容，跨页面、跨几次浏览都保留着，你可以分几次逛完再导出。之后再导出一次时，只会新增或更新数据；某一次没顺便采集到的部分，不会把之前已经存进桌面应用里的记录抹掉。

## 自动填写登录信息

在面板的**账号**区块里把邮箱和密码填一次。**记住密码**默认是勾选的，会把密码明文存在你的用户脚本管理器自己的存储里；如果不想这样，取消勾选即可，之后每次都要重新输入。

在 eplus.jp 的登录页，或者首页弹出的登录框里，会出现一个**一键填写登录信息**按钮，点一下就把邮箱密码填进去了——登录按钮还是要你自己点。

## 查看当前 IP

面板的**当前 IP / 来源地**区块会显示你的公网 IP、国家、地区和城市，用的是 [ip-api.com](http://ip-api.com)（连不上时自动换成 [ipwho.is](https://ipwho.is/)）。这纯粹是给你自己看的，不会写进导出的文件里。

## 从源码运行桌面应用

需要装了 npm 的 Node.js。

```bash
npm install
npm run dev
```

这会构建 Electron 主进程、启动 Vite，然后打开应用。`src/renderer/` 下的改动会热更新；`src/main/` 下的改动需要完全重启一次 `npm run dev` 才会生效。

如果要跑生产构建：

```bash
npm run build
npm start
```

## 打包成独立安装包

```bash
npm run dist:win    # Windows：NSIS 安装包 + 便携版 exe，产物在 release/
npm run dist:mac    # macOS：dmg + zip，产物在 release/（必须在 macOS 上跑）
```

electron-builder 没法在 Windows 上产出 macOS 安装包（反过来也不行）——这是 Apple/electron-builder 工具链本身的限制，不是这个项目绕不过去的坑。如果你手头没有 Mac，推一个 `v*` 的 tag（或者在 GitHub 仓库的 Actions 页面手动触发），[`.github/workflows/release.yml`](.github/workflows/release.yml) 会在 GitHub 提供的云端 runner 上分别构建两个平台，并把安装包挂到一次 Release 上。两边都没有做代码签名，所以 Windows 首次运行会被 SmartScreen 提示一下，macOS 需要右键"打开"或者去"安全性与隐私"里放行。

## 导入采集文件

打开**账号列表**，点**选择采集文件**——可以一次选中多个 JSON 文件。应用会按邮箱把每个文件自动匹配到已有账号；如果没有匹配到，会新建一个账号——这个账号不会有真实密码，因为你本来就是手动登录的，没有把密码交给用户脚本。之后可以在账号的**详情**里手动补上真实密码，这样**显示密码**和旁边的复制按钮才有意义。

账号列表里显示编号、电话号码、邮箱、启用状态，以及资料最后更新时间。

## 查看账号详情

打开某个账号的**详情**，可以看到它的个人资料——带假名注音的姓名、电话、地址、已绑定的同行者、信用卡摘要（只有卡组织和后四位，卡号、CVV、有效期都不会采集），以及完整的抽选申请记录，记录表格自带状态筛选。

## 查看所有账号的中选情况

**账号总览**页面把所有账号汇总在一起：账号总数、中选次数合计、抽过的公演数、整体中率，另外还有：

- 性别分布和抽选结果分布，条形图/饼图可以切换
- 各账号的中率排行榜
- 最近的抽选动态、最多人抽的公演
- 可排序、可筛选的账号明细表，点开某个账号能看到它抽过的每一场公演

页面顶部有个按钮，能把整张表导出成 CSV。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `userscript/eplus-collector.user.js` | 浏览器用户脚本，单文件、无需构建。 |
| `src/main/` | Electron 主进程：IPC 处理、账号/资料/抽选记录数据库、加密的密钥存储。 |
| `src/renderer/` | 桌面端界面，用 React 写的。 |
| `src/shared/` | 主进程和渲染进程共用的类型定义和 IPC 约定。 |
| `build/icon.png` | 应用图标源文件，electron-builder 会从它生成 `.ico`/`.icns`。 |
| `.github/workflows/release.yml` | 推 tag 或手动触发时，在云端构建 Windows 和 macOS 安装包。 |

账号密码在写入本地数据库之前会用 Electron 的 `safeStorage` 加密。从源码运行时，本地数据库在 `data/` 目录下；安装后则在系统标准的每用户应用数据目录里。

## 测试、类型检查和构建

```bash
npm run typecheck
npm test
npm run build
```
