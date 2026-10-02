// gaia-inspection-capture / lib/vision.js
// 门店照片视觉判断（能力词：门店照片视觉判断）——A 档，**真视觉模型调用**。
//
// 硬约束（本单 §4 红线，逐条落在这里）：
//   1) 只走宿主 `ctx.get('llm').stream(...)`（见 lib/modelroute.js），本文件不读凭据、不写 key；
//   2) 发请求**前**做图像模态前置检查：模型未声明 image 输入 → 立即返回 `MODEL_NOT_VISION`，
//      不发请求、不落假结论（文本模型会把图投影成占位符文本，那是静默降级，本单禁止）；
//   3) **本文件里没有任何 if-else / 关键词规则去产出"问题项"**。判断只能来自模型输出；
//      模型输出不是合法 JSON / 为空 / 调用失败 → 一律返回可诊断错误，**绝不套用预设结论**；
//   4) 模糊、失焦、过暗、过曝、拍偏的照片：提示词明确要求模型放进 `unreadable` 并说明原因，
//      并且**不许猜测**；本文件对 `unreadable` 只做原样转发，不加工、不补全。
//
// 每张照片先经宿主 attachment 服务落成持久附件（`ctx.attachments.saveImages`），
// 再以 `{type:'image', attachment:ref}` 进入消息 —— 这是宿主多模态输入的唯一正路。
import { basename } from 'node:path'

import { resolveRoute, assertVisionModel, fail } from './modelroute.js'
import { loggedCall } from './modellog.js'

export const VISION_SYSTEM = [
  '你是餐饮门店巡店督导的照片判读员。你**只依据照片里真正看得到的证据**下判断。',
  '规则：',
  '1) 只输出 JSON，不要 markdown 代码块，不要额外解释。',
  '2) 每条问题都要能在这张照片里指出来：能定位就给圈框 boxes（归一化比例 0-1，相对该照片宽高）；**只能指个大致位置、框不准的**，就给 point（归一化比例 0-1 的一个点）并把 boxes 留空数组 []；连位置都指不出来的，boxes 与 point 都留空/null。',
  '3) 照片模糊、失焦、过暗、过曝、被遮挡、角度拍偏、看不清细节时，**必须**把它放进 unreadable 并说明原因，**不得猜测、不得编造问题项**。',
  '4) 这张照片里没看到问题的，不要硬凑问题项（findings 可以为空）。',
  '5) reason 只写你看到的证据（物体 / 位置 / 状态），不要写"可能""大概""建议检查"这类没有画面依据的话。',
  '6) 照片之间是同一家门店的同一次巡店，别把不同照片的问题混在一起（每条 finding 用 photoIndex 指明是哪张）。',
  '7) confidence 是**你自己对这条判断的把握**，只许用文字 高 / 中 / 低（不要用百分比）；证据充分就 高，只能看出个大概就 中，很勉强就 低。它和 severity 不是一回事：severity 是问题有多严重，confidence 是你有多确定。',
  '输出 JSON 形状：',
  '{"findings":[{"photoIndex":0,"item":"地面清洁","severity":"高|中|低","confidence":"高|中|低","reason":"画面左下的地砖上有深色散落物","suggestion":"立即清扫并复查","boxes":[{"x":0.12,"y":0.55,"w":0.25,"h":0.3}],"point":null}],',
  ' "unreadable":[{"photoIndex":1,"why":"画面整体失焦且过暗，看不清地面细节"}],',
  ' "summary":"一句话总结本次照片判断"}',
].join('\n')

/**
 * 提示词版本：改 VISION_SYSTEM / 提示词结构时必须同步涨版本（README 有说明）。
 * v1 → v2：新增每条判断的 confidence（文字 高/中/低）与 boxes 不准时的 point 降级。
 */
export const VISION_PROMPT_VERSION = 'vision-judge-v2'

const ALLOWED_SEVERITY = ['高', '中', '低']

function clamp01(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.min(1, Math.max(0, n))
}

/** 归一化一个 boxes 数组（ratio 0-1）；形状不完整的框直接丢弃（宁可空，不许编）。 */
function normalizeBoxes(raw, photoIndex) {
  const out = []
  if (!Array.isArray(raw)) return out
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue
    const x = clamp01(b.x)
    const y = clamp01(b.y)
    const w = clamp01(b.w ?? b.width)
    const h = clamp01(b.h ?? b.height)
    if (x === null || y === null || w === null || h === null) continue
    if (w <= 0 || h <= 0) continue
    out.push({ x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y), photoIndex })
  }
  return out
}

/**
 * 归一化 fallbackPoint（"图上标点"降级的落点）：只有模型真的给了可解析的点才回对象，
 * 否则回 null —— 前端据此区分「模型确实无法定位」与「框缺失」。
 * `text` = 该条判断的依据文字（界面要点旁边写的那句话）。
 */
function normalizePoint(raw, photoIndex, reasonText) {
  if (!raw || typeof raw !== 'object') return null
  const x = clamp01(raw.x)
  const y = clamp01(raw.y)
  if (x === null || y === null) return null
  return { x, y, unit: 'ratio', photoIndex, source: 'model', text: reasonText || '' }
}

function str(v) {
  return typeof v === 'string' ? v.trim() : v === undefined || v === null ? '' : String(v).trim()
}

/**
 * 真视觉判断。
 * @param {{ctx:object, logger:object}} deps logger = 模型调用日志端口（start/end）
 * @param {{photos:Array<{bytes:Buffer,mediaType:string,name:string}>, storeId?:string, storeName?:string,
 *          storeType?:string, note?:string, inspectionId?:string, checklistItems?:Array, provider?:string,
 *          model?:string, timeoutMs?:number}} args
 * @returns 成功：{ok:true, callId, provider, model, latencyMs, data:{findings,unreadable,summary,boxes}}
 *          失败：{ok:false, callId, error:{code,message}}
 */
export async function judgePhotos(deps, args) {
  const { ctx, logger } = deps
  const photos = Array.isArray(args.photos) ? args.photos.filter((p) => p && p.bytes && p.bytes.length > 0) : []
  if (photos.length === 0) return fail('NO_PHOTO', '本次没有可判读的照片（照片字节为空）')

  const route = resolveRoute(ctx, { provider: args.provider, model: args.model })
  if (!route.ok) return { ok: false, callId: null, error: route.error }

  // ① 图像模态前置检查（不通过就**不发请求**）
  const vis = await assertVisionModel(route.llm, route.provider, route.model)
  if (!vis.ok) return { ok: false, callId: null, error: vis.error }

  // ② 照片经宿主 attachment 服务落成持久附件
  const attachments = ctx && typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
  if (!attachments || typeof attachments.saveImages !== 'function') {
    return {
      ok: false,
      callId: null,
      error: {
        code: 'ATTACHMENT_UNAVAILABLE',
        message: '宿主未提供 attachments 服务：DeepSeek 适配器的图像输入要求「vision 模型 + attachment 服务」同时在场，本次未发起调用（不会用文本模型硬凑）。',
      },
    }
  }
  let refs
  try {
    refs = await attachments.saveImages(
      photos.map((p) => ({
        data: p.bytes,
        mediaType: p.mediaType,
        ...(p.name ? { name: p.name } : {}),
      })),
    )
  } catch (error) {
    return {
      ok: false,
      callId: null,
      error: { code: (error && error.code) || 'ATTACHMENT_SAVE_FAILED', message: `照片附件落盘失败：${String((error && error.message) || error)}` },
    }
  }

  // ③ 组装多模态消息（图片块 + 判读要求）
  const items = Array.isArray(args.checklistItems) ? args.checklistItems : []
  const prompt = [
    `门店：${str(args.storeName) || '未指定门店'}（业态：${str(args.storeType) || '未指定'}）`,
    `店长说明：${str(args.note) || '（店长未附说明）'}`,
    items.length > 0 ? `本次检查项（由检查项动态生成环节给出，供你聚焦；没有证据的项不要硬凑）：\n${items.map((i) => `- ${str(i.name)}：${str(i.why) || '（未给理由）'}`).join('\n')}` : '本次检查项：无（按照片里看得到的证据判读）',
    `本次共 ${photos.length} 张照片，按给出顺序 photoIndex 从 0 开始：${photos.map((p, i) => `${i}=${basename(String(p.name || `photo-${i}`))}`).join('，')}`,
    '请按系统提示的 JSON 形状输出判断结果。看不清的照片放进 unreadable，不要猜。',
  ].join('\n\n')
  const content = [{ type: 'text', text: prompt }, ...refs.map((r) => ({ type: 'image', attachment: r }))]

  // ④ 真调用（调用发生的那一刻写模型调用日志；只落业务摘要，不落 key/请求头/完整 prompt）
  const call = await loggedCall(logger, route, {
    kind: 'vision_judge',
    promptVersion: VISION_PROMPT_VERSION,
    requestSummary: `门店 ${str(args.storeName) || '未指定'}（${str(args.storeType) || '未指定'}）；照片 ${photos.length} 张；检查项 ${items.length} 项；店长说明 ${str(args.note).length} 字`,
    storeId: args.storeId ?? null,
    inspectionId: args.inspectionId ?? null,
  }, {
    content,
    system: VISION_SYSTEM,
    timeoutMs: args.timeoutMs,
    purpose: 'gaia-inspection-vision',
  })
  if (!call.ok) return { ok: false, callId: call.callId, error: call.error }

  const text = String(call.text || '')
  if (text.trim() === '') {
    return { ok: false, callId: call.callId, error: { code: 'EMPTY_RESPONSE', message: '模型返回了空文本：本次不产生任何判断（不编造结论）。可重试。' } }
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  let parsed = null
  if (start !== -1 && end > start) {
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch {
      parsed = null
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, callId: call.callId, error: { code: 'MODEL_OUTPUT_INVALID', message: `视觉判断失败：模型输出不是合法 JSON（收到 ${text.length} 字符，前 200 字：${text.slice(0, 200)}）。` } }
  }

  // ⑤ 只做**形状归一**（坐标范围、严重度取值），不做任何"补结论"
  const findings = []
  const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : []
  for (const f of rawFindings) {
    if (!f || typeof f !== 'object') continue
    const itemName = str(f.item ?? f.name ?? f.itemName)
    if (!itemName) continue
    const pi = Number.isInteger(f.photoIndex) ? f.photoIndex : 0
    const sev = str(f.severity)
    const conf = str(f.confidence ?? f.confidenceText)
    const boxes = normalizeBoxes(f.boxes, pi)
    findings.push({
      photoIndex: pi,
      itemName,
      severity: ALLOWED_SEVERITY.includes(sev) ? sev : sev || '未标注',
      // 置信度：**模型自己给的文字把握**（高/中/低），不是由 severity 折算出来的；模型没给就是 null
      confidence: ALLOWED_SEVERITY.includes(conf) ? conf : conf || null,
      confidenceSource: ALLOWED_SEVERITY.includes(conf) ? 'model' : conf ? 'model' : 'missing',
      reason: str(f.reason),
      suggestion: str(f.suggestion),
      boxes,
      // 无坐标时的"图上标点"：模型给了点就用，没给就是 null（前端只显示文字依据）
      fallbackPoint: boxes.length > 0 ? null : normalizePoint(f.point, pi, str(f.reason)),
    })
  }
  const unreadable = []
  for (const u of Array.isArray(parsed.unreadable) ? parsed.unreadable : []) {
    if (!u || typeof u !== 'object') continue
    const pi = Number.isInteger(u.photoIndex) ? u.photoIndex : 0
    unreadable.push({ photoIndex: pi, photoId: null, why: str(u.why ?? u.reason) || '模型标注为看不清但未说明原因' })
  }
  const boxes = findings.flatMap((f) => f.boxes)

  return {
    ok: true,
    callId: call.callId,
    provider: route.provider,
    model: route.model,
    latencyMs: call.latencyMs,
    usage: call.usage,
    inputModalities: vis.inputModalities ?? null,
    promptVersion: VISION_PROMPT_VERSION,
    data: {
      findings,
      unreadable,
      boxes,
      summary: str(parsed.summary),
      photos: photos.map((p, i) => ({ photoIndex: i, name: str(p.name), mediaType: p.mediaType, attachmentId: refs[i] && refs[i].attachmentId ? String(refs[i].attachmentId) : null })),
      raw: text,
    },
  }
}
