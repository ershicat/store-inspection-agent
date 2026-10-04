// gaia-inspection-action / lib/index.js
// 宿主半：逾期定时扫描（**进程内真定时器**）+ 整改催办与升级（状态机）。
// 承担能力词：逾期定时扫描 / 整改催办与升级。
//
// 状态机（唯一产生 actions 的地方）：
//   判断落库 → 生成「整改要求」动作（dueAt = 判断时间 + 严重度 SLA）
//   → 到期未整改（定时器或「立即扫描」触发）→ 状态置「逾期」+ 生成「催办」动作
//   → 再过一个升级窗口仍未整改 → 状态置「已升级」+ 生成「升级」动作
// 定时器是**真的**：apply() 里 setInterval 起进程内定时器，每次触发都把时间戳与扫描结果
// 追加到 `<数据根>/logs/scan-log.jsonl`（可核对两次真实触发的间隔）；
// 「立即扫描」只是**互为备份的第二个入口**，走的仍是同一个 scan()。
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { resolveDefineTool } from './gaia-tools.js'

export const name = 'gaia-inspection-action'
export const inject = ['tools']

export const NS_KEY = '__gaia_inspection__'

/** 整改 SLA（小时）与升级窗口：按严重度给出的业务常量（不是模型判断）。 */
export const SLA_HOURS = { 高: 2, 中: 8, 低: 24 }
export const DEFAULT_SLA_HOURS = 8
/** 过了截止这么久仍未整改 → 升级。 */
export const ESCALATE_AFTER_HOURS = 8
/**
 * 退回时重算整改截止：**从退回时刻起 + 8 小时**（客户 2026-10-03 裁定）。
 *
 * 为什么不能沿用原单的 dueAt：原单的截止是**提交那一刻**按严重度算的（高 2h / 中 8h / 低 24h）。
 * 真机数据里就有这个坑 —— `#uzrn` 提交 02:08、截止 04:08（严重度高 → 2h），督导 02:09 才退回，
 * 店长拿到的整改窗口只剩不到 2 小时；而"退回"本身就是对"还要整改"的**重新认定**，
 * 窗口理应从退回时刻重新算。仍可由调用方用 `newDueHours` 覆盖（界面暂未暴露这个参数）。
 */
export const REJECT_DUE_HOURS = 8
/**
 * 「已办结」的状态集合（与两个前端包同一口径）。
 *
 * 用途：**办结守卫**（客户 2026-10-03 裁定："办结是工单完成的标志，办结之后再开一轮是反逻辑的"）。
 * 一个订单 = 一个链根（`reworkOf` 走到底），轮次 = 一次提交。所以：
 *   · 本单名下若还有**未办结的回拍轮**，就不许把本单置 `rectified` —— 否则订单会变成
 *     "已办结 + 底下还挂着一轮待复核"（真机 `#1xek` 就是这么来的）；
 *   · 反过来，0 条判断项的轮次（模型只标"看不清"、或本次没发现问题）过去**没有任何办结路径**，
 *     会永远挂在待复核 —— 现在有 `办结` 这个显式动作收口。
 */
export const DONE_STATUSES = ['rectified', 'closed', 'approved']

const OUT_SCHEMA = { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, error: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] } } }
const jsonRender = (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }]

function mkLogger(ctx) {
  const l = ctx && ctx.logger
  return {
    info: (m) => (l && typeof l.info === 'function' ? l.info(m) : undefined),
    warn: (m) => (l && typeof l.warn === 'function' ? l.warn(m) : process.stderr.write(`[gaia-inspection-action] ${m}\n`)),
    error: (m) => (l && typeof l.error === 'function' ? l.error(m) : process.stderr.write(`[gaia-inspection-action] ${m}\n`)),
  }
}

export function slaHoursOf(severity) {
  const key = String(severity || '').trim()
  return SLA_HOURS[key] ?? DEFAULT_SLA_HOURS
}

export function dueAtOf(atIso, severity) {
  const base = new Date(atIso).getTime()
  return new Date(base + slaHoursOf(severity) * 3600 * 1000).toISOString()
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

  const logDir = () => {
    const d = db()
    return d && typeof d.logDir === 'function' ? d.logDir() : join(String(process.env.GAIA_INSPECTION_DATA || process.cwd()), 'logs')
  }

  function tickLog(entry) {
    try {
      mkdirSync(logDir(), { recursive: true })
      appendFileSync(join(logDir(), 'scan-log.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
    } catch {
      /* 日志失败不影响业务 */
    }
  }

  const ticks = []

  /**
   * 为一张检查单的全部判断生成「整改要求」动作，并把 dueAt 写回检查单与判断。
   * 由 gaia-inspection-capture 在判断落库后调用（**每条判断之后必须有自动动作**）。
   */
  function planForInspection({ inspectionId, findings, at }) {
    const d = db()
    if (!d) return { ok: false, error: { code: 'DEPENDENCY_MISSING', message: '需要 ns.db，请确认 gaia-inspection-core 已加载' } }
    const ins = d.get('inspections', String(inspectionId))
    if (!ins) return { ok: false, error: { code: 'INSPECTION_NOT_FOUND', message: `检查单不存在：${inspectionId}` } }
    const list = Array.isArray(findings) ? findings : d.where('findings', (f) => f.inspectionId === ins.id)
    const atIso = at || ins.createdAt || new Date().toISOString()
    const created = []
    let earliest = null
    for (const f of list) {
      const dueAt = f.dueAt || dueAtOf(atIso, f.severity)
      d.put('findings', { ...f, id: f.id, dueAt, status: f.status || 'pending_rectify' })
      created.push(
        d.put('actions', {
          inspectionId: ins.id,
          findingId: f.id,
          type: '整改要求',
          target: f.itemName || null,
          severity: f.severity || null,
          dueAt,
          reason: f.reason || null,
          createdAt: atIso,
          source: 'state-machine',
          actor: '系统',
          actorIsHuman: false,
          result: '已派单',
        }),
      )
      if (!earliest || dueAt < earliest) earliest = dueAt
    }
    const updated = d.put('inspections', { ...ins, id: ins.id, dueAt: earliest || ins.dueAt || null, status: ins.status === 'rectified' ? 'rectified' : 'pending_rectify' })
    return { ok: true, data: { inspectionId: ins.id, actionsCreated: created.map((a) => a.id), dueAt: updated.dueAt, rules: { SLA_HOURS, ESCALATE_AFTER_HOURS } } }
  }

  /**
   * 扫描一遍：把到期未整改的置「逾期」并生成催办；把已过升级窗口的置「已升级」并生成升级。
   * 纯状态机 + 表内时间比较，不调模型。
   */
  function scan(args = {}) {
    const d = db()
    if (!d) return { ok: false, runId: null, status: 'failed', summary: '巡店业务库未就绪', data: null, artifacts: [], traceRef: null, error: { code: 'DEPENDENCY_MISSING', message: '需要 ns.db，请确认 gaia-inspection-core 已加载' } }
    const nowMs = Date.now()
    const nowIsoStr = new Date(nowMs).toISOString()
    const inspections = d.all('inspections')
    const markedOverdue = []
    const markedEscalated = []
    const actionsCreated = []
    for (const ins of inspections) {
      if (!ins.dueAt) continue
      const dueMs = new Date(ins.dueAt).getTime()
      if (!Number.isFinite(dueMs)) continue
      const escalateMs = dueMs + ESCALATE_AFTER_HOURS * 3600 * 1000
      if (ins.status === 'pending_rectify' && dueMs < nowMs) {
        d.put('inspections', { ...ins, id: ins.id, status: 'overdue', overdueAt: nowIsoStr })
        for (const f of d.where('findings', (x) => x.inspectionId === ins.id)) {
          if (f.status === 'pending_rectify') d.put('findings', { ...f, id: f.id, status: 'overdue' })
        }
        const a = d.put('actions', {
          inspectionId: ins.id,
          findingId: null,
          type: '催办',
          target: `${ins.storeName || ins.storeId || '门店'}·整改截止已过`,
          dueAt: ins.dueAt,
          reason: `截止时间 ${ins.dueAt} 已过（扫描时间 ${nowIsoStr}）`,
          createdAt: nowIsoStr,
          source: args.reason === 'timer' ? 'timer' : 'manual-scan',
          actor: '系统',
          actorIsHuman: false,
          result: '已催办',
        })
        markedOverdue.push({ inspectionId: ins.id, dueAt: ins.dueAt, actionId: a.id })
        actionsCreated.push(a.id)
      } else if (ins.status === 'overdue' && escalateMs < nowMs) {
        d.put('inspections', { ...ins, id: ins.id, status: 'escalated', escalatedAt: nowIsoStr })
        for (const f of d.where('findings', (x) => x.inspectionId === ins.id)) {
          if (f.status === 'overdue') d.put('findings', { ...f, id: f.id, status: 'escalated' })
        }
        const a = d.put('actions', {
          inspectionId: ins.id,
          findingId: null,
          type: '升级',
          target: `${ins.storeName || ins.storeId || '门店'}·逾期未整改升级`,
          dueAt: ins.dueAt,
          reason: `催办后仍未整改，超出升级窗口 ${ESCALATE_AFTER_HOURS} 小时（扫描时间 ${nowIsoStr}）`,
          createdAt: nowIsoStr,
          source: args.reason === 'timer' ? 'timer' : 'manual-scan',
          actor: '系统',
          actorIsHuman: false,
          result: '已升级',
        })
        markedEscalated.push({ inspectionId: ins.id, dueAt: ins.dueAt, actionId: a.id })
        actionsCreated.push(a.id)
      }
    }
    return {
      ok: true,
      runId: `SCAN-${nowMs}`,
      status: 'completed',
      summary: `扫描 ${inspections.length} 张检查单：新逾期 ${markedOverdue.length}、新升级 ${markedEscalated.length}、动作 ${actionsCreated.length}`,
      data: { scanned: inspections.length, markedOverdue, markedEscalated, actionsCreated, at: nowIsoStr, rules: { SLA_HOURS, ESCALATE_AFTER_HOURS } },
      artifacts: [{ name: 'scan-log.jsonl', type: 'jsonl', path: join(logDir(), 'scan-log.jsonl') }],
      traceRef: `scan/${nowMs}`,
      error: null,
    }
  }

  const ns = (globalThis[NS_KEY] ??= {})
  ns.action = {
    scan,
    planForInspection,
    review: (args) => reviewReceipt(review(args)),
    status: () => ({
      ok: true,
      periodMs: periodMs,
      tickCount: ticks.length,
      lastTicks: ticks.slice(-5),
      logFile: join(logDir(), 'scan-log.jsonl'),
      rules: { SLA_HOURS, ESCALATE_AFTER_HOURS },
    }),
    logDir,
  }

  /** 前端（fe）用的英文动作码 → 本包内部的中文动作名（两套入口同一套落库语义）。 */
  const ACTION_CODE = { approve: '通过', reject: '退回并说明', remind: '催办', close: '办结' }
  const CODE_OF = { 通过: 'review_approve', 退回并说明: 'review_reject', 催办: 'review_remind', 办结: 'review_close' }

  /** 这张单名下还没办结的**回拍轮**（`reworkOf === 本单`）。办结守卫用。 */
  function openReworkRounds(d, inspectionId) {
    return d
      .all('inspections')
      .filter((x) => x && x.reworkOf === inspectionId && DONE_STATUSES.indexOf(String(x.status || '').toLowerCase()) === -1)
  }

  /**
   * 督导的人工动作（画面级说明要求的三态：通过 / 退回并说明 / 催办）。
   * 与自动动作走**同一张 actions 表**，用 `actor`/`actorIsHuman`/`result` 区分人机来源；
   * 每次动作都写一条记录（时间 / 操作者 / 结果 / 原因），并回填检查单与判断的状态。
   * 入参兼容两种写法：`action:'通过'|'退回并说明'|'催办'` 或 `action:'approve'|'reject'|'remind'`。
   */
  function review(args = {}) {
    const d = db()
    if (!d) return { ok: false, error: { code: 'DEPENDENCY_MISSING', message: '需要 ns.db，请确认 gaia-inspection-core 已加载' } }
    const rawKind = String(args.action || '').trim()
    const kind = ACTION_CODE[rawKind] || rawKind
    const actionCode = CODE_OF[kind] || null
    let inspectionId = String(args.inspectionId || '').trim()
    const findingId = args.findingId ? String(args.findingId) : null
    // 只给 findingId 也认：从判断反查它所属的检查单
    if (!inspectionId && findingId) {
      const f = d.get('findings', findingId)
      if (!f) return { ok: false, error: { code: 'FINDING_NOT_FOUND', message: `没有这条判断：${findingId}` } }
      inspectionId = String(f.inspectionId || '')
    }
    if (!inspectionId) {
      return { ok: false, error: { code: 'BAD_BODY', message: '至少要给 inspectionId（或只给 findingId 让我反查所属检查单）。' } }
    }
    const ins = d.get('inspections', inspectionId)
    if (!ins) return { ok: false, error: { code: 'INSPECTION_NOT_FOUND', message: `检查单不存在：${inspectionId}` } }
    const actor = String(args.actor || args.operator || '督导').trim() || '督导'
    const actorName = String(args.actorName || '').trim()
    const atIso = String(args.at || '').trim() || new Date().toISOString()
    const findings = findingId ? d.where('findings', (f) => f.id === findingId && f.inspectionId === ins.id) : d.where('findings', (f) => f.inspectionId === ins.id)
    if (findingId && findings.length === 0) return { ok: false, error: { code: 'FINDING_NOT_FOUND', message: `该检查单下没有这条判断：${findingId}` } }

    if (kind === '通过') {
      // 状态矩阵（客户 10-03）：通过 / 打回**互斥** —— 已被打回的项不能再点通过（复核在新一轮上做）。
      // 逐项（给了 findingId）→ 结构化拒绝；批量（没给）→ 跳过已打回的项，只通过剩下的。
      if (findingId && findings[0] && findings[0].rejectedAt) {
        return { ok: false, error: { code: 'FINDING_ALREADY_REJECTED', message: '这一项已经退回给门店（只能催办）：复核请在门店回拍后的新一轮上做。' } }
      }
      const targets = findings.filter((f) => !f.rejectedAt)
      if (targets.length === 0) {
        return { ok: false, error: { code: 'FINDING_ALREADY_REJECTED', message: '这些判断项都已经退回给门店（只能催办）：复核请在门店回拍后的新一轮上做。' } }
      }
      for (const f of targets) d.put('findings', { ...f, id: f.id, status: 'rectified', rectifiedAt: atIso, rectifiedBy: actorName || actor })
      const rest = d.where('findings', (f) => f.inspectionId === ins.id && f.status !== 'rectified')
      const allDone = rest.length === 0
      // 办结守卫：本单名下还有未办结的回拍轮 → 本单**不许**置 rectified（订单状态以最新一轮为准）。
      // 通过记录照写（这一项确实过了），只是不把整单办结。
      const openRounds = allDone ? openReworkRounds(d, ins.id) : []
      const blocked = allDone && openRounds.length > 0
      const updated = d.put('inspections', {
        ...ins,
        id: ins.id,
        status: allDone && !blocked ? 'rectified' : ins.status,
        rectifiedAt: allDone && !blocked ? atIso : ins.rectifiedAt || null,
        rectifiedBy: actorName || actor,
      })
      const a = d.put('actions', {
        inspectionId: ins.id,
        findingId,
        type: '通过',
        actionCode,
        target: findingId ? (findings[0].itemName || findingId) : `${ins.storeName || ins.storeId || '门店'}·本次整改`,
        reason: String(args.reason || '').trim() || (blocked ? `本单名下还有 ${openRounds.length} 轮回拍未办结：暂不置办结（订单状态以最新一轮为准）` : null),
        createdAt: atIso,
        source: 'supervisor',
        actor,
        actorName: actorName || null,
        actorIsHuman: true,
        result: blocked ? '通过（本单暂不办结）' : '通过',
      })
      return { ok: true, data: { inspectionId: ins.id, actionId: a.id, action: a, inspectionStatus: updated.status, passedFindings: findings.map((f) => f.id), remainingUnrectified: rest.length, blockedByOpenRework: blocked, openReworkRounds: openRounds.map((x) => x.id) } }
    }

    // 「办结」= 给**没有判断项可点**的轮次一条收口路径（0 条问题项：模型只标了"看不清"、或本次没发现问题）。
    // 守卫：①名下有未办结的回拍轮 → 不许办结；②还有没过判断项 → 不许跳步（逐项点通过即可自动办结）。
    if (kind === '办结') {
      const rest = d.where('findings', (f) => f.inspectionId === ins.id && f.status !== 'rectified')
      const openRounds = openReworkRounds(d, ins.id)
      if (openRounds.length > 0) {
        return { ok: false, error: { code: 'OPEN_REWORK_ROUND', message: `本单名下还有 ${openRounds.length} 轮回拍未办结（${openRounds.map((x) => x.id).join('、')}）：订单状态以最新一轮为准，请先把最新那一轮处置完。` } }
      }
      if (rest.length > 0) {
        return { ok: false, error: { code: 'FINDINGS_PENDING', message: `还有 ${rest.length} 项判断没过：逐项点「通过」，全部通过后本单会自动办结。` } }
      }
      const updated = d.put('inspections', { ...ins, id: ins.id, status: 'rectified', rectifiedAt: atIso, rectifiedBy: actorName || actor })
      const a = d.put('actions', {
        inspectionId: ins.id,
        findingId: null,
        type: '办结',
        actionCode,
        target: `${ins.storeName || ins.storeId || '门店'}·本单办结`,
        reason: String(args.reason || '').trim() || (d.where('findings', (f) => f.inspectionId === ins.id).length === 0 ? '本单 0 条问题项判断：确认无需整改，办结' : '本单判断项已全部通过：确认办结'),
        createdAt: atIso,
        source: 'supervisor',
        actor,
        actorName: actorName || null,
        actorIsHuman: true,
        result: '已办结',
      })
      return { ok: true, data: { inspectionId: ins.id, actionId: a.id, action: a, inspectionStatus: updated.status, closed: true } }
    }

    if (kind === '退回并说明') {
      const reason = String(args.reason || '').trim()
      if (!reason) return { ok: false, error: { code: 'REASON_REQUIRED', message: '退回必须带说明文本（reason）：界面要把这段说明写给店长看。' } }
      // 已通过的项**不许再被处置**（客户 10-03："已办结、也就是通过的项目，还能重新打回"）；
      // 已打回的项**也不许重复退回**（同一个状态矩阵：打回之后只能催办）。
      const unpassed = findings.filter((f) => String(f.status || '').toLowerCase() !== 'rectified')
      const actionable = unpassed.filter((f) => !f.rejectedAt)
      if (actionable.length === 0) {
        if (unpassed.length === 0) {
          return { ok: false, error: { code: 'ALL_FINDINGS_PASSED', message: `${findingId ? '这一项' : '本单的判断项'}已经通过（本项已办结）：不能再退回。要让门店重做，请在门店端重新提交一轮（整改回拍）。` } }
        }
        return { ok: false, error: { code: 'FINDING_ALREADY_REJECTED', message: `${findingId ? '这一项' : '这些判断项'}已经退回给门店了：只能催办（不能重复退回）。` } }
      }
      // 退回 = 对"还要整改"的重新认定 → **重算整改截止**（默认 退回时刻 + 8h，见 REJECT_DUE_HOURS）。
      // 改前是"不传 newDueHours 就沿用原单 dueAt"，于是店长可能只剩几十分钟（真机 #uzrn 只剩 2 小时）。
      const hours = Number(args.newDueHours) > 0 ? Number(args.newDueHours) : REJECT_DUE_HOURS
      const dueAt = new Date(Date.now() + hours * 3600 * 1000).toISOString()
      for (const f of actionable) {
        d.put('findings', { ...f, id: f.id, status: 'pending_rectify', dueAt: dueAt || f.dueAt || null, rejectedAt: atIso, rejectedReason: reason })
      }
      // 给了新窗口，旧的「逾期 / 已升级」标记必须一起清掉：否则界面会出现"截止还在未来、却挂着逾期/已升级"
      // 的自相矛盾（历史事实仍留在 actions 表里，审计不丢；新窗口再错过，逾期扫描会重新标）。
      const updated = d.put('inspections', {
        ...ins,
        id: ins.id,
        status: 'pending_rectify',
        dueAt: dueAt || ins.dueAt || null,
        rejectedAt: atIso,
        overdueAt: null,
        escalated: false,
        escalatedAt: null,
      })
      const a = d.put('actions', {
        inspectionId: ins.id,
        findingId,
        type: '退回并说明',
        actionCode,
        target: findingId ? (findings[0].itemName || findingId) : `${ins.storeName || ins.storeId || '门店'}·本次整改`,
        reason,
        dueAt: updated.dueAt,
        createdAt: atIso,
        source: 'supervisor',
        actor,
        actorName: actorName || null,
        actorIsHuman: true,
        result: '退回',
      })
      return { ok: true, data: { inspectionId: ins.id, actionId: a.id, action: a, inspectionStatus: updated.status, dueAt: updated.dueAt, rejectedFindings: actionable.map((f) => f.id), skippedPassedFindings: findings.filter((f) => String(f.status || '').toLowerCase() === 'rectified').map((f) => f.id) } }
    }

    if (kind === '催办') {
      // 同一条口径：**已通过的项不催**（它已经办结了，催它没有意义，也会在界面上看起来像"打回去还能催"）。
      const actionable = findings.filter((f) => String(f.status || '').toLowerCase() !== 'rectified')
      if (actionable.length === 0) {
        return { ok: false, error: { code: 'ALL_FINDINGS_PASSED', message: `${findingId ? '这一项' : '本单的判断项'}已经通过（本项已办结）：不需要催办。` } }
      }
      const reason = String(args.reason || '').trim() || `督导人工催办（当前状态：${ins.status}）`
      const a = d.put('actions', {
        inspectionId: ins.id,
        findingId,
        type: '催办',
        actionCode,
        target: findingId ? (findings[0].itemName || findingId) : `${ins.storeName || ins.storeId || '门店'}·整改催办`,
        reason,
        dueAt: ins.dueAt || null,
        createdAt: atIso,
        source: 'supervisor',
        actor,
        actorName: actorName || null,
        actorIsHuman: true,
        result: '已催办',
      })
      return { ok: true, data: { inspectionId: ins.id, actionId: a.id, action: a, inspectionStatus: ins.status, dueAt: ins.dueAt || null } }
    }

    return { ok: false, error: { code: 'BAD_ACTION', message: 'action 只能是 通过 / 退回并说明 / 催办 / 办结（或 approve / reject / remind / close）' } }
  }

  /**
   * 把 review() 的结果包成统一回执形状（总工程师拍板）：{ok, runId, status, summary, data, artifacts, traceRef, error}
   */
  function reviewReceipt(r) {
    if (!r.ok) {
      return { ok: false, runId: null, status: 'failed', summary: `人工动作未记录：${r.error.message}`, data: null, artifacts: [], traceRef: null, error: r.error }
    }
    const a = r.data.action
    return {
      ok: true,
      runId: a.id,
      status: 'completed',
      summary: `已记录人工动作「${a.type}」（${a.actionCode}）：操作者 ${a.actor}${a.actorName ? '/' + a.actorName : ''}｜结果 ${a.result}｜检查单状态 ${r.data.inspectionStatus}`,
      data: r.data,
      // 顶层 action 便于前端直接取（总工程师给的形状）：{id, type, target, createdAt, reason}
      action: { id: a.id, type: a.type, actionCode: a.actionCode, target: a.target, createdAt: a.createdAt, reason: a.reason, actor: a.actor, actorName: a.actorName, actorIsHuman: a.actorIsHuman, result: a.result },
      artifacts: [],
      traceRef: `review/${a.actionCode}/${a.id}`,
      error: null,
    }
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

  wrap({
    name: 'inspection_scan_overdue',
    description: '立即扫描一遍逾期项（与后台真定时器互为备份，走的是同一个状态机）：到期未整改的检查单置「逾期」并生成催办动作，已过升级窗口的置「已升级」并生成升级动作。返回扫描了几张、新逾期/新升级/新动作各几条。',
    parameters: {
      reason: { type: 'string', description: '可选：触发原因，默认 manual（定时器触发时为 timer）' },
    },
    async execute(args) {
      const r = scan({ reason: (args && args.reason) || 'manual' })
      return { ok: r.ok, summary: r.summary, data: r.data, error: r.error, runId: r.runId, status: r.status, artifacts: r.artifacts, traceRef: r.traceRef }
    },
  })

  wrap({
    name: 'inspection_plan_actions',
    description: '为一张检查单的全部判断生成整改要求动作：按严重度算截止时间（高 2h / 中 8h / 低 24h），写回 findings.dueAt 与 inspections.dueAt，并落 actions 记录。每条判断之后必须有自动动作，本工具就是那个动作的生成口。',
    parameters: {
      inspectionId: { type: 'string', required: true, description: '检查单 id' },
    },
    async execute(args) {
      const r = planForInspection({ inspectionId: String(args.inspectionId || '') })
      if (!r.ok) return { ok: false, summary: `动作生成失败：${r.error.code}`, data: null, error: r.error }
      return { ok: true, summary: `为 ${r.data.inspectionId} 生成 ${r.data.actionsCreated.length} 条整改要求（最早截止 ${r.data.dueAt}）`, data: r.data, error: null }
    },
  })

  wrap({
    name: 'inspection_action_timeline',
    description: '读某张检查单（或全部）的整改动作时间线：整改要求 → 催办 → 升级，含生成时间、目标、触发原因与截止时间。供看板把「逾期与催办·升级痕迹」渲染在同屏。',
    parameters: {
      inspectionId: { type: 'string', description: '可选：只看这张检查单；不给则返回全部' },
    },
    async execute(args) {
      const d = db()
      if (!d) return { ok: false, summary: '巡店业务库未就绪', data: null, error: { code: 'DEPENDENCY_MISSING', message: '需要 ns.db' } }
      const id = args.inspectionId ? String(args.inspectionId) : ''
      let rows = d.all('actions')
      if (id) rows = rows.filter((a) => a.inspectionId === id)
      rows = rows.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
      return { ok: true, summary: `动作 ${rows.length} 条${id ? `（检查单 ${id}）` : ''}`, data: { inspectionId: id || null, total: rows.length, actions: rows }, error: null }
    },
  })

  wrap({
    name: 'inspection_review_action',
    description: '督导的人工处置动作（与自动动作同一张 actions 表，用 actor/result 区分人机）：action=通过（认可整改，检查单/判断置已整改；**本单名下还有未办结回拍轮时不置办结**，回执里说明）｜退回并说明（**必须带 reason 说明文本**，判断状态退回待整改，并按「退回时刻 + 8 小时」重算整改截止，可用 newDueHours 覆盖）｜催办（写一条人工催办记录，不改状态）｜办结（给**没有判断项可点**的轮次收口：0 条问题项或判断项已全部通过时置已办结；名下还有未办结回拍轮时拒绝）。每次动作都落一条记录：时间 / 操作者 / 结果 / 原因。',
    parameters: {
      action: { type: 'string', enum: ['通过', '退回并说明', '催办', '办结', 'approve', 'reject', 'remind', 'close'], required: true, description: '动作类型（中文逐字：通过/退回并说明/催办/办结；也接受 approve/reject/remind/close）' },
      inspectionId: { type: 'string', required: true, description: '检查单 id' },
      findingId: { type: 'string', description: '可选：只针对某条判断；不给则针对该检查单的全部判断' },
      reason: { type: 'string', description: '退回并说明**必填**的说明文本；通过/催办可选' },
      newDueHours: { type: 'number', description: '可选（仅退回）：新的整改时限小时数。不传则按口径重算为「退回时刻 + 8 小时」（改前是沿用原单截止，实测会让店长只剩几十分钟）' },
      actor: { type: 'string', description: '可选：操作者角色，默认「督导」；也接受 operator 字段' },
      actorName: { type: 'string', description: '可选：操作者名称（演示用，不做账号体系）' },
    },
    async execute(args) {
      return reviewReceipt(review(args || {}))
    },
  })

  wrap({
    name: 'inspection_scan_status',
    description: '查看定时扫描的运行事实：周期毫秒、已触发次数、最近几次触发的真实时间戳与扫描结果、以及扫描日志文件的绝对路径（用于核对"定时器是真的是按周期跑的"）。',
    parameters: {},
    async execute() {
      const st = ns.action.status()
      return { ok: true, summary: `定时器周期 ${st.periodMs}ms，已触发 ${st.tickCount} 次`, data: st, error: null }
    },
  })

  // ── 真定时器 ────────────────────────────────────────────────────────────────
  const periodMs = Math.max(0, Number(process.env.GAIA_INSPECTION_SCAN_MS ?? 60000))
  let timer = null
  if (periodMs > 0) {
    timer = setInterval(() => {
      try {
        const r = scan({ reason: 'timer' })
        const tick = { tick: ticks.length + 1, ts: new Date().toISOString(), scanned: r.data ? r.data.scanned : null, markedOverdue: r.data ? r.data.markedOverdue.length : null, actionsCreated: r.data ? r.data.actionsCreated.length : null, ok: r.ok }
        ticks.push(tick)
        tickLog({ event: 'timer-tick', ...tick })
        if (tick.markedOverdue > 0) logger.info(`[逾期扫描] 第 ${tick.tick} 次触发：新逾期 ${tick.markedOverdue} 条`)
      } catch (error) {
        logger.warn(`[逾期扫描] 异常：${String((error && error.message) || error)}`)
      }
    }, periodMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
    logger.info(`逾期定时扫描已启动：每 ${periodMs}ms 一次（日志 ${join(logDir(), 'scan-log.jsonl')}）`)
  } else {
    logger.warn('GAIA_INSPECTION_SCAN_MS=0：定时扫描未启动（只能靠「立即扫描」手动触发）')
  }

  return () => {
    if (timer) clearInterval(timer)
    for (const dr of reg) {
      try {
        if (typeof dr === 'function') dr()
      } catch {
        /* 幂等 */
      }
    }
    const g = globalThis[NS_KEY]
    if (g && g.action && typeof g.action.scan === 'function') delete g.action
  }
}
