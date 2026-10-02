// gaia-inspection-capture / lib/index.js
// 宿主半：门店照片视觉判断（真多模态模型调用）+ 断网降级与待判队列 + 照片缩略与附件预览。
// 承担能力词：门店照片视觉判断 / 断网降级与待判队列 / 照片缩略与附件预览。
//
// 本包对外发布 `globalThis.__gaia_inspection__.capture`：
//   submit(body) / judge(args) / thumb(args) / queueState() / setOffline(bool) / flush()
// 供前端按钮（经 core 的固定动作口 /submit）与其它同单插件在运行期取用。
//
// 红线自查（本文件）：
//   · 没有任何 if-else / 关键词规则产出"问题项"；判断只来自 vision.js 的真模型输出；
//   · 模型不可达 → 进待判队列并如实回执为"离线：仅采集排队，不产生模型判断"，
//     **离线期间 model_calls 一行都不新增**（可直接核对）；
//   · 不写 key、不读凭据；照片尺寸/张数有上限，超限返回结构化错误。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { resolveDefineTool } from './gaia-tools.js'
import { judgePhotos } from './vision.js'
import { DEFAULT_THUMB_LONG_EDGE, findById, makeThumb, mediaTypeOf, saveOriginal, sizeOf, photoIdOf } from './photos.js'
import { clear as clearQueue, enqueue, loadQueue, queueState as readQueueState, rewrite } from './queue.js'
import { isOfflineLikeError } from './modelroute.js'
import { nowIso } from './modellog.js'

export const name = 'gaia-inspection-capture'
export const inject = ['tools']

export const NS_KEY = '__gaia_inspection__'
/**
 * 采集上限（画面级说明 §采集面：**采集面是单张照片**）：
 *   · `/submit` 与 `inspection_submit_selfcheck`：**单张**（MAX_PHOTOS_SUBMIT = 1）；
 *   · `inspection_judge_photos`（内部/其它调用方）：仍支持 1-6 张（规格书 §7 写了"单张/多张"）。
 * 单张解码后字节上限统一 2MB；超限一律返回结构化错误，不静默截断。
 */
export const MAX_PHOTOS_SUBMIT = 1
export const MAX_PHOTOS = 6
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024
export const OFFLINE_NOTICE = '离线：仅采集排队，不产生模型判断'

const OUT_SCHEMA = { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, summary: { type: 'string' }, error: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] } } }
const jsonRender = (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }]

function mkLogger(ctx) {
  const l = ctx && ctx.logger
  return {
    info: (m) => (l && typeof l.info === 'function' ? l.info(m) : undefined),
    warn: (m) => (l && typeof l.warn === 'function' ? l.warn(m) : process.stderr.write(`[gaia-inspection-capture] ${m}\n`)),
    error: (m) => (l && typeof l.error === 'function' ? l.error(m) : process.stderr.write(`[gaia-inspection-capture] ${m}\n`)),
  }
}

function fail(code, message) {
  return { ok: false, error: { code, message } }
}

/** 统一回执形状（总工程师拍板）：{ok, runId, status, summary, data, artifacts, traceRef, error}。 */
function receipt({ ok, runId = null, status, summary, data = null, artifacts = [], traceRef = null, error = null }) {
  return { ok, runId, status, summary, data, artifacts, traceRef, error }
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

  // 离线两态（区分"人开的演示开关"与"模型这一路自己断了"）：
  //   · manualOffline：演示用离线开关，submit 与 flush 都停；
  //   · routeDown：模型不可达后的熔断，submit 不再重复打空请求、但 **flush 允许**（那是恢复探针）。
  const state = { manualOffline: false, routeDown: false, offlineSince: null, offlineSource: 'none' }
  const offlineNow = () => state.manualOffline === true || state.routeDown === true
  const offlineSource = () => (state.manualOffline ? 'demo-switch' : state.routeDown ? state.offlineSource : 'none')

  const paths = () => {
    const ns = NSc()
    const db = ns && ns.db
    const root = db && typeof db.dataRoot === 'function' ? db.dataRoot() : String(process.env.GAIA_INSPECTION_DATA || '')
    return {
      root,
      photoDir: db && typeof db.photoDir === 'function' ? db.photoDir() : join(root, 'photos'),
      thumbDir: db && typeof db.thumbDir === 'function' ? db.thumbDir() : join(root, 'thumbs'),
      queueDir: db && typeof db.queueDir === 'function' ? db.queueDir() : join(root, 'queue'),
      logDir: db && typeof db.logDir === 'function' ? db.logDir() : join(root, 'logs'),
    }
  }

  const db = () => {
    const ns = NSc()
    return ns && ns.db && typeof ns.db.put === 'function' ? ns.db : null
  }

  const modelLog = () => {
    const ns = NSc()
    return ns && ns.modelLog && typeof ns.modelLog.logStart === 'function' ? ns.modelLog : null
  }

  const actionSlot = () => {
    const ns = NSc()
    return ns && ns.action && typeof ns.action.planForInspection === 'function' ? ns.action : null
  }
  const checklistSlot = () => {
    const ns = NSc()
    return ns && ns.checklist && typeof ns.checklist.generate === 'function' ? ns.checklist : null
  }
  const registrySlot = () => {
    const ns = NSc()
    return ns && ns.registry && typeof ns.registry.getStore === 'function' ? ns.registry : null
  }

  function logTick(entry) {
    try {
      const { logDir } = paths()
      mkdirSync(logDir, { recursive: true })
      writeFileSync(join(logDir, 'capture-log.jsonl'), `${JSON.stringify({ ...entry, ts: nowIso() })}\n`, { encoding: 'utf8', flag: 'a' })
    } catch {
      /* 日志失败不影响业务 */
    }
  }

  // ── 输入归一：从 dataBase64 / 本地路径 两种形态取照片字节 ──────────────────────
  function collectPhotoInputs(body, maxPhotos = MAX_PHOTOS) {
    const out = []
    const photos = Array.isArray(body.photos) ? body.photos : []
    for (const p of photos) {
      if (!p || typeof p !== 'object') continue
      const b64 = typeof p.dataBase64 === 'string' ? p.dataBase64.trim() : typeof p.data === 'string' ? p.data.trim() : ''
      if (!b64) continue
      let bytes
      try {
        bytes = Buffer.from(b64, 'base64')
      } catch {
        return fail('PHOTO_BASE64_INVALID', `照片 ${p.name || '(未命名)'} 的 base64 解码失败`)
      }
      if (bytes.length === 0) return fail('PHOTO_EMPTY', `照片 ${p.name || '(未命名)'} 解码后是 0 字节`)
      const mediaType = (typeof p.mediaType === 'string' && p.mediaType.trim()) || mediaTypeOf(bytes) || ''
      if (!mediaType) return fail('PHOTO_TYPE_UNKNOWN', `照片 ${p.name || '(未命名)'} 的类型既没给也没能从魔数判出（只支持 PNG/JPEG/WebP/GIF）`)
      out.push({ bytes, mediaType, name: String(p.name || `photo-${out.length}`) })
    }
    const photoPaths = Array.isArray(body.photoPaths) ? body.photoPaths : []
    for (const p of photoPaths) {
      if (typeof p !== 'string' || !p.trim()) continue
      let bytes
      try {
        bytes = readFileSync(p.trim())
      } catch (error) {
        return fail('PHOTO_READ_FAILED', `照片读取失败（${basename(p.trim())}）：${String((error && error.message) || error)}`)
      }
      const mediaType = mediaTypeOf(bytes)
      if (!mediaType) return fail('PHOTO_TYPE_UNKNOWN', `照片 ${basename(p.trim())} 不是受支持的图片（只支持 PNG/JPEG/WebP/GIF）`)
      out.push({ bytes, mediaType, name: basename(p.trim()) })
    }
    if (out.length === 0) return fail('NO_PHOTO', `本次没有照片：请提交 1-${maxPhotos} 张门店照片（photos[].dataBase64 或 photoPaths）`)
    if (out.length > maxPhotos) return fail('TOO_MANY_PHOTOS', maxPhotos === 1 ? `采集面只收**单张**照片（本次 ${out.length} 张）；如需多张判读请用 inspection_judge_photos` : `一次最多提交 ${maxPhotos} 张照片（本次 ${out.length} 张）`)
    for (const p of out) {
      if (p.bytes.length > MAX_PHOTO_BYTES) return fail('PHOTO_TOO_LARGE', `照片 ${p.name} 单张 ${(p.bytes.length / 1024 / 1024).toFixed(2)}MB，超过单张上限 ${MAX_PHOTO_BYTES / 1024 / 1024}MB`)
    }
    return { ok: true, photos: out }
  }

  /** 照片落盘 + 缩略图 + 证据行所需字段（原图保留，内容寻址）。 */
  async function persistPhotos(photoInputs) {
    const { photoDir, thumbDir } = paths()
    const saved = []
    for (let i = 0; i < photoInputs.length; i += 1) {
      const p = photoInputs[i]
      const original = saveOriginal({ bytes: p.bytes, mediaType: p.mediaType, photoDir })
      const size = sizeOf(p.bytes)
      let thumb = null
      try {
        thumb = await makeThumb(ctx, { bytes: p.bytes, mediaType: p.mediaType, photoDir, thumbDir, longEdge: DEFAULT_THUMB_LONG_EDGE })
      } catch (error) {
        thumb = { ok: false, code: 'THUMB_THREW', message: String((error && error.message) || error) }
      }
      saved.push({
        photoIndex: i,
        name: p.name,
        mediaType: p.mediaType,
        photoId: original.photoId,
        originalPath: original.path,
        bytes: p.bytes.length,
        width: size.width,
        height: size.height,
        thumb: thumb && thumb.ok ? { ok: true, thumbPath: thumb.thumbPath, width: thumb.width, height: thumb.height, via: thumb.via, longEdge: thumb.longEdge } : { ok: false, code: (thumb && thumb.code) || 'THUMB_UNKNOWN', message: (thumb && thumb.message) || '缩略图未生成' },
      })
    }
    return saved
  }

  /** 把一次判断结果落成 inspections / findings / evidences 三张表，并派整改动作。 */
  function persistJudgement({ body, saved, vision, runId, storeInfo }) {
    const d = db()
    const at = nowIso()
    const inspectionId = runId
    const insRow = {
      id: inspectionId,
      storeId: body.storeId ?? null,
      storeName: (storeInfo && storeInfo.name) || body.storeName || null,
      storeType: (storeInfo && storeInfo.format) || body.storeType || null,
      note: body.note ?? null,
      status: 'pending_rectify',
      source: 'selfcheck',
      demo: false,
      // 整改回拍来源（店长端从「待整改」发起时带的原单号）；不是回拍单就是 null
      reworkOf: body.reworkOf ?? null,
      createdAt: at,
      dueAt: null,
      items: Array.isArray(body.checklistItems) ? body.checklistItems : [],
      reasons: body.checklistReasons || '',
      checklistCallId: body.checklistCallId || null,
      unreadable: vision.data.unreadable || [],
      visionCallId: vision.callId,
      provider: vision.provider,
      model: vision.model,
      photos: saved.map((s) => ({ photoId: s.photoId, name: s.name, thumbPath: s.thumb.ok ? s.thumb.thumbPath : null })),
    }
    d.put('inspections', insRow)

    const findings = []
    for (const f of vision.data.findings) {
      const s = saved[f.photoIndex] || saved[0] || null
      const row = d.put('findings', {
        inspectionId,
        storeId: insRow.storeId,
        itemName: f.itemName,
        severity: f.severity,
        confidence: f.confidence ?? null,
        confidenceSource: f.confidenceSource ?? 'missing',
        reason: f.reason,
        suggestion: f.suggestion,
        boxes: f.boxes,
        fallbackPoint: f.fallbackPoint || null,
        photoId: s ? s.photoId : null,
        originalPath: s ? s.originalPath : null,
        thumbPath: s && s.thumb.ok ? s.thumb.thumbPath : null,
        photoIndex: f.photoIndex,
        status: 'pending_rectify',
        dueAt: null,
        source: 'vision_judge',
        callId: vision.callId,
        unreadable: [],
      })
      if (s) {
        d.put('evidences', {
          findingId: row.id,
          inspectionId,
          photoId: s.photoId,
          originalPath: s.originalPath,
          thumbPath: s.thumb.ok ? s.thumb.thumbPath : null,
          width: s.thumb.ok ? s.thumb.width : s.width,
          height: s.thumb.ok ? s.thumb.height : s.height,
          photoIndex: f.photoIndex,
          capturedAt: at,
        })
      }
      findings.push(row)
    }

    // 每条判断之后必须有自动动作（整改要求 → 到期催办 → 再逾期升级，由 action 包负责状态机）
    let planResult = null
    const act = actionSlot()
    if (act) {
      planResult = act.planForInspection({ inspectionId, findings, at })
    } else {
      planResult = { ok: false, error: { code: 'DEPENDENCY_MISSING', message: 'ns.action 未就绪：整改要求动作未生成（请确认 gaia-inspection-action 已加载）' } }
    }
    return { inspectionId, findings, planResult }
  }

  function artifactsOf(saved) {
    return saved.map((s) => ({
      name: s.name,
      type: 'image',
      photoId: s.photoId,
      bytes: s.bytes,
      // 注意：**不回绝对路径**（前端用 /api/gaia-inspection/photo?id=<photoId> 取图），避免路径外泄
      thumb: s.thumb.ok ? { width: s.thumb.width, height: s.thumb.height, via: s.thumb.via } : null,
      url: `/api/gaia-inspection/photo?id=${s.photoId}&kind=original`,
      thumbUrl: `/api/gaia-inspection/photo?id=${s.photoId}&kind=thumb`,
    }))
  }

  /** 真实判断一次采集（真模型调用；离线/不可达由调用方决定是否排队）。 */
  async function judgeInternal({ photoInputs, body, runId }) {
    const { photoDir, thumbDir } = paths()
    void photoDir
    void thumbDir
    const saved = await persistPhotos(photoInputs)
    const reg = registrySlot()
    let storeInfo = null
    if (reg && body.storeId) {
      const r = reg.getStore(String(body.storeId))
      if (r && r.ok) storeInfo = r.data
    }
    const log = modelLog()
    const vision = await judgePhotos(
      { ctx, logger: log },
      {
        photos: photoInputs,
        storeId: body.storeId,
        storeName: (storeInfo && storeInfo.name) || body.storeName,
        storeType: (storeInfo && storeInfo.format) || body.storeType,
        note: body.note,
        inspectionId: runId,
        checklistItems: body.checklistItems,
        provider: body.provider,
        model: body.model,
        timeoutMs: body.timeoutMs,
      },
    )
    if (!vision.ok) {
      return { ok: false, saved, error: vision.error, callId: vision.callId, storeInfo }
    }
    const persisted = persistJudgement({ body, saved, vision, runId, storeInfo })
    const unreadableCount = (vision.data.unreadable || []).length
    const status = vision.data.findings.length === 0 ? (unreadableCount > 0 ? 'unreadable' : 'clean') : 'judged'
    const stuck = persisted.planResult && persisted.planResult.ok === false
    return {
      ok: true,
      saved,
      callId: vision.callId,
      provider: vision.provider,
      model: vision.model,
      latencyMs: vision.latencyMs,
      usage: vision.usage,
      inputModalities: vision.inputModalities,
      storeInfo,
      persisted,
      status,
      warnings: stuck ? [persisted.planResult.error.message] : [],
      summaryText: vision.data.summary,
      findingsCount: vision.data.findings.length,
      unreadableCount,
    }
  }

  function newRunId() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `INS-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`
  }

  /**
   * 「本次查哪几项」的那次模型调用 —— **必须**把「门店档案解析后的名字/业态」与「本次照片原图」一起送进去。
   *
   * 真机教训（教练在真机数据里抓到，见交付报告 §13）：早先这里传的是 HTTP body 里的
   * `storeName/storeType`（前端根本不发这两个字段），并且**完全不传照片**，于是模型在 reasons 里
   * 如实写下「本次仅有店长说明，无照片，且门店与业态未指定」；而同一单后面那次视觉判断却知道
   * 门店是 S-001/快餐档口、也知道照片里有瓶子 —— 两次调用自相矛盾，核心差异化点做掉了一半。
   * 现在：门店档案先解析（与 judgeInternal 用同一份口径），照片按字节原样交给 core 作为图像输入。
   */
  async function decideChecklist({ storeId, storeName, storeType, note, photos, timeoutMs, inspectionId }) {
    const cs = checklistSlot()
    if (!cs) return { items: [], reasons: '', callId: null, storeInfo: null, error: { code: 'DEPENDENCY_MISSING', message: 'ns.checklist 未就绪（gaia-inspection-core 未加载）：本次没有动态检查项' } }
    const reg = registrySlot()
    let storeInfo = null
    if (reg && storeId) {
      const r = reg.getStore(String(storeId))
      if (r && r.ok) storeInfo = r.data
    }
    const r = await cs.generate({
      storeId,
      storeName: (storeInfo && storeInfo.name) || storeName,
      storeType: (storeInfo && storeInfo.format) || storeType,
      note,
      photos,
      inspectionId,
      timeoutMs,
    })
    if (r && r.ok) return { items: r.data.items, reasons: r.data.reasons, callId: r.callId, storeInfo, error: null }
    return { items: [], reasons: '', callId: null, storeInfo, error: (r && r.error) || { code: 'CHECKLIST_UNKNOWN', message: '检查项生成未返回结果' } }
  }

  // ── ① 提交自查（前端「提交自查」入口的后端口；也是 /submit 路由的落点） ────────
  async function submit(body) {
    const b = body && typeof body === 'object' ? body : {}
    if (!db()) return receipt({ ok: false, status: 'failed', summary: '巡店业务库未就绪', error: { code: 'DEPENDENCY_MISSING', message: '需要 ns.db，请确认 gaia-inspection-core 已加载' } })
    const input = collectPhotoInputs(b, MAX_PHOTOS_SUBMIT)
    if (!input.ok) return receipt({ ok: false, status: 'failed', summary: input.error.message, error: input.error })

    const offline = state.manualOffline === true || state.routeDown === true
    // runId 在**检查项生成之前**就定下来：这样两次模型调用（checklist_generate / vision_judge）
    // 都挂在同一张检查单上，看板详情里的「模型调用 N 次」才是真数（早先 checklist 那条的
    // inspectionId 是 null，所以明明调了两次却只显示 1 次）。
    const runId = offline ? null : newRunId()

    // 「整改回拍」来源：店长端从「待整改」里点重新提交时带上原单号（reworkOf）。
    // 只有原单**真的存在**才认（不写脏来源）；这样督导端能看出"这单是整改回拍自 #xxxx"，
    // 退回→整改→复交这条链才闭合（用户实测反馈：点完退回之后找不到退到哪去了）。
    const reworkOf = (() => {
      const want = String(b.reworkOf || '').trim()
      if (!want) return null
      try {
        return db().get('inspections', want) ? want : null
      } catch {
        return null
      }
    })()

    // 检查项动态生成（真模型调用；离线时不调用，队列里带上原始输入，联网后一起补）
    let checklist = { items: [], reasons: '', callId: null }
    if (!offline) {
      try {
        const decided = await decideChecklist({
          storeId: b.storeId,
          storeName: b.storeName,
          storeType: b.storeType,
          note: b.note,
          photos: input.photos,
          inspectionId: runId,
          timeoutMs: b.timeoutMs,
        })
        checklist = { items: decided.items, reasons: decided.reasons, callId: decided.callId }
        if (decided.error) logger.warn(`检查项生成未成功（${decided.error.code}）：${decided.error.message}；本次按"无检查项"继续判读`)
      } catch (error) {
        logger.warn(`检查项生成异常（继续按"无检查项"判读）：${String((error && error.message) || error)}`)
      }
    }
    const runBody = { ...b, checklistItems: checklist.items, checklistReasons: checklist.reasons, checklistCallId: checklist.callId, reworkOf }

    if (offline) {
      const { queueDir } = paths()
      // **离线也必须先把原图落盘**：否则联网后补判时找不到原图（队列只能排队，不能丢照片）。
      const saved = await persistPhotos(input.photos)
      const item = enqueue(queueDir, {
        storeId: b.storeId ?? null,
        note: b.note ?? null,
        storeName: b.storeName ?? null,
        storeType: b.storeType ?? null,
        photoIds: saved.map((s) => s.photoId),
        reworkOf,
        reason: 'offline-switch',
      })
      const st = readQueueState(queueDir)
      logTick({ event: 'submit-queued', qid: item.qid, offline: true })
      return receipt({
        ok: true,
        runId: item.qid,
        status: 'queued',
        summary: OFFLINE_NOTICE,
        data: { offline: true, offlineSource: offlineSource(), queuePosition: st.pending, qid: item.qid, accepted: input.photos.length, modelCallsAdded: 0, reworkOf, photos: artifactsOf(saved) },
        artifacts: artifactsOf(saved),
        traceRef: `queue/${item.qid}`,
      })
    }

    const result = await judgeInternal({ photoInputs: input.photos, body: runBody, runId })
    if (!result.ok) {
      const code = (result.error && result.error.code) || 'MODEL_CALL_FAILED'
      if (isOfflineLikeError(code)) {
        const { queueDir } = paths()
        const item = enqueue(queueDir, {
          storeId: b.storeId ?? null,
          note: b.note ?? null,
          storeName: b.storeName ?? null,
          storeType: b.storeType ?? null,
          photoIds: result.saved.map((s) => s.photoId),
          reason: code,
          lastError: result.error.message,
        })
        const st = readQueueState(queueDir)
        // 熔断：模型这一路既然不可达，先停掉后续自动尝试（避免反复打空请求），
        // 由后台补判定时器 / 手动 flush 在恢复后清掉熔断。**已发生的失败尝试已如实入日志**。
        state.routeDown = true
        state.offlineSince = nowIso()
        state.offlineSource = `auto:${code}`
        logTick({ event: 'submit-queued', qid: item.qid, reason: code, breaker: state.offlineSource })
        const attempted = (checklist.callId ? 1 : 0) + (result.callId ? 1 : 0)
        return receipt({
          ok: true,
          runId: item.qid,
          status: 'queued',
          summary: `${OFFLINE_NOTICE}（原因：${code}）`,
          data: {
            offline: true,
            offlineSource: offlineSource(),
            queuePosition: st.pending,
            qid: item.qid,
            accepted: input.photos.length,
            // 如实说明：本单已发生 N 次**失败的调用尝试**（status=error 已入 model_calls），
            // 但**没有产生任何模型判断**（findings 0 条），采集本身已受理并排队。
            attemptedModelCalls: attempted,
            judgementsProduced: 0,
            diagnostic: result.error,
            photos: artifactsOf(result.saved),
          },
          artifacts: artifactsOf(result.saved),
          traceRef: `queue/${item.qid}`,
        })
      }
      return receipt({ ok: false, runId, status: 'failed', summary: `本次采集未被判读：${code}`, data: { error: result.error }, error: result.error })
    }

    return receipt({
      ok: true,
      runId,
      status: result.status,
      summary:
        result.status === 'unreadable'
          ? `受理 ${runId}：${result.unreadableCount} 张照片看不清，未产生问题判断（${result.provider}/${result.model}）`
          : `受理 ${runId}：判断 ${result.findingsCount} 条问题、${result.unreadableCount} 张看不清（${result.provider}/${result.model}，${result.latencyMs}ms）`,
      data: {
        inspectionId: runId,
        receiptNo: runId,
        offline: false,
        accepted: input.photos.length,
        findings: result.persisted.findings.map((f) => ({ findingId: f.id, itemName: f.itemName, severity: f.severity, dueAt: f.dueAt, boxesUnit: 'ratio' })),
        findingsCount: result.findingsCount,
        unreadable: result.persisted ? (NSc().db.get('inspections', runId) || {}).unreadable || [] : [],
        modelCallId: result.callId,
        provider: result.provider,
        model: result.model,
        latencyMs: result.latencyMs,
        usage: result.usage,
        inputModalities: result.inputModalities,
        checklist: { items: checklist.items, reasons: checklist.reasons, callId: checklist.callId },
        actions: result.persisted.planResult && result.persisted.planResult.ok ? result.persisted.planResult.data : null,
        warnings: result.warnings,
      },
      artifacts: artifactsOf(result.saved),
      traceRef: `${runId}/vision_judge`,
    })
  }

  /** 补判一支队列项（联网恢复后自动补判 / 手动 flush 共用）。 */
  async function flushOne(row) {
    const { photoDir, queueDir } = paths()
    const inputs = []
    for (const pid of Array.isArray(row.photoIds) ? row.photoIds : []) {
      const hit = findById(photoDir, pid)
      if (!hit) return { ok: false, error: { code: 'PHOTO_MISSING', message: `队列项 ${row.qid} 的原图已不在数据根里（photoId=${pid}）` } }
      const bytes = readFileSync(hit)
      const mediaType = mediaTypeOf(bytes)
      if (!mediaType) return { ok: false, error: { code: 'PHOTO_TYPE_UNKNOWN', message: `队列项 ${row.qid} 的原图类型判不出` } }
      inputs.push({ bytes, mediaType, name: basename(hit) })
    }
    if (inputs.length === 0) return { ok: false, error: { code: 'NO_PHOTO', message: `队列项 ${row.qid} 没有可用原图` } }
    const runId = newRunId()
    // 补判也要先决定「查哪几项」：这条路径同样拿得到原图，且此刻已联网 —— 否则离线提交的单子
    // 永远没有动态检查项，视觉判断只能"按照片里看得到的证据判读"，与在线提交的口径不一致。
    let checklistItems = []
    let checklistReasons = ''
    let checklistCallId = null
    try {
      const decided = await decideChecklist({
        storeId: row.storeId,
        storeName: row.storeName,
        storeType: row.storeType,
        note: row.note,
        photos: inputs,
        inspectionId: runId,
        timeoutMs: row.timeoutMs,
      })
      checklistItems = decided.items
      checklistReasons = decided.reasons
      checklistCallId = decided.callId
      if (decided.error) logger.warn(`补判前的检查项生成未成功（${decided.error.code}）：${decided.error.message}；本次按"无检查项"判读`)
    } catch (error) {
      logger.warn(`补判前的检查项生成异常（继续按"无检查项"判读）：${String((error && error.message) || error)}`)
    }
    const result = await judgeInternal({ photoInputs: inputs, body: { storeId: row.storeId, note: row.note, storeName: row.storeName, storeType: row.storeType, provider: row.provider, model: row.model, reworkOf: row.reworkOf ?? null, checklistItems, checklistReasons, checklistCallId }, runId })
    if (!result.ok) return { ok: false, error: result.error, runId }
    void queueDir
    return { ok: true, runId, findingsCount: result.findingsCount, unreadableCount: result.unreadableCount, callId: result.callId, provider: result.provider, model: result.model }
  }

  async function flushQueue() {
    const { queueDir } = paths()
    if (state.manualOffline === true) return { ok: false, error: { code: 'OFFLINE', message: '当前是演示离线开关状态，补判未执行（关掉离线开关后再 flush）。' } }
    const rows = loadQueue(queueDir)
    const pending = rows.filter((r) => r.status === 'pending')
    if (pending.length === 0) return { ok: true, data: { flushed: 0, judged: 0, remaining: 0 } }
    let judged = 0
    const details = []
    for (const row of pending) {
      const r = await flushOne(row)
      if (r.ok) {
        row.status = 'judged'
        row.judgedAt = nowIso()
        row.inspectionId = r.runId
        row.modelCallId = r.callId
        judged += 1
        details.push({ qid: row.qid, ok: true, inspectionId: r.runId, findings: r.findingsCount })
      } else {
        row.attempts = (row.attempts || 0) + 1
        row.lastError = r.error
        details.push({ qid: row.qid, ok: false, error: r.error })
        if (isOfflineLikeError(r.error && r.error.code)) break
      }
    }
    rewrite(queueDir, rows)
    if (judged > 0) {
      // 补判成功 → 清掉熔断（模型这一路已恢复）
      state.routeDown = false
      state.offlineSince = null
      state.offlineSource = 'none'
    }
    logTick({ event: 'queue-flush', judged, remaining: rows.filter((r) => r.status === 'pending').length })
    return { ok: true, data: { flushed: pending.length, judged, remaining: rows.filter((r) => r.status === 'pending').length, details } }
  }

  // ── 槽位发布 ────────────────────────────────────────────────────────────────
  const ns = (globalThis[NS_KEY] ??= {})
  ns.capture = {
    submit,
    judge: (args) => judgeTool(args),
    thumb: (args) => thumbTool(args),
    setOffline: (flag) => {
      state.manualOffline = flag === true
      if (flag === true) {
        state.offlineSince = nowIso()
        state.offlineSource = 'demo-switch'
      } else {
        state.routeDown = false
        state.offlineSince = null
        state.offlineSource = 'none'
      }
      logTick({ event: 'offline-switch', offline: state.manualOffline })
      return { ok: true, offline: state.manualOffline, offlineSource: offlineSource() }
    },
    flush: () => flushQueue(),
    queueState: () => {
      const { queueDir } = paths()
      const st = readQueueState(queueDir)
      return { ok: true, offline: offlineNow(), manualOffline: state.manualOffline, routeDown: state.routeDown, offlineSource: offlineSource(), offlineSince: state.offlineSince, file: st.file, pending: st.pending, judged: st.judged, items: st.items }
    },
    paths,
  }

  // ── 工具实现 ────────────────────────────────────────────────────────────────
  async function judgeTool(args) {
    const a = args || {}
    const input = collectPhotoInputs({ photos: a.photos, photoPaths: a.photoPaths })
    if (!input.ok) return { ok: false, summary: input.error.message, data: { error: input.error }, error: input.error }
    const runId = a.inspectionId || newRunId()
    const { photoDir, thumbDir } = paths()
    const saved = await persistPhotos(input.photos)
    void photoDir
    void thumbDir
    const log = modelLog()
    const vision = await judgePhotos({ ctx, logger: log }, {
      photos: input.photos,
      storeId: a.storeId,
      storeName: a.storeName,
      storeType: a.storeType,
      note: a.note,
      inspectionId: runId,
      checklistItems: a.checklistItems,
      provider: a.provider,
      model: a.model,
      timeoutMs: a.timeoutMs,
    })
    if (!vision.ok) return { ok: false, summary: `视觉判断未完成：${vision.error.code}`, data: { callId: vision.callId, error: vision.error, photos: artifactsOf(saved) }, error: vision.error }
    return {
      ok: true,
      summary: `判断完成：${vision.data.findings.length} 条问题、${vision.data.unreadable.length} 张看不清（${vision.provider}/${vision.model}，${vision.latencyMs}ms）`,
      data: {
        runId,
        callId: vision.callId,
        provider: vision.provider,
        model: vision.model,
        inputModalities: vision.inputModalities,
        latencyMs: vision.latencyMs,
        usage: vision.usage,
        findings: vision.data.findings,
        boxes: vision.data.boxes,
        boxesUnit: 'ratio',
        unreadable: vision.data.unreadable,
        summary: vision.data.summary,
        photos: artifactsOf(saved),
      },
      error: null,
    }
  }

  async function thumbTool(args) {
    const a = args || {}
    const { photoDir, thumbDir } = paths()
    let bytes = null
    let photoId = ''
    if (typeof a.photoPath === 'string' && a.photoPath.trim()) {
      try {
        bytes = readFileSync(a.photoPath.trim())
      } catch (error) {
        const e = { code: 'PHOTO_READ_FAILED', message: String((error && error.message) || error) }
        return { ok: false, summary: `缩略图未生成：${e.message}`, data: { error: e }, error: e }
      }
      photoId = photoIdOf(bytes)
    } else if (typeof a.photoId === 'string' && a.photoId.trim()) {
      const hit = findById(photoDir, a.photoId.trim())
      if (!hit) {
        const e = { code: 'PHOTO_NOT_FOUND', message: `数据根 photos 目录里没有 photoId=${a.photoId} 的图` }
        return { ok: false, summary: `缩略图未生成：${e.message}`, data: { error: e }, error: e }
      }
      bytes = readFileSync(hit)
      photoId = a.photoId.trim().toLowerCase()
    } else {
      const e = { code: 'NO_INPUT', message: '请给 photoPath（本地路径）或 photoId（库内 id）之一' }
      return { ok: false, summary: `缩略图未生成：${e.message}`, data: { error: e }, error: e }
    }
    const mediaType = mediaTypeOf(bytes)
    if (!mediaType) {
      const e = { code: 'PHOTO_TYPE_UNKNOWN', message: '不是受支持的图片（只支持 PNG/JPEG/WebP/GIF）' }
      return { ok: false, summary: `缩略图未生成：${e.message}`, data: { error: e, photoId }, error: e }
    }
    const r = await makeThumb(ctx, { bytes, mediaType, photoDir, thumbDir, longEdge: Math.max(32, Number(a.longEdge) || DEFAULT_THUMB_LONG_EDGE) })
    if (!r.ok) return { ok: false, summary: `缩略图未生成：${r.message}`, data: { photoId, error: { code: r.code, message: r.message } }, error: { code: r.code, message: r.message } }
    return {
      ok: true,
      summary: `缩略图已生成：${r.width}x${r.height}（长边 ${r.longEdge}，来源 ${r.via}）`,
      data: {
        original: { photoId: r.photoId, path: findById(photoDir, r.photoId), url: `/api/gaia-inspection/photo?id=${r.photoId}&kind=original` },
        photoId: r.photoId,
        thumbPath: r.thumbPath,
        thumbUrl: `/api/gaia-inspection/photo?id=${r.photoId}&kind=thumb`,
        width: r.width,
        height: r.height,
        longEdge: r.longEdge,
        via: r.via,
        originalPreserved: true,
      },
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
    name: 'inspection_judge_photos',
    description: '对门店照片发起真实的多模态模型判断：返回问题项、严重度、依据文字、圈框坐标（归一化比例，可为空数组）、以及"看不清"的照片清单。模型未声明图像输入时返回 MODEL_NOT_VISION 且不发请求；模型输出不合法时返回可诊断错误，不会套用预设结论。',
    parameters: {
      photoPaths: { type: 'array', items: { type: 'string' }, description: '照片的本地绝对路径（与 photos 二选一）' },
      photos: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '照片（与 photoPaths 二选一）：[{name, mediaType, dataBase64}]' },
      storeId: { type: 'string', description: '门店标识（可空）' },
      storeName: { type: 'string', description: '门店名（可空）' },
      storeType: { type: 'string', description: '业态（可空）' },
      note: { type: 'string', description: '店长的一句话说明（可空）' },
      checklistItems: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '可选：本次检查项（供模型聚焦，不强凑）' },
      inspectionId: { type: 'string', description: '可选：关联的检查单 id' },
      provider: { type: 'string', description: '可选：显式指定 provider' },
      model: { type: 'string', description: '可选：显式指定 model' },
      timeoutMs: { type: 'number', description: '可选：超时毫秒，默认 120000' },
    },
    async execute(args) {
      return judgeTool(args)
    },
  })

  wrap({
    name: 'inspection_submit_selfcheck',
    description: '受理一次门店自查采集（**单张照片** + 一句话）：在线时真实判读并落库、自动派整改动作并回受理回执；模型不可达或处于离线开关时只把采集排进待判队列、不产生任何模型判断并如实回执"离线：仅采集排队，不产生模型判断"。单张解码后上限 2MB，超限返回结构化错误。',
    parameters: {
      photos: { type: 'array', items: { type: 'object', additionalProperties: true }, description: '照片：[{name, mediaType, dataBase64}]，**只收 1 张**、解码后 ≤2MB' },
      photoPaths: { type: 'array', items: { type: 'string' }, description: '照片的本地绝对路径（与 photos 二选一）' },
      storeId: { type: 'string', description: '门店标识' },
      note: { type: 'string', description: '店长的一句话说明' },
      storeName: { type: 'string', description: '可选：门店名（默认取门店档案）' },
      storeType: { type: 'string', description: '可选：业态（默认取门店档案）' },
      provider: { type: 'string', description: '可选：显式指定 provider' },
      model: { type: 'string', description: '可选：显式指定 model' },
      timeoutMs: { type: 'number', description: '可选：超时毫秒' },
    },
    async execute(args) {
      return submit(args || {})
    },
  })

  wrap({
    name: 'inspection_pending_queue',
    description: '待判队列：action=list 查看离线期间排队等待判读的采集（含离线状态与队列位置）；action=flush 立即补判全部待判项（联网恢复后也由后台定时器自动补判），补判成功会补派整改单并回填队列状态。',
    parameters: {
      action: { type: 'string', enum: ['list', 'flush'], required: true, description: 'list 查看 / flush 补判' },
    },
    async execute(args) {
      const action = String(args.action || '')
      if (action === 'list') {
        const st = ns.capture.queueState()
        return { ok: true, summary: `待判 ${st.pending} 条、已补判 ${st.judged} 条；离线=${st.offline}`, data: st, error: null }
      }
      if (action === 'flush') {
        const r = await flushQueue()
        if (!r.ok) return { ok: false, summary: `补判未执行：${r.error.message}`, data: r.data ?? null, error: r.error }
        return { ok: true, summary: `补判完成：判读 ${r.data.judged} 条，剩余待判 ${r.data.remaining} 条`, data: r.data, error: null }
      }
      return { ok: false, summary: `未知 action：${action}`, data: null, error: { code: 'BAD_ACTION', message: 'action 只能是 list 或 flush' } }
    },
  })

  wrap({
    name: 'inspection_thumb',
    description: '对一张门店照片生成缩略图（长边默认 512px、保持比例、原图原样保留）。优先走宿主图像管线（ctx.attachments），不可用时退到本包零第三方 PNG 缩放；解不了的格式返回 THUMB_UNSUPPORTED，不会假装生成。返回缩略图 id/URL 供看板小图与证据卡片读取。',
    parameters: {
      photoPath: { type: 'string', description: '照片本地绝对路径（与 photoId 二选一）' },
      photoId: { type: 'string', description: '库内照片 id（与 photoPath 二选一）' },
      longEdge: { type: 'number', description: '可选：缩略图长边像素，默认 512' },
    },
    async execute(args) {
      return thumbTool(args)
    },
  })

  wrap({
    name: 'inspection_offline_mode',
    description: '演示用离线开关：打开后本次会话的采集只排队、不产生模型判断（model_calls 不新增），用于复现"断网降级与待判队列"；关闭并 flush 后恢复真实补判。这不是账号状态，也不落持久身份。',
    parameters: {
      offline: { type: 'boolean', required: true, description: 'true=进入离线（仅排队），false=恢复在线' },
    },
    async execute(args) {
      const r = ns.capture.setOffline(args.offline === true)
      return { ok: true, summary: r.offline ? `已进入离线模式：${OFFLINE_NOTICE}` : '已恢复在线：可提交真实判读或 flush 补判', data: r, error: null }
    },
  })

  // ── 联网后自动补判（真定时器；与「立即扫描」无关，各管一摊） ──────────────────
  const flushMs = Math.max(0, Number(process.env.GAIA_INSPECTION_FLUSH_MS ?? 30000))
  let timer = null
  if (flushMs > 0) {
    timer = setInterval(() => {
      try {
        // 演示离线开关下不补判；模型熔断（routeDown）下**仍会尝试**——那正是"恢复联网后自动补判"。
        if (state.manualOffline === true) return
        const { queueDir } = paths()
        if (readQueueState(queueDir).pending === 0) return
        flushQueue().then((r) => logger.info(`[自动补判] ${JSON.stringify(r.data || r.error)}`))
      } catch (error) {
        logger.warn(`[自动补判] 异常：${String((error && error.message) || error)}`)
      }
    }, flushMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  return () => {
    if (timer) clearInterval(timer)
    for (const d of reg) {
      try {
        if (typeof d === 'function') d()
      } catch {
        /* 幂等 */
      }
    }
    const g = globalThis[NS_KEY]
    if (g && g.capture && typeof g.capture.submit === 'function') delete g.capture
  }
}

export { judgePhotos, makeThumb, saveOriginal, mediaTypeOf, photoIdOf, clearQueue, loadQueue, rewrite, enqueue, readQueueState }
