// gaia-inspection-core / lib/checklist.js
// 检查项动态生成（能力词：检查项动态生成）——A 档、必须真模型调用。
//
// 「本次为什么查这几项」是命门：检查项由模型按**本次输入**决定，并给出理由列表；
// 本文件里**没有任何固定检查项清单**，也没有"生成失败就套预设清单"的分支——
// 模型不可用/输出不是合法 JSON 时一律返回可诊断错误，由调用方决定排队或重试。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveRoute, assertVisionModel, streamCall, parseJsonObject, fail } from './modelroute.js'
import { loggedCall } from './modellog.js'
import { dataRoot } from './store.js'

/**
 * 内置参考维度 —— **兜底**，不是清单。
 * 只在"客户还没注入检查标准"时使用，保证没标准也能跑。
 */
export const DIMENSION_HINTS = [
  '人员与卫生（工服、健康证、手部清洁）',
  '食材与半成品（生熟分开、覆盖、温度、效期）',
  '台面与设备（操作台、灶台、冰柜、清洁度）',
  '地面与通道（积水、油污、杂物堆放、通道占用）',
  '三防设施（防蝇防鼠防尘、垃圾与垃圾桶）',
  '标识与留样（效期标签、留样记录、公示信息）',
]

/** 可注入的检查标准文件名：客户/总部只需放一个文件，**不改代码、不用重启**。 */
export const STANDARDS_FILE = 'standards.json'

/** 标准文件的两个座位，按优先级：① 客户可写区（数据根）② 随包交付的插件目录。 */
function standardsSeats() {
  let pluginDir = ''
  try {
    pluginDir = fileURLToPath(new URL('../', import.meta.url))
  } catch {
    pluginDir = ''
  }
  const seats = [{ seat: 'data', path: join(dataRoot(), STANDARDS_FILE) }]
  if (pluginDir) seats.push({ seat: 'plugin', path: join(pluginDir, STANDARDS_FILE) })
  return seats
}

/** 维度项两种写法都收：`"人员与卫生"` 或 `{ name, items: [...] }`。 */
function dimensionText(raw) {
  if (typeof raw === 'string') return raw.trim()
  if (raw && typeof raw === 'object') {
    const name = String(raw.name ?? raw.title ?? '').trim()
    if (!name) return ''
    const items = Array.isArray(raw.items) ? raw.items.map((x) => String(x).trim()).filter(Boolean) : []
    return items.length > 0 ? `${name}（${items.join('、')}）` : name
  }
  return ''
}
function normalizeDimensions(list) {
  if (!Array.isArray(list)) return []
  return list.map(dimensionText).filter(Boolean)
}

/**
 * 在 `byFormat` 里找本次业态对应的那份：**先精确、再宽松包含**（"快餐档口" 能命中键 "快餐"），
 * 多个包含命中时取**最长的键**（最具体的那个）。找不到返回 null（交给通用 dimensions）。
 */
function pickFormatEntry(byFormat, format) {
  if (!byFormat || typeof byFormat !== 'object' || !format) return null
  const keys = Object.keys(byFormat).filter((k) => k.trim() && byFormat[k] !== null && byFormat[k] !== undefined)
  if (keys.length === 0) return null
  const exact = keys.find((k) => k.trim() === format)
  if (exact) return { key: exact, entry: byFormat[exact], match: 'exact' }
  const loose = keys
    .filter((k) => {
      const key = k.trim()
      return key && (format.includes(key) || key.includes(format))
    })
    .sort((a, b) => b.trim().length - a.trim().length)[0]
  return loose ? { key: loose, entry: byFormat[loose], match: 'loose' } : null
}

/** byFormat 的一项可以写成 `{version, dimensions}`，也可以直接写成 dimensions 数组。 */
function formatEntryOf(entry) {
  if (Array.isArray(entry)) return { version: '', dimensions: normalizeDimensions(entry) }
  if (entry && typeof entry === 'object') return { version: String(entry.version || '').trim(), dimensions: normalizeDimensions(entry.dimensions) }
  return { version: '', dimensions: [] }
}

/**
 * 读「检查标准」——总部把自己的门店检查标准给进来的**文件级口子**。
 *
 * 形状（JSON）——通用一份 + **可选**的分业态专项（`dimensions` 与 `byFormat.*.dimensions` 都接受纯字符串数组）：
 * ```json
 * {
 *   "version": "示例连锁·门店自查标准 v1",
 *   "dimensions": [{ "name": "人员与卫生", "items": ["工服", "健康证"] }],
 *   "byFormat": {
 *     "快餐档口": { "version": "快餐档口专项 v3", "dimensions": [{ "name": "打包与出餐动线", "items": ["封签完好"] }] },
 *     "正餐堂食": { "dimensions": [{ "name": "留样与公示", "items": ["留样 48h"] }] }
 *   }
 * }
 * ```
 *
 * 取用顺序：**byFormat[业态]（精确→宽松包含）→ 文件的通用 dimensions → 内置 6 维**。
 * 「统一标准」和「分业态标准」两种做法都能表达：不写 `byFormat` 就是全公司统一一份。
 *
 * **每次调用都重读文件**：客户改完即刻生效，不用重启。
 * **任何异常都不抛**：读不到 / 解析失败 / 形状不对 → 退回内置，并把原因带在 `error` 里。
 *
 * @param {string} [format] 本次业态（如 '快餐档口'）；给了才可能命中 byFormat 专项
 * @returns {{source:'injected'|'packaged'|'builtin', seat:string|null, path:string|null, version:string, dimensions:string[],
 *            scope:'format'|'base'|'builtin', format:string, matchedBy:string|null, error:object|null}}
 */
export function loadStandards(format) {
  const wanted = String(format || '').trim()
  let firstError = null
  for (const seat of standardsSeats()) {
    if (!existsSync(seat.path)) continue
    try {
      // 容忍 UTF-8 BOM：Windows 上客户用记事本 / PowerShell 存这个文件**一定**会带 BOM，
      // 不剥掉 JSON.parse 直接抛错 → 静默退回内置（真机实测踩过：文件明明在，日志却说"未注入"）。
      const raw = JSON.parse(readFileSync(seat.path, 'utf8').replace(/^\uFEFF/, ''))
      const baseVersion = String((raw && raw.version) || '').trim() || '未标注版本'
      const baseDimensions = normalizeDimensions(raw && raw.dimensions)
      const hit = pickFormatEntry(raw && raw.byFormat, wanted)
      const picked = hit ? formatEntryOf(hit.entry) : { version: '', dimensions: [] }
      const dimensions = picked.dimensions.length > 0 ? picked.dimensions : baseDimensions
      if (dimensions.length === 0) {
        firstError = { code: 'STANDARDS_EMPTY', message: `标准文件里没有可用维度（dimensions / byFormat 都为空或形状不对）：${seat.path}` }
        continue
      }
      const isFormat = picked.dimensions.length > 0
      return {
        source: seat.seat === 'data' ? 'injected' : 'packaged',
        seat: seat.seat,
        path: seat.path,
        version: isFormat ? picked.version || `${baseVersion} · ${hit.key}` : baseVersion,
        dimensions,
        scope: isFormat ? 'format' : 'base',
        format: wanted,
        matchedBy: isFormat ? hit.match : null,
        error: null,
      }
    } catch (error) {
      firstError = { code: 'STANDARDS_INVALID', message: `标准文件读取/解析失败（${seat.path}）：${String((error && error.message) || error)}` }
    }
  }
  return {
    source: 'builtin',
    seat: null,
    path: null,
    version: '内置参考维度（尚未注入检查标准）',
    dimensions: DIMENSION_HINTS.slice(),
    scope: 'builtin',
    format: wanted,
    matchedBy: null,
    error: firstError,
  }
}

/** 提示词版本：改 CHECKLIST_SYSTEM / 提示词结构时必须同步涨版本（README 有说明）。 */
export const CHECKLIST_PROMPT_VERSION = 'checklist-v4'

export const CHECKLIST_SYSTEM = [
  '你是餐饮门店巡店督导的检查项生成器。',
  '你的任务：根据**本次**门店业态、本次采集到的**照片**、店长说明，以及总部注入的**检查标准**，决定这次到底要查哪几项。',
  '规则：',
  '1) 检查项必须与本次输入相关；不同业态（快餐档口 / 正餐堂食）与不同采集内容应产生不同的检查项集合，不要每次都输出同一套。',
  '2) 每项给出 why：为什么这次要查这一项（要引用本次输入里的具体线索）。引用照片线索时，只说画面里**真实看得到**的东西；看不清就说看不清，不要猜。',
  '3) weight 用 1-5 的数字表示本次权重（越贴近本次线索越大）。',
  '4) 只输出 JSON，不要输出解释、不要用 markdown 代码块。',
  '5) 若本次输入不足以判断，要在 reasons 里如实说明"信息不足"，不要编造线索；**有没有照片、门店与业态是否给出，都必须按实际收到的情况说**。',
  '6) 若给了「检查标准」（可能是全公司通用，也可能标注为**本次业态专项**）：**以它为主要参考**（总部/客户就是按它考核的），但**不是逐条勾选**——标准里与本次输入无关的项可以不列；标准里没写、而本次照片或说明里确实出现的问题，**也要提出**，并在 why 里说明理由。标准只是参考维度，不是本次检查项的固定清单。',
  '输出 JSON 形状：',
  '{"items":[{"itemId":"简短英文或拼音标识","name":"中文检查项名","why":"为什么这次查它","weight":3}],"reasons":"本次为什么查这几项的一段话"}',
].join('\n')

/**
 * 生成检查项（真模型调用 + 当刻落日志）。
 *
 * 【真机教训 · 必须保留】产品差异化的命门是「拍一张照片 + 一句话 → Agent **看照片和这句话**决定该查哪几项」。
 * 所以 `args.photos`（**原始图片字节**）在这条路径上是必给项：早先这里只接受文字 `photoHints`，
 * 而采集侧从来没有人产过 hints，于是决定检查项的那次调用**从头到尾没见过照片**，
 * 模型如实写出「本次仅有店长说明，无照片」——创新点被做掉了一半（教练在真机数据里抓到，见交付报告 §13）。
 * 现在：有照片就按与视觉判断**同一套纪律**（图像模态前置检查 + attachment 落盘）把真图送进去；
 * 没有照片（例如 agent 直接调工具手工生成）才退回「文字线索」口径。
 *
 * @param {{logger:object, ctx:object}} deps logger = core 的模型调用日志写入端口
 * @param {{photos?:Array<{bytes:Buffer,mediaType:string,name?:string}>}} args
 */
export async function generateChecklist(deps, args) {
  const { ctx, logger } = deps
  const route = resolveRoute(ctx, { provider: args.provider, model: args.model })
  if (!route.ok) return { ok: false, error: route.error, callId: null }
  const storeType = String(args.storeType || '').trim() || '未指定业态'
  const storeName = String(args.storeName || '').trim() || '未指定门店'
  const note = String(args.note || '').trim() || '（店长未附一句话说明）'
  const photoHints = Array.isArray(args.photoHints) ? args.photoHints.filter(Boolean).map(String) : []
  const photos = Array.isArray(args.photos) ? args.photos.filter((p) => p && p.bytes && p.bytes.length > 0) : []
  // 本次使用的检查标准：客户/总部注入的那份 → 随包交付的 → 内置兜底（读不到也绝不抛）。
  // 传 storeType，让"分业态标准"（byFormat）能被命中；没有 byFormat 就是全公司统一一份。
  const standards = loadStandards(storeType)

  // 照片作为**图像块**进模型（不是文字描述）：模态前置检查 → attachment 落盘 → content 里带 image part。
  let refs = []
  if (photos.length > 0) {
    const vis = await assertVisionModel(route.llm, route.provider, route.model)
    if (!vis.ok) return { ok: false, error: vis.error, callId: null }
    const attachments = ctx && typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
    if (!attachments || typeof attachments.saveImages !== 'function') {
      return {
        ok: false,
        callId: null,
        error: {
          code: 'ATTACHMENT_UNAVAILABLE',
          message: '宿主未提供 attachments 服务：本次照片无法作为图像输入送进「检查项生成」。**不会**退化成"只看文字"来决定查哪几项（那正是本次修掉的缺陷）。',
        },
      }
    }
    try {
      refs = await attachments.saveImages(
        photos.map((p) => ({
          data: p.bytes,
          mediaType: p.mediaType,
          ...(p.name ? { name: p.name } : {}),
        })),
      )
    } catch (error) {
      return { ok: false, callId: null, error: { code: (error && error.code) || 'ATTACHMENT_SAVE_FAILED', message: `照片附件落盘失败：${String((error && error.message) || error)}` } }
    }
  }

  const prompt = [
    `门店：${storeName}（业态：${storeType}）`,
    `店长说明：${note}`,
    refs.length > 0
      ? `本次共 ${refs.length} 张门店照片，**已随本消息附上（按顺序 photoIndex 从 0 开始：${photos.map((p, i) => `${i}=${String(p.name || `photo-${i}`)}`).join('，')}）。必须直接看图**，把画面里真实看得到的东西当作本次检查项的线索。`
      : '本次没有照片，只能依据店长说明与门店业态判断（请在 reasons 里如实说明"无照片"）。',
    photoHints.length > 0 ? `本次照片的机器可见线索（由采集侧原样给出，未做判断）：\n${photoHints.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : '',
    // 检查标准：客户/总部注入的那份（可能是全公司统一、也可能是本业态专项）。标准是**参考维度**，不是本次清单。
    standards.source === 'builtin'
      ? `可参考的判定维度（本单尚未注入客户检查标准，先用内置参考维度；可增删，不必全用）：\n${standards.dimensions.map((t) => `- ${t}`).join('\n')}`
      : `总部/客户注入的检查标准「${standards.version}」${standards.scope === 'format' ? `（**本次业态「${standards.format}」专项**）` : '（通用标准）'}（**以它为主要参考**；但不是逐条勾选——与本次输入无关的项可以不列，标准外但本次照片/说明里确实出现的问题也要提出）：\n${standards.dimensions.map((t) => `- ${t}`).join('\n')}`,
    '请据此生成本次检查项清单，只输出 JSON。',
  ]
    .filter(Boolean)
    .join('\n\n')
  const content = [{ type: 'text', text: prompt }, ...refs.map((r) => ({ type: 'image', attachment: r }))]

  const call = await loggedCall(logger, route, {
    kind: 'checklist_generate',
    promptVersion: CHECKLIST_PROMPT_VERSION,
    requestSummary: `门店 ${storeName}（${storeType}）；照片 ${photos.length} 张；店长说明 ${note.length} 字；照片线索 ${photoHints.length} 条；参考维度 ${standards.dimensions.length} 条；检查标准 ${standards.version}${standards.scope === 'format' ? `（按业态专项·${standards.format}）` : standards.source === 'builtin' ? '（未注入）' : `（${standards.source === 'injected' ? '客户注入' : '随包交付'}）`}`,
    storeId: args.storeId ?? null,
    inspectionId: args.inspectionId ?? null,
  }, {
    content,
    system: CHECKLIST_SYSTEM,
    timeoutMs: args.timeoutMs,
    purpose: 'gaia-inspection-checklist',
  })
  if (!call.ok) return { ok: false, error: call.error, callId: call.callId }
  const parsed = parseJsonObject(call.text)
  if (!parsed) {
    return { ok: false, callId: call.callId, error: { code: 'MODEL_OUTPUT_INVALID', message: `检查项生成失败：模型输出不是合法 JSON（收到 ${String(call.text || '').length} 字符）。原始输出前 200 字：${String(call.text || '').slice(0, 200)}` } }
  }
  const items = []
  for (const raw of Array.isArray(parsed.items) ? parsed.items : []) {
    if (!raw || typeof raw !== 'object') continue
    const nameStr = String(raw.name ?? raw.item ?? '').trim()
    if (!nameStr) continue
    const w = Number(raw.weight)
    items.push({
      itemId: String(raw.itemId ?? raw.id ?? `item-${items.length + 1}`).trim(),
      name: nameStr,
      why: String(raw.why ?? raw.reason ?? '').trim(),
      weight: Number.isFinite(w) ? Math.min(5, Math.max(1, w)) : null,
    })
  }
  if (items.length === 0) {
    return { ok: false, callId: call.callId, error: { code: 'MODEL_OUTPUT_EMPTY', message: `检查项生成失败：模型输出里没有可用的检查项（原始输出前 200 字：${String(call.text || '').slice(0, 200)}）。` } }
  }
  return {
    ok: true,
    callId: call.callId,
    provider: route.provider,
    model: route.model,
    latencyMs: call.latencyMs,
    data: {
      items,
      reasons: String(parsed.reasons ?? '').trim(),
      dimensionHints: standards.dimensions,
      // 本次参考的是哪套标准、从哪儿读的（答辩/排查都用得上：客户改完文件，这里立刻变）
      standards: { source: standards.source, seat: standards.seat, path: standards.path, version: standards.version, count: standards.dimensions.length, scope: standards.scope, format: standards.format, matchedBy: standards.matchedBy, error: standards.error },
    },
  }
}

/** 供 route/工具层构造"模型不可用"的可诊断错误（不兜底）。 */
export function checklistUnavailable(error) {
  return fail((error && error.code) || 'MODEL_CALL_FAILED', (error && error.message) || '检查项生成失败', { callId: error && error.callId })
}
