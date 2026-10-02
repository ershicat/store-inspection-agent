// gaia-inspection-registry / lib/index.js
// 宿主半：门店档案管理（能力词：门店档案管理）——**两家示例门店的静态档案**。
//
// 硬性边界（本单指令 ⑤ + 规格书 §14）：
//   · 只有 list / get 两个只读工具，**没有新增、编辑、删除**（也没有对应工具与路由）；
//   · 门店名一律**中性示例名**，不含任何真实品牌名；
//   · 不做组织架构 / 连锁总部管理（防止扩成「连锁公司管理系统」）。
//
// 档案作为种子写进 core 的 `stores` 表（storeId 即行 id），供看板门店切换与检查项生成参考。
import { resolveDefineTool } from './gaia-tools.js'

export const name = 'gaia-inspection-registry'
export const inject = ['tools']

export const NS_KEY = '__gaia_inspection__'

/** 两家示例门店的静态档案（中性示例名；业态一快餐档口、一正餐堂食）。 */
export const STORES = [
  {
    storeId: 'S-001',
    name: '示例门店·快餐档口甲',
    format: '快餐档口',
    businessHours: '06:30-21:00（高峰 11:30-13:00 / 17:30-19:30）',
    checkDimensions: ['食材与半成品', '台面与设备', '地面与通道', '三防设施'],
    focusNote: '档口出餐快、翻台高：重点看台面清洁、半成品覆盖与效期、地面油污。',
    seats: '无堂食，仅打包窗口',
    sample: true,
  },
  {
    storeId: 'S-002',
    name: '示例门店·正餐堂食乙',
    format: '正餐堂食',
    businessHours: '10:00-21:30（高峰 12:00-13:30 / 18:00-20:00）',
    checkDimensions: ['人员与卫生', '食材与半成品', '地面与通道', '标识与留样'],
    focusNote: '堂食现炒、留样与公示要求高：重点看人员卫生、留样与效期标签、通道堆放。',
    seats: '堂食 12 桌',
    sample: true,
  },
]

const OUT_SCHEMA = { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, error: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] } } }
const jsonRender = (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }]

function mkLogger(ctx) {
  const l = ctx && ctx.logger
  return {
    info: (m) => (l && typeof l.info === 'function' ? l.info(m) : undefined),
    warn: (m) => (l && typeof l.warn === 'function' ? l.warn(m) : process.stderr.write(`[gaia-inspection-registry] ${m}\n`)),
    error: (m) => (l && typeof l.error === 'function' ? l.error(m) : process.stderr.write(`[gaia-inspection-registry] ${m}\n`)),
  }
}

export async function apply(ctx, config = {}) {
  void config
  const logger = mkLogger(ctx)
  const tools = ctx && ctx.tools
  if (!tools || typeof tools.register !== 'function') {
    logger.warn('ctx.tools 不可用：未注册任何工具')
    return
  }
  const defineTool = await resolveDefineTool(ctx)
  const NSc = () => globalThis[NS_KEY] || undefined
  const db = () => {
    const ns = NSc()
    return ns && ns.db && typeof ns.db.put === 'function' ? ns.db : null
  }

  /** 把静态档案播种进 `stores` 表（幂等；只写这两家，不做任何增删改）。 */
  function ensureSeeded() {
    const d = db()
    if (!d) return { ok: false, seeded: 0, error: { code: 'DEPENDENCY_MISSING', message: '需要 ns.db，请确认 gaia-inspection-core 已加载' } }
    let seeded = 0
    for (const s of STORES) {
      const prev = d.get('stores', s.storeId)
      if (!prev) {
        d.put('stores', { id: s.storeId, ...s, source: 'static-seed' })
        seeded += 1
      }
    }
    return { ok: true, seeded, total: STORES.length }
  }

  function listStores() {
    const d = db()
    if (d) ensureSeeded()
    return { ok: true, stores: STORES.map((s) => ({ ...s })) }
  }

  function getStore(storeId) {
    const key = String(storeId || '').trim()
    const hit = STORES.find((s) => s.storeId === key)
    if (!hit) return { ok: true, data: null, summary: `没有这家门店：${key}` }
    return { ok: true, data: { ...hit } }
  }

  const seedResult = ensureSeeded()
  if (!seedResult.ok) logger.warn(`门店档案未能写入 stores 表：${seedResult.error.message}（稍后调用工具时会重试）`)
  else logger.info(`门店档案已就绪：${STORES.length} 家静态示例门店（本次新播 ${seedResult.seeded} 条）`)

  // ── 槽位发布（演示重置需要重播档案） ──
  const ns = (globalThis[NS_KEY] ??= {})
  ns.registry = { listStores, getStore, ensureSeeded, stores: STORES }

  const reg = []
  const wrap = (opts) => reg.push(tools.register(defineTool({ ...opts, output: { schema: OUT_SCHEMA, render: jsonRender } })))

  wrap({
    name: 'inspection_list_stores',
    description: '列出本单的两家示例门店静态档案（门店名 / 业态 / 营业时段 / 默认检查维度倾向 / 关注重点）。只读，且本系统**不支持**门店新增、编辑、删除。',
    parameters: {},
    async execute() {
      const r = listStores()
      return { ok: true, summary: `共 ${r.stores.length} 家示例门店：${r.stores.map((s) => `${s.storeId} ${s.name}`).join('；')}`, data: { total: r.stores.length, stores: r.stores, readonly: true, crudSupported: false }, error: null }
    },
  })

  wrap({
    name: 'inspection_get_store',
    description: '按 storeId 取一家门店的静态档案（供看板门店切换与检查项生成参考）。找不到时返回结构化空态，不报错、不杜撰。',
    parameters: {
      storeId: { type: 'string', required: true, description: '门店标识，如 S-001' },
    },
    async execute(args) {
      const r = getStore(args.storeId)
      if (!r.data) return { ok: false, summary: r.summary, data: null, error: { code: 'STORE_NOT_FOUND', message: `没有这家门店：${args.storeId}（本单只有 S-001 / S-002）` } }
      return { ok: true, summary: `${r.data.storeId}｜${r.data.name}（${r.data.format}）`, data: r.data, error: null }
    },
  })

  return () => {
    for (const d of reg) {
      try {
        if (typeof d === 'function') d()
      } catch {
        /* 幂等 */
      }
    }
    const g = globalThis[NS_KEY]
    if (g && g.registry && typeof g.registry.listStores === 'function') delete g.registry
  }
}
