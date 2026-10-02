# gaia-inspection-oversight-ui（门店督导 · 督导端界面包）

订单词：**门店督导** ｜ 承担能力词（逐字）：**巡店判断回放看板**、**证据挂图卡片**、**立即扫描按钮**、**模型调用日志面板**
**本文与《界面实现说明（画面级）》屏 B 与 §三 逐条对齐**（内容/交互/文案以那份为准）。

## 一、挂载点（最终决定，已同步总工程师）

| 面 | 挂载 | 为什么 |
|---|---|---|
| 屏 B（巡店判断回放看板 + 证据挂图卡片 + 立即扫描按钮 + 动作行） | **不遮挡的右侧全高面板**（`shell.overlay` 里挂一个 `position:absolute; right:0` 的 panel，宽 `min(1080px, 82vw)`，**没有遮罩层**） | 说明 §二 要求"右栏完整展开、不得横向滚动"；`rightbar` 放不下两栏结构。说明 §四 6 只禁"点开遮窗、关了才能继续"的**全屏浮层**——本面板不遮会话（左侧照常可读可操作），会话里点一下就能继续用 |
| 模型调用日志 | **① 同一面板内的独立一等 tab（一步可点）** + **② 右侧栏独立 tab** + **③ 会话 header 独立按钮 `📜 模型调用日志`** | 说明 §三 要求"督导端顶部独立标签/浮层，一步可点，不埋在看板分区里"——上面三个入口都是一步可点，且日志**不是**看板里的一个小分区 |
| 视图标签（店长端/督导端） | 输入区那枚常驻控件（`conversation.input.dock`，切面板时始终可见） | 面板会占住右侧，视图切换必须留在看得见的地方 |
| 立即扫描 | 面板顶栏 + 会话 header（各一枚） | 与真定时器互为备份；现场用它时要能一眼找到 |

## 二、屏 B 结构（左右两栏）

- **顶栏**：`今日 N 条 · 待你判断 M 条 · 逾期 K 条`（数字动态）+ [⏱ 立即扫描] [刷新] [模型调用日志] [关闭]。
- **左栏**：筛选 `待复核 · 逾期 · 全部` + 倒序列表；每行 = 缩略图 + 编号（`#ab12`）+ 门店 + 时间 + 状态；**逾期条目整条标红并显示「已升级」**；点击切换右侧详情。
- **右栏（详情）**：
  - `提交 #ab12 · 示例门店 A · 快餐档口` + 状态徽章；
  - **门店原话**（引用块）；
  - 状态行：状态 / 提交时间 / 截止 / 模型调用次数 / 来源；
  - **「为什么查这几项（本次动态决定）」浅底块**（蓝底、与详情区分；用后端 `reasons`，缺失时退到检查项的 `why`，都没有就如实说"后端未给理由文本"）；
  - **检查项卡**：项名 · **置信度（文字 高/中/低，不用百分比）** · 状态徽章 · 「判断 / 依据 / 整改要求与截止」· **[回看原图]** · **动作行 `通过` / `退回并说明` / `催办`**；
  - **动作记录**（时间 · 操作者 · 结果）：后端 `actions` 时间线 + 本次界面动作；后端口未就绪时该条标 **⚠ 未同步到后端**（不假装成功）。
- **三态**：空 → `当前没有待复核`（+ 引导句）；加载 → 列表骨架；失败 → 该项标「分析失败：＜原因＞」且可重试，**不显示假结果**。

## 三、证据「回看原图」（证据挂图卡片）—— 面板内放大区，不是浮层

点 `回看原图` 在**同一个面板的检查项卡里展开**（说明 §四 6：证据不要用全屏浮层）：

| 后端给的数据 | 界面表现 |
|---|---|
| `hasBoxes === true` / `boxes[]` 非空（`boxesUnit:'ratio'`，0–1 归一化） | 原图上**画框** + **框心标点**；旁边标注「已在原图上框出 N 处证据区域」+ 框的归一化数值。（此时后端 `fallbackPoint` 恒为 `null`） |
| `boxes` 为空、`fallbackPoint {x,y,unit:'ratio',text,source}` 非 null | 原图上**标点**（不画框）+ 旁边写依据文字：「模型未给区域框，已在图上标出定位点（text）」 |
| `boxes` 与 `fallbackPoint` **都为空**（后端明确返回 `null` = **模型确实无法定位**，不是"框缺失"） | **图上什么都不画**（绝不画空框），旁写明「模型确实无法定位：本次降级为图上不标任何框或点、只写依据文字」，并把依据 / 整改要求 / 截止列出来 |
| 非法框（零尺寸、越界、非数字） | 一律丢弃（不画空框） |

依据文字、整改要求、截止始终与图同屏（取自 `evidence` 路由：`reason` / `suggestion` / `dueAt`）。

## 四、模型调用日志面板

- 列逐字：`时间 / 模型 / 提示词版本 / 提交编号 / 请求摘要 / 响应摘要 / 耗时`。
- **脱敏红线**：前端只认一张**业务摘要白名单**字段（`callId/ts/provider/model/kind/promptVersion/inspectionId/storeId/requestSummary/responseSummary/latencyMs/usage/status/errorCode`）——**即便后端误带 API Key / Authorization 一类字段，也不读取、不透传、不展示**（自测里有一条断言 DOM 中不出现这类字段名）。
- 空态逐字：`暂无调用记录`。
- 刷新策略：打开时拉一次 + 手动刷新 + 可选「每 5 秒自动刷新」（经总工程师批准）。
- `promptVersion` / `requestSummary` / `responseSummary` 后端暂未提供时显示 `—`（提示词版本一列退为调用类型并标「（类型）」），并在表下如实说明有几条缺失、口径需后端补齐——**前端不代填、不臆造**。

## 五、取数（全部只读，前端不造数、不改本地状态；字段口径以 `be` 最终实现为准）

| 用途 | 接口 |
|---|---|
| 看板全量 | `GET /api/gaia-inspection/snapshot`（轮询 2s；失败显示「看板数据不可用 · 上次成功 HH:MM」且**不清空已有数据**） |
| 证据（回看原图） | `GET /api/gaia-inspection/evidence?id=<findingId>`：`data.hasBoxes` / `data.boxes[]`（ratio 0–1）/ `data.fallbackPoint {x,y,unit:'ratio',source,text}`（**有框时为 null**；无框且模型给了点 → 给点；**确实定位不了也为 null**）/ `data.photo {photoId, originalUrl, thumbUrl, width, height}` |
| 图片 | **只消费后端拼好的 URL**：`snapshot.findings[].thumbUrl/originalUrl`、`evidence.data.photo.thumbUrl/originalUrl`（`/api/gaia-inspection/photo?id=<16位hex>&kind=thumb\|original`）。**前端不拼 `?path=`**（该口已不存在） |
| 立即扫描 | `POST /api/gaia-inspection/scan`，体 `{reason:'manual'}` |
| 调用日志 | `GET /api/gaia-inspection/model-calls`：`calls[{callId, ts, provider, model, kind, promptVersion, storeId, inspectionId, latencyMs, usage, status, errorCode, requestSummary, responseSummary, tsEnd}]` |
| 动作行写记录 | `POST /api/gaia-inspection/review`，体 `{inspectionId, findingId, action:'通过'\|'退回并说明'\|'催办', reason?}` → `{ok, action:{id,type,target,createdAt,reason}}`（**待 `be` 补 HTTP 口；见七**） |

## 六、宿主半（`lib/index.js`）做什么

不重复实现后端语义（**不注册任何业务路由**），只提供只读自检口
`GET /api/gaia-inspection-oversight-ui/selfcheck`：回报四个能力词、依赖的上游口清单（含标记 `needs-backend` 的 `review-action`）、以及本地视图通道是否存在。`inject` 为 `['webServer']`；没有 `webServer` 时只 `console.warn`，不抛错。

## 七、与后端（be）已就位的口径（前端按此实现，均已在自测里断言）

1. **督导动作口已就位**：`POST /api/gaia-inspection/review`（be 同时注册了 `/review-action`，同一 handler）。
   - 前端发：`{inspectionId, findingId, action, operator:'督导（演示视图）', reason?, at}`，`action ∈ '通过' | '退回并说明' | '催办'`（be 也认 `approve|reject|remind`）。
   - 前端读回执：`action.actionCode`（`review_approve|review_reject|review_remind`）、`action.result`（通过/退回/已催办）、`action.actorName`、`data.inspectionStatus`、`data.dueAt` → 一起写进详情的**动作记录**（时间 · 操作者 · 结果），并刷新快照。
   - 失败码不当成功：`BAD_BODY`（两 id 都没给，前端也先拦）/ `REASON_REQUIRED`（**退回没写原因：前端弹窗已设必填**，也提示后端口径）/ `BAD_ACTION` / `INSPECTION_NOT_FOUND` / `FINDING_NOT_FOUND` —— 原样显示后端错误并把该条标 **⚠ 未同步到后端**。
2. **证据降级字段已就位**：`hasBoxes` / `boxes[]`(ratio) / `fallbackPoint{x,y,unit:'ratio',text,source}`（有框恒 `null`；`hasBoxes:false` 且有值 → 画点 + 点旁写 `text`；两者皆空 → 只写文字，**绝不画空框**）。
3. **日志字段已就位**：每条都有 `promptVersion` / `requestSummary` / `responseSummary`（实测 `vision-judge-v2` / `checklist-v1`）。
   - **失败调用**（`status:'error'`）的 `responseSummary` 本来就是 `null`（没有响应）→ 列里显示「（本次无响应）」，**不计入"后端缺字段"告警**（告警只统计"该给却没给"的条数）。
   - **脱敏**：前端只认业务摘要白名单；be 写入前也抹掉了 `sk-…` / `Bearer …` / `authorization:` / `x-api-key:`（自测断言：拉平日志 DOM 正则不命中这些）。
4. **置信度已就位且由模型给出**：`findings[].confidence`（高/中/低）+ `confidenceSource`（`'model'` | `'missing'`）。
   - `'model'` → 卡片直接显示「置信度 高」（悬停提示"模型置信度：高"）；
   - `'missing'` / 空值 → 显示「置信度 未标注」，**不再用 severity 折算**（避免拿严重度冒充置信度）；
   - 旧数据（字段整个不存在）才按 `severity` 折算，并**在卡上标注来源**。
5. **图片**：`/photo?id=<photoId>&kind=thumb|original`（`photoId` 从 `findings[].photoId` 或 `evidence.data.photo.photoId` 拿）——前端**只消费 URL**（`thumbUrl`/`originalUrl`），**不自己拼路径**。
6. `snapshot.inspections[].findings[]` 与 `evidence.data` 现在都带 `boxesUnit` / `hasBoxes` / `confidence` 语义；`actions[]` 带 `actor / actorIsHuman / result / actionCode / source`（动作记录显示"谁、何时、什么结果"已用上）。

## 八、装载契约与自测

- `package.json` → `exports["./client"] = "./client/client.js"`（文件真实存在）
- `dsh.client = { "platform": "web" }`
- `dsh.bundle.patch = "./cordis.patch.yml"`（文件存在且含 `- insert:`，行 id 唯一）
- 零第三方 `dependencies`；client 半是纯浏览器 ESM

```
node test/selftest.mjs
```

覆盖：宿主半 import / 自检路由；装载契约四项；**主面板挂 `shell.overlay` 且证据不再挂 overlay**（说明 §四 6 的回归断言）；面板渲染（统计行、筛选三档、列表编号/门店/时间、逾期标红+已升级、门店原话、「为什么查这几项」、检查项卡、置信度文字、动作行、动作时间线）；「回看原图」展开与降级三分支（有框 / `hasBoxes:false`+有点 / 两者皆空）+ 非法框丢弃；日志 7 列逐字、空态文案、脱敏白名单与 DOM 无凭据字段；立即扫描真 POST `/scan` 且回执按后端返回值渲染；**图片一律消费后端拼好的 `?id=` URL**（不再拼 `?path=`）；动作行 POST `/api/gaia-inspection/review`、`退回并说明` 缺原因被拦、后端口缺失时标「未同步」；`manifest.keywords` 逐字。

**本轮对齐 `be` 最终字段的改动（2026-10-02 复核后）**：① 图片只消费 `thumbUrl` / `originalUrl`（`?id=`），移除"包内拼 `?path=`"的做法（该口已不存在）；② 证据降级改用 `hasBoxes` + `fallbackPoint`（含 `unit:'ratio'`、`source`，**有框时为 null**、**定位不了也为 null**）；③ 日志三列（`promptVersion`/`requestSummary`/`responseSummary`）已按后端就绪字段展示；④ 动作行改为调 `POST /api/gaia-inspection/review`（动作值为中文 `通过`/`退回并说明`/`催办`，`退回并说明` 前端就要求填原因）。

## 九、明确不做

账号与权限、门店增删改、大屏播放页、参数配置面板（阈值/周期表单）、日志导出与成本估算、图片标注工具、响应式、皮肤/主题/品牌色（美术层）。

## 十、依赖与来源

- 零第三方运行时依赖；`peerDependencies` 只列宿主提供的 `@deepseek-ai/dsh-web-server`。
- 挂载与注册写法（`sidebarRightTabs.register` + `sidebar.right.pane.tab` keyed 两步注册、`shell.overlay` 注册）参照同机既有交付物 `科研综述自审\fe\gaia-selfaudit-board` 的**写法**；本包代码与文案为**本单原创**（逐字文案来自操作者下发的《界面实现说明（画面级）》）。档位 D/C 的判定依据来自盖亚技能 `frontend-backend-split`（只摘录 Apple Human Interface Guidelines 的可迁移原则，转引自 `FrancoStino/opencode-skills-collection` 的 `hig-patterns`，MIT），**未复制其文本或代码**。
- 许可：MIT。
