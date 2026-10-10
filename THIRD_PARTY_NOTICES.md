# 第三方来源与许可证

本项目原创部分采用 **GPL-3.0-or-later**，署名 Chryui。第三方文件与依赖保留各自许可证；根目录 [LICENSE](LICENSE) 不对它们重新授权。

## 仓库内包含的上游源码

| 项目 | 固定版本 | 选入文件 | 许可证 |
| --- | --- | --- | --- |
| [adoresever/bilibili-mcp](https://github.com/adoresever/bilibili-mcp) | `1521d19d4118bfe23e08ec4c7702991c5f9de0ba` | `mcp_server.py`、`bili_login.py`、`LICENSE` | MIT，Copyright (c) 2026 AGI_Ananas |

这些文件位于 `vendor/bilibili-mcp/`，保持上游原样；原始 [MIT LICENSE](vendor/bilibili-mcp/LICENSE) 完整保留。分发其副本或实质部分时须保留版权与许可声明。

本地行为适配放在 `bridge/server.py`；来源、Git blob 校验值的维护方式和适配边界见 [UPSTREAM.md](vendor/bilibili-mcp/UPSTREAM.md) 与 [重导入脚本](scripts/vendor-upstream.mjs)。该脚本只下载指定公开源码，不下载凭据；不要在一般开发任务中自动运行它。

## 运行时依赖

特别注意直接依赖 **[`bilibili-api-python==17.4.2`](https://github.com/Nemo2011/bilibili-api)** 的许可为 **GPL-3.0-or-later**，不是 MIT。许可已由该版本安装包的 `License` 元数据和 `licenses/LICENSE` 正文核对。项目原创部分选择 GPL-3.0-or-later 与此一致。

其他依赖按安装版本携带的许可使用，例如 Python MCP SDK 使用 MIT，aiohttp 及其内含第三方代码有 Apache-2.0 / MIT 声明；Node 依赖的许可元数据可在 `package-lock.json` 和对应安装包中核查。此处不是全部传递依赖的法律审计清单。

- Node 依赖版本以 `package-lock.json` 为准。
- Python 的 `bilibili-api-python` 固定为 17.4.2，其余依赖目前是范围约束；不同安装时间可能得到不同版本。制作可再分发的发行物前，应记录实际解析版本和许可证。
- 打包 SDK、Node / Python 依赖、容器或桌面程序时，必须另行核查并随发行物提供适用的许可证、版权声明及 GPL 要求的对应源码 / 提供方式；不能只附一份根目录许可证。
- 仅发布源代码不等于已经完成未来所有打包形式的许可证合规审查。商业再分发或存在疑问时请寻求专业法律意见。

## 视觉参考

界面布局参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的侧栏、排版、留白与细边框，组件和样式由本项目自行实现，未复制其代码或图片资源。

Bilibili 和各模型服务商的名称仅用于说明兼容对象，不代表授权、合作或官方背书。
