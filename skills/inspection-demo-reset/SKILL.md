---
name: inspection-demo-reset
description: Use when 门店督导单要准备现场演示（搭可复现的样例、复位到干净状态、演示后清理）时加载。规定演示样例的四种状态、重置边界（model_calls 绝不清空）、现场演示顺序与失败回退。能力词：演示样例与状态重置。
---

# 演示样例与状态重置（inspection-demo-reset）

## 这个技能解决什么

现场演示最怕两件事：**状态脏**（上次演示留下的数据让这次看起来不对）和**日志被清**（评委要看 API 调用记录，结果被重置顺手清了）。
本技能把"样例怎么搭、重置清什么留什么、按什么顺序演"固定成可执行步骤。

## 什么时候用

- 演示前 5 分钟：复位 + 载入样例；
- 演示中途被问"能不能看另一种状态"：切到对应样例态；
- 演示结束/下一场前：复位；
- 有人提议"顺手把日志也清了重新跑一遍"时 —— 加载本技能，**明确拒绝**（见下面的红线）。

## 演示样例的四种状态（缺一不可）

| 状态 | 用来演示什么 | 关键判据 |
|---|---|---|
| **达标态** | 同一家门店"正常那次"长什么样 | 检查单 0 条问题项，不能是"造一条然后标通过" |
| **问题态** | 判断 → 整改要求 → 截止时间这条链 | 至少 2 条判断，其中一条有圈框、一条只有文字依据（演示降级） |
| **逾期态** | 真定时器/立即扫描把状态推到逾期、再推到已升级 | 截止时间在**过去**，扫描后出现「催办」「升级」动作 |
| **看不清态** | 模糊照片不许硬编结论 | `unreadable` 有内容且**问题项 0 条** |

**样例必须诚实标注**：演示用的图是合成示例图（不是真实门店照片）时，样例数据里要带 `demoLabel` 与 `judgedBy:'demo-sample（未调用模型）'`，看板上能让评委一眼看出"这条是样例、不是模型真判的"。

## 执行步骤（演示前）

1. **复位**：调 `inspection_reset_demo`（无参数）。
   - 核对返回：`data.cleared` 含 `inspections/findings/evidences/actions/pending_queue`；
   - `data.kept` 含 `model_calls`；`data.modelCalls.dropped === 0`；
   - 若 `ok:false` 且 `error.code === MODEL_CALLS_LOST` → **停下来排查**，不要继续演示。
2. **载入样例**：调 `inspection_load_samples({ replaceDemo: true })`。
   - 核对 `data.variants` 有 4 条（达标/问题/逾期/看不清）；
   - 核对 `data.modelCalls.before === data.modelCalls.after`（样例不写日志）；
   - 记下 `data.variants[]` 里各状态的 `inspectionId`，演示时按 id 直接切。
3. **把逾期态推起来**：调 `inspection_scan_overdue({ reason: 'manual' })`（或等真定时器自己跑）。
   - 核对返回 `data.markedOverdue` / `data.markedEscalated` / `data.actionsCreated`；
   - 留一句现场话术："这条逾期是定时器扫出来的，不是我手点的"—— 用真定时器的日志（`logs/scan-log.jsonl` 的时间戳）作证。
4. **关掉离线开关**（如果上一场演示开过）：`inspection_offline_mode({ offline: false })`。
5. **看一眼基线**：`GET /api/gaia-inspection/snapshot` 确认 `counts`、`offline`、`pendingQueue` 都是预期值。

## 执行步骤（演示中）

- 要演"断网降级"：`inspection_offline_mode({ offline: true })` → 提交一张照片 → 回执必须是 `status:'queued'` 且文案「离线：仅采集排队，不产生模型判断」→ 展示 `model_calls` 条数**没有变**→ `offline:false` 后 `inspection_pending_queue({action:'flush'})` 补判成功。
- 要演"模型真不可达"：保持离线开关关闭、把客户端模型 provider 关掉/断网，再提交。此时回执同样是排队，且说明里带原因码（如 `TRANSPORT`）；`model_calls` 里会出现**失败的尝试**记录（`status:'error'`）——这是"我们真的试过了"的证据，**不要**把它说成"没有调用"。
- 要演"看不清"：切到看不清态那张检查单，演示问题项 0 条 + `unreadable` 的原因文字。

## 执行步骤（演示后）

1. 复位（同演示前第 1 步）；
2. 汇报时**顺手报一次 `model_calls` 计数**（复位前 / 复位后），让"日志没被清"这句结论有数字支撑。

## 边界与不做什么（红线）

- **重置绝不清 `model_calls`**：日志不许事后补写、不许清空重跑（清空后再"补"出来的记录是伪造历史）。
- **重置不清 `stores`**：两家示例门店是静态档案，不是演示业务数据。
- **样例不许冒充模型判断**：样例里的问题项/圈框要么明确标 `demo-sample（未调用模型）`，要么就真的调模型现场判一次。
- 不做"演示模式"全局开关界面，不做样例云端拉取；重置不删归档证据原件。

## 相关产物

- 重置：`gaia-inspection-demo` 的 `inspection_reset_demo`
- 样例：`gaia-inspection-demo` 的 `inspection_load_samples`
- 扫描：`gaia-inspection-action` 的 `inspection_scan_overdue` / `inspection_scan_status`
- 离线：`gaia-inspection-capture` 的 `inspection_offline_mode` / `inspection_pending_queue`
