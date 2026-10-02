/**
 * gaia-inspection-capture-ui — 宿主半（host half）。
 *
 * 这个包承担两个**界面**能力词（逐字）：
 *   1) 门店自查采集入口 —— 提交动作与回执都来自后端（`gaia-inspection-core` 的
 *      `POST /api/gaia-inspection/submit` 转调 `gaia-inspection-capture` 的真提交工具）；
 *      浏览器半**不做本地假回执**。
 *   2) 角色视图切换 —— 纯前端本地视图状态（不做账号/登录/权限，指令 ④）。
 *
 * 因此宿主半只做两件**只读**的事，不重复实现后端业务、不写任何业务数据：
 *   · 在进程内保留「最近 N 条提交回执」的**内存**记录（客户每次提交成功后由浏览器半回报），
 *     供验收/自检复核「界面显示的回执」与「真实提交回执」是否同源；
 *   · 把这份记录暴露成两条只读路由：
 *       GET /api/gaia-inspection-capture-ui/last-submit   -> 最近一条回执
 *       GET /api/gaia-inspection-capture-ui/receipts      -> 最近 N 条（最多 20 条）
 *
 * 纪律：零第三方依赖；异常一律收成 200 + 结构化错误体；没有回执是**正常空态**而不是错误；
 * 不读凭据、不碰宿主 profiles、不写盘。
 */

export const name = 'gaia-inspection-capture-ui'

/** 宿主服务依赖：只读路由挂在 webServer 上。 */
export const inject = ['webServer']

const MAX_RECEIPTS = 20

/** 进程内回执记录（只读内省用；重启即空，这不是业务数据）。 */
const receipts = []

function asText(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return '（不可解析）'
  }
}

/** 把浏览器半回报的回执收成固定形状；字段一律透传文本，不做加工、不补默认值。 */
function sanitizeReceipt(raw) {
  if (!raw || typeof raw !== 'object') return null
  return {
    at: new Date().toISOString(),
    ok: raw.ok === true,
    receiptNo: asText(raw.receiptNo),
    status: asText(raw.status),
    queued: raw.queued === true,
    offline: raw.offline === true,
    storeId: asText(raw.storeId),
    noteChars: typeof raw.noteChars === 'number' ? raw.noteChars : null,
    photoCount: typeof raw.photoCount === 'number' ? raw.photoCount : null,
    code: asText(raw.code),
    message: asText(raw.message),
  }
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

async function readJsonBody(req) {
  if (req && req.body && typeof req.body === 'object') return req.body
  const chunks = []
  try {
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  } catch {
    return null
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function record(raw) {
  const receipt = sanitizeReceipt(raw)
  if (!receipt) return { ok: false, error: { code: 'BAD_RECEIPT', message: '回执不是对象' } }
  receipts.push(receipt)
  while (receipts.length > MAX_RECEIPTS) receipts.shift()
  return { ok: true, count: receipts.length }
}

export function apply(ctx) {
  const webServer = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (!webServer || typeof webServer.register !== 'function') {
    // 没有 webServer 就**不静默**：没有内省口，但界面（client 半）仍可用。
    console.warn('[gaia-inspection-capture-ui] 宿主未提供 webServer：内省路由未注册（界面不受影响，取数走 gaia-inspection-core）')
    return
  }

  const disposers = []

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/api/gaia-inspection-capture-ui/last-submit',
      handler: (req, res) => sendJson(res, { ok: true, receipt: receipts.length ? receipts[receipts.length - 1] : null }),
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/api/gaia-inspection-capture-ui/receipts',
      handler: (req, res) => sendJson(res, { ok: true, count: receipts.length, receipts: receipts.slice() }),
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/api/gaia-inspection-capture-ui/report-submit',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          if (body === null) return sendJson(res, { ok: false, error: { code: 'BAD_BODY', message: '请求体不是合法 JSON 对象' } })
          sendJson(res, record(body))
        } catch (error) {
          sendJson(res, { ok: false, error: { code: 'ROUTE_THREW', message: String((error && error.message) || error) } })
        }
      },
    }),
  )

  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          /* 幂等 */
        }
      }
    }, 'gaia-inspection-capture-ui: read-only introspection routes')
  }
}

/** 供自测/宿主内省用的导出（不参与运行期路由）。 */
export const __internals = { sanitizeReceipt, receipts }
