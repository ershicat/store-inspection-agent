# gaia-inspection-preset —— 盖亚预设 inspection（门店督导）

> 这是**交付给客户的那份客户预设**。种子《可删清单.md》A10 明文：「删完客户端一个预设都没有 …… **必须装一份客户预设并把 `default` 指到它**（客户预设由操作者手写，不自动生成）」。本包就是那一份。

## 一、本包是什么 / 不是什么

| | |
|---|---|
| **是** | 一个 agent 预设声明（`id: inspection`，显示名「门店督导」，`order: 6`）+ 注册表默认预设覆盖 |
| **不是** | 业务能力包。19 个业务工具、`/api/gaia-inspection/*` 路由、六张本地表，全部由随成品交付的 7 个业务插件包提供（`gaia-inspection-{capture,core,action,registry,demo,capture-ui,oversight-ui}`）；本包**不重复声明**它们（重复挂载 = 行 id 与服务冲突） |
| **不是** | 人设的第二个事实源。纪律、文案、工具名都在 `cordis.patch.yml` 的 persona 里，本文件只讲挂载与验证 |

## 二、包内文件

```
gaia-inspection-preset\
├─ package.json          声明 dsh.bundle.patch = ./cordis.patch.yml（壳的 seedPlugins() 就认这个字段）
├─ cordis.patch.yml      ① 插一条 name: '@deepseek-ai/dsh-agent-preset' 的预设行
│                        ② 用同 id 覆盖 agent-preset-registry 的 default / selectedDefault
└─ README.md             本文件
```

**零依赖、零构建步、零 `lib/`**：本包不 `import` 任何东西，只提供声明与人设文本。整份 8,001 字符 / 151 行，其中人设 63 行。

## 三、预设行结构（`cordis.patch.yml`）

```
- insert:
    - id: preset-inspection                     ← 行 id（bundle 内唯一）
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: inspection                          ← 预设身份：注册表 default 指的是这个
        name: "门店督导"
        description: "…"                         ← 预设选择器里显示给客户的说明
        order: 6                                ← 接在 resolver(5) 之后
        plugins: [ 9 条行 ]
```

行内的 9 条插件行：

| # | 行 id | 作用 |
|---|---|---|
| 1 | `persona` | **本包主体**：判断引擎人设（见 §四） |
| 2 | `agent-instructions` | 项目级说明文件（`maxBytes: 65536`，与其它盖亚预设同值） |
| 3 | `tool-fs` | 只读文件工具：读随包资料、演示说明、材料 |
| 4 | `tool-fs-search` | 只读检索（`sampleOverCapGlobResults: false`） |
| 5 | `skill-filesystem` | 技能根：**不配 `customSkillDirs`**，吃默认用户根 `<DSH_HOME>\skills`（rank 400）= 壳 `seedSkills()` 播种的 `resources\gaia\skill库\`；本单 4 个产品技能都在其中 |
| 6 | `tool-skill` | 技能目录 + 按需加载正文 |
| 7 | `tool-web` | 只检索不抓全文（`fetch: false`） |
| 8 | `tool-ask-user` | 口径不清时问清楚 |
| 9 | `present` | 交付物卡片（免得提示词点名了不存在的工具） |

**故意没挂的行**：`tool-bash` / `tool-pwsh` / `tool-jobs` / `delegation` / `planning` / `compaction` / `tool-todo` / `tool-plugin-manager`。本 agent 是**判断引擎**，不是生产/装配 agent；与 `gaia-resolver-preset` 一样只保留最小行集。

## 四、人设（persona）写了什么

放在 `config.plugins[0].config.prefix`，YAML 块标量 `|-`。内容按需求描述的「约束 10 条 + 完成判据 10 项」逐条落地：

1. **身份与唯一差异**：判断引擎（不是连锁公司管理系统）；检查项**不是预先写死的清单**，必须回答「为什么查这几项」并引用本次线索。
2. **运行链路 8 步**：采集 → 看懂 → 决定检查项 3–5 项 + 理由 → 逐项判断 + 依据 + 证据回指 → 整改要求 + 截止 → 督导复核 → 到期自动升级 → 全程留调用日志。
3. **技能清单 + 必载标记**：`inspection-checklist-dynamic`、`inspection-scope-discipline`（必载）、`inspection-demo-reset`、`inspection-delivery-docs`（按需）。
4. **19 个业务工具逐字列出并分组**（采集判读 / 检查项与落库 / 整改闭环 / 门店档案只读 / 演示），明确「不要臆造别的名字」。
5. **硬约束 10 条**：真调用真日志（禁预设结果、禁补写日志）· 证据回指（给不出坐标就降级「图上标点 + 依据文字」，不许空框）· 看不清就说看不清 · 断网只排队不判断（模拟开关必须说明是模拟）· 单张照片 / 无语音 / 无账号 / 无考核合规率 · 检查项动态 · 范围纪律先问再做 · 演示数据诚实（中性示例名 + 自摆样例标注）· **三处不能删的文案逐字写死**（`演示替身：真实场景中门店在手机上提交，本面板为演示视图`、`离线：仅采集排队，不产生模型判断`、`已升级`）· 不部署 / 冻结期不动仓库 / 不代提交。
6. **价值锚点**：记在**督导覆盖率与督导工时**上，绝不记在「门店合规率」上。
7. **完成判据 10 项**（启动 / 真调用 / 证据 / 理由随输入变化 / 换门店换话术结果不同 / 看不清 / 断网 / 补判 / 升级留痕 / 日志面板）。
8. **诚实声明**：没实测的一律标「未实测」，做不到的如实说。

## 五、挂载与生效方式

预设**不是**放在 `.agent-presets\` 目录里的（0.2.0 起已改为 bundle 声明式）。本包与另外 4 个盖亚预设走同一条机制：

1. **放进成品**：本包必须出现在 `<包根>\resources\gaia\插件库\gaia-inspection-preset\`（与 7 个业务插件包同级）。
2. **登记进 profile**：壳首启的 `seedPlugins()`（`resources\app.asar` → `app\main.js`）扫描 `resources\gaia\插件库\` 下每个目录，读 `package.json` 的 `dsh.bundle.patch`；有该字段的包以 `file:<出厂源>` 形式写进 profile 的 `dependencies`，并追加到 `dsh.profile.bundles`，随后跑一次 `pnpm install` 落盘。**已经写进去的包一律不动**，所以本包只要进得去，客户清掉 `data\` 重开后也会自己回来。
3. **生效时机**：追加进 `bundles` 末尾 → 本包的补丁在 `web-app` 之后应用 → 后面那条 `agent-preset-registry` 覆盖生效。
4. **重启**：内核每次启动都重新组合补丁，**首启装包成功即生效**。若 `seedPlugins()` 判为「无需改动」（package.json 里已有本包且 node_modules 已落盘）则零开销、不碰磁盘。

## 六、已经实测的 / 未实测的

### 已实测（2026-10-02，本机）

| 项 | 方法 | 结果 |
|---|---|---|
| YAML 可被内核同一套解析器解析 | 用成品内核自带的 `yaml` 包 `YAML.parse()` 真解析本文件 | 通过：顶层 2 段，`insert` 1 条，插件行 9 条，无 BOM、无 CRLF、无裸 tab |
| 人设块标量取值正确 | 解析后逐行核对 `config.plugins[0].config.prefix` | 63 行；首行/末行为预期文本；三处不能删的文案逐字在文本内 |
| **`default` 覆盖真的生效** | 用 `dsh-app-boot` 的 `composeEntries()`，把**真实的** `dsh-web-app\cordis.patch.yml` 当第一层、本包补丁当第二层合成一行后取 `agent-preset-registry` | `{"default":"inspection","selectedDefault":"inspection"}`（覆盖了 web-app 里的 `default: standard`）；合成的条目树里多出 `preset-inspection` 一条 |
| 覆盖语义 | 读 `dsh-app-boot\lib\index.js` 的 `applyEntryPatches` | 补丁按 id 命中后逐键**浅覆盖**（`target[key] = value`）⇒ `default` 与 `selectedDefault` 必须**一起写全**，否则 `selectedDefault` 残留继续生效（取值优先级 `selectedDefault ?? default`） |

> 合并验证时出现的 `patch: entry "tool-fs" not found` 一类告警，是因为那次合成**只喂了两个补丁层、没有喂 `dsh-base`**，与基础包里的行对不上；出现在 web-app 自己那几条补丁上，与本包无关。

### 未实测（不许当成已验过）

| 项 | 为什么没测 | 怎么验（谁来做） |
|---|---|---|
| **真机启动后注册表里真有 `inspection` 且新会话用它建得起来** | 本会话**起不了壳**（`盖亚.exe` 直接退出，收尾报告 L4-03 实测为手段限制：对照实验里构建侧 `dist\win-unpacked\盖亚.exe` 同样秒退）；要真验必须双击成品 | 手：双击成品 → 新建会话，不报 `Unknown agent preset` 即通过；本包 `default` 覆盖生效时该会话就是「门店督导」 |
| **`seedPlugins()` 真把本包登记并落盘** | 同上（要真启一次壳） | `data\logs\startup.log` 里 `plugins-seeded` 应等于 `resources\gaia\插件库\` 的**包数 8**（现为 7），并出现 `host-ready` / `app-shown`；`data\home\profiles\desktop\package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里应出现 `gaia-inspection-preset` |
| **本包进成品的路径** | 属**打包/安装环节**，不在本次改动范围（本包只写到编辑侧 `build\gaia\插件库\`） | 见 §七 |
| **`agent-preset-registry` 行一定已存在** | 本包那条覆盖写的是「同 id 覆盖」，若该行不存在，补丁会被跳过（只留一行 `patch: entry not found` 告警，不致命） | 该行由内置 `web-app` 组合包插入（0.2.0-rc.1 `web-app\cordis.patch.yml:561-565`，已读代码确认）；换内核线后重核一次 |
| **技能目录在客户机上真的出现在模型可见清单** | 同「起不了壳」 | 会话里让 agent 列技能，或看它能不能加载 `inspection-checklist-dynamic` |

（本包已验证部分见 §六；成品侧一轮落地与修复见 §七）

## 七、落地与修复记录（2026-10-02 本轮，已执行）

### 1. 本包已进入交付链路的两个位置

| 位置 | 状态 |
|---|---|
| 编辑侧 `build\gaia\插件库\gaia-inspection-preset\` | ✅ 本包正本（3 文件） |
| 交付备料 `<产品区>\素材库\插件素材库\门店督导\gaia-inspection-preset\` | ✅ 已放入（安装器按订单词取件，这是进成品的入口） |

> 顺带核过：成品 `resources\gaia\插件库\` 里**还没有**本包——要等安装器按订单词再跑一次取件。本包**不是**"丢进成品目录就完事"的：没有登记进 profile 的包不会被挂载。

### 2. 本轮一并修掉的成品缺陷（门店督导，`build\products\成品区\门店督导\`）

| 缺陷 | 修复 | 实测结果 |
|---|---|---|
| 收尾报告附二 A：`…\@deepseek-ai\dsh-web-app\package.json` 带 UTF-8 BOM → 内核跳过整个 web 组合包 → 客户看不到界面 | 去掉 BOM（原 9378 B → 9375 B） | 头三字节非 `EF BB BF`；`JSON.parse` 通过；`dsh.bundle.patch` 只剩 `./cordis.patch.yml` |
| 收尾报告 L2-03：`…\dsh-web-app\cordis.patch.yml` 里 `ui-sidebar-documentpreview` 名册行悬空（该包已按 A8 删除） | 删掉那一行 + 它的 `name:` + 上方注释（566 → 563 行） | 成品全树 20 个 `cordis.patch.yml` 里 `documentpreview` 计数 = **0** |
| 收尾报告附二 D：备料侧 `gaia-inspection-action\lib\index.js` 带 BOM（会随安装器复制进成品） | 备料侧与成品侧两处都去掉 BOM（各 23101 B → 23098 B） | 成品与备料 SHA256 **完全一致** |
| 附二 E：成品零 agent 预设、`default: standard` 指向不存在的预设 | 本包（预设声明 + bundle 补丁里的注册表覆盖）；另外把 `data\home\profiles\desktop\cordis.patch.yml` 也补上同 id 覆盖 | 注册表那行实测合并结果为 `{"default":"inspection","selectedDefault":"inspection"}` |
| 附二 H：`日志库\门店督导\state.json` 不是合法 JSON | **无需修复**：本轮实测该文件已是合法 JSON（33 行、单一 `stages` 对象、无重复键） | `check-acceptance.ps1` 不再报 `state.json 读不出来` |

成品全树 BOM 终检：**15,066 个文件，带 BOM 的 0 个**。

### 3. 同步改了"缺陷源头"，否则重跑一次打包又回来

| 文件 | 改动 |
|---|---|
| `build\products\种子库\基础客户端\…\dsh-web-app\cordis.patch.yml` | 删掉同一条悬空行（与成品**逐字节一致**，SHA256 相同） |
| `build\products\种子库\基础客户端\data\home\profiles\desktop\cordis.patch.yml` | 补上 `agent-preset-registry` 覆盖（默认预设 = `inspection`） |
| `build\gaia\插件库\gaia-pipeline-master-preset\roles\打包器.md` | 新增：**A10b 改写 `package.json` 必须 UTF-8 无 BOM**（附根因与"不能拿 `ConvertFrom-Json` 当验证手段"）· **A8 删包必须同删 `cordis.patch.yml` 里的名册行**·「编码自检」写进日志 · 自检清单加 `11) 编码无 BOM` 与 `12) documentpreview 计数=0` |

> 种子库原本是**只读锁定**的（根一级子项带 Deny ACE）。本轮为改上面两处，按「解锁 → 改 → 按同一形态重新上锁」处理，改完已复测**仍然不可写**（写回被拒）。**这是本轮唯一的越界操作**：如果你们的规矩是"种子库绝对不碰"，可以改回从 `build\dist\win-unpacked\` 那份出厂源重新镜像覆盖。

### 4. `check-acceptance.ps1` 复核

```
& '<包根>\resources\gaia\插件库\gaia-pipeline-master-preset\scripts\check-acceptance.ps1' `
  -OrderDir '<产品区>\日志库\门店督导' -SkillPath '<包根>\resources\gaia\skill库\agent-acceptance\SKILL.md'
```

- 结果：**exit=0，PASS**（28 条逐项记录；防漂移已核对 28 项）。
- ⚠️ 这只说明**机读结论自身的结构与一致性通过**，不代判各条结论对不对。`日志库\门店督导\acceptance.json` 与 `收尾报告.md` 仍是**修复前**的结论（`verdict: blocked`、`blocking: [L2-03]`），本轮**没有**改它们——那两份是收尾器的产物，重测应由收尾器再跑一次四层（或由操作者裁定沿用）。

### 5. 仍然没有验的（只有真机能验）

| 项 | 怎么验 |
|---|---|
| 双击成品：界面起得来（BOM 那条的最终证明） | 双击 `成品区\门店督导\盖亚.exe` → 看界面；`data\logs\startup.log` 里应有 `host-ready` / `app-shown` |
| 新建会话真的用「门店督导」预设 | 新建会话不报 `Unknown agent preset` 即通过 |
| `seedPlugins()` 真把本包登记落盘 | `data\home\profiles\desktop\package.json` 的 `dependencies`/`dsh.profile.bundles` 里出现 `gaia-inspection-preset`；`startup.log` 的 `plugins-seeded` 从 7 变 8 |
| 4 个产品技能真的进模型可见清单 | 会话里让它加载 `inspection-checklist-dynamic` |

我没有在本会话里跑这些——**本会话起不了壳**（收尾报告 L4-03 已实测为手段限制：对照实验里构建侧 `dist\win-unpacked\盖亚.exe` 同样秒退）。

## 八、还要谁做什么（本包自己做不到的）

| 步骤 | 归属 | 说明 |
|---|---|---|
| 把本包装进成品 `resources\gaia\插件库\` | **安装器**（本单流水线） | 备料已就位（§七.1），安装器按订单词取件即可；装完 `seedPlugins()` 会在首启登记并 `pnpm install` 落盘 |
| 重跑四层验收、更新 `acceptance.json` 与 `收尾报告.md` | **收尾器** | 本轮把 L2-03（悬空行）与附二 A/D/E 都改了，旧结论已过期。**能力面 L4 仍需操作者授权** |
| 真机双击验证（§七.5） | **操作者/收尾器** | 唯一能证明"客户双击能看到界面"的手段 |

## 九、怎么核对本包与需求描述一致

| 需求描述里的固定项 | 本包落在哪 |
|---|---|
| 订单词 `门店督导` | `config.name` + persona 首行 |
| 交付形态「一个 agent、两个视图」 | persona「本单交付形态」段 |
| 交互 `text`、无语音、单张照片 | persona 硬约束 5 |
| 输入「单张照片 + 一句话（1–200 字）」 | persona 首段 + 硬约束 5 |
| 检查项动态 3–5 项 + 为什么查这几项 | persona「唯一对外差异」+ 运行链路 3 + 硬约束 6 |
| 证据回指原图（含降级） | 运行链路 4 + 硬约束 2 |
| 看不清就说看不清 | 硬约束 3 + 完成判据 6 |
| 断网只排队不判断、联网补判 | 硬约束 4 + 完成判据 7/8 |
| 到期未整改自动升级（真定时器 + 立即扫描） | 运行链路 7 + 工具清单（`inspection_scan_overdue` / `inspection_scan_status`） |
| 真调用真日志、禁补写 | 硬约束 1 + 运行链路 8 |
| 三处文案不能删 | 硬约束 9（逐字） |
| 演示数据诚实 / 中性示例名 | 硬约束 8 + 工具清单（门店档案只读） |
| 范围纪律（先问再做） | 硬约束 7 + 人格首段 |
| 付费方与价值锚点 | 「价值与口径」段 |
| 完成判据 10 项 | 「完成判据」段（逐条） |
| 不做部署 / 冻结期不动仓库 | 硬约束 10 |
