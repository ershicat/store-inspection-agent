// gaia-inspection 共用 / lib/modelroute.js
// 模型路由与调用：**只走宿主已挂载的 `llm` 服务（ctx.get('llm').stream(...)）**。
//
// 硬约束（本单 §4 红线）：
//   · 不读凭据文件、不出现任何 key、不 new 任何 adapter、不硬编码 provider 之外的凭据；
//   · 拿不到 provider / 凭据 → 返回**可诊断错误**（NO_PROVIDER / NO_MODEL / MISSING_CREDENTIAL），
//     **绝不静默降级成假结果**，也**绝不用 if-else 规则伪造模型判断**；
//   · 本文件只做「发起真实调用 + 收流 + 报错归一」，不做任何内容判断。
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

function llmCandidates() {
  const out = []
  const home = String(process.env.DSH_HOME || '').trim()
  if (home) out.push(join(home, '..', '..', 'resources', 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'))
  out.push(join(process.cwd(), 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'))
  return out.filter((p) => {
    try {
      return existsSync(p)
    } catch {
      return false
    }
  })
}

let cachedCreateUserMessage
/** 取宿主 createUserMessage（provider 中立消息构造）；拿不到退到等价最小实现。 */
export async function resolveCreateUserMessage() {
  if (cachedCreateUserMessage) return cachedCreateUserMessage
  try {
    const mod = await import('@deepseek-ai/dsh-llm')
    if (mod && typeof mod.createUserMessage === 'function') {
      cachedCreateUserMessage = mod.createUserMessage
      return cachedCreateUserMessage
    }
  } catch {
    /* 落到候选路径 */
  }
  for (const candidate of llmCandidates()) {
    try {
      const mod = await import(pathToFileURL(candidate).href)
      if (mod && typeof mod.createUserMessage === 'function') {
        cachedCreateUserMessage = mod.createUserMessage
        return cachedCreateUserMessage
      }
    } catch {
      /* 逐个候选尝试 */
    }
  }
  cachedCreateUserMessage = (input) => ({
    content: input.content,
    source: input.source,
    role: 'user',
    id: globalThis.crypto.randomUUID(),
  })
  return cachedCreateUserMessage
}

export function fail(code, message, extra) {
  return { ok: false, error: { code, message, ...(extra || {}) } }
}

export function getLlm(ctx) {
  const get = ctx && typeof ctx.get === 'function' ? (k) => ctx.get(k) : () => undefined
  const llm = get('llm')
  return llm && typeof llm.stream === 'function' ? llm : null
}

/**
 * 解析本次调用要用的模型路由。
 * 优先级：入参显式 provider/model → 宿主默认模型选择（agentDefaultModel）→ 失败并给诊断。
 */
export function resolveRoute(ctx, request = {}) {
  const llm = getLlm(ctx)
  if (!llm) {
    return fail('NO_PROVIDER', '宿主 `llm` 服务不可用：客户端未挂载模型 provider。请在客户端模型设置里配置一个 provider 后重试。')
  }
  const get = ctx && typeof ctx.get === 'function' ? (k) => ctx.get(k) : () => undefined
  let selection
  try {
    const def = get('agentDefaultModel')
    if (def && typeof def.currentSelection === 'function') selection = def.currentSelection()
  } catch (error) {
    return fail('NO_PROVIDER', `读取默认模型选择失败：${String((error && error.message) || error)}`)
  }
  const explicitProvider = typeof request.provider === 'string' ? request.provider.trim() : ''
  const explicitModel = typeof request.model === 'string' ? request.model.trim() : ''
  const provider = explicitProvider || (selection && selection.provider ? String(selection.provider) : '')
  const model = explicitModel || (selection && selection.model ? String(selection.model) : '')
  const reasoningEffort = selection && selection.reasoningEffort ? String(selection.reasoningEffort) : undefined
  if (!provider) {
    let known = []
    try {
      known = typeof llm.listProviders === 'function' ? llm.listProviders().map((p) => p && p.id).filter(Boolean) : []
    } catch {
      known = []
    }
    if (known.length === 0) return fail('NO_PROVIDER', '宿主 llm 服务没有已注册的 provider：客户端未配置模型服务。')
    return fail('NO_MODEL', `宿主没有默认模型选择，请显式指定 provider/model。已注册的 provider：${known.join(', ')}`)
  }
  if (!model) return fail('NO_MODEL', `未能确定 provider "${provider}" 下的模型名，请在入参里显式给出 model。`)
  const route = { ok: true, llm, provider, model }
  if (reasoningEffort) route.reasoningEffort = reasoningEffort
  return route
}

/**
 * 视觉能力前置检查：解析到的模型必须声明 image 输入模态，否则**拒绝发请求**。
 * 理由：文本模型会把图片投影成占位符文本，此时模型仍会"说话"——那是静默降级，本单禁止。
 * 拿不到模态信息（adapter 未声明）→ 放行但把 modelInfo 标为 unknown，交由调用方在结果里如实标注。
 */
export async function assertVisionModel(llm, provider, model, signal) {
  if (typeof llm.resolveModelInfo !== 'function') return { ok: true, inputModalities: undefined }
  let info
  try {
    info = await llm.resolveModelInfo(provider, model, signal)
  } catch (error) {
    return fail('MODEL_INFO_UNAVAILABLE', `无法解析模型能力（provider=${provider} model=${model}）：${String((error && error.message) || error)}`)
  }
  const modalities = info && Array.isArray(info.inputModalities) ? info.inputModalities : undefined
  if (modalities && !modalities.includes('image')) {
    return fail('MODEL_NOT_VISION', `provider "${provider}" 的模型 "${model}" 未声明 image 输入模态（inputModalities=${modalities.join('/')}），本次照片判断未发起：请在客户端模型设置里选择支持图像的模型，或显式指定 provider/model。`)
  }
  return { ok: true, inputModalities: modalities }
}

/**
 * 发起一次真实的文本/多模态模型调用并收流。
 * @returns {{ok:true,text:string,usage:object|null,finishKind:string,latencyMs:number}|{ok:false,error:object}}
 */
export async function streamCall(route, { content, system, timeoutMs, purpose }) {
  const createUserMessage = await resolveCreateUserMessage()
  const controller = new AbortController()
  const started = Date.now()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 120000))
  const options = {
    provider: route.provider,
    model: route.model,
    messages: [createUserMessage({ content, source: { kind: purpose || 'gaia-inspection' } })],
    signal: controller.signal,
  }
  if (system) options.system = system
  if (route.reasoningEffort) options.reasoningEffort = route.reasoningEffort
  let text = ''
  let usage = null
  let finishKind = ''
  let failure = null
  try {
    for await (const chunk of route.llm.stream(options)) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      else if (chunk.type === 'usage') usage = chunk.usage ?? null
      else if (chunk.type === 'finish') {
        finishKind = chunk.reason && chunk.reason.kind ? String(chunk.reason.kind) : String(chunk.reason || '')
        if (chunk.reason && chunk.reason.failure) failure = chunk.reason.failure
      }
    }
  } catch (error) {
    clearTimeout(timer)
    const code = (error && error.code) || ''
    const message = String((error && error.message) || error)
    if (code === 'MISSING_CREDENTIAL' || /no API key|credential/i.test(message)) {
      return fail('MISSING_CREDENTIAL', `模型 provider "${route.provider}" 没有可用凭据：请在客户端模型设置里配置后重试。`, { latencyMs: Date.now() - started })
    }
    if (controller.signal.aborted) {
      return fail('MODEL_TIMEOUT', `模型调用超时（${Math.round((Number(timeoutMs) || 120000) / 1000)} 秒未完成），本次未产生结果。`, { latencyMs: Date.now() - started })
    }
    return fail('MODEL_CALL_FAILED', `模型调用失败：${message}`, { latencyMs: Date.now() - started })
  }
  clearTimeout(timer)
  const latencyMs = Date.now() - started
  if (finishKind === 'error') {
    const code = (failure && failure.code) || 'MODEL_CALL_FAILED'
    const message = (failure && failure.message) || '模型返回失败'
    return fail(code, `模型返回失败：${message}`, { latencyMs })
  }
  if (finishKind === 'aborted') return fail('MODEL_ABORTED', '模型调用被取消。', { latencyMs })
  return { ok: true, text, usage, finishKind: finishKind || 'stop', latencyMs }
}

/** 从模型输出里抽出第一个 JSON 对象；抽不出就报 MODEL_OUTPUT_INVALID（**不兜底、不猜**）。 */
export function parseJsonObject(text) {
  const s = String(text || '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  const slice = s.slice(start, end + 1)
  try {
    const v = JSON.parse(slice)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/** 解析「离线/不可达」是否属于本次可排队的情形（供断网降级与待判队列判定）。 */
export function isOfflineLikeError(code) {
  return ['NO_PROVIDER', 'NO_MODEL', 'MISSING_CREDENTIAL', 'MODEL_TIMEOUT', 'MODEL_CALL_FAILED', 'MODEL_INFO_UNAVAILABLE', 'TRANSPORT', 'NETWORK_ERROR'].includes(String(code || ''))
}
