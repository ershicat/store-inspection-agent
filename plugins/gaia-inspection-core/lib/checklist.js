// gaia-inspection-core / lib/checklist.js
// 检查项动态生成（能力词：检查项动态生成）——A 档、必须真模型调用。
//
// 「本次为什么查这几项」是命门：检查项由模型按**本次输入**决定，并给出理由列表；
// 本文件里**没有任何固定检查项清单**，也没有"生成失败就套预设清单"的分支——
// 模型不可用/输出不是合法 JSON 时一律返回可诊断错误，由调用方决定排队或重试。
import { resolveRoute, streamCall, parseJsonObject, fail } from './modelroute.js'
import { loggedCall } from './modellog.js'

/** 判定维度库（提示里给"参考维度"，模型可增删——但**不作为固定清单**）。 */
export const DIMENSION_HINTS = [
  '人员与卫生（工服、健康证、手部清洁）',
  '食材与半成品（生熟分开、覆盖、温度、效期）',
  '台面与设备（操作台、灶台、冰柜、清洁度）',
  '地面与通道（积水、油污、杂物堆放、通道占用）',
  '三防设施（防蝇防鼠防尘、垃圾与垃圾桶）',
  '标识与留样（效期标签、留样记录、公示信息）',
]

/** 提示词版本：改 CHECKLIST_SYSTEM / 提示词结构时必须同步涨版本（README 有说明）。 */
export const CHECKLIST_PROMPT_VERSION = 'checklist-v1'

export const CHECKLIST_SYSTEM = [
  '你是餐饮门店巡店督导的检查项生成器。',
  '你的任务：根据**本次**门店业态与本次采集到的照片描述/店长说明，决定这次到底要查哪几项。',
  '规则：',
  '1) 检查项必须与本次输入相关；不同业态（快餐档口 / 正餐堂食）与不同采集内容应产生不同的检查项集合，不要每次都输出同一套。',
  '2) 每项给出 why：为什么这次要查这一项（要引用本次输入里的具体线索）。',
  '3) weight 用 1-5 的数字表示本次权重（越贴近本次线索越大）。',
  '4) 只输出 JSON，不要输出解释、不要用 markdown 代码块。',
  '5) 若本次输入不足以判断，要在 reasons 里如实说明"信息不足"，不要编造线索。',
  '输出 JSON 形状：',
  '{"items":[{"itemId":"简短英文或拼音标识","name":"中文检查项名","why":"为什么这次查它","weight":3}],"reasons":"本次为什么查这几项的一段话"}',
].join('\n')

/**
 * 生成检查项（真模型调用 + 当刻落日志）。
 * @param {{logger:object, ctx:object}} deps logger = core 的模型调用日志写入端口
 */
export async function generateChecklist(deps, args) {
  const { ctx, logger } = deps
  const route = resolveRoute(ctx, { provider: args.provider, model: args.model })
  if (!route.ok) return { ok: false, error: route.error, callId: null }
  const storeType = String(args.storeType || '').trim() || '未指定业态'
  const storeName = String(args.storeName || '').trim() || '未指定门店'
  const note = String(args.note || '').trim() || '（店长未附一句话说明）'
  const photoHints = Array.isArray(args.photoHints) ? args.photoHints.filter(Boolean).map(String) : []
  const prompt = [
    `门店：${storeName}（业态：${storeType}）`,
    `店长说明：${note}`,
    photoHints.length > 0 ? `本次照片的机器可见线索（由采集侧原样给出，未做判断）：\n${photoHints.map((t, i) => `${i + 1}. ${t}`).join('\n')}` : '本次照片线索：无',
    `可参考的判定维度（可增删，不必全用）：\n${DIMENSION_HINTS.map((t) => `- ${t}`).join('\n')}`,
    '请据此生成本次检查项清单，只输出 JSON。',
  ].join('\n\n')

  const call = await loggedCall(logger, route, {
    kind: 'checklist_generate',
    promptVersion: CHECKLIST_PROMPT_VERSION,
    requestSummary: `门店 ${storeName}（${storeType}）；店长说明 ${note.length} 字；照片线索 ${photoHints.length} 条；参考维度 ${DIMENSION_HINTS.length} 条`,
    storeId: args.storeId ?? null,
    inspectionId: args.inspectionId ?? null,
  }, {
    content: [{ type: 'text', text: prompt }],
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
      dimensionHints: DIMENSION_HINTS,
    },
  }
}

/** 供 route/工具层构造"模型不可用"的可诊断错误（不兜底）。 */
export function checklistUnavailable(error) {
  return fail((error && error.code) || 'MODEL_CALL_FAILED', (error && error.message) || '检查项生成失败', { callId: error && error.callId })
}
