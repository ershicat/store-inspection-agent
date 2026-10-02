# gaia-inspection-demo — 演示样例与状态重置

> 订单词：**门店督导** ｜ 承担能力词（逐字）：`演示样例与状态重置`
> 包名：`@gaia/dsh-inspection-demo` ｜ 形态：插件（host 半，无 client 半，不会白屏）

## 1. 职责

1. **演示样例**：载入四种可复现的现场状态（同一门店的达标态与问题态 + 逾期态 + 看不清态），带 3 张**合成示例图**。
2. **状态重置**：复位业务数据，用于下一次现场演示。

## 2. 工具（2 个；`manifest.json` 的 `tools` 与注册名逐字一致）

| 工具名 | 用途 |
|---|---|
| `inspection_load_samples` | 载入演示样例（默认 `replaceDemo:true`：先删上一次的 `demo:true` 行，**不碰真实业务数据与 `model_calls`**）。 |
| `inspection_reset_demo` | 重置：清 4 张业务表 + 待判队列；**保留 `model_calls` 与 `stores`**，返回 `cleared` / `kept` / 前后计数对照。 |

另发布槽位 `ns.demo.samplePhoto(key)`，由 core 的只读口 `GET /api/gaia-inspection/sample-photo?key=issue|clean|unreadable` 暴露给前端「载入示例」按钮：返回 `{key, name, mediaType, width, height, dataUrl, label, notice}`，`dataUrl` 是 `data:image/png;base64,…`，**不含任何判断结论**（填完表提交后由真模型判读）。存在原因：前端拿不到本包的 PNG 生成代码，走 HTTP 才能保证**前端展示的示例图与 demo 载入的样例是同一张**（避免两套示例图漂移）。

## 3. 演示样例的四态（每条判据都可现场核对）

| key | 门店 | 状态 | 内容 |
|---|---|---|---|
| `OK` | S-001 | 达标态 | 检查单状态 `rectified`，**0 条判断**（不是"造一条然后标为通过"） |
| `ISSUE` | S-001 | 问题态 | 2 条判断（高 / 中），带圈框（一条有框、一条 `boxes:[]` + `fallbackPoint:null`），已生成「整改要求」 |
| `LATE` | S-002 | 逾期态 | 截止时间=现在-10h，**扫描后**被定时器/立即扫描置「逾期」→「已升级」并生成催办/升级动作 |
| `UNREADABLE` | S-001 | 看不清态 | `unreadable` 1 条、**findings 0 条**（不产生任何问题判断） |

**诚实标注（重要）**：3 张图是**几何图形合成的示例图**（`lib/samples.js` 用零第三方 PNG 画布确定性生成，同种子同结果），**不是真实门店照片**。每个样例行都带：
- `demo: true`、`demoLabel: '合成示例图（几何图形合成，非真实门店照片）'`
- `judgedBy: 'demo-sample（未调用模型）'`

**样例不冒充模型判断**：载入样例**不向 `model_calls` 写任何记录**（前后计数必须相等，返回体里 `ok` 也按这个判）。样例里的「问题项/圈框」是人工构造的演示数据，因此在看板上可以清楚区分"这条是样例"还是"这条是模型真判的"（后者带 `visionCallId` / `source:'vision_judge'`）。

## 4. 重置边界（§4 红线）

```
cleared = ['inspections','findings','evidences','actions','pending_queue']
kept    = ['model_calls','stores']
```
- `model_calls`（模型调用日志）**一行不动**：§4 红线——日志不许事后补写、不许被演示重置清空。返回体里显式回 `kept:['model_calls']`，并给 `modelCalls:{before,after,dropped}`；若 `dropped !== 0`，`ok` 直接置 `false` 并回 `MODEL_CALLS_LOST`（**宁可报错也不放过**）。
- `stores` 保留的理由：它是两家示例门店的**静态档案**（registry 的种子），不属于演示产生的业务数据；清掉会让"门店档案"当场失效。

## 5. 依赖

- `peerDependencies`（宿主提供，不搬）：`@deepseek-ai/dsh-tools`。`dependencies`：**零第三方**（PNG 合成本包自带）。
- 运行期依赖 `ns.db`（core）、可选 `ns.registry`（重播档案）与 `ns.action`（生成整改要求动作）、`ns.capture.thumb`（样例缩略图）。缺 `ns.action` 时样例仍可载入，但在返回体 `warnings` 里如实写明"整改要求动作未生成"。

## 6. 空架说明

数据根为空时载入样例 = 直接创建 4 张检查单 + 3 张合成图 + 缩略图；`model_calls` 文件不存在 → 计数 0 → 载入后仍是 0（这是"样例没写日志"的最简证据）。

## 7. 本机自检怎么跑

见 `../gaia-inspection-core/README.md` 第 7 节；本包判据在 `_harness/selftest.mjs` 的 T11（四态齐备、标注、零日志、缩略图）与 T13（重置边界）段。
