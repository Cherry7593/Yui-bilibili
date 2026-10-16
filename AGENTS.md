# AGENTS.md

本文件适用于整个仓库，供编码 Agent 和开发者使用。默认用简体中文沟通；代码、命令、路径、标识符和日志原文保持原样。

## 项目定位与取证入口

Yui Comment（仓库名 `Yui-bilibili`）是单账号、单机、低频的 Bilibili 巡逻工具，不是全站采集器或多账号运营平台。现有架构为 TypeScript + Fastify + React + SQLite，实际 Bilibili 调用通过 Python stdio MCP 桥接。

开始任务前按需阅读：

- `README.md`：使用方式、安全默认值和行为说明。
- `package.json`、`package-lock.json`、`requirements.txt`：运行命令和依赖；实际 Node 依赖版本以锁文件为准。
- `server/model.ts`：前后端共用的 Zod schema、类型和工具名单。
- `vendor/bilibili-mcp/UPSTREAM.md`：上游固定版本与本地适配边界。
- 对应的 `tests/` 文件：已有契约和回归场景。

以当前源码、配置和可复现测试核实行为；README / CHANGELOG 中的历史验证记录不代表本次已经验证。

## 目录与职责

| 路径 | 职责 / 修改入口 |
| --- | --- |
| `server/index.ts` | 组装服务、解释器和数据路径，启动与关闭 |
| `server/app.ts` | Fastify HTTP API、静态 SPA 与本机访问守卫 |
| `server/model.ts` | 共享 schema、类型、默认配置、日界与基础过滤 |
| `server/store.ts` | SQLite、配置、去重、队列、claim 和活动记录 |
| `server/scheduler.ts` | Discovery / Interaction 调度、额度、暂停、退避与发送前复核 |
| `server/bilibili.ts` | 持久 MCP 子进程客户端与返回值规范化 |
| `server/auth.ts`、`server/ai.ts` | 私有凭据存储；模型连接、判断、撰写和文本检查 |
| `bridge/server.py` | 固定上游的本地适配、串行调用、写锁与响应脱敏 |
| `web/main.tsx`、`web/style.css` | React 界面和样式；复用共享契约 |
| `tests/` | TypeScript 回归和 Python bridge 回归 |
| `scripts/vendor-upstream.mjs` | 受控重导入上游文件并验证 Git blob ID |
| `build-server/`、`dist/` | 编译产物，只由构建生成，不直接编辑 |
| `data/` | 本机私有运行数据，不作为开发夹具或提交内容 |

## 环境与命令

要求 Node.js **24+**、Python **3.11+**。从仓库根目录运行；MCP 入口和静态资源依赖这一工作目录。默认 Python 为 `.venv/bin/python`，可由 `PYTHON` 覆盖。

缺少依赖且任务需要安装时，使用 `npm ci`；Python 按 `README.md` 建立虚拟环境并安装 `requirements.txt`。不要因初始化规范而升级依赖或重写锁文件。

基础检查（Python 测试不包含在 `npm test` 中）：

```bash
export BILIBILI_WRITES_ENABLED=false
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
npm run lint
npm run build
```

- `npm test`：`tsx --test tests/*.test.ts`，使用 `node:test` / `node:assert/strict`，不是 Jest / Vitest。
- `npm run build`：全项目类型检查、后端编译、Vite 前端构建。
- `npm run lint`：检查 `server`、`web`、`tests`、`scripts`，排除 vendor。

开发服务分别为 `npm run dev`（后端 `3217`）和 `npm run dev:web`（Vite `3218`，严格端口，代理 `/api` 到 `3217`）。`npm start` 使用编译产物，须先构建。启动服务应使用隔离 checkout 或临时 `DATA_DIR`，且写开关保持 `false`；不要接入现有私有账号数据。环境变量通过 shell 显式传入；`.env.example` 仅为参考，本地 Node 启动不自动加载 `.env`。

## 不可破坏的安全边界

- 每次启动保持 **Paused**，新频道默认禁用；重启不能自动恢复互动。
- 开发、Review、QA 的 `BILIBILI_WRITES_ENABLED` 必须为 `false`。不要打开真实写锁、使用真实凭据做自动化测试或调用真实模型验证；真人登录与实际评论 / 回复由维护者自己验收。
- 默认不读取、打印或复制 `.env`、`data/`、凭据文件、私有数据库及备份。确有授权的排查也只提取必要的脱敏信息；日志、HTTP 响应、Activity 和模型输入不得泄露 Cookie、刷新令牌或 API key。
- 凭据保存在私有 `data/config/bili_credential.json`（目录 0700、文件 0600）；模型 key 保存在本机 SQLite，不在前端回显。不要把 Bilibili 凭据写入模型配置或工具参数。
- 服务仅供本机访问；本地运行保持 loopback 绑定，`HOST` 默认 `127.0.0.1`。保留本机访问守卫，不开放公网。
- 自动巡逻仅使用 `bili_check_credential`、`bili_search`、`bili_comments`、`bili_reply`。其余注册工具不接入自动队列；手动 Agent 工具仍受桥接层真实写锁保护。
- 未登录、验证码、风控和 HTTP 403/412 必须失败关闭并暂停。不得绕过登录、平台权限或风控；不要将 SDK 字符串化的风险错误当作成功。

## 调度与持久化不变量

修改 `scheduler.ts` / `store.ts` 时保留并测试这些约束：

1. Discovery 与 Interaction Queue 分离；BV / AV 去重跨频道且持久化，删除频道不删除全局发现记录。
2. 网络发送前持久化 claim、实际发送文本 / 已知回复对象和尝试时间；额度按尝试计数，失败发送也占额度。
3. 超时、失败或崩溃后的已尝试视频不重放；重启将 `claimed` 转为 `uncertain`，宁可漏发，不重复发送。
4. 全局与频道额度同时生效，日界固定 **Asia/Shanghai**，不依赖宿主机时区。
5. 异步请求返回后复核当前运行状态与配置；claim 前再检查登录、频道、额度、最短间隔、模板和 AI 模式。暂停等待在途请求结束，但不得启动下一次互动。
6. 读取与互动拥有独立连续失败计数和指数退避；成功搜索或读取不清除互动失败。
7. AI 判断只决定发现后的分流，撰写 / 抽模板发生在队列执行阶段。切换 AI 判断模式时旧待发送队列失效，但保留发现去重。
8. AI 缺配置、超时或输出不合格时失败关闭，不自动重试、不回退随机分流；模型不能修改额度、暂停、间隔、claim 或写锁。
9. 发送回执和登录续期状态是附加信息；可选元数据格式异常不能把已成功发送或有效登录变成失败。

## 修改约定与上游边界

- 保留现有未提交改动；只修改任务相关文件，不运行破坏性 reset / clean，不顺手全仓格式化或重构。
- TypeScript 使用严格类型和 ESM；后端相对导入沿用 `.js` 后缀。请求 / 配置 / 响应契约优先复用 `server/model.ts`，避免前后端各写一套。
- SQLite 字段和设置演进须兼容旧数据、旧配置默认值，并补充迁移 / 重启回归；不能清空真实数据库解决迁移问题。
- 页面变更保留中文文案、加载 / 禁用 / 错误反馈和失败后的表单草稿；不要让在途响应覆盖用户的新编辑。
- `vendor/bilibili-mcp/` 固定提交为 `1521d19d4118bfe23e08ec4c7702991c5f9de0ba`；选入的 `mcp_server.py`、`bili_login.py`、`LICENSE` 保持上游原样。本地行为适配放在 `bridge/server.py`，保留现有 27 个工具的名称和参数契约。
- 不运行 vendored 原始入口或登录辅助脚本。只有明确的上游更新任务才运行重导入脚本，并同步检查来源、blob 校验、许可证、依赖和回归测试。
- 添加 / 升级依赖或依赖未知 API 时，先查锁定版本、已安装源码、现有包装和测试；不足时再查 canonical GitHub 上游，不凭印象编造 API。

## 验证与交付

- 测试使用内存 / 临时 SQLite、临时凭据、Fake Bilibili 和 loopback 假模型服务，避免真实账号和供应商网络请求。HTTP API 可沿用 Fastify `app.inject()`；调度测试注入时钟和随机数。
- MCP 工具注册测试会启动真实 Python 子进程，但只枚举 27 个工具，不调用工具；需要安装 Python 依赖。
- 行为修复补针对性回归。改 bridge 必跑 Python unittest；改共享契约或跨模块行为跑 Node 测试、lint、build；纯文档修改至少核对命令和路径。
- 用户可见行为变化同步 `README.md` / `CHANGELOG.md`，不要把假服务测试写成真实 Bilibili 或供应商验收。
- 交付说明列出修改路径、实际运行的检查及未验证项；不自动 commit、push、发布、部署或更改正在运行的服务。
