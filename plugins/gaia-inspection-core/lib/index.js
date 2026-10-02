// gaia-inspection-core / lib/index.js
// 宿主半：巡店数据落库（六张表）+ 模型调用日志留存 + 检查项动态生成（真模型调用）。
// 承担能力词：巡店数据落库 / 模型调用日志留存 / 检查项动态生成。
//
// 对外两件事：
//   ① 注册 5 个工具（inspection_record_save / inspection_query / inspection_counts /
//      inspection_generate_checklist / inspection_model_calls）；
//   ② 在宿主全局注册表 `globalThis.__gaia_inspection__` 上发布 `db`（业务库读写口，
//      **只供同单其它插件在运行期取用**，不做跨包 import）与 `checklist`（检查项生成口），
//      并注册前端要的三条只读路由 + 三条前端按钮必需的口（见 lib/routes.js 顶部说明）。
//
// 纪律：模型调用一律走宿主 `ctx.llm.stream(...)`（见 lib/modelroute.js），
//       本包不读凭据、不写 key、不做任何 if-else 兜底判断。
import { resolveDefineTool } from './gaia-tools.js'
import * as store from './store.js'
import { generateChecklist, DIMENSION_HINTS, CHECKLIST_SYSTEM } from './checklist.js'
import { registerRoutes } from './routes.js'

export const name = 'gaia-inspection-core'
export const inject = ['tools']

export const NS_KEY = '__gaia_inspection__'

function mkLogger(ctx) {
  const l = ctx && ctx.logger
  return {
    info: (m) => (l && typeof l.info === 'function' ? l.info(m) : undefined),
    warn: (m) => (l && typeof l.warn === 'function' ? l.warn(m) : process.stderr.write(`[gaia-inspection-core] ${m}\n`)),
    error: (m) => (l && typeof l.error === 'function' ? l.error(m) : process.stderr.write(`[gaia-inspection-core] ${m}\n`)),
  }
}

const OUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
    // 宿主输出校验的受限 schema 方言不支持 `type` 数组，也禁止 `type` 与 `oneOf` 并存，
    // 所以「成功返回 error: null / 失败返回 error: {code,message}」必须用 oneOf 表达。
    error: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
  },
}

function jsonRender(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** 会话内结果卡片（presentResult）：只在形状可解析时给，任何异常都退回 undefined。 */
function card(title, summaryOf, sectionsOf) {
  return (args, result) => {
    try {
      if (!result || result.ok === false) return undefined
      return { kind: 'generic', title, summary: summaryOf(result), sections: sectionsOf(result) }
    } catch {
      return undefined
    }
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

  store.ensureDirs()
  const loaded = store.loadAll()
  logger.info(`本地库已加载：${Object.entries(loaded).map(([k, v]) => `${k}=${v}`).join(' ')}（根目录 ${store.dataRoot()}）`)

  // ── 模型调用日志写入端口：调用发生的那一刻写 start，结束后 patch 终态 ──
  const modelLog = {
    logStart: (row) => store.put('model_calls', { ...row, ts: row.ts || store.nowIso() }),
    logEnd: (callId, patch) => store.patch('model_calls', callId, patch),
  }

  // ── 槽位注册（同单其它包在运行期取用，不做跨包 import） ──
  const ns = (globalThis[NS_KEY] ??= {})
  ns.db = {
    tables: store.TABLES,
    businessTables: store.BUSINESS_TABLES,
    put: (t, r) => store.put(t, r),
    patch: (t, id, f) => store.patch(t, id, f),
    get: (t, id) => store.get(t, id),
    del: (t, id) => store.del(t, id),
    all: (t) => store.all(t),
    where: (t, p) => store.where(t, p),
    counts: () => store.counts(),
    clearTables: (ts) => store.clearTables(ts),
    modelCalls: () => store.modelCalls(),
    normalizeCallRow: (r) => store.normalizeCallRow(r),
    dataRoot: () => store.dataRoot(),
    tablePath: (t) => store.tablePath(t),
    photoDir: () => store.photoDir(),
    thumbDir: () => store.thumbDir(),
    queueDir: () => store.queueDir(),
    logDir: () => store.logDir(),
    newId: (t, at) => store.newId(t, at),
    nowIso: () => store.nowIso(),
  }
  ns.modelLog = modelLog
  ns.checklist = {
    generate: (args) => generateChecklist({ ctx, logger: modelLog }, args || {}),
    dimensionHints: DIMENSION_HINTS,
  }

  const reg = []
  const wrap = (opts) => {
    const def = { ...opts, output: { schema: OUT_SCHEMA, render: jsonRender } }
    if (opts.card) {
      def.presentResult = opts.card
      delete def.card
    }
    reg.push(tools.register(defineTool(def)))
  }

  // ① 巡店数据落库（写）
  wrap({
    name: 'inspection_record_save',
    description: '把巡店业务数据写入本地库的六张表之一（stores/inspections/findings/evidences/actions/model_calls 之外的业务表由本工具写；model_calls 只由模型调用日志端口写，禁止手工补写）。返回落库后的行与各表计数。',
    parameters: {
      table: { type: 'string', enum: ['stores', 'inspections', 'findings', 'evidences', 'actions'], required: true, description: '目标表名（逐字）' },
      row: { type: 'object', additionalProperties: true, required: true, description: '要落库的行（缺 id 时自动生成）' },
    },
    async execute(args) {
      const table = String(args.table || '')
      if (!store.TABLES.includes(table) || table === 'model_calls') {
        return { ok: false, error: { code: 'BAD_TABLE', message: `不支持的写入表：${table}。model_calls 由模型调用日志端口在调用发生时刻写入，禁止手工补写。` } }
      }
      const row = store.put(table, args.row || {})
      return { ok: true, summary: `${table} 已落库：${row.id}`, data: { table, row, counts: store.counts() }, error: null }
    },
  })

  // ② 查询
  wrap({
    name: 'inspection_query',
    description: '查询本地库六张表里的记录（可按 id 精确取一行，或按字段等值过滤；默认按创建时间倒序，默认最多 50 条）。只读。',
    parameters: {
      table: { type: 'string', enum: store.TABLES, required: true, description: '表名（逐字）' },
      id: { type: 'string', description: '可选：按 id 精确取一行' },
      filter: { type: 'object', additionalProperties: true, description: '可选：字段等值过滤（浅比较）' },
      limit: { type: 'number', description: '可选：最多返回条数，默认 50，上限 500' },
    },
    async execute(args) {
      const table = String(args.table || '')
      if (!store.TABLES.includes(table)) return { ok: false, error: { code: 'BAD_TABLE', message: `未知表：${table}` } }
      if (args.id) {
        const row = table === 'model_calls' ? store.normalizeCallRow(store.get(table, args.id) || {}) : store.get(table, args.id)
        return { ok: true, summary: row ? `命中 1 行：${args.id}` : `未命中：${args.id}`, data: { table, rows: row ? [row] : [] }, error: null }
      }
      const limit = Math.min(500, Math.max(1, Number(args.limit) || 50))
      let rows = table === 'model_calls' ? store.modelCalls().map(store.normalizeCallRow) : store.all(table)
      if (args.filter && typeof args.filter === 'object') {
        const f = args.filter
        rows = rows.filter((r) => Object.entries(f).every(([k, v]) => r[k] === v))
      }
      rows = rows
        .slice()
        .sort((a, b) => String(b.createdAt || b.ts || '').localeCompare(String(a.createdAt || a.ts || '')))
        .slice(0, limit)
      return { ok: true, summary: `${table} 返回 ${rows.length} 行`, data: { table, total: store.counts()[table], rows }, error: null }
    },
  })

  // ③ 表计数（落库能力的最直接证据面）
  wrap({
    name: 'inspection_counts',
    description: '返回六张表的行数与各自的本地库文件绝对路径，用于核对"数据真的落库了、重启后还在"。',
    parameters: {},
    async execute() {
      const c = store.counts()
      return { ok: true, summary: `六张表：${store.TABLES.map((t) => `${t}=${c[t]}`).join(' ')}`, data: c, error: null }
    },
    card: card('本地库表计数', (r) => store.TABLES.map((t) => `${t}=${r.data[t]}`).join(' '), (r) => [{ title: '表与文件', lines: store.TABLES.map((t) => `${t}：${r.data[t]} 行 → ${r.data.files[t]}`) }]),
  })

  // ④ 检查项动态生成（真模型调用；本文件里没有固定清单）
  wrap({
    name: 'inspection_generate_checklist',
    description: '按本次门店业态与采集内容，由模型动态决定这次要查哪几项，并给出「本次为什么查这几项」的理由列表。真模型调用；模型不可用或输出不合法时返回可诊断错误，不会套用预设清单。注意两点：① **采集提交路径会把本次照片作为图像输入一并送入**（generateChecklist 支持 photos），本工具被直接调用时没有图片通道，只能给 photoHints 文字线索；② 本次参考的**检查标准**来自可注入的 standards.json（客户可写区优先，插件目录次之，都没有则用内置参考维度），标准只是参考维度、不是本次清单——模型仍按本次照片与说明增删。',
    parameters: {
      storeId: { type: 'string', description: '门店标识（可空）' },
      storeName: { type: 'string', description: '门店名（可空）' },
      storeType: { type: 'string', description: '业态：快餐档口 / 正餐堂食 等' },
      note: { type: 'string', description: '本次采集时店长附的一句话说明' },
      photoHints: { type: 'array', items: { type: 'string' }, description: '本次照片的机器可见线索（原样给出，未做判断）' },
      inspectionId: { type: 'string', description: '可选：把生成的检查项写回该检查单' },
      provider: { type: 'string', description: '可选：显式指定 provider（默认用宿主当前模型选择）' },
      model: { type: 'string', description: '可选：显式指定 model' },
      timeoutMs: { type: 'number', description: '可选：超时毫秒，默认 120000' },
    },
    async execute(args) {
      const r = await generateChecklist({ ctx, logger: modelLog }, args || {})
      if (!r.ok) return { ok: false, summary: `检查项生成失败：${r.error.code}`, data: { callId: r.callId, error: r.error }, error: r.error }
      let saved = null
      if (args.inspectionId) {
        const ins = store.get('inspections', String(args.inspectionId))
        if (ins) saved = store.put('inspections', { ...ins, id: ins.id, items: r.data.items, reasons: r.data.reasons, checklistCallId: r.callId })
      }
      return {
        ok: true,
        summary: `生成 ${r.data.items.length} 项检查项（${r.provider}/${r.model}，${r.latencyMs}ms，callId=${r.callId}）；参考标准：${r.data.standards.version}`,
        data: { items: r.data.items, reasons: r.data.reasons, standards: r.data.standards, callId: r.callId, provider: r.provider, model: r.model, latencyMs: r.latencyMs, savedTo: saved ? saved.id : null },
        error: null,
      }
    },
    card: card('检查项动态生成', (r) => r.summary, (r) => [
      { title: '本次参考的检查标准', lines: [r.data.standards ? `${r.data.standards.version}（来源：${r.data.standards.source === 'injected' ? '客户注入' : r.data.standards.source === 'packaged' ? '随包交付' : '内置兜底'}，维度 ${r.data.standards.count} 条${r.data.standards.path ? '，文件 ' + r.data.standards.path : ''}）` : '（未记录）'] },
      { title: '本次检查项', lines: r.data.items.map((i) => `${i.name}（权重 ${i.weight ?? '未标注'}）｜为什么查：${i.why || '模型未给'} `) },
      { title: '为什么查这几项', lines: [r.data.reasons || '（模型未给理由）'] },
    ]),
  })

  // ⑤ 模型调用日志查询（留存的读取面）
  wrap({
    name: 'inspection_model_calls',
    description: '读模型调用日志（每次调用在调用发生时刻写入一条真实记录：时间/provider/model/用途/门店与检查单/耗时/usage/状态/错误码）。可按 kind 或 storeId 过滤。只读，且演示重置不会清空它。',
    parameters: {
      kind: { type: 'string', description: '可选：按用途过滤，如 vision_judge / checklist_generate' },
      storeId: { type: 'string', description: '可选：按门店过滤' },
      limit: { type: 'number', description: '可选：最多返回条数，默认 50' },
    },
    async execute(args) {
      let rows = store.modelCalls().map(store.normalizeCallRow)
      if (args.kind) rows = rows.filter((r) => r.kind === String(args.kind))
      if (args.storeId) rows = rows.filter((r) => r.storeId === String(args.storeId))
      const total = rows.length
      rows = rows.slice(-Math.min(500, Math.max(1, Number(args.limit) || 50)))
      return { ok: true, summary: `模型调用记录 ${total} 条（本次返回 ${rows.length} 条）`, data: { total, logFile: store.tablePath('model_calls'), calls: rows }, error: null }
    },
    card: card('模型调用日志', (r) => r.summary, (r) => [
      { title: '调用记录（最近）', lines: r.data.calls.slice(-10).map((c) => `${c.ts}｜${c.provider}/${c.model}｜${c.kind}｜${c.latencyMs ?? '?'}ms｜${c.status}${c.errorCode ? `｜${c.errorCode}` : ''}`) },
    ]),
  })

  // ── 路由 ──
  // 【真机实测必须项】`webServer` 必须按**声明式依赖**等，不能在 apply 里同步 `ctx.get('webServer')`。
  // 本包只声明了 `tools`，apply 会早于 dsh-host-webserver 提供服务就绪；而 cordis 的 ctx.get(name)
  // 对「提供者 fiber 还没 active」的服务一律返回 undefined（kernel: ReflectService.get → _getImpl(name, strict)）。
  // 后果：lib/routes.js 里六条 /api/gaia-inspection/* 一条都不注册，前端看板/采集/日志全部 404
  // （真机实测：/api/gaia-inspection/snapshot → 404 "not found"，而同机 UI 包自带路由 200）。
  // 用 ctx.inject(['webServer'], …)：服务一就绪就注册路由，且**不占用本包工具原有的装载时机**
  // （未声明 webServer 的环境里工具照旧可用，只是没有 HTTP 口）。
  const mountRoutes = (routeCtx) => {
    const routes = registerRoutes(routeCtx, () => globalThis[NS_KEY], logger)
    if (routes.registered.length > 0) logger.info(`已注册路由：${routes.registered.join(', ')}`)
    return routes.dispose
  }
  let disposeRoutes = () => {}
  if (ctx && typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (webCtx) => {
      disposeRoutes = mountRoutes(webCtx)
      return () => {
        try {
          disposeRoutes()
        } catch {
          /* 幂等 */
        }
      }
    })
  } else {
    // 自测垫片没有 cordis 的 inject：退回同步路径（拿不到就由 routes.js 照旧告警）。
    disposeRoutes = mountRoutes(ctx)
  }

  return () => {
    disposeRoutes()
    for (const d of reg) {
      try {
        if (typeof d === 'function') d()
      } catch {
        /* 幂等 */
      }
    }
    const g = globalThis[NS_KEY]
    if (g) {
      if (g.db && typeof g.db.put === 'function') delete g.db
      if (g.checklist && typeof g.checklist.generate === 'function') delete g.checklist
      if (g.modelLog) delete g.modelLog
    }
  }
}

export { generateChecklist, CHECKLIST_SYSTEM, DIMENSION_HINTS }
export * as store from './store.js'
