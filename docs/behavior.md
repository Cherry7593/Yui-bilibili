# 详细行为与边界

本页描述当前实现；安装和首次使用见 [README](../README.md)。安全默认值与限额不能保证账号安全，也不替代平台规则。

## 调度、额度与去重

```text
关键词轮询 → 日期限定播放量排序搜索 → 精确时间 / 播放量过滤 → 全局 BV / AV 去重
  → 概率分支或一次 AI 判断 → 持久化互动队列 → 随机等待
  → 抽模板或 AI 撰写 → 当前状态复核 → 持久化 claim → 发送 → 记录结果
```

Discovery 与 Interaction Queue 分开存储，删除频道不会删除全局发现记录。

- 默认每频道搜索 30–90 分钟一次、最近 72 小时、最低播放量留空按 1000 执行；每日搜索 20 / 评论 5 / 回复 3；跳过 / 评论 / 回复概率 70 / 20 / 10。
- 搜索固定为「播放量降序（click）+ 原生日期筛选」第一页最多 50 条，再由本地按精确时间窗与播放量上下限过滤；资格在发现前、AI 入队后、队列执行与发送前按最新配置复核。被热度过滤的视频不写发现记录、不占去重。
- 全局每日搜索 200 / 评论 10 / 回复 5 / 总互动 15；两次互动等待 5–30 分钟。
- 全局和频道额度同时生效，日界固定为 **Asia/Shanghai**，不依赖宿主机时区。发送额度按尝试计数，失败也占额度。
- 所有异步准备完成后复核最新运行状态；claim 前再检查登录、频道、限额、最短间隔、模板和 AI 模式。调高等待下限后，尚未 claim 的队列继续等待，不提前占额度。
- 每次启动保持暂停；暂停等待在途请求完成，不启动下一次互动。已发送到网络的请求不能撤回。
- 读取与互动有独立失败计数和指数退避，退避从 1 分钟增加到最多 1 小时，任一达到默认 3 次连续失败即暂停。成功读取不会清除互动失败。
- 未登录、验证码、风控和 HTTP 403/412 失败关闭并暂停；桥接层也识别 SDK 被上游转成字符串的风险错误。

### 防重复发送

网络发送前，将 claim、实际发送文本、已知回复对象和尝试时间一并持久化。已尝试的视频无论成功、失败、超时还是进程崩溃，都不自动重发。

启动时将未确认的 `claimed` 转为 `uncertain`，在同一事务内补记不确定活动。它不代表发送失败或成功；本项目选择宁可漏发，不重复发。旧 SQLite 会补齐 `target`、`target_likes`、`target_content`、`receipt` 等字段；旧版本没有存下来的回复对象、原评论正文和回执无法追溯。

## 模板与回复对象

关闭 AI 判断时，保持概率分流与发送前抽模板。模板绑定频道，评论和回复分别管理；没有有效模板或只能选到与上一条完全相同的发送文本时跳过。

`bili_reply` 的 `rpid=0` 表示视频评论，`rpid>0` 回复普通根评论。`bili_comments` 读取热度排序第一页，并为每条评论带回点赞数 `like`；缺失时为 `null`，Node 侧整条丢弃，不按 0 赞猜测。

自动回复不选择置顶、非普通、本账号或缺少可靠元数据的对象，内容须通过与 AI 撰写相同的保守词汇检查（并非语义理解）；点赞数须达到频道「回复评论最低点赞数」（默认 50，含边界，`0` 为不限）。合格评论按点赞降序：模板模式在其中随机抽一条，AI 撰写模式把 `rpid`、内容和 `like` 交给模型从中选择。claim 时与回复对象一起保存该评论读取时的点赞数（`target_likes`）和正文（`target_content`，已受上述词汇检查的 300 字上限约束），活动记录显示为「→ @用户（N 赞）」并在其下方完整引用原评论，总览卡片显示为「回复 @用户 · N 赞」并在发出的回复上方引用原评论（超过 3 行截断，悬停显示全文；触屏设备无法悬停，直接显示全文）；视频评论和旧记录不显示。没有合格评论时跳过且不重放；claim 前按最新频道配置复核目标评论是否仍达到门槛。旧频道配置缺少该字段时按 50 解释。

## AI 判断与撰写

频道配置：`aiJudgment` 默认关闭；`aiInteraction` 默认 `reply`（回复高赞评论），可选 `comment`（评论视频），旧频道缺此字段时按 `reply` 解释；`writingMode` 默认 `template`，可选 `ai`；`style` 最多 300 字符，仅用于 AI 撰写。关闭 AI 判断时写法和风格不生效。

### 模型配置与连接检查

一份全局配置保存在 SQLite `app_settings`，不再读取旧 `YUI_AI_*` 环境变量。模型 key 是本机私有明文，不在状态 API、活动或日志中回显。

- 根地址接受 HTTP / HTTPS，去掉末尾斜杠后只补一次 `/chat/completions`；不强插 `/v1`，拒绝 URL 中的账号密码、查询参数和片段。除本机假服务外应使用 HTTPS，以免 key 通过明文网络传输。
- 地址、模型名留空可清空；key 留空保留旧值，输入新值替换，勾选清空后删除旧 key。
- 表单保存期间禁用相关字段，避免迟到响应覆盖新输入；成功后按共用 schema 去除地址和模型名首尾空白并清空密码框，失败保留草稿。
- 连接检查使用已保存配置，仅发 `model` / `messages` 的最短请求；不调用 Bilibili、不写巡逻 Activity，不回传供应商正文。检查会产生服务商网络请求，可能计费。

### 配置变化的失败关闭

- 保存开启 AI 的频道前检查根地址、模型名和 key；缺项返回 **HTTP 409**，整次保存不创建、更新或禁用频道，不改变队列、全局设置或 Activity。
- 启动检查所有打开 AI 判断的频道（包括暂停频道）；缺配置则保持总调度器暂停。
- 已启用 AI 的频道运行中丢失配置时，在空闲 / 退避、异步返回和 claim 前复核；禁用该频道并跳过其队列，其他非 AI 频道继续运行。补齐后需手动重新启用。
- 成功切换 AI 判断开关时，同一 SQLite 事务将该频道旧待发队列标为 `skipped`，保留发现去重，不重新判断旧视频。被拒绝的保存不触发取消。

### 模型输入与输出

发现过滤和全局去重之后，对每个新视频最多判断一次。模型得到标题、UP 主、关键词和频道名，不读取字幕、弹幕或视频。返回 `action` / `reason`，`action` 只表示跳过（`skip` / `uncertain`）或互动（`interact`；旧格式 `comment` / `reply` 同样按互动处理），模型不选择互动方式。入队动作取频道当前的 `aiInteraction`；队列执行与 claim 前也按频道当前的互动方式执行，切换后已排队的 AI 决定随之改为评论或回复，并以实际动作计入额度。回复模式下没有合格评论时跳过，不回退为视频评论。不确定、失败或跳过仍持久去重，不补判、不回退概率分流。

正文在队列到期并通过初次额度和间隔检查之后才决定：

- 固定模板避开上一条完全相同的文本。
- AI 撰写不要求模板；回复时从安全候选选择 rpid。候选需普通、非置顶、有效 rpid、明确 UID 且不是自己，并通过本地文本检查；模型只收到候选 rpid 和正文，不收到 UID。
- 输出正文不合格、选择候选外对象、与上一条相同或无法选择时终结为 `skipped`；不重试、不留下 claim。

巡逻 Chat Completions 使用 `model` / `messages`、`temperature: 0.2`、`max_tokens: 4096`、`response_format: {"type":"json_object"}`；不发送供应商专用 `thinking` 字段。只读取 `choices[0].message.content`，忽略 `reasoning_content`。服务商与具体模型必须支持 JSON mode。

4096 是有界工程预算，不是短评长度或成功保证；有些模型将思考 token 计入该预算。供应商语义需按当前文档核查，参考 [DeepSeek JSON mode](https://api-docs.deepseek.com/guides/json_mode)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion)、[思考模式](https://api-docs.deepseek.com/guides/thinking_mode) 和 [硅基流动 Chat Completions](https://docs.siliconflow.cn/docs/api/chat-completions-post)。

- 单次超时 **12 秒**，包括读响应；上限 **16 KiB**，不重试、不跟随重定向。
- 原因最多 80、正文最多 120 个 UTF-16 字符；`finish_reason` 非 `stop` 即跳过。
- 非 JSON、截断、无效 action / rpid、撰写对象多余字段均失败关闭；判断对象只取 action / reason，丢弃模型附带的草稿等字段。
- 提示词将标题、风格和评论视为不可信数据；模型没有额度、暂停、间隔、claim 或写锁权限。
- 本地 NFKC 词法检查拒绝控制 / 隐藏字符、链接 / 域名 / IP、邮箱、常见联系方式、广告、明显辱骂、危险内容和疑似凭据；检查原始输出及 JSON 解码后的字符串，阻断本次 key 的转义回显。规则保守但不是完整语义审核。

### 活动中的判断原因

原因仅本机显示，不发往 Bilibili，因此不使用对外发文的词法检查，「无广告」之类的措辞不会改变判断。仍拒绝回显本次 key 或疑似凭据（整次判断失败关闭），并去掉控制 / 隐藏字符；页面以纯文本显示。模型错误记录固定脱敏原因：HTTP 状态、超限、非 JSON、结构不符、未正常结束、空内容、疑似凭据、格式不符、超时或连接失败，不记录供应商正文或被拒文本。

## 登录保持与续期

推荐给本工具独立登录。若与日常浏览器共用同一登录会话，一方续期后可能让另一方失效。

- 扫码确认后同时读取 Set-Cookie 与轮询 URL；仅 `SESSDATA`、`bili_jct`、`DedeUserID` 齐全且 UID 合格时原子替换凭证，缺项保留原登录。二维码在内存生成。
- 扫码自动保存 `refresh_token` 为 `ac_time_value`；Cookie 登录可选填写该刷新令牌。格式无效时返回 400，不暂停或改动原登录。
- 登录有效性检查使用登录用户自身端点，而不是公开用户信息。
- 有刷新令牌时，桥接进程首次 / 新登录后、之后每 12 小时最多查询一次是否需刷新；需要时调用 SDK `check_refresh()` / `refresh()` 并原子保存新凭证。全局锁串行化续期与工具调用。
- 续期失败保留当前 Cookie，之后重试；状态只有 `current` / `renewed` / `failed` / `unsupported` 与时间，不含秘密。
- 调度器暂停时也在启动后及每 12 小时检查登录；检查失败 5 分钟后重试，但不会自动启动巡逻。
- 退出或重新登录先暂停并关闭旧 MCP 会话。强制下线、改密码和风控可能需要重新登录，不能保证自动续期一直成功。

扫码与续期依赖非官方 SDK 17.4.2 及平台接口；假服务回归不是真人确认或平台可用性保证。

## 总览摘要与热力图

总览摘要的数字都来自活动记录（不清理，因此为全部历史）：累计发现 / 评论 / 回复 / 跳过 / 失败，右上角的「今日 +N」与原先的今日计数相同。热力图按 Asia/Shanghai 日界统计最近 53 周（周一为每列第一天）每日发送成功的评论与回复，可切换互动 / 评论 / 回复；颜色按窗口内单日最大值分四档。鼠标进入格子立即在上方显示提示框（日期与星期、当前指标、评论 / 回复数），靠近边缘时收在热力图内；格子本身无选中样式，滚动或移出时隐藏。

## 最近评论与回执

总览只列最近 10 条 `succeeded` 评论 / 回复，不展示失败、不确定、排队或跳过。卡片含实际发送内容、已知回复对象（含原评论正文）和发现信息。

发送时已有的视频信息及返回响应提供封面、新 rpid 和播放 / 点赞 / 评论 / 收藏数据，不额外请求 Bilibili。可选回执字段异常只丢弃该字段，不将已成功发送判成失败。封面只接受 `*.hdslb.com` 并转换为 HTTPS，以 no-referrer 加载；有 rpid 时链接加 `#reply<rpid>`。旧记录缺回执时显示占位封面和发现时播放量，只链接到视频。

失败尝试和不确定结果可在活动页查看保存的发送内容、回复对象、原评论正文及脱敏原因。它们同样属于本机私有运行数据。

## Agent / MCP

Agent 使用 `bridge/server.py`，不要运行 vendored 原始入口或登录脚本。示例路径需换成自己的隔离 checkout，不要指向日常账号数据：

```json
{
  "mcpServers": {
    "yui-bilibili": {
      "command": "/your/isolated/checkout/.venv/bin/python",
      "args": ["/your/isolated/checkout/bridge/server.py"],
      "env": {
        "BILI_CREDENTIAL_FILE": "/your/isolated/checkout/data/config/bili_credential.json",
        "BILIBILI_WRITES_ENABLED": "false"
      }
    }
  }
}
```

注册工具如下；WebUI `/api/tools` 可检查实际列表：

`bili_login`、`bili_login_check`、`bili_check_credential`、`bili_search`、`bili_comments`、`bili_subtitle`、`bili_danmaku`、`bili_video_info`、`bili_reply`、`bili_crawl`、`bili_send_dynamic`、`bili_upload_video`、`bili_upload_video_multi`、`bili_send_opus`、`bili_video_zones`、`bili_hot_videos`、`bili_hot_buzzwords`、`bili_weekly_hot`、`bili_rank`、`bili_user_info`、`bili_user_videos`、`bili_favorite_lists`、`bili_favorite_content`、`bili_send_message`、`bili_unread_messages`、`bili_received_replies`、`bili_received_at_and_likes`。

自动队列仅使用 `bili_check_credential`、`bili_search`、`bili_comments`、`bili_reply`。其他工具用于手动 Agent；**手动调用不经过巡逻额度和队列**，所有写工具仍受桥接写开关约束。不要把启用真实写操作的 MCP 服务交给不可信 Agent。
