# gaia-inspection-core — 巡店数据落库 · 模型调用日志留存 · 检查项动态生成

> 订单词：**门店督导** ｜ 承担能力词（逐字）：`巡店数据落库`、`模型调用日志留存`、`检查项动态生成`
> 包名：`@gaia/dsh-inspection-core` ｜ 形态：插件（host 半，无 client 半，不会白屏）

## 1. 职责

1. **巡店数据落库**：六张表 `stores / inspections / findings / evidences / actions / model_calls` 的建表与读写，落本地库，进程重启后仍可读。
2. **模型调用日志留存**：每次模型调用**在调用发生的那一刻**写一条真实记录；调用结束后补耗时 / usage / 终态（同一条 `callId` 的 patch）。**不许事后补写、不许被演示重置清空。**
3. **检查项动态生成**：由模型按**本次输入**决定要查哪几项，并给出「本次为什么查这几项」的理由列表。代码里**没有固定检查项清单**，也没有"生成失败就套预设清单"的分支。

## 2. 工具（5 个；`manifest.json` 的 `tools` 与注册名逐字一致）

| 工具名 | 用途 |
|---|---|
| `inspection_record_save` | 写入业务表（`stores/inspections/findings/evidences/actions` 五张之一）。**`model_calls` 不允许手工写**，它只由模型调用日志端口在调用发生时刻写入。 |
| `inspection_query` | 读表（按 id 或字段等值过滤），默认倒序取 50 条、上限 500。只读。 |
| `inspection_counts` | 六张表行数 + 各自 JSONL 文件绝对路径（核对"真的落库了、重启后还在"）。 |
| `inspection_generate_checklist` | 检查项动态生成（真模型调用）。模型不可用 / 输出不合法 → 可诊断错误，不套预设清单。 |
| `inspection_model_calls` | 读模型调用日志（可按 `kind` / `storeId` 过滤）。只读；重置不清它。 |

## 3. 路由（本包是唯一的 HTTP 出口）

### 3.1 契约三条（**纯只读**，前端按此消费）

| 路由 | 用途 | 失败降级 |
|---|---|---|
| `GET /api/gaia-inspection/snapshot` | 看板全量快照 | 槽位缺失 → `{ok:false,degraded:true,error:{code:'DEPENDENCY_MISSING'}}`，前端保留上次数据 |
| `GET /api/gaia-inspection/evidence?id=<findingId>` | 单条证据 | 无此条 → `{ok:true,data:null,summary:'未找到该证据'}`（**200，不报错**） |
| `GET /api/gaia-inspection/model-calls` | 模型调用日志 | 槽位缺失 → 同上结构化错误 |

**字段清单（最终口径，逐字）**

- `/snapshot`：`ok, ts, stores[], inspections[], actions[], counts{}, tableCounts{}, offline{offline,source,since}, pendingQueue{pending,judged,items[]}, degraded, modelCallsTotal`
  - `stores[]`：`storeId, name, format, businessHours, checkDimensions[], focusNote, seats, sample`
  - `inspections[]`：`id, storeId, storeName, storeType, note, status, source, demo, createdAt, dueAt, overdue, escalated, items[], reasons, unreadable[], findings[], actions[]`
    - `findings[]`：`findingId, itemName, severity, confidence, confidenceSource, reason, suggestion, dueAt, status, boxes[], boxesUnit('ratio'), evidenceId, photoId, thumbUrl, originalUrl`
    - `actions[]`：`id, type, actionCode, target, createdAt, reason, actor, actorIsHuman, result, dueAt, source`
  - `counts{}`：`检查单, 判断, 证据, 动作, 待整改, 逾期, 已升级`（另 `tableCounts` 给六张表的行数）
- `/evidence`：`ok, data{findingId, inspectionId, storeId, itemName, severity, confidence, confidenceSource, reason, suggestion, dueAt, status, boxes[], boxesUnit, hasBoxes, fallbackPoint{x,y,unit,text,photoIndex,source}, fallbackPointUnit, fallbackPointSource, photo{photoId,originalUrl,thumbUrl,width,height}, evidence{id,capturedAt,photoIndex}, unreadable[], source}, summary`
- `/model-calls`：`ok, count, calls[{callId, ts, provider, model, kind, promptVersion, storeId, inspectionId, latencyMs, usage, status, errorCode, requestSummary, responseSummary, tsEnd}], degraded`

**图片一律给 URL（服务端拼好），前端只消费 URL、不自己拼**：`/api/gaia-inspection/photo?id=<photoId>&kind=thumb|original`。
**对外返回体里不出现任何本地文件路径**（绝对路径只出现在工具返回的 `data`/`artifacts` 里，供本机核对）。

**圈框与降级口径**：`boxes[{x,y,w,h}]` 一律是**归一化比例 0-1**（`boxesUnit:'ratio'`）。
- `hasBoxes:true` → 用 `boxes` 画框，`fallbackPoint` 必为 `null`；
- `hasBoxes:false` 且 `fallbackPoint:{x,y,unit:'ratio',text:'…'}` → 界面「图上标点 + 旁边写依据文字」（`text` 就是要写在点旁的那句话）；
- `hasBoxes:false` 且 `fallbackPoint:null` → **模型确实无法定位**（不是"框缺失"），界面只显示文字依据。
- **不许出现空框**：前端据 `hasBoxes` 决定画框 / 画点 / 只写字。

**置信度口径**：`confidence` 是**模型自己给的文字把握**（`高/中/低`），与 `severity`（问题有多严重）不是一回事；模型没给时 `confidence:null` + `confidenceSource:'missing'`，前端据此决定是否展示（**不要拿 severity 折算后冒充模型置信度**）。

### 3.2 三条额外口（**总工程师已拍板批准**，非契约；前端按钮必需）

本机客户端插件侧**没有**"调用宿主工具"的 API（全量检索 `resources\runtime\dsh\node_modules\@deepseek-ai\` 只在 `dsh-mcp-client` 内部命中一处 `callTool`），所以「提交自查」与「立即扫描」两个按钮只能走 HTTP。为此补三条口：

| 路由 | 用途 | 安全约束 |
|---|---|---|
| `POST /api/gaia-inspection/submit` | **固定动作转发**到 `gaia-inspection-capture` 的提交口 | 不接收工具名/参数，不做通用工具代理；body 上限 16MB，单张照片解码后 ≤2MB |
| `POST /api/gaia-inspection/scan` | **固定动作转发**到 `gaia-inspection-action` 的真扫描 | 同上，`{reason:'manual'}` |
| `GET /api/gaia-inspection/photo?id=<photoId>&kind=thumb\|original` | 读图（只读） | **按库内 16 位十六进制 id 取，不接受任意路径**；只在数据根的 `photos`/`thumbs` 两个目录内按 `<id>.<ext>` 查找；`realpath` 解符号链接后仍须落在该目录内；被拒只回结构化错误码，**不回真实路径** |
| `POST /api/gaia-inspection/review`（别名 `POST /api/gaia-inspection/review-action`） | **固定动作转发**到 `gaia-inspection-action` 的 `review`（督导三态动作：通过 / 退回并说明 / 催办） | body `{inspectionId?, findingId?, action:'通过'\|'退回并说明'\|'催办'（也接受 approve/reject/remind）, reason?, newDueHours?, operator?/actor?, at?}`；`action` 非法 → `BAD_ACTION`；退回缺 `reason` → `REASON_REQUIRED`；两个 id 都不给 → `BAD_BODY`；只给 `findingId` 时反查所属检查单 |
| `GET /api/gaia-inspection/sample-photo?key=issue\|clean\|unreadable` | 读一张**合成演示样例**（画面级「载入示例」按钮填表用，只读） | 返回 `{ok, data:{key, name, mediaType, width, height, dataUrl, label, notice}}`；`dataUrl` 是 `data:image/png;base64,…`；**不含任何判断结论**（提交后由真模型判读）；`label` 恒含「非真实门店照片」 |

**为什么会有后面这三条（存在原因，供事后复核）**：本机客户端插件侧**没有**"调用宿主工具"的 API（全量检索 `resources\runtime\dsh\node_modules\@deepseek-ai\` 只在 `dsh-mcp-client` 内部命中一处 `callTool`），所以「提交自查」「立即扫描」「督导动作行」「载入示例」这些**浏览器侧按钮**只能走 HTTP。它们全部是**固定动作转发**（不接受工具名、不接受任意参数透传、没有通用代理），并统一回结构化回执；`/review` 与 `/review-action` 是同一个 handler 的两个路径别名（前端与总工程师各自命名）。

三条口回执统一为 `{ok, runId, status, summary, data, artifacts, traceRef, error}`；`/review` 额外在**顶层**给一个 `action:{id,type,actionCode,target,createdAt,reason,actor,actorName,actorIsHuman,result}` 便于前端直接取。

## 4. 存储（本地库）

- 根目录：`GAIA_INSPECTION_DATA`（显式指定）→ 否则 `$DSH_HOME/gaia-inspection` → 否则 `<cwd>/gaia-inspection-data`。
- 形态：每表一个**追加式 JSONL**（`db/<表>.jsonl`，行是 `{op:'put'|'patch'|'del', ...}`），启动时回放成内存索引 → **重启后可读、不丢历史**。零第三方依赖，只用 `node:` 内置模块。
- 空架说明：首次启动时所有表都是空的（`counts` 全 0）；只有 `stores` 会在 `gaia-inspection-registry` 就位后被播种 2 家示例门店。空表不是错误。

## 5. 模型调用与提示词版本

- 一律走宿主 `ctx.get('llm').stream({ provider, model, messages })`；本包**不读凭据、不写 key**。
- `promptVersion`：本次调用所用**提示词版本**标识，写进 `model_calls`，日志面板按列显示。
  - `checklist-v3` = 本包 `lib/checklist.js` 的 `CHECKLIST_PROMPT_VERSION`（`CHECKLIST_SYSTEM` + 提示词结构；v2→v3 加了"以注入的检查标准为主要参考、但不是逐条勾选"这一条）。
  - `vision-judge-v2` = `gaia-inspection-capture` 的 `VISION_PROMPT_VERSION`（v1 → v2 加了每条判断的 `confidence` 与 `boxes` 不准时的 `point` 降级）。
  - **涨版本规则**：只要改了 `*_SYSTEM` 文本或提示词的拼装结构（字段、顺序、示例），就同步 +1（`v1 → v2`）；只改措辞不改结构也要涨。旧记录不回溯改写。
- 日志脱敏（画面级 §3 红线）：只落 `requestSummary`（业务要点）/`responseSummary`（模型输出截断 300 字）；写入前统一过 `redact()`：抹掉 `sk-…`、`Bearer …`、`authorization:`/`x-api-key:` 片段。**不落 key、不落 Authorization、不落请求头、不落完整 prompt。**

### 5.1 检查标准可注入（`standards.json`）——**客户改标准不用改代码**

「这次查哪几项」的参考维度**不是写死在代码里的常量**，而是从一个可注入的文件读出来的。读取优先级：

1. **客户可写区**：`<GAIA_INSPECTION_DATA 或 $DSH_HOME/gaia-inspection>/standards.json`（推荐：升级不丢、客户自己就能改）
2. **随包交付**：本插件目录下的 `standards.json`（发行方把某连锁的标准随包带）
3. **内置兜底**：上面都没有（或文件坏了）时用代码里的 6 个内置参考维度 —— 保证"客户还没给标准也能跑"

文件形状（`dimensions` 与 `byFormat.*.dimensions` 都接受纯字符串数组；`items` 可省）：

```json
{
  "version": "示例连锁·门店自查标准 v1",
  "dimensions": [
    { "name": "人员与卫生", "items": ["工服", "健康证", "手部清洁"] },
    { "name": "食材与半成品", "items": ["生熟分开", "覆盖", "温度", "效期"] }
  ],
  "byFormat": {
    "快餐档口": { "version": "快餐档口专项 v3", "dimensions": [{ "name": "打包与出餐动线", "items": ["封签完好"] }] },
    "正餐堂食": { "dimensions": [{ "name": "留样与公示", "items": ["留样 48h", "健康证公示"] }] }
  }
}
```

**统一的还是分业态的？两种都支持，由你决定：**

- **不写 `byFormat`** → 全公司**统一一份**标准（`dimensions` 对所有门店生效，业态差异交给模型按本次输入取舍）；
- **写了 `byFormat`** → 按门店档案里的**业态**取专项：匹配顺序是 **精确命中 → 宽松包含**（键写 `快餐` 也能命中业态 `快餐档口`）；专项那项可以带自己的 `version`（不带则自动拼成 `通用版本 · 业态`）；
- 某业态**没有专项** → 退回该文件的**通用 `dimensions`**（注意：是退回通用，不是退回内置）；文件都没有 → 内置 6 维。

- **每次调用都重读文件**：客户改完**即刻生效，不用重启**。
- 文件读不到 / JSON 坏了 / 形状不对：**退回内置 6 维并把原因带在返回值里**（`data.standards.error`），既不抛错，也不"假装读到了标准"。
- **Windows 的 UTF-8 BOM 会被剥掉**（记事本 / PowerShell 存出来的文件一定带 BOM；不剥会静默退回内置）。
- 每次调用的 `model_calls.requestSummary` 都写明本次用的是哪套标准
  （`检查标准 <version>（客户注入/随包交付/未注入）`，分业态时是 `（按业态专项·快餐档口）`），可追溯。
- 返回体 `data.standards` 带 `source / seat / path / version / count / scope（format|base|builtin）/ format / matchedBy`。
- 插件目录里随包带了一份 `standards.example.json`（**不会被读取**，只作模板）。
- **标准是参考维度，不是本次清单**：提示词明确要求"以它为主要参考，但不是逐条勾选——与本次无关的项可以不列；标准里没写、而本次照片或说明里确实出现的问题也要提出并说明理由"。这正是「去掉 AI 换规则引擎做不到」的原因：规则引擎只能对着注入的标准逐条勾，无法在标准之外提出新检查项并说明理由。

## 6. 依赖

- `peerDependencies`（宿主提供，不搬）：`@deepseek-ai/dsh-tools`（工具工厂）、`@deepseek-ai/dsh-llm`（消息构造，拿不到时有等价内置实现）。
- `dependencies`：**零第三方**。
- 可选服务：`webServer`（注册路由）、`llm`（模型）、`attachments`（图片，见 capture 包）、`agentDefaultModel`（默认模型选择）。缺 `webServer` 时只打警告不抛错，工具仍可用。

## 7. 本机自检怎么跑

```
<node.exe> ../_harness/selftest.mjs        # 143 项机器判据（含路由真 fetch、定时器、重置、静态禁令扫描）
<node.exe> ../_harness/reload-check.mjs    # 另起进程从磁盘回放本地库（重启后可读）
<node.exe> ../_harness/live-vision-probe.mjs  # 真模型调用证据（视觉判断 / 看不清 / 检查项生成）
```
`node.exe` 用随包运行时：`$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`。
