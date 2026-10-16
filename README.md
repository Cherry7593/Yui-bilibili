# Yui-bilibili

**在本机运行的 Bilibili 低频巡逻工具：按关键词发现视频，在严格限额下使用模板或可选 AI 进行评论与回复。**

单账号、单进程、本地优先。不是全站采集器，也不是批量营销或多账号运营平台。

![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=nodedotjs&logoColor=white)
![Python 3.11+](https://img.shields.io/badge/Python-3.11%2B-3776AB?logo=python&logoColor=white)
![License GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue)

> **先了解风险，再启用互动。** 默认禁止真实写操作，每次启动都处于暂停状态。低频、限额和文本过滤不代表平台许可，也不能保证账号不受限制。本项目非 Bilibili 官方产品；请遵守平台规则和适用法律，不用于刷屏、骚扰、广告或规避风控。

[快速开始](#快速开始) · [首次使用](#首次使用) · [AI 配置](#可选-ai) · [安全与隐私](#安全与隐私) · [开发](#开发与验证) · [详细行为](docs/behavior.md)

## 能做什么

- **巡逻频道**：多个关键词、发布时间与播放量过滤、随机搜索间隔、独立日额度。
- **热度筛选**：按播放量降序 + 发布时间日期限定搜索，再按精确时间窗与最低播放量过滤；阈值留空按 1000 执行。
- **模板与可选 AI**：默认概率分流与模板；频道可以开启 AI 判断，选择固定模板或 AI 撰写。
- **回复高赞评论**：回复只挑点赞数达到频道门槛（默认 50）的普通根评论，按点赞从高到低优先。
- **中文 WebUI**：总览、频道、模板、活动和设置；支持深色模式和窄屏布局。
- **可追踪的互动**：总览展示累计数据（右上角为今日增量）、最近 53 周的每日互动热力图和已确认成功的最近评论；活动页记录跳过、失败和不确定结果。回复会引用被回复的原评论，方便对照审查。
- **持久化去重**：跨频道、跨重启按 BV / AV 去重；发送前落盘 claim，不重放结果不确定的尝试。
- **本机 MCP 桥接**：保留上游 27 个工具；自动巡逻只使用登录检查、搜索、读取评论和评论 / 回复这 4 个工具。

## 快速开始

### 环境要求

- Node.js **24+** 与 npm（使用 Node 内置 SQLite）。
- Python **3.11+** 与 venv。
- 本机浏览器；运行 Bilibili 功能时需要网络连接。

以下命令适用于 macOS / Linux，请在仓库根目录执行：

```bash
git clone https://github.com/Cherry7593/Yui-bilibili.git
cd Yui-bilibili

# 默认关闭真实评论、回复及其他写操作。
export BILIBILI_WRITES_ENABLED=false

python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
npm ci
npm run build
npm start
```

打开 **<http://127.0.0.1:3217>**。服务启动后保持 **Paused**；此时可以配置界面和登录，但不能启动巡逻。写开关关闭不是离线模式：登录检查、扫码和模型连接检查仍可能发出相应网络请求。

已安装 uv 时，可用以下两行替代 Python 环境创建和安装：

```bash
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
```

Windows / PowerShell 的 Python 环境与变量设置示例：

```powershell
$env:BILIBILI_WRITES_ENABLED = "false"
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:PYTHON = ".venv/Scripts/python.exe"
npm ci
npm run build
npm start
```

Windows 示例未经本次实机验收；目前不提供桌面安装包。运行中的 Cookie、模型 key 和数据库不要带入共享或测试环境。

### 运行参数

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BILIBILI_WRITES_ENABLED` | 未设置即关闭 | 仅值为 `true` 时允许真实写操作；开发、测试始终为 `false`。 |
| `HOST` | `127.0.0.1` | 保持 loopback 绑定；不支持直接面向公网部署。 |
| `PORT` | `3217` | 本机 HTTP 服务端口；部分端口受代码限制，建议保留默认。 |
| `DATA_DIR` | `data` | 数据目录；相对路径基于启动工作目录。 |
| `PYTHON` | `.venv/bin/python` | MCP 子进程使用的 Python 解释器；Windows 需覆盖。 |

**程序不会自动加载 `.env`**；[`.env.example`](.env.example) 只是变量参考。请通过 shell 显式传入运行参数。账号和模型配置均在 WebUI 设置，不要把 Cookie 或 API key 写进命令、Issue 或仓库。

## 首次使用

1. **登录账号**：在设置页生成二维码并扫码确认，页面自动查询状态；也可粘贴本人账号的 Cookie，需含 `SESSDATA`、`bili_jct`、`DedeUserID`。建议给本工具使用独立的登录会话。
2. **创建频道**：填写关键词和发现范围，先保持禁用。设置搜索间隔、互动概率及频道日额度。
3. **准备模板**：分别添加视频评论和高赞根评论回复模板（如「喵」这类不依赖上下文的短句）。建议每种至少两条不同内容；无可用模板或与上一条发送文本完全相同时会跳过。
4. **检查全局限制**：全局与频道额度同时生效；失败的发送尝试也占额度。日界固定为 **Asia/Shanghai**。
5. **自行决定是否启用真实互动**：确认账号、模板、频道和限额后，先停止服务。仅在本人明确接受平台与账号风险时，以显式写开关重新启动：

   ```bash
   BILIBILI_WRITES_ENABLED=true npm start
   ```

   PowerShell 使用 `$env:BILIBILI_WRITES_ENABLED = "true"` 后运行 `npm start`。重启仍暂停，需要登录有效、启用频道并手动启动总调度器。不要在开发、自动化测试或 Review 环境中打开此开关。

6. **观察结果**：总览顶部是累计发现 / 评论 / 回复 / 跳过 / 失败（右上角为今日增量）和最近 53 周的互动热力图，下方只显示已确认成功的最近 10 条评论 / 回复；活动页可筛选其他状态。暂停会等待在途请求结束，已经发到网络上的请求无法撤回。

### 默认限额

| 范围 | 默认值 |
| --- | --- |
| 每频道搜索 | 30–90 分钟一次；最近 72 小时；最低播放量留空按 1000 执行；每日最多 20 次 |
| 每频道互动 | 每日评论 5、回复 3；跳过 / 评论 / 回复概率 70 / 20 / 10 |
| 全局搜索 | 每日 200 次 |
| 全局互动 | 每日评论 10、回复 5、总互动 15；两次尝试间隔 5–30 分钟 |

这些是上限而非发送目标；过滤、去重、缺模板或错误都可能导致没有互动。

### 热度与排序

- **最低播放量**：频道「最低播放量」留空按默认 **1000** 执行；显式填 `0` 表示不限，也可填 500、3000 等；「最高播放量」留空为不限。
- **时间窗**：`最近发布（小时）` 默认 **72**，窗口与上下界都含边界，未来视频被拒绝。
- **搜索方式**：固定用「播放量降序（click）」+ SDK 原生发布时间日期筛选，每次取第一页、最多 50 条；再由本地按精确时间窗和播放量上下限逐条过滤。日期参数只支持 `YYYY-MM-DD` 并按宿主本地零点解释，bridge 会把窗口向外扩到整天，Node 侧再精确裁剪。
- **不改动已存频道**：不迁移 SQLite 中的旧频道值，也不新增热度或排序字段；旧频道留下的空值在新版本里按 1000 解释。
- **回复点赞门槛**：频道「回复评论最低点赞数」默认 **50**（含 50），`0` 表示不限。回复时读取热度排序第一页评论，只保留点赞数达到门槛、通过安全过滤的普通根评论，按点赞降序；模板模式在其中随机抽一条，AI 撰写模式把点赞数一并交给模型选择。没有合格评论就跳过；发送前按最新门槛再复核一次。旧频道未存此字段时按 50 解释。
- **资格复核**：发现前、AI 判断入队后、队列执行与发送前都会按最新频道配置再次检查；调高下限或缩短窗口会让已排队但不再合格的视频被跳过，而不是照发。被热度过滤的视频不写入发现记录、不占用 BV / AV 去重。

## 可选 AI

无需模型也能使用默认概率与模板模式。需要 AI 时，在 **设置 → AI 模型** 保存一份全局配置：

- **接口根地址**：OpenAI 兼容 Chat Completions 根地址；程序只补一次 `/chat/completions`，不会自动插入 `/v1`。
- **模型名**：填写服务商实际支持的模型名，模型必须支持 JSON mode。
- **API key**：只在密码框输入；留空保留旧 key，可通过复选框清空，不会回显。

例如 `https://api.deepseek.com` 或 `https://api.siliconflow.cn/v1`。先保存，再点击连接检查；该检查会调用模型服务，可能产生费用，但不发送 Bilibili 评论。

在频道编辑页开启 **AI 判断**，选择「AI 互动方式」（默认回复高赞评论，可改为评论视频）以及固定模板或 AI 撰写，可填写最多 300 字符的风格。模型只判断视频值不值得互动，互动方式由频道决定；回复模式下没有达到点赞门槛的评论就跳过，不改为评论视频。关闭 AI 判断时，互动方式、AI 写法和风格不生效。

- 模型只获得公开发现信息（标题、UP 主、关键词）及你配置的频道名；撰写时还可能获得风格和候选评论的 rpid / 正文。**不发送 Bilibili Cookie、刷新令牌、账号凭据或评论用户 UID**。这些输入会交给所配置的服务商，请先了解其隐私与费用政策。
- 缺配置时不允许保存开启 AI 的频道，并保持失败关闭；模型超时、无效输出或本地检查不通过时跳过，不回退随机分流、不自动重试。
- AI 不控制额度、间隔、暂停、claim 或写开关。文本经过保守词法检查，但不提供语义审核保证，仍可能误拒或漏判。

请求字段、配置切换和队列规则见 [详细行为](docs/behavior.md#ai-判断与撰写)。

## 安全与隐私

- **启动即暂停**，新频道默认禁用；验证码、风控、登录失效和 HTTP 403/412 失败关闭并暂停。
- **只供本机使用**。界面没有多用户认证；Host / Origin 检查不能代替远程身份认证。不要使用 `0.0.0.0`、公网端口映射或公开反向代理。
- **宁可漏发，不重复发**。发送前持久化 claim；超时、失败或崩溃后的已尝试视频不自动重发。
- **私有数据不是密钥保险库**。Cookie 文件和 SQLite 存在本机磁盘上；权限限制不等于加密。能读取你账户文件的程序也可能读取这些秘密。

默认私有路径：

| 路径 | 内容 |
| --- | --- |
| `data/config/bili_credential.json` | Cookie 和可选刷新令牌；目录 0700、文件 0600 |
| `data/patrol.sqlite` 及其侧文件 | 频道、模板、发现、活动、发送内容及模型 key；数据库文件 0600 |

**不要提交、分享或附上 `data/`、`.env`、数据库及备份、登录二维码、浏览器 HAR、Cookie 或模型 key。** 自定义 `DATA_DIR` 同样含有私有数据；建议放在仓库外。截图应先遮住账号、二维码、频道和活动中的私人信息。

[`.gitignore`](.gitignore) 仅防止未跟踪文件被意外加入；无法移除历史提交里的秘密，也无法阻止 `git add -f`。如果秘密曾泄漏，先撤销 / 轮换，再按 [安全说明](SECURITY.md) 处理。

## 开发与验证

前后端分别启动，必须保持真实写操作关闭；使用独立 checkout 或临时数据目录，不接入日常账号数据：

```bash
export BILIBILI_WRITES_ENABLED=false
export DATA_DIR="$(mktemp -d)"
npm run dev       # 后端：127.0.0.1:3217
```

在另一个终端进入仓库并运行 `npm run dev:web`，打开 <http://127.0.0.1:3218>。Vite 严格使用 3218，代理 `/api` 到后端 3217。

安装 Node / Python 依赖后运行全部检查：

```bash
export BILIBILI_WRITES_ENABLED=false
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
npm run lint
npm run build
```

Node 测试使用 `node:test`，Python 测试不包含在 `npm test` 内。测试使用临时 / 内存 SQLite、假 Bilibili 和 loopback 假模型；MCP 注册测试启动 Python 子进程，只枚举工具、不调用真实工具。自动化检查不代表真实账号、真人扫码、实际发送或供应商兼容性验收。

### 项目结构

```text
server/                 Fastify API、SQLite、调度、账号与 AI
web/                    React 中文界面与样式
bridge/server.py        Python MCP 本地适配与写锁
vendor/bilibili-mcp/    固定版本上游源码及 MIT 许可证
scripts/                上游受控重导入脚本
tests/                  TypeScript 与 Python 回归
docs/                   详细行为文档
```

详见 [贡献指南](CONTRIBUTING.md) 和 [变更记录](CHANGELOG.md)。

## 已知限制

- 单账号、单机、单进程；没有多账号、自动私信、全站抓取或公网部署支持。
- 仅搜索日期限定 click 排序的第一页，最多 50 条；上游可能返回更少或不遵守日期参数，本地过滤不放宽，也不补页。AI 不读取视频、字幕或弹幕，不应据此断言视频事实。
- 回复对象过滤只是保守的词汇检查，并非语义理解；点赞数缺失、置顶、非普通评论、含广告 / 联系方式 / 辱骂等内容都会跳过。高赞门槛越高，可回复的视频越少，实际回复比例可能远低于设置值。
- 依赖非官方 Bilibili SDK；平台接口变化可能影响搜索、扫码和续期。扫码不成功时可改用本人 Cookie 登录；真人确认和真实互动由使用者自行验收。
- 无桌面安装包；Windows 安装步骤与文件权限语义仍需在目标环境验证。

## 许可证与致谢

Copyright © 2026 **Chryui**。项目原创代码与文档以 **GPL-3.0-or-later** 发布，见 [LICENSE](LICENSE) 和 [COPYRIGHT](COPYRIGHT)。直接依赖 `bilibili-api-python==17.4.2` 同样采用 GPL-3.0-or-later；分发修改版或打包程序时须遵守适用的 GPL 条件，包括相应的源码提供义务。

`vendor/bilibili-mcp/` 中选入的上游文件仍适用其原有 **MIT** 许可证，不被重新授权。来源为 [adoresever/bilibili-mcp](https://github.com/adoresever/bilibili-mcp)，固定提交 `1521d19d4118bfe23e08ec4c7702991c5f9de0ba`；见 [来源与适配边界](vendor/bilibili-mcp/UPSTREAM.md) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。不要直接运行 vendored 原始入口或登录辅助脚本。

UI 视觉参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的侧栏、排版和留白，自行实现，未复制其代码。本项目不代表或获得 Bilibili、模型服务商及上游项目的官方背书。
