# gaia-inspection-capture — 门店照片视觉判断 · 断网降级与待判队列 · 照片缩略与附件预览

> 订单词：**门店督导** ｜ 承担能力词（逐字）：`门店照片视觉判断`、`断网降级与待判队列`、`照片缩略与附件预览`
> 包名：`@gaia/dsh-inspection-capture` ｜ 形态：插件（host 半，无 client 半，不会白屏）

## 1. 职责

1. **门店照片视觉判断**：对门店照片发起**真实多模态模型调用**，返回问题项 / 严重度 / 依据文字 / 圈框坐标（可空）/「看不清」清单。
2. **断网降级与待判队列**：模型不可达或处于演示离线开关时，采集**仍然受理**并进待判队列，**不产生任何模型判断**；恢复后自动补判（也支持手动 flush）并补派整改单。
3. **照片缩略与附件预览**：原图**原样保留**（内容寻址），生成缩略图（长边默认 512px、保持比例），供看板小图与证据卡片读取。

## 2. 工具（5 个；`manifest.json` 的 `tools` 与注册名逐字一致）

| 工具名 | 用途 |
|---|---|
| `inspection_submit_selfcheck` | 受理一次采集（**单张照片** + 一句话）：在线真判读落库并派整改动作；离线只排队并如实回执。 |
| `inspection_judge_photos` | 直接对 1-6 张照片做真视觉判断（不落库），用于内部/其它调用方。 |
| `inspection_thumb` | 生成缩略图（长边可指定）；返回 `photoId` 与 URL。 |
| `inspection_pending_queue` | `action=list` 看待判队列 / `action=flush` 立即补判。 |
| `inspection_offline_mode` | 演示用离线开关（打开后只排队、零调用零日志）。**不是账号状态**，不落持久身份。 |

## 3. 上限（画面级说明：采集面是**单张**照片）

| 项 | 上限 | 超限行为 |
|---|---|---|
| `/submit` 与 `inspection_submit_selfcheck` 张数 | **1 张** | `{ok:false,error:{code:'TOO_MANY_PHOTOS'}}` |
| `inspection_judge_photos` 张数 | 6 张 | 同上（规格书 §7 写了"单张/多张"） |
| 单张解码后字节 | **2MB** | `{ok:false,error:{code:'PHOTO_TOO_LARGE'}}` |
| HTTP 请求体 | 16MB | `{ok:false,error:{code:'BODY_TOO_LARGE'}}` |
| 照片格式 | PNG / JPEG / WebP / GIF（按**魔数**判定，不信扩展名） | `PHOTO_TYPE_UNKNOWN` |

一律**结构化拒绝**，不静默截断、不丢弃后继续。

## 4. 模型调用（红线自查）

- 只走宿主 `ctx.get('llm').stream(...)`；**不读凭据、不写 key、不 new adapter**。
- **发请求前的图像模态前置检查**：`llm.resolveModelInfo()` 返回的 `inputModalities` 不含 `image` → 直接回 `MODEL_NOT_VISION` 且**不发请求**。理由：文本模型会把图片投影成占位符文本，模型仍会"说话"——那是静默降级，本单禁止。
- 图片输入走宿主 attachment 服务：`ctx.attachments.saveImages([...])` → `{type:'image',attachment:ref}` 进消息。DeepSeek 适配器要求「vision 模型 + attachment 服务」同时在场，缺一即 `ATTACHMENT_UNAVAILABLE`。
- **没有 if-else / 关键词规则产出问题项**：`lib/vision.js` 里 `findings` 的唯一来源是模型输出的 `parsed.findings`（自检脚本用"剥注释后的结构判据"核这一点）。
- 模型输出不是合法 JSON → `MODEL_OUTPUT_INVALID`；空文本 → `EMPTY_RESPONSE`；都不兜底、不编结论。
- 模糊 / 失焦 / 过暗 / 拍偏：提示词**要求**模型放进 `unreadable` 并说明原因，本包只原样转发，不加工、不补全。
- `promptVersion`：`lib/vision.js` 的 `VISION_PROMPT_VERSION`（当前 `vision-judge-v1`），写进 `model_calls`。改 `VISION_SYSTEM` 或提示词结构必须同步涨版本。

## 5. 离线降级口径（两种"离线"分得很清楚）

| 场景 | 行为 | `model_calls` |
|---|---|---|
| **演示离线开关**（`inspection_offline_mode{offline:true}`） | 采集受理 → 队列；submit 与 flush 都停 | **0 条新增**（连尝试都没有） |
| **模型真不可达**（首次尝试失败，如 `TRANSPORT`） | 采集受理 → 队列；并**熔断**（后续 submit 不再重复打空请求） | 如实记录**失败尝试**（`status:'error'` + `errorCode`），**不产生任何判断**（`judgementsProduced:0`） |
| 恢复（`flush` 或后台自动补判成功） | 队列项补判 → 补派检查单与整改单 → 回填队列状态 → **清掉熔断** | 新增成功调用记录 |

回执文案与指令一致：`离线：仅采集排队，不产生模型判断`。队列文件 `<数据根>/queue/pending.jsonl`；离线**必须先把原图落盘**（否则联网补判找不到照片）。

## 6. 缩略图

- 首选**宿主图像管线**：`ctx.attachments.readImageRequest(ref,{width,height,maxBytes})`（宿主自带 sharp 实现，本包**零第三方依赖**）→ `via:'host-attachments'`。
- 兜底：本包自带零第三方 PNG 缩放（`lib/png.js`，`zlib` + 手写解码/箱式缩放）→ `via:'png-fallback'`；仅支持 8bit 非隔行 PNG，灰度/RGB/RGBA。
- 两者都做不到（JPEG/WebP/GIF/隔行 PNG）→ `THUMB_UNSUPPORTED`，**绝不假装生成了缩略图**。
- 命名：默认长边 → `<photoId>.<ext>`（读图路由按这个名字取）；非默认长边 → `<photoId>-le<长边>.<ext>`（内部产物，只在工具返回里给 `thumbPath`）。
- 原图保留：`photos/<photoId>.<ext>`（内容寻址，重复照片天然去重，不覆盖、不改写）。

## 7. 依赖

- `peerDependencies`（宿主提供，不搬）：`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-attachment`。
- `dependencies`：**零第三方**，只用 `node:fs / node:path / node:crypto / node:zlib`。
- 运行期依赖同单其它包的槽位：`ns.db`（core）、`ns.modelLog`（core）、`ns.action`（action）、`ns.registry`（registry）。**不做跨包 import**，全部运行期解析；缺 `ns.action` 时判读仍落库，但会在回执 `warnings` 里如实说明"整改要求动作未生成"。

## 8. 存储与空架

- 数据根同 core（`$DSH_HOME/gaia-inspection`，可用 `GAIA_INSPECTION_DATA` 覆盖）。空架时 `photos/`、`thumbs/`、`queue/` 都是空目录；首次提交后面出现文件。队列文件不存在 = 队列为空（不是错误）。

## 9. 本机自检怎么跑

见 `../gaia-inspection-core/README.md` 第 7 节；本包相关的判据在 `_harness/selftest.mjs` 的 T6 / T7 / T8 / T10 段，真调用证据在 `_evidence/live-vision-probe.txt`。
