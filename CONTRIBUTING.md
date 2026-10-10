# 贡献指南

欢迎可复现的 Bug 报告、小范围修复、测试和文档改进。项目定位是**单账号、单机、低频巡逻**，不是批量营销或多账号运营平台。

## 报告问题

先阅读 [README](README.md) 与 [已知限制](README.md#已知限制)。普通问题可提交 Issue，包含：

- 操作系统、Node / Python 版本、使用的 commit 或版本。
- 最小复现步骤、期望结果、实际结果。
- 脱敏后的错误消息，以及是否能在写开关关闭、无真实账号的环境复现。

**不要上传 `.env`、Cookie、刷新令牌、API key、`data/`、数据库、HAR、登录二维码或未遮挡的账号截图。** 涉及漏洞或凭据泄漏时遵循 [SECURITY.md](SECURITY.md)，不要公开利用细节。

## 本地开发

依赖安装步骤见 README。必须从仓库根目录启动；使用独立 checkout 或临时 `DATA_DIR`，不要接入现有账号数据：

```bash
export BILIBILI_WRITES_ENABLED=false
export DATA_DIR="$(mktemp -d)"
npm run dev
# 另一个终端：npm run dev:web
```

不得在 Review、QA、CI 中打开真实写锁、使用真实凭据或调用付费模型。通过 Fake Bilibili、loopback 假模型服务、临时凭据和 SQLite 验证行为；真正的登录与发送由使用者自行验收。

## 提交修改

1. 保持修改范围聚焦，大的行为变化先通过 Issue 说明目标。
2. 添加针对性的回归，不顺手升级依赖、全仓格式化或重写调度器。
3. TypeScript 使用严格类型与 ESM；后端相对导入保留 `.js` 后缀，共享契约优先放在 `server/model.ts`。
4. SQLite 变更须兼容旧数据，增加迁移 / 重启回归；不能靠清空数据库解决兼容性。
5. 用户可见行为同步 README、详细行为文档和 CHANGELOG；错误表单保留草稿，避免在途响应覆盖新编辑。
6. 不编辑 `dist/` / `build-server/` 产物；不直接修改固定版本 vendor 文件。本地适配放在 `bridge/server.py`，明确上游更新任务才重导入。
7. 新增或升级依赖时，核查锁定版本、canonical 上游 API、许可证与安全影响。

### 不可破坏的约束

- 启动暂停、新频道默认禁用；不绕过登录、验证码、平台权限或风控。
- 跨频道持久去重；发送前持久化 claim、内容、对象和尝试时间，失败也占额度。
- 已尝试或不确定结果不重放；重启 `claimed` → `uncertain`。
- Asia/Shanghai 日界，全局与频道限额同时生效，异步返回后与 claim 前复核最新状态。
- 读取和互动分别退避；成功搜索不能清除互动失败。
- AI 失败关闭，不自动重试、不回退随机；模型不能决定安全边界。
- 可选发送回执和续期元数据异常，不得把已成功发送或有效登录改成失败。

## 检查命令

```bash
export BILIBILI_WRITES_ENABLED=false
npm test
.venv/bin/python -m unittest discover -s tests -p 'test_*.py' -v
npm run lint
npm run build
```

Node 测试不是 Jest / Vitest；Python 回归单独执行。改 bridge 必跑 Python；跨模块行为和共享契约运行全部检查。MCP 子进程测试只枚举 27 个工具，不调用工具。

PR 说明修改原因、测试命令与实际结果、未验证项。不要把 fake 服务回归描述成真实 Bilibili 或模型供应商验收。

## 许可证

原创贡献按 **GPL-3.0-or-later** 提交，见 [LICENSE](LICENSE)。贡献者应有权提交其内容；第三方文件需保留来源、许可与版权声明，不把秘密或不可再分发的素材加入仓库。
