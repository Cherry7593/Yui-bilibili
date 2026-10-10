# Upstream provenance

Source: <https://github.com/adoresever/bilibili-mcp/tree/1521d19d4118bfe23e08ec4c7702991c5f9de0ba>

Pinned commit: `1521d19d4118bfe23e08ec4c7702991c5f9de0ba`.

The selected upstream files are unmodified: `mcp_server.py`, `bili_login.py`, and `LICENSE`. Copyright and MIT license are retained. No credential/session backup was fetched. `scripts/vendor-upstream.mjs` reimports these exact files and verifies their Git blob IDs before writing. Do not invoke the original entry point or login helper; the application and Agent use `bridge/server.py`.

## Inspected upstream paths

- `load_credential` (line 33), `bili_login` (63), `bili_login_check` (114).
- `bili_check_credential` (195) looks up public user information, which does not prove session validity.
- `bili_search` (230) omits publication time from normalized search results.
- `bili_comments` (278) omits reliable pin metadata and catches API exceptions.
- `bili_reply` (471) sends new comments with `rpid=0` (492); root replies set `root` and `parent` (503).

Links to the pinned source: <https://github.com/adoresever/bilibili-mcp/blob/1521d19d4118bfe23e08ec4c7702991c5f9de0ba/mcp_server.py>.

## Local boundary adaptations

`bridge/server.py` imports the pinned source, preserves the schemas of all 27 tools, and replaces selected tool implementations at registration:

- Authenticated self-info validates login, not public UID lookup.
- Latest search includes publication time and IDs for durable filtering/deduplication.
- Root comments retain ordinary/pinned metadata; comment read failures propagate classified risk/auth/API errors instead of disappearing.
- HTTP 403/412 refusals are classified as risk from `NetworkException.status` or the upstream SDK's stringified status, allowing immediate scheduler pause; ordinary HTTP 500 remains an API failure.
- Web QR login no longer uses `QrCodeLogin.check_state`: 17.4.2 parses cookies only from the poll `url`, which can lack them and then yields an empty credential. The bridge sends the SDK's own prepared request (`Api._prepare_request`, same buvid/ticket/headers) through the SDK client, reads cookies from both the response Set-Cookie headers and the `url` query, and atomically replaces the private credential only when SESSDATA, bili_jct and DedeUserID are all present, also keeping `refresh_token` as `ac_time_value`. Otherwise the existing credential is untouched and only received field names are reported. The QR PNG is generated in memory (no temp `qrcode.png`). States distinguish waiting scan / waiting confirm / timeout. The upstream SDK repository is archived; 17.4.2 is its final release.
- `bili_reply` keeps the upstream signature and the exact `get_info` + `send_comment` calls (`rpid=0` new comment; otherwise `root`/`parent` as upstream). On success it also returns the new comment `rpid`, the video cover `pic`, and `view/like/reply/favorite` from the `get_info` it already performed — no extra request. Missing or malformed values only drop that field and never turn a sent comment into a failure.
- `bili_check_credential` loads the private credential including `ac_time_value` (ignored by upstream `load_credential`). At most once per 12 hours per bridge process (re-armed by a new QR login) it calls SDK `check_refresh()`; when Bilibili asks, `refresh()` (including confirm) runs and the new cookie and refresh token are atomically written before the self-info check uses them. Renewal failures keep the current cookie and are reported only as a status. The tool keeps its name and parameters.
- A single lock serializes calls. Write tools require `BILIBILI_WRITES_ENABLED=true`; default false.
- Credentials are loaded from `BILI_CREDENTIAL_FILE`, never supplied to model tool calls. Responses scrub credential keys/values; raw exceptions and SDK diagnostics do not reach application logs or the WebUI.

`requirements.txt` uses `bilibili-api-python==17.4.2` and `mcp>=1.0.0,<2`. The SDK dependency is GPL-3.0-or-later (confirmed from its installed 17.4.2 package metadata and license), even though the selected bilibili-mcp source files are MIT; see `THIRD_PARTY_NOTICES.md`. TypeScript's client connects to the bridge through persistent stdio. Automatic patrol only checks login, searches, reads comments, and posts/replies through `bili_reply`; all other registered tools remain available only for manual Agent use.

## Observed verification and limits

The real MCP SDK subprocess registers exactly 27 tools without any live write calls. Fake Python tests cover confirmed QR persistence, pending confirmation, invalid authentication, and risk propagation. Fake TypeScript runtime checks cover queue-to-reply and immediate risk pause. No real Bilibili writes or real credentials were used.

A live human scan once reached confirmation but the SDK saved an empty credential; that path is fixed as above and live generate + poll returns waiting-scan, but a successful live confirmation after the fix still needs human acceptance. Cookie login remains the fallback. Live login/comment/reply acceptance is left to the account owner; automated checks are not a real-platform acceptance guarantee.
