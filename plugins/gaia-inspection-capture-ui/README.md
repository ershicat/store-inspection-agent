# gaia-inspection-capture-ui（门店督导 · 店长端界面包）

订单词：**门店督导** ｜ 承担能力词（逐字）：**门店自查采集入口**、**角色视图切换** ｜ 档位：C + E
**本文与《界面实现说明（画面级）》屏 A 逐条对齐**（内容/交互/文案以那份为准）。

## 一、这个包做什么（屏 A）

| 区块 | 形态 | 挂载点 |
|---|---|---|
| 视图标签 | 顶部两态：「店长端 / 督导端」（E 档状态化控件，**不做登录/权限**） | `conversation.input.dock`（会话顶部输入区）+ 会话 header 入口 + 面板内也带一份 |
| 演示替身提示条 | 浅橙底逐字：`演示替身：真实场景中门店在手机上提交，本面板为演示视图` | 面板内（**不可删**） |
| 门店下拉 | 两家静态示例门店：**示例门店 A · 快餐档口** / **示例门店 B · 正餐堂食**（不做增删改；由后端 `stores` 的业态映射而来） | 面板内 |
| 照片区 | 点击选择 + 拖拽入区；**只收 jpg/png、单张**；选中后缩略图 + 文件名 + 可删除；**不调用摄像头**；前端拦超限（≤2MB，与后端 `MAX_PHOTO_BYTES` 对齐） | 面板内 |
| 一句话说明 | 1–200 字、实时字数、超长或为空时主按钮不可用 | 面板内 |
| [载入示例] | 一键填入**示例图 + 那句话**：**优先**取后端 `GET /api/gaia-inspection/sample-photo`；该口不存在/形状不符时**自动退回前端内置示例图**（Canvas 2D 合成，确定性几何图形）。两条路都只是"填表"，**提交仍走真实模型调用，不写死结果** | 面板内 |
| [提交并分析] | 照片与文字都非空才可用；点击后置灰 + 显示「正在分析…」；**同一门店不允许重复提交未完成的分析** | 面板内 |
| 状态行 | 五态逐字（见二） | 面板底部 |

屏 A 整体是**"手机形状卡片"**（桌面上的视觉形态：窄卡片 + 圆角 + 顶部状态条样式；**不做响应式**），
挂在无遮罩浮层里：**不挡会话**（画面级说明 §四 6 只禁"全屏遮窗"，对话照常可读可操作）。

## 二、五态状态行（逐字，一个都不能少）

| 状态 | 文案 |
|---|---|
| 空 | `待提交（照片与文字都填写后按钮可用）` |
| 加载中 | `正在分析…（本次为真实模型调用）` |
| 成功 | `已提交，编号 #A-2317，等待督导复核`（编号取后端 `runId` 尾段：`INS-20261002-201530-ab12` → `#ab12`） |
| 失败 | `分析失败：＜原因摘要＞ [重试]`（**输入与照片保留**） |
| 断网 | `离线：仅采集排队，不产生模型判断；联网后自动补判`（**不可删**） |
| 断网恢复 | `已联网，正在补判排队中的 N 条…`（离线→在线的沿跳变时显示若干秒） |

## 三、取数

| 用途 | 接口 |
|---|---|
| 提交并分析（真实模型调用） | `POST /api/gaia-inspection/submit`，体 `{storeId, note, photos:[{name, mediaType, dataBase64}]}`（**单张**） |
| 门店下拉 / 离线与待判队列 | `GET /api/gaia-inspection/snapshot`（`stores[]`、`offline`、`pendingQueue`） |
| 载入示例 | `GET /api/gaia-inspection/sample-photo` → `{ok, data:{name, mediaType, dataUrl, label}}`（**需后端提供，见六**） |

## 四、宿主半（`lib/index.js`）做什么

**不重复实现后端业务**。业务数据来自 `gaia-inspection-core` 的 `/api/gaia-inspection/*`。本包宿主半只在进程内保留一份**只读内省记录**（浏览器半每次提交后回报一条回执），供验收/自检复核「界面显示的回执」与「真实提交回执」同源：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/gaia-inspection-capture-ui/last-submit` | GET | 最近一条提交回执（无 → `{ok:true,receipt:null}` 的空态） |
| `/api/gaia-inspection-capture-ui/receipts` | GET | 最近最多 20 条回执 |
| `/api/gaia-inspection-capture-ui/report-submit` | POST | 浏览器半回报一条回执（只写内存，不落盘） |

宿主半的 `inject` 为 `['webServer']`（字符串数组）；没有 `webServer` 时只打 `console.warn`，**不抛错**。

## 五、装载契约与自测

- `package.json` → `exports["./client"] = "./client/client.js"`（文件真实存在）
- `dsh.client = { "platform": "web" }`
- `dsh.bundle.patch = "./cordis.patch.yml"`（文件存在且含 `- insert:`，行 id 唯一）
- 零第三方 `dependencies`；client 半是纯浏览器 ESM（不引 `node:`；React 取不到就不挂载、不报错）

```
node test/selftest.mjs
```

覆盖：宿主半 import / `inject` / 内省路由；装载契约四项；在最小 React/DOM/fetch 垫片下**把屏 A 渲染出来**并断言逐字文案与控件状态（视图标签、演示替身提示条、两家门店、单张 jpg/png、`0 / 200 字`、[载入示例]、[提交并分析] 空表单禁用）；**「载入示例」两条路**（后端口可用 → 用后端图；口 404 → 退回前端内置合成图，Canvas 画法被调用）；**真实提交流程**（POST body、回执同源、成功态编号、失败态保留输入与照片、离线排队、断网恢复文案、同门店重复提交被拦）；`manifest.keywords` 逐字。

## 六、需要后端配合（本单前端已按此实现，接口若缺会如实提示，不假装成功）

1. `GET /api/gaia-inspection/sample-photo` ——「载入示例」**优先**取内置合成示例图（`{data:{name, mediaType, dataUrl, label}}`）。
   期望实现：调 `ns.demo` / `writeSamples(photoDir)` 取 `issue` 那张，转 dataURL 返回，`label` 带「合成示例图（几何图形合成，非真实门店照片）」。
   **该口不是硬依赖**：不存在/不可用时前端自动退回**内置示例图**（Canvas 合成，同为演示素材，标签写「内置合成示例图」），只在本机画布也不可用时才提示手动选图。**两条路都只是填表，提交仍走真实模型调用。**
2. `POST /api/gaia-inspection/submit` 的请求体：`{storeId, note, photos:[{name, mediaType, dataBase64}]}`（**单张**，与 `MAX_PHOTOS_SUBMIT = 1` 一致）。

## 七、明确不做

勾选表 / 结构化验项表单、登录与权限、门店增删改、照片编辑与大图查看器、摄像头调用、上传进度大屏、真扫码、响应式移动端、皮肤/主题/品牌色（美术层）。

## 八、依赖与来源

- 零第三方运行时依赖；`peerDependencies` 只列宿主提供的 `@deepseek-ai/dsh-web-server`。
- 本包界面文案与代码为**本单原创**（逐字文案来自操作者下发的《界面实现说明（画面级）》）；档位 C/E 的判定依据来自盖亚技能 `frontend-backend-split`（只摘录 Apple Human Interface Guidelines 中可迁移的交互原则，转引自 `FrancoStino/opencode-skills-collection` 的 `hig-patterns`，MIT），**未复制其文本或代码**。归属记录见编辑侧 `<构建区>\资料\THIRD-PARTY.md`。
- 许可：MIT。
