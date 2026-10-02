# gaia-inspection-registry — 门店档案管理

> 订单词：**门店督导** ｜ 承担能力词（逐字）：`门店档案管理`
> 包名：`@gaia/dsh-inspection-registry` ｜ 形态：插件（host 半，无 client 半，不会白屏）

## 1. 职责

维护**两家示例门店的静态档案**，作为种子写进 core 的 `stores` 表（`storeId` 即行 `id`），供看板门店切换与检查项生成参考。

| storeId | 门店名（中性示例名） | 业态 | 默认检查维度倾向 |
|---|---|---|---|
| `S-001` | 示例门店·快餐档口甲 | 快餐档口 | 食材与半成品 / 台面与设备 / 地面与通道 / 三防设施 |
| `S-002` | 示例门店·正餐堂食乙 | 正餐堂食 | 人员与卫生 / 食材与半成品 / 地面与通道 / 标识与留样 |

每店另带 `businessHours`（营业时段）、`focusNote`（关注重点）、`seats`、`sample:true`。

## 2. 工具（2 个；`manifest.json` 的 `tools` 与注册名逐字一致）

| 工具名 | 用途 |
|---|---|
| `inspection_list_stores` | 列出两家示例门店档案（只读，返回体显式带 `readonly:true, crudSupported:false`）。 |
| `inspection_get_store` | 按 `storeId` 取单店档案；找不到 → 结构化错误 `STORE_NOT_FOUND`（**不杜撰**）。 |

## 3. 明确不做（指令 ⑤ + 规格书 §14）

- **没有新增 / 编辑 / 删除**：既没有对应工具，也没有对应路由，`stores` 表也不开放写工具（只有 core 的 `inspection_record_save` 能写 `stores`，且本包自己不调用它做增删改）。
- **没有真实品牌名**：全部是「示例门店·…」中性名。
- **不做组织架构 / 连锁总部管理**（防止扩成「连锁公司管理系统」）。

## 4. 依赖

- `peerDependencies`（宿主提供，不搬）：`@deepseek-ai/dsh-tools`。`dependencies`：**零第三方**。
- 运行期依赖 `ns.db`（core）。缺它时 `ensureSeeded()` 失败并打警告，工具仍能返回静态档案（**档案是随包常量，不依赖库**）。

## 5. 空架说明

`stores` 表为空时，本包在 `apply()` 里播种 2 条（幂等：已存在就不覆盖，避免把演示中改过的状态冲掉）。演示重置**不清 `stores`**（它是静态档案，不属于演示业务数据）。

## 6. 本机自检怎么跑

见 `../gaia-inspection-core/README.md` 第 7 节；本包判据在 `_harness/selftest.mjs` 的 T4 段（两家、只读、无增删改工具、中性名）。
