// gaia-inspection-demo / lib/index.js
// 宿主半：演示样例与状态重置（能力词：演示样例与状态重置）。
//
// 两条硬边界（§4 红线 + 规格书 §15）：
//   ① **重置只清业务表与待判队列**：inspections / findings / evidences / actions + 待判队列；
//      `model_calls`（模型调用日志）**一行都不动**（返回体里显式回 kept:['model_calls']）；
//      `stores`（门店档案）是静态档案，也不清（保持两家示例门店可用）。
//   ② 演示样例**不冒充模型判断**：样例行带 `demo:true`、`demoLabel`、`judgedBy:'demo-sample（未调用模型）'`，
//      且**不向 model_calls 写任何记录**（样例加载前后 model_calls 计数必须相等）。
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { resolveDefineTool } from './gaia-tools.js'
import { DEMO_IMAGE_LABEL, writeSamples } from './samples.js'

export const name = 'gaia-inspection-demo'
export const inject = ['tools']

export const NS_KEY = '__gaia_inspection__'

const OUT_SCHEMA = { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, error: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] } } }
const jsonRender = (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }]

function mkLogger(ctx) {
  const l = ctx && ctx.logger
  return {
    info: (m) => (l && typeof l.info === 'function' ? l.info(m) : undefined),
    warn: (m) => (l && typeof l.warn === 'function' ? l.warn(m) : process.stderr.write(`[gaia-inspection-demo] ${m}\n`)),
    error: (m) => (l && typeof l.error === 'function' ? l.error(m) : process.stderr.write(`[gaia-inspection-demo] ${m}\n`)),
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
  const cap = () => {
    const ns = NSc()
    return ns && ns.capture && typeof ns.capture.paths === 'function' ? ns.capture : null
  }

  function newRunId(prefix) {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${d.getHours()}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`
  }

  /** 只删演示行（demo:true），绝不碰真实业务数据与日志。 */
  function dropDemoRows(d) {
    let dropped = 0
    for (const t of ['actions', 'evidences', 'findings', 'inspections']) {
      for (const row of d.all(t)) {
        if (row && row.demo === true) {
          d.del(t, row.id)
          dropped += 1
        }
      }
    }
    return dropped
  }

  // ── ① 状态重置 ──────────────────────────────────────────────────────────────
  function resetDemo(args = {}) {
    const d = db()
    if (!d) return { ok: false, runId: null, status: 'failed', summary: '巡店业务库未就绪', data: null, artifacts: [], traceRef: null, error: { code: 'DEPENDENCY_MISSING', message: '需要 ns.db，请确认 gaia-inspection-core 已加载' } }
    const before = d.counts()
    const c = cap()
    const queueFile = c ? c.paths().queueDir : d.queueDir()
    let queueCleared = false
    try {
      mkdirSync(queueFile, { recursive: true })
      writeFileSync(join(queueFile, 'pending.jsonl'), '', 'utf8')
      queueCleared = true
    } catch (error) {
      logger.warn(`待判队列清空失败：${String((error && error.message) || error)}`)
    }
    const cleared = d.clearTables(['inspections', 'findings', 'evidences', 'actions'])
    const after = d.counts()
    const modelCallsBefore = before.model_calls
    const modelCallsAfter = after.model_calls
    const dropped = modelCallsBefore - modelCallsAfter
    const runId = newRunId('RESET')
    return {
      ok: dropped === 0,
      runId,
      status: dropped === 0 ? 'completed' : 'failed',
      summary: `重置完成：清空 ${cleared.join('、')} 与待判队列；model_calls 保留 ${modelCallsAfter} 条（${modelCallsBefore} → ${modelCallsAfter}，未减）`,
      data: {
        cleared: [...cleared, 'pending_queue'],
        queueCleared,
        kept: ['model_calls', 'stores'],
        keptReason: {
          model_calls: '§4 红线：模型调用日志不许事后补写、不许被演示重置清空',
          stores: '门店档案是静态种子（两家示例门店），不属于本次演示业务数据',
        },
        counts: { before, after },
        modelCalls: { before: modelCallsBefore, after: modelCallsAfter, dropped },
      },
      artifacts: [],
      traceRef: `reset/${runId}`,
      error: dropped === 0 ? null : { code: 'MODEL_CALLS_LOST', message: `model_calls 在重置中减少了 ${dropped} 条：违反 §4 红线，请立即排查` },
    }
  }

  // ── ② 演示样例 ──────────────────────────────────────────────────────────────
  async function loadSamples(args = {}) {
    const d = db()
    if (!d) return { ok: false, runId: null, status: 'failed', summary: '巡店业务库未就绪', data: null, artifacts: [], traceRef: null, error: { code: 'DEPENDENCY_MISSING', message: '需要 ns.db，请确认 gaia-inspection-core 已加载' } }
    const registry = (() => {
      const ns = NSc()
      return ns && ns.registry ? ns.registry : null
    })()
    if (registry && typeof registry.ensureSeeded === 'function') registry.ensureSeeded()
    const modelCallsBefore = d.counts().model_calls
    const c = cap()
    const photoDir = c ? c.paths().photoDir : d.photoDir()
    const samples = writeSamples(photoDir)
    const byKey = Object.fromEntries(samples.map((s) => [s.key, s]))

    let droppedRows = 0
    if (args.replaceDemo !== false) droppedRows = dropDemoRows(d)

    const stores = registry && typeof registry.listStores === 'function' ? registry.listStores().stores : []
    const storeOf = (id) => stores.find((s) => s.storeId === id) || { storeId: id, name: id, format: '未标注' }
    const at = new Date()
    const iso = (ms) => new Date(ms).toISOString()
    const nowMs = at.getTime()
    const runId = newRunId('DEMO')
    const created = { inspections: [], findings: [], actions: [], evidences: [] }

    /** 造一张检查单（demo:true，明确标注不来自模型判断）。 */
    function makeInspection({ key, storeId, note, status, dueAt, photos, items, reasons, unreadable }) {
      const s1 = storeOf(storeId)
      const ins = d.put('inspections', {
        id: `${runId}-${key}`,
        storeId,
        storeName: s1.name,
        storeType: s1.format,
        note,
        status,
        source: 'demo-sample',
        demo: true,
        demoLabel: DEMO_IMAGE_LABEL,
        judgedBy: 'demo-sample（未调用模型）',
        createdAt: iso(nowMs - 3 * 3600 * 1000),
        dueAt: dueAt || null,
        items: items || [],
        reasons: reasons || '',
        unreadable: unreadable || [],
        photos: photos.map((p) => ({ photoId: p.photoId, name: p.name, thumbPath: null })),
      })
      created.inspections.push(ins.id)
      return ins
    }

    function makeFinding({ ins, s, itemName, severity, reason, suggestion, boxes, dueAt, status }) {
      const f = d.put('findings', {
        inspectionId: ins.id,
        storeId: ins.storeId,
        itemName,
        severity,
        reason,
        suggestion,
        boxes,
        photoId: s.photoId,
        originalPath: s.originalPath,
        photoIndex: 0,
        status: status || 'pending_rectify',
        dueAt: dueAt || null,
        source: 'demo-sample',
        demo: true,
        judgedBy: 'demo-sample（未调用模型）',
      })
      created.findings.push(f.id)
      d.put('evidences', {
        findingId: f.id,
        inspectionId: ins.id,
        photoId: s.photoId,
        originalPath: s.originalPath,
        width: s.width,
        height: s.height,
        photoIndex: 0,
        capturedAt: ins.createdAt,
        demo: true,
      })
      created.evidences.push(1)
      return f
    }

    // ① 达标态：同一门店（S-001）这一次没问题
    const insOk = makeInspection({
      key: 'OK',
      storeId: 'S-001',
      note: '演示样例：开档前自查，台面与地面已清洁，无异常。',
      status: 'rectified',
      dueAt: null,
      photos: [byKey.clean],
      items: [
        { itemId: 'obs-1', name: '台面与设备', why: '开档前自查的重点项', weight: 4 },
        { itemId: 'obs-2', name: '地面与通道', why: '开档前自查的重点项', weight: 3 },
      ],
      reasons: '演示样例：本次输入为开档前自查，仅列台面与地面两项。',
    })

    // ② 问题态：同一门店这一次有两条问题 → 由 action 状态机生成「整改要求」
    const insIssue = makeInspection({
      key: 'ISSUE',
      storeId: 'S-001',
      note: '演示样例：地面有散落杂物，操作台角落有污渍。',
      status: 'pending_rectify',
      dueAt: null,
      photos: [byKey.issue],
      items: [
        { itemId: 'obs-3', name: '地面与通道', why: '照片里地面出现散落杂物', weight: 5 },
        { itemId: 'obs-4', name: '台面与设备', why: '操作台角落存在污渍', weight: 4 },
      ],
      reasons: '演示样例：本次输入为地面与台面异常，列出与异常直接相关的两项。',
    })
    const f1 = makeFinding({
      ins: insIssue,
      s: byKey.issue,
      itemName: '地面与通道',
      severity: '高',
      reason: '演示样例：画面左下的地面上有深色散落杂物，挡在过道边。',
      suggestion: '立即清扫并在 2 小时内复查',
      boxes: [{ x: 0.15, y: 0.66, w: 0.22, h: 0.18, photoIndex: 0 }],
    })
    const f2 = makeFinding({
      ins: insIssue,
      s: byKey.issue,
      itemName: '台面与设备',
      severity: '中',
      reason: '演示样例：操作台右下的台面上有一摊深色污渍。',
      suggestion: '清洁台面并检查清洁频次记录',
      boxes: [],
    })

    // ③ 逾期态：另一家门店，截止时间早就过了（下一次扫描/立即扫描会把它变逾期并生成催办）
    const insLate = makeInspection({
      key: 'LATE',
      storeId: 'S-002',
      note: '演示样例：留样标签缺失，已要求整改但一直未完成。',
      status: 'pending_rectify',
      dueAt: iso(nowMs - 10 * 3600 * 1000),
      photos: [byKey.issue],
      items: [{ itemId: 'obs-5', name: '标识与留样', why: '堂食留样与效期标签要求高', weight: 5 }],
      reasons: '演示样例：本次输入为留样与标识异常。',
    })
    makeFinding({
      ins: insLate,
      s: byKey.issue,
      itemName: '标识与留样',
      severity: '中',
      reason: '演示样例：留样容器上没有效期标签。',
      suggestion: '补写效期标签并留存拍照',
      boxes: [{ x: 0.42, y: 0.6, w: 0.3, h: 0.22, photoIndex: 0 }],
      dueAt: iso(nowMs - 10 * 3600 * 1000),
    })

    // ④ 看不清态：**不产生任何问题判断**（findings 为空），如实标为看不清
    const insUnreadable = makeInspection({
      key: 'UNREADABLE',
      storeId: 'S-001',
      note: '演示样例：这张照片拍偏又失焦。',
      status: 'unreadable',
      dueAt: null,
      photos: [byKey.unreadable],
      items: [],
      reasons: '',
      unreadable: [{ photoIndex: 0, photoId: byKey.unreadable.photoId, why: '演示样例：整幅失焦、明显过暗，看不清地面与台面细节（未产生问题判断）' }],
    })

    // 由 action 状态机补「整改要求」动作（保持与真实链路同一处生成，不手写动作行）
    const ns = NSc()
    const act = ns && ns.action && typeof ns.action.planForInspection === 'function' ? ns.action : null
    let plan = null
    if (act) {
      plan = {
        issue: act.planForInspection({ inspectionId: insIssue.id }),
        late: act.planForInspection({ inspectionId: insLate.id }),
      }
      created.actions = [].concat(plan.issue && plan.issue.ok ? plan.issue.data.actionsCreated : [], plan.late && plan.late.ok ? plan.late.data.actionsCreated : [])
    }

    // 摘要里补上照片与缩略图 id（缩略图交给 capture 的缩略工具生成，若它在场）
    const photosOut = samples.map((s) => ({ key: s.key, photoId: s.photoId, width: s.width, height: s.height, label: s.label, url: `/api/gaia-inspection/photo?id=${s.photoId}&kind=original`, thumbUrl: `/api/gaia-inspection/photo?id=${s.photoId}&kind=thumb` }))
    let thumbs = 0
    const capSlot = cap()
    if (capSlot && typeof capSlot.thumb === 'function') {
      for (const s of samples) {
        try {
          const r = await capSlot.thumb({ photoId: s.photoId })
          if (r && r.ok) thumbs += 1
        } catch (error) {
          logger.warn(`样例缩略图生成失败（${s.key}）：${String((error && error.message) || error)}`)
        }
      }
    }

    const modelCallsAfter = d.counts().model_calls
    const warnings = []
    if (!act) warnings.push('ns.action 未就绪：样例的「整改要求」动作未生成')
    if (thumbs < samples.length) warnings.push(`样例缩略图只生成了 ${thumbs}/${samples.length} 张（看板小图会退化为原图）`)
    return {
      ok: modelCallsAfter === modelCallsBefore,
      runId,
      status: modelCallsAfter === modelCallsBefore ? 'completed' : 'failed',
      summary: `演示样例已载入：${created.inspections.length} 张检查单（达标态 / 问题态 / 逾期态 / 看不清态）、${created.findings.length} 条判断、${created.actions.length} 条动作；${samples.length} 张合成示例图。未调用模型，model_calls 保持 ${modelCallsAfter} 条。`,
      data: {
        demoLabel: DEMO_IMAGE_LABEL,
        judgedBy: 'demo-sample（未调用模型）',
        replaceDemo: args.replaceDemo !== false,
        droppedDemoRows: droppedRows,
        inspections: created.inspections,
        findings: created.findings,
        actions: created.actions,
        evidences: created.evidences.length,
        photos: photosOut,
        thumbsGenerated: thumbs,
        modelCalls: { before: modelCallsBefore, after: modelCallsAfter },
        variants: [
          { key: 'OK', inspectionId: insOk.id, store: 'S-001', state: '达标态（无问题项）' },
          { key: 'ISSUE', inspectionId: insIssue.id, store: 'S-001', state: `问题态（${f1.severity}/${f2.severity} 两条，已生成整改要求）` },
          { key: 'LATE', inspectionId: insLate.id, store: 'S-002', state: '逾期态（截止已过 10 小时，扫描后会变逾期+催办）' },
          { key: 'UNREADABLE', inspectionId: insUnreadable.id, store: 'S-001', state: '看不清态（未产生问题判断）' },
        ],
        warnings,
      },
      artifacts: photosOut.map((p) => ({ name: `${p.key}.png`, type: 'image', photoId: p.photoId, label: p.label })),
      traceRef: `demo/${runId}`,
      error: modelCallsAfter === modelCallsBefore ? null : { code: 'MODEL_CALLS_CHANGED', message: '载入演示样例时 model_calls 计数发生了变化（样例不应写日志）' },
    }
  }

  const reg = []
  const wrap = (opts) => reg.push(tools.register(defineTool({ ...opts, output: { schema: OUT_SCHEMA, render: jsonRender } })))

  wrap({
    name: 'inspection_load_samples',
    description: '载入现场演示用样例：同一门店（S-001）的达标态与问题态、另一门店的逾期态、以及一张看不清的照片态；四点都带 demo 标记与「合成示例图（非真实门店照片）」，样例判断明确标注为未调用模型。默认先清掉上一次的 demo 行（replaceDemo），不动真实业务数据与 model_calls。',
    parameters: {
      replaceDemo: { type: 'boolean', description: '可选：是否先清掉上一次的 demo 行，默认 true' },
    },
    async execute(args) {
      const r = await loadSamples(args || {})
      return { ok: r.ok, summary: r.summary, data: r.data, error: r.error, runId: r.runId, status: r.status, artifacts: r.artifacts, traceRef: r.traceRef }
    },
  })

  wrap({
    name: 'inspection_reset_demo',
    description: '演示状态重置：清空业务表（inspections/findings/evidences/actions）与待判队列，**保留 model_calls**（模型调用日志，§4 红线：不许清空）与 stores（静态门店档案）。返回 cleared / kept / 重置前后计数对照，供现场演示前复位。',
    parameters: {},
    async execute() {
      const r = resetDemo({})
      return { ok: r.ok, summary: r.summary, data: r.data, error: r.error, runId: r.runId, status: r.status, artifacts: r.artifacts, traceRef: r.traceRef }
    },
  })

  const ns = (globalThis[NS_KEY] ??= {})
  ns.demo = {
    reset: resetDemo,
    loadSamples,
    dropDemoRows: () => dropDemoRows(db()),
    /**
     * 取一张合成演示样例（给前端的「载入示例」按钮填表用）：
     * 返回 dataURL 与标注，**不含任何判断结果**——提交仍走真实的 /submit 模型调用。
     */
    samplePhoto: (key = 'issue') => {
      const samples = writeSamples(cap() ? cap().paths().photoDir : d_photoDirSafe())
      const hit = samples.find((s) => s.key === String(key)) || samples.find((s) => s.key === 'issue') || samples[0]
      if (!hit) return { ok: false, error: { code: 'NO_SAMPLE', message: '没有可用的合成演示样例' } }
      return {
        ok: true,
        data: {
          key: hit.key,
          name: hit.name,
          mediaType: hit.mediaType,
          width: hit.width,
          height: hit.height,
          dataUrl: `data:${hit.mediaType};base64,${hit.bytes.toString('base64')}`,
          label: hit.label,
          // 明确：这只是合成示例图，不含判断结论；提交后由真模型判读
          notice: '合成示例图，未调用模型；点击提交后由模型真实判读',
        },
      }
    },
  }

  function d_photoDirSafe() {
    const d = db()
    return d && typeof d.photoDir === 'function' ? d.photoDir() : join(String(process.env.GAIA_INSPECTION_DATA || process.cwd()), 'photos')
  }

  return () => {
    for (const d of reg) {
      try {
        if (typeof d === 'function') d()
      } catch {
        /* 幂等 */
      }
    }
    const g = globalThis[NS_KEY]
    if (g && g.demo && typeof g.demo.reset === 'function') delete g.demo
  }
}

export { writeSamples, DEMO_IMAGE_LABEL }
