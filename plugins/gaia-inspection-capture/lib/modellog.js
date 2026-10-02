// gaia-inspection 共用 / lib/modellog.js（各包各带一份副本，避免跨包 import）
// 模型调用日志留存（能力词：模型调用日志留存）——§4 红线：
//   每次模型调用**在调用发生的那一刻**写一条真实记录（status:'running' + 开始时间戳），
//   调用结束后再补耗时 / usage / 终态（patch 同一条 callId）；**不许事后批量补写、不许重置清空**。
//
// 脱敏纪律（画面级说明 §3 红线）：
//   · 不落 key、不落 Authorization / 请求头、不落完整 prompt；
//   · 只落**业务摘要**：`requestSummary`（本次请求的业务要点）与 `responseSummary`（模型输出截断摘要）；
//   · 任何写进日志的字符串都先过 `redact()`：抹掉 sk- 形式的 key、Bearer 串、authorization/x-api-key 片段；
//   · `promptVersion` = 本次调用用的提示词版本标识（改提示词必须同步涨版本，README 有说明）。
import { streamCall } from './modelroute.js'

export function nowIso() {
  return new Date().toISOString()
}

let seq = 0
/** 生成本次调用的日志 id。 */
export function newCallId() {
  seq += 1
  return `MC-${Date.now().toString(36)}-${String(seq).padStart(4, '0')}-${Math.random().toString(36).slice(2, 6)}`
}

/** 脱敏：抹掉 key / 认证头片段，保留业务内容。 */
export function redact(text, maxLen = 300) {
  let s = String(text === undefined || text === null ? '' : text)
  s = s.replace(/sk-[A-Za-z0-9_-]{6,}/g, '[REDACTED_KEY]')
  s = s.replace(/(Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1[REDACTED]')
  s = s.replace(/(authorization|x-api-key|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s
}

/**
 * 带日志的真实模型调用。
 * @param {{logStart:Function, logEnd:Function}} logger 写入端口（由库侧提供）
 * @param {object} route resolveRoute 的返回值
 * @param {{kind:string, promptVersion:string, requestSummary?:string, storeId?:string, inspectionId?:string}} meta
 * @param {{content:Array, system?:string, timeoutMs?:number, purpose?:string}} req
 * @returns {Promise<{ok:true,callId,text,usage,latencyMs}|{ok:false,callId,error,latencyMs}>}
 */
export async function loggedCall(logger, route, meta, req) {
  const callId = newCallId()
  const startedAt = Date.now()
  // ① 调用发生的那一刻先落一条 running —— 时间戳必然早于/等于真实请求发出时间
  logger.logStart({
    id: callId,
    callId,
    ts: nowIso(),
    provider: route.provider,
    model: route.model,
    kind: meta.kind,
    promptVersion: meta.promptVersion || 'unversioned',
    requestSummary: redact(meta.requestSummary, 200),
    responseSummary: null,
    storeId: meta.storeId ?? null,
    inspectionId: meta.inspectionId ?? null,
    status: 'running',
    latencyMs: null,
    usage: null,
    errorCode: null,
  })
  // ② 真调用
  const result = await streamCall(route, req)
  const latencyMs = result.ok ? result.latencyMs : (result.error && result.error.latencyMs) || Date.now() - startedAt
  // ③ 结束后补终态（同一条 callId 的 patch，不是新起一条）
  if (result.ok) {
    logger.logEnd(callId, { status: 'ok', latencyMs, usage: result.usage ?? null, responseSummary: redact(result.text, 300), errorCode: null, tsEnd: nowIso() })
    return { ok: true, callId, text: result.text, usage: result.usage ?? null, latencyMs }
  }
  logger.logEnd(callId, { status: 'error', latencyMs, errorCode: result.error.code, errorMessage: redact(result.error.message, 200), responseSummary: null, tsEnd: nowIso() })
  return { ok: false, callId, error: result.error, latencyMs }
}
