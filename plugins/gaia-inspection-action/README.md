# gaia-inspection-action — 逾期定时扫描 · 整改催办与升级

> 订单词：**门店督导** ｜ 承担能力词（逐字）：`逾期定时扫描`、`整改催办与升级`
> 包名：`@gaia/dsh-inspection-action` ｜ 形态：插件（host 半，无 client 半，不会白屏）

## 1. 职责

**一条状态机 + 一个真定时器**，是本单「真动作」的证据面：

```
判断落库 → 生成「整改要求」动作（dueAt = 判断时间 + 严重度 SLA）
  → 到期未整改（定时器 / 立即扫描）→ 状态置「逾期」 + 生成「催办」动作
  → 再过一个升级窗口仍未整改 → 状态置「已升级」 + 生成「升级」动作
另外：督导的人工动作「通过 / 退回并说明 / 催办」也写进同一张 actions 表（用 actor 区分人机）。
```

- **SLA（业务常量，不是模型判断）**：`高 2h / 中 8h / 低 24h`；升级窗口 `ESCALATE_AFTER_HOURS = 8h`。
- **真定时器**：`apply()` 里 `setInterval`，周期 `GAIA_INSPECTION_SCAN_MS`（默认 **60000ms**）。每次触发把 `{tick, ts, scanned, markedOverdue, actionsCreated, ok}` 追加到 `<数据根>/logs/scan-log.jsonl` —— 两次触发的真实时间戳可直接从文件核对。
- 「立即扫描」按钮走的是**同一个 `scan()`**，只是另一个入口（互为备份），不是"假装定时"。

## 2. 工具（5 个；`manifest.json` 的 `tools` 与注册名逐字一致）

| 工具名 | 用途 |
|---|---|
| `inspection_scan_overdue` | 立即扫描一遍逾期项（返回扫了几张、新逾期/新升级/新动作各几条）。 |
| `inspection_plan_actions` | 为一张检查单的全部判断生成「整改要求」（按严重度算截止，写回 `findings.dueAt` / `inspections.dueAt`）。**每条判断后必须有自动动作，这里是那个动作的生成口。** |
| `inspection_action_timeline` | 读某张检查单（或全部）的动作时间线：整改要求 → 催办 → 升级。 |
| `inspection_review_action` | 督导人工动作：`通过` / `退回并说明`（**必须带 `reason` 说明文本**，否则 `REASON_REQUIRED`）/ `催办`。每次落一条记录：时间 / 操作者 / 结果 / 原因。 |
| `inspection_scan_status` | 定时器运行事实：周期、已触发次数、最近几次触发的真实时间戳与结果、扫描日志文件路径。 |

`actions` 行字段：`id, inspectionId, findingId, type, actionCode, target, severity, dueAt, reason, createdAt, source, actor, actorName, actorIsHuman, result`
- `type`：`整改要求` / `催办` / `升级` / `通过` / `退回并说明`
- `actionCode`：人工动作的英文码（`review_approve` / `review_reject` / `review_remind`），前端按码匹配；自动动作没有这个字段
- `source`：`state-machine`（派单）/ `timer`（定时器触发）/ `manual-scan`（立即扫描）/ `supervisor`（督导人工）
- `actor`：`系统`（`actorIsHuman:false`）或 `督导`（`actorIsHuman:true`）；`actorName` 可选，仅演示用，**不做账号体系**

## 2b. 浏览器侧入口（HTTP）

浏览器插件没有"调用宿主工具"的通路，所以督导动作行（`[通过] [退回并说明] [催办]`）走 core 的固定动作口：

```
POST /api/gaia-inspection/review        （别名 /api/gaia-inspection/review-action）
body: { inspectionId?, findingId?, action, reason?, newDueHours?, operator?, at? }
      action ∈ '通过' | '退回并说明' | '催办'（也接受 approve / reject / remind）
resp: { ok:true, runId, status, summary, data{inspectionId, actionId, action, inspectionStatus, dueAt?},
        action{id, type, actionCode, target, createdAt, reason, actor, actorName, actorIsHuman, result},
        artifacts:[], traceRef, error:null }
失败: { ok:false, ..., error:{ code, message } }
      · 两个 id 都不给            → BAD_BODY
      · 退回并说明 缺 reason      → REASON_REQUIRED
      · action 不是那三种         → BAD_ACTION
      · 检查单/判断不存在         → INSPECTION_NOT_FOUND / FINDING_NOT_FOUND
只给 findingId 也认（反查它所属的检查单）。
```
入口只是**固定动作转发**（不接受工具名、不做通用代理），落库语义与工具 `inspection_review_action` **完全同一处代码**。

## 3. 状态取值（看板用）

`inspections.status`：`pending_rectify`（待整改）→ `overdue`（逾期）→ `escalated`（已升级）→ `rectified`（已整改，人工「通过」后）
`findings.status` 跟随检查单同步流转；「退回并说明」会把状态退回 `pending_rectify` 并按 `newDueHours`（缺省沿用原截止）重算。

## 4. 依赖

- `peerDependencies`（宿主提供，不搬）：`@deepseek-ai/dsh-tools`。
- `dependencies`：**零第三方**（定时器与文件写入都用 `node:` 内置）。
- 运行期依赖 `ns.db`（core）。缺它时所有工具返回 `DEPENDENCY_MISSING`，定时器也不会"假装在扫"（每次 tick 的记录里 `ok:false`）。

## 5. 空架说明

数据根里没有 `inspections` 行时，扫描是最便宜的空转：`scanned:0`、无动作产生，`scan-log.jsonl` 仍会写 tick（这是"定时器真的在跑"的证据，不是假数据）。库里没有逾期项时不会生成任何动作——**不存在"为了演示而先造几条动作"**的逻辑。

## 6. 本机自检怎么跑

见 `../gaia-inspection-core/README.md` 第 7 节；本包判据在 `_harness/selftest.mjs` 的 T12（两次真实触发间隔 1215/1206ms ≈ 配置 1200ms）与 T13b（三个人工动作）段。
