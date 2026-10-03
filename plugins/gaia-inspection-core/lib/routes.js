// gaia-inspection-core / lib/routes.js
// 对前端（督导端看板 / 证据挂图 / 模型调用日志面板）暴露的 HTTP 接口。
//
// **契约三条（只读，前端按此消费）**：
//   GET /api/gaia-inspection/snapshot      -> 看板全量快照（门店/检查单/判断/动作/计数/离线与队列）
//   GET /api/gaia-inspection/evidence?id=  -> 单条证据（原图+缩略图+圈框（可空）+依据+建议+截止）
//   GET /api/gaia-inspection/model-calls   -> 模型调用日志（真实记录，逐条来自 model_calls 表）
// 另有三条非契约但**前端按钮必需**的口（总工程师已拍板批准，见 README 第 5 节）：
//   GET  /api/gaia-inspection/photo?id=<photoId>&kind=original|thumb -> 读图（只读，**按库内 id 取**，
//        不接受任意路径；id 只允许 [a-f0-9]{16}，文件必须落在本单数据根内 → 天然规避路径逃逸与信息泄露）
//   POST /api/gaia-inspection/submit       -> 提交自查（**固定动作转发**到 gaia-inspection-capture 的提交口）
//   POST /api/gaia-inspection/scan         -> 立即扫描（**固定动作转发**到 gaia-inspection-action 的真扫描）
// 三条口都**不做通用工具代理**（不能传工具名/参数转发），回执统一为
// {ok, runId, status, summary, data, artifacts, traceRef, error}。
//
// 纪律：任何异常都收成 200 + 结构化错误体（**不给客户 500 页面**）；槽位缺失返回
// DEPENDENCY_MISSING 而不是假数据；"没有数据"是正常空态，不是错误。
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, resolve, sep } from 'node:path'

import { TABLES, all, counts, dataRoot, get, modelCalls, normalizeCallRow, photoDir, thumbDir, where } from './store.js'

const MEDIA = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function sendJson(res, payload) {
  let text
  try {
    text = JSON.stringify(payload)
  } catch (error) {
    text = JSON.stringify({ ok: false, error: { code: 'SERIALIZE_FAILED', message: String((error && error.message) || error) } })
  }
  try {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text)
  } catch {
    /* 响应已结束 */
  }
}

function sendBytes(res, bytes, mediaType) {
  try {
    res.writeHead(200, { 'content-type': mediaType, 'cache-control': 'no-store', 'content-length': bytes.length })
    res.end(bytes)
  } catch {
    /* 响应已结束 */
  }
}

function query(req, key) {
  try {
    const url = new URL((req && req.url) || '/', 'http://localhost')
    return url.searchParams.get(key) || ''
  } catch {
    return ''
  }
}

async function readJsonBody(req, maxBytes = 16 * 1024 * 1024) {
  if (req && req.body && typeof req.body === 'object') return { ok: true, body: req.body }
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buf.length
      if (size > maxBytes) return { ok: false, error: { code: 'BODY_TOO_LARGE', message: `请求体超过上限 ${Math.round(maxBytes / 1024 / 1024)}MB（本单照片请压缩后再提交，或减少张数）` } }
      chunks.push(buf)
    }
  } catch (error) {
    return { ok: false, error: { code: 'BODY_READ_FAILED', message: String((error && error.message) || error) } }
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return { ok: true, body: {} }
  try {
    const v = JSON.parse(text)
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: { code: 'BAD_BODY', message: '请求体不是 JSON 对象' } }
    return { ok: true, body: v }
  } catch {
    return { ok: false, error: { code: 'BAD_BODY', message: '请求体不是合法 JSON' } }
  }
}

function guarded(compute) {
  return (req, res) => {
    let payload
    try {
      payload = compute(req)
    } catch (error) {
      payload = { ok: false, error: { code: 'ROUTE_THREW', message: String((error && error.message) || error) } }
    }
    sendJson(res, payload)
  }
}

function guardedAsync(compute) {
  return async (req, res) => {
    let payload
    try {
      payload = await compute(req)
    } catch (error) {
      payload = { ok: false, error: { code: 'ROUTE_THREW', message: String((error && error.message) || error) } }
    }
    sendJson(res, payload)
  }
}

function missing(slot, what) {
  return { ok: false, degraded: true, error: { code: 'DEPENDENCY_MISSING', slot, message: `需要 ${slot}（${what}），请确认对应插件已加载` } }
}

function slotOf(nsGetter, name) {
  const ns = nsGetter()
  if (!ns) return null
  const v = ns[name]
  return v && (typeof v === 'object' || typeof v === 'function') ? v : null
}

// ── ① 快照 ────────────────────────────────────────────────────────────────────
function buildSnapshot(nsGetter) {
  const db = slotOf(nsGetter, 'db')
  if (!db) return missing('ns.db', '巡店业务库，由 gaia-inspection-core 提供')
  const stores = all('stores')
    .slice()
    .sort((a, b) => String(a.storeId || a.id).localeCompare(String(b.storeId || b.id)))
  const inspections = all('inspections').slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
  const findings = all('findings')
  // 真实模型调用次数：按 inspectionId 归属统计（一次提交通常是 checklist_generate + vision_judge 两次）。
  // 提供这个字段是因为前端早先把「模型调用 N 次」写死成"有判断就是 1 次"，与日志里的实际条数不符。
  const modelCalls = all('model_calls')
  const actions = all('actions').slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
  const evidences = all('evidences')
  const now = Date.now()
  const snapshotInspections = inspections.map((ins) => {
    const mine = findings.filter((f) => f.inspectionId === ins.id)
    const myActions = actions.filter((a) => a.inspectionId === ins.id)
    const lastAction = myActions.length > 0 ? myActions[myActions.length - 1] : null
    const overdue = Boolean(ins.dueAt) && new Date(ins.dueAt).getTime() < now && ins.status !== 'rectified' && ins.status !== 'closed'
    const escalated = ins.status === 'escalated'
    return {
      id: ins.id,
      storeId: ins.storeId ?? null,
      storeName: ins.storeName ?? null,
      storeType: ins.storeType ?? null,
      note: ins.note ?? null,
      status: ins.status ?? 'unknown',
      source: ins.source ?? null,
      demo: ins.demo === true,
      createdAt: ins.createdAt ?? null,
      dueAt: ins.dueAt ?? null,
      overdue,
      escalated,
      // ── 退回闭环（用户实测反馈：督导点完"退回并说明"后，界面上找不到退到哪去了）──
      // 后端本来就把退回写下来了（ins.rejectedAt / finding.rejectedReason / 一条 actions 记录），
      // 但快照没露出来 → 督导端只能靠详情最底部那行时间线，店长端更是完全看不到。这里补四个字段：
      //   returnedAt     最近一次被退回的时间（没退回过则 null）
      //   returnedCount  被退回过的次数（点了好几次也看得出来）
      //   reworkOf       本单是"整改回拍"自哪一张（null = 不是回拍单）
      //   lastAction     最近一条人工动作（谁 / 什么时候 / 什么结果 / 什么原因）
      returnedAt: ins.rejectedAt ?? null,
      returnedCount: myActions.filter((a) => a.type === '退回并说明' || a.actionCode === 'review_reject').length,
      reworkOf: ins.reworkOf ?? null,
      lastAction: lastAction
        ? {
            id: lastAction.id,
            type: lastAction.type ?? null,
            actionCode: lastAction.actionCode ?? null,
            at: lastAction.createdAt ?? null,
            actor: lastAction.actorName || lastAction.actor || null,
            reason: lastAction.reason ?? null,
            result: lastAction.result ?? null,
            target: lastAction.target ?? null,
            dueAt: lastAction.dueAt ?? null,
          }
        : null,
      items: Array.isArray(ins.items) ? ins.items : [],
      reasons: ins.reasons ?? '',
      unreadable: Array.isArray(ins.unreadable) ? ins.unreadable : [],
      modelCallCount: modelCalls.filter((c) => c && c.inspectionId === ins.id).length,
      findings: mine.map((f) => ({
        findingId: f.id,
        itemName: f.itemName ?? null,
        severity: f.severity ?? null,
        // 置信度：模型自己给的文字把握（高/中/低）；模型没给就是 null + source='missing'（前端据此决定是否展示）
        confidence: f.confidence ?? null,
        confidenceSource: f.confidenceSource ?? 'missing',
        reason: f.reason ?? '',
        suggestion: f.suggestion ?? '',
        dueAt: f.dueAt ?? null,
        status: f.status ?? 'pending_rectify',
        // 这条判断被退回过的痕迹（店长端整改时要看的就是它）
        rejectedAt: f.rejectedAt ?? null,
        rejectedReason: f.rejectedReason ?? null,
        boxes: Array.isArray(f.boxes) ? f.boxes : [],
        boxesUnit: 'ratio',
        // A-1.3：把"模型只给了落点"这件事也露给快照 —— 否则前端只看到 boxes 为空，
        // 分不清"模型确实指不出来"（该写清楚）与"给了落点、只是没给框"（该在图上标点）。
        fallbackPoint: f.fallbackPoint && typeof f.fallbackPoint === 'object' ? { x: f.fallbackPoint.x, y: f.fallbackPoint.y, unit: 'ratio', text: f.fallbackPoint.text || f.reason || '', source: f.fallbackPoint.source || 'model' } : null,
        evidenceId: (evidences.find((e) => e.findingId === f.id) || {}).id ?? null,
        photoId: f.photoId ?? null,
        thumbUrl: f.photoId ? `/api/gaia-inspection/photo?id=${f.photoId}&kind=thumb` : null,
        originalUrl: f.photoId ? `/api/gaia-inspection/photo?id=${f.photoId}&kind=original` : null,
      })),
      actions: actions.filter((a) => a.inspectionId === ins.id).map((a) => ({ id: a.id, type: a.type, actionCode: a.actionCode ?? null, target: a.target ?? null, createdAt: a.createdAt, reason: a.reason ?? null, actor: a.actor ?? null, actorName: a.actorName ?? null, actorIsHuman: a.actorIsHuman === true, result: a.result ?? null, dueAt: a.dueAt ?? null, source: a.source ?? null })),
    }
  })
  const flatFindings = snapshotInspections.flatMap((i) => i.findings)
  const cap = slotOf(nsGetter, 'capture')
  let offline = { offline: null, source: 'unknown' }
  let pendingQueue = { pending: null, judged: null, items: [] }
  if (cap && typeof cap.queueState === 'function') {
    try {
      const q = cap.queueState()
      if (q && q.ok !== false) {
        offline = { offline: q.offline === true, source: q.offlineSource || 'capture', since: q.offlineSince ?? null }
        pendingQueue = { pending: q.pending ?? null, judged: q.judged ?? null, items: Array.isArray(q.items) ? q.items : [] }
      }
    } catch (error) {
      offline = { offline: null, source: `capture 读取失败：${String((error && error.message) || error)}` }
    }
  }
  const c = counts()
  // 注意：**不外传任何本地文件路径**（`c.files` 只在工具侧用），对外只给计数与 URL。
  const tableCounts = {}
  for (const t of TABLES) tableCounts[t] = c[t]
  return {
    ok: true,
    ts: new Date().toISOString(),
    stores,
    inspections: snapshotInspections,
    actions: actions.map((a) => ({ id: a.id, inspectionId: a.inspectionId ?? null, findingId: a.findingId ?? null, type: a.type, target: a.target ?? null, createdAt: a.createdAt, reason: a.reason ?? null, actor: a.actor ?? null, actorIsHuman: a.actorIsHuman === true, result: a.result ?? null, dueAt: a.dueAt ?? null, source: a.source ?? null })),
    counts: {
      检查单: c.inspections,
      判断: c.findings,
      证据: c.evidences,
      动作: c.actions,
      待整改: snapshotInspections.filter((i) => i.status === 'pending_rectify').length,
      逾期: snapshotInspections.filter((i) => i.overdue).length,
      已升级: snapshotInspections.filter((i) => i.escalated).length,
    },
    tableCounts,
    offline,
    pendingQueue,
    degraded: false,
    modelCallsTotal: c.model_calls,
  }
}

// ── ② 单条证据 ────────────────────────────────────────────────────────────────
function buildEvidence(nsGetter, id) {
  const db = slotOf(nsGetter, 'db')
  if (!db) return missing('ns.db', '巡店业务库，由 gaia-inspection-core 提供')
  const key = String(id || '').trim()
  if (!key) return { ok: true, data: null, summary: '未找到该证据', detail: '请求缺少 id 参数' }
  const finding = get('findings', key)
  if (!finding) return { ok: true, data: null, summary: '未找到该证据', detail: `id=${key}` }
  const ev = where('evidences', (e) => e.findingId === finding.id)[0] || null
  const boxes = Array.isArray(finding.boxes) ? finding.boxes : []
  const photoId = finding.photoId ?? (ev && ev.photoId) ?? null
  const rawPoint = boxes.length === 0 && finding.fallbackPoint && typeof finding.fallbackPoint === 'object' ? finding.fallbackPoint : null
  // fallbackPoint：{x, y, unit:'ratio', text} —— text 就是界面要写在点旁边的"依据文字"
  const fallbackPoint = rawPoint ? { x: rawPoint.x, y: rawPoint.y, unit: 'ratio', text: rawPoint.text || finding.reason || '', photoIndex: rawPoint.photoIndex ?? null, source: rawPoint.source || 'model' } : null
  return {
    ok: true,
    data: {
      findingId: finding.id,
      inspectionId: finding.inspectionId ?? null,
      storeId: finding.storeId ?? null,
      itemName: finding.itemName ?? null,
      severity: finding.severity ?? null,
      confidence: finding.confidence ?? null,
      confidenceSource: finding.confidenceSource ?? 'missing',
      reason: finding.reason ?? '',
      suggestion: finding.suggestion ?? '',
      dueAt: finding.dueAt ?? null,
      status: finding.status ?? null,
      // 圈框坐标：**归一化比例（0-1，相对原图宽高）**，模型未给坐标时为空数组 []。
      boxes,
      boxesUnit: 'ratio',
      // 「模型未给坐标」的降级呈现：#2 界面据此"图上标点 + 旁边写依据文字"（**不许出现空框**）。
      //   · hasBoxes=true  → 用 boxes 画框，fallbackPoint 必为 null；
      //   · hasBoxes=false → 用 fallbackPoint 画点（unit 恒为 ratio）；
      //   · fallbackPoint=null → **模型确实无法定位**（不是"框缺失"），前端只显示文字依据。
      hasBoxes: boxes.length > 0,
      fallbackPoint,
      fallbackPointUnit: 'ratio',
      fallbackPointSource: fallbackPoint ? fallbackPoint.source || 'model' : null,
      // 图片一律用 URL（按库内 photoId 取图），**不回裸文件路径**；前端只消费这里的 URL，不自己拼。
      photo: {
        photoId,
        originalUrl: photoId ? `/api/gaia-inspection/photo?id=${photoId}&kind=original` : null,
        thumbUrl: photoId ? `/api/gaia-inspection/photo?id=${photoId}&kind=thumb` : null,
        width: (ev && ev.width) ?? null,
        height: (ev && ev.height) ?? null,
      },
      evidence: ev ? { id: ev.id, capturedAt: ev.capturedAt ?? null, photoIndex: ev.photoIndex ?? null } : null,
      unreadable: Array.isArray(finding.unreadable) ? finding.unreadable : [],
      source: finding.source ?? null,
    },
    summary: `${finding.itemName || '判断'}（${finding.severity || '未标注'}）`,
  }
}

// ── ③ 模型调用日志 ─────────────────────────────────────────────────────────────
function buildModelCalls(nsGetter) {
  const db = slotOf(nsGetter, 'db')
  if (!db) return missing('ns.db', '巡店业务库，由 gaia-inspection-core 提供')
  const rows = modelCalls()
  const calls = rows.map(normalizeCallRow)
  return {
    ok: true,
    count: calls.length,
    calls,
    degraded: false,
  }
}

/** photoId 只允许 16 位小写十六进制（sha256 前 16 位，由采集侧计算）。 */
const PHOTO_ID = /^[a-f0-9]{16}$/

/**
 * 读图（只读）——**按库内 id 取，不接受任意路径**（总工程师拍板口径）：
 *   · id 必须匹配 PHOTO_ID；
 *   · 只在 `<数据根>/photos`（原图）与 `<数据根>/thumbs`（缩略图）两个目录里按 `<id>.<ext>` 找；
 *   · 解析后仍要求真实路径落在对应目录内（realpath 解符号链接后复核）；
 *   · 被拒时只给结构化错误码，**不回任何真实文件系统路径**。
 */
function servePhoto(rawId, rawKind) {
  const id = String(rawId || '').trim().toLowerCase()
  const kind = String(rawKind || 'original').trim().toLowerCase() === 'thumb' ? 'thumb' : 'original'
  if (!id) return { ok: false, error: { code: 'NO_ID', message: '缺少 id 参数（照片 id，16 位十六进制）' } }
  if (!PHOTO_ID.test(id)) return { ok: false, error: { code: 'BAD_ID', message: '照片 id 形状不合法（只允许 16 位小写十六进制）' } }
  const root = dataRoot()
  const dir = kind === 'thumb' ? thumbDir(root) : photoDir(root)
  let dirReal
  try {
    dirReal = realpathSync(resolve(dir))
  } catch {
    dirReal = resolve(dir)
  }
  let entries = []
  try {
    entries = existsSync(dirReal) ? readdirSync(dirReal) : []
  } catch {
    entries = []
  }
  const hit = entries.find((name) => name.toLowerCase().startsWith(`${id}.`))
  if (!hit) return { ok: false, error: { code: 'NOT_FOUND', message: `本单数据根里没有这张图（kind=${kind}）` } }
  const abs = join(dirReal, hit)
  let absReal
  try {
    absReal = realpathSync(abs)
  } catch {
    return { ok: false, error: { code: 'NOT_FOUND', message: `本单数据根里没有这张图（kind=${kind}）` } }
  }
  const within = (candidate, base) => candidate === base || candidate.startsWith(base.endsWith(sep) ? base : base + sep)
  if (!within(absReal, dirReal) || !within(absReal, dirReal)) {
    return { ok: false, error: { code: 'PATH_NOT_ALLOWED', message: '拒绝越出本单数据根的读图请求' } }
  }
  if (!statSync(absReal).isFile()) return { ok: false, error: { code: 'NOT_FOUND', message: `本单数据根里没有这张图（kind=${kind}）` } }
  return { ok: true, abs: absReal, mediaType: MEDIA[extname(absReal).toLowerCase()] || 'application/octet-stream' }
}

/** 统一回执形状（总工程师拍板）：{ok, runId, status, summary, data, artifacts, traceRef, error}。 */
export function asReceipt(value, fallbackSummary) {
  if (!value || typeof value !== 'object') {
    return { ok: false, runId: null, status: 'failed', summary: String(fallbackSummary || '未返回结果'), data: null, artifacts: [], traceRef: null, error: { code: 'EMPTY_RESULT', message: '被调用的动作没有返回对象结果' } }
  }
  if ('runId' in value || 'traceRef' in value || 'artifacts' in value) return value
  return {
    ok: value.ok === true,
    runId: value.runId ?? value.data?.runId ?? null,
    status: value.ok === true ? 'completed' : 'failed',
    summary: value.summary ?? fallbackSummary ?? '',
    data: value.data ?? null,
    artifacts: Array.isArray(value.artifacts) ? value.artifacts : [],
    traceRef: value.traceRef ?? null,
    error: value.ok === true ? null : value.error ?? { code: 'ACTION_FAILED', message: value.summary || '动作失败' },
  }
}

// ── 注册 ─────────────────────────────────────────────────────────────────────
/**
 * 取 webServer：优先走**声明式依赖后**的 ctx.webServer（ctx.inject(['webServer']) 回调里传入的 ctx），
 * 再退回 ctx.get('webServer')。直接同步 ctx.get 在真机会拿到 undefined —— 见 lib/index.js 里的说明。
 */
function resolveWebServer(ctx) {
  if (!ctx) return undefined
  const direct = ctx.webServer
  if (direct && typeof direct.register === 'function') return direct
  if (typeof ctx.get === 'function') {
    const viaGet = ctx.get('webServer')
    if (viaGet && typeof viaGet.register === 'function') return viaGet
  }
  return undefined
}

export function registerRoutes(ctx, nsGetter, logger) {
  const webServer = resolveWebServer(ctx)
  if (!webServer || typeof webServer.register !== 'function') {
    logger.warn('[gaia-inspection-core] 宿主未提供 webServer：/api/gaia-inspection/* 路由未注册（看板将显示"数据不可用"）')
    return { registered: [], dispose: () => {} }
  }
  const disposers = []
  const add = (path, handler) => {
    disposers.push(webServer.register({ kind: 'exact', path, handler }))
    return path
  }
  const registered = []
  registered.push(add('/api/gaia-inspection/snapshot', guarded(() => buildSnapshot(nsGetter))))
  registered.push(add('/api/gaia-inspection/evidence', guarded((req) => buildEvidence(nsGetter, query(req, 'id')))))
  registered.push(add('/api/gaia-inspection/model-calls', guarded(() => buildModelCalls(nsGetter))))
  // 非契约但前端必需：读图（只读，按库内 photoId 取；不接受任意路径）
  registered.push(
    add(
      '/api/gaia-inspection/photo',
      (req, res) => {
        let r
        try {
          r = servePhoto(query(req, 'id'), query(req, 'kind'))
        } catch (error) {
          r = { ok: false, error: { code: 'ROUTE_THREW', message: String((error && error.message) || error) } }
        }
        if (r.ok) {
          try {
            sendBytes(res, readFileSync(r.abs), r.mediaType)
          } catch (error) {
            sendJson(res, { ok: false, error: { code: 'READ_FAILED', message: String((error && error.message) || error) } })
          }
        } else sendJson(res, r)
      },
    ),
  )
  // 非契约但前端必需：提交自查（转调 capture 的真实提交工具，不产生本地假回执）
  registered.push(
    add(
      '/api/gaia-inspection/submit',
      guardedAsync(async (req) => {
        const cap = slotOf(nsGetter, 'capture')
        if (!cap || typeof cap.submit !== 'function') return missing('ns.capture', '采集提交，由 gaia-inspection-capture 提供')
        const read = await readJsonBody(req)
        if (!read.ok) return { ok: false, runId: null, status: 'failed', summary: read.error.message, data: null, artifacts: [], traceRef: null, error: read.error }
        return asReceipt(await cap.submit(read.body), '提交自查')
      }),
    ),
  )
  // 非契约但前端必需：立即扫描（转调 action 的真实扫描，与真定时器互为备份）
  registered.push(
    add(
      '/api/gaia-inspection/scan',
      guardedAsync(async (req) => {
        const act = slotOf(nsGetter, 'action')
        if (!act || typeof act.scan !== 'function') return missing('ns.action', '逾期扫描，由 gaia-inspection-action 提供')
        const read = await readJsonBody(req)
        if (!read.ok) return { ok: false, runId: null, status: 'failed', summary: read.error.message, data: null, artifacts: [], traceRef: null, error: read.error }
        const body = read.body
        return asReceipt(await act.scan({ reason: typeof body.reason === 'string' && body.reason ? body.reason : 'manual', _body: body }), '立即扫描')
      }),
    ),
  )

  // 非契约但前端必需：督导人工动作（固定动作转发到 action 的 review；<-> 画面级 §二 2.2「每次动作写入记录」）
  // 两个路径指向**同一个固定动作**（fe 用 /review-action，总工程师命名 /review），不接收工具名、不做通用代理。
  const reviewHandler = guardedAsync(async (req) => {
    const act = slotOf(nsGetter, 'action')
    if (!act || typeof act.review !== 'function') return missing('ns.action', '督导人工动作，由 gaia-inspection-action 提供')
    const read = await readJsonBody(req)
    if (!read.ok) return { ok: false, runId: null, status: 'failed', summary: read.error.message, data: null, artifacts: [], traceRef: null, error: read.error }
    return asReceipt(await act.review(read.body), '督导人工动作')
  })
  registered.push(add('/api/gaia-inspection/review-action', reviewHandler))
  registered.push(add('/api/gaia-inspection/review', reviewHandler))
  // 非契约但前端必需：读一张合成演示样例（画面级 §一 1.2「载入示例」；只填表，不写死任何判断结果）
  registered.push(
    add(
      '/api/gaia-inspection/sample-photo',
      guarded((req) => {
        const demo = slotOf(nsGetter, 'demo')
        if (!demo || typeof demo.samplePhoto !== 'function') return missing('ns.demo', '演示样例，由 gaia-inspection-demo 提供')
        return demo.samplePhoto(query(req, 'key') || 'issue')
      }),
    ),
  )

  const dispose = () => {
    for (const d of disposers) {
      try {
        if (typeof d === 'function') d()
      } catch {
        /* 幂等 */
      }
    }
  }
  if (ctx && typeof ctx.effect === 'function') ctx.effect(() => dispose, 'gaia-inspection-core: routes')
  return { registered, dispose }
}

export { buildSnapshot, buildEvidence, buildModelCalls, TABLE_PATHS }
const TABLE_PATHS = TABLES
