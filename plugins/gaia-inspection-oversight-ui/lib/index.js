/**
 * gaia-inspection-oversight-ui — 宿主半（host half）。
 *
 * 这个包承担四个**界面**能力词（逐字）：
 *   · 巡店判断回放看板   —— 数据来自 `gaia-inspection-core` 的 `GET /api/gaia-inspection/snapshot`
 *   · 证据挂图卡片       —— 数据来自 `GET /api/gaia-inspection/evidence?id=`（图片直接用返回体里的 originalUrl/thumbUrl）
 *   · 立即扫描按钮       —— 触发 `POST /api/gaia-inspection/scan`（后端真扫描）
 *   · 模型调用日志面板   —— 数据来自 `GET /api/gaia-inspection/model-calls`
 *
 * 另外督导的动作行（通过 / 退回并说明 / 催办）要**写入记录**（画面级说明 §二 2.2）：
 * 它需要后端提供 `POST /api/gaia-inspection/review-action`（写 `actions` 表）。本包不代它实现，
 * 只在自检口里如实列出；后端口未就绪时，界面把该条动作标为「未同步到后端」而**不假装成功**。
 *
 * 宿主半因此**不重复实现任何后端语义**，只做两件只读的事：
 *   1) 把「本界面包的装载状态 + 依赖的上游口」暴露成一个只读自检口，供验收/自检核对；
 *   2) 读 `globalThis.__gaia_inspection_view__`（由 capture-ui 发布的本地视图状态）的**存在性**——只读，不改它。
 *
 * 纪律：零第三方依赖；异常一律收成 200 + 结构化错误体；不写盘、不读凭据、不碰宿主 profiles。
 */

export const name = 'gaia-inspection-oversight-ui'

/** 宿主服务依赖：只读自检路由挂在 webServer 上。 */
export const inject = ['webServer']

/** 本包要消费的上游口（供自检口回报"应当存在的上游"，不代它注册）。 */
const UPSTREAM_ROUTES = [
  { method: 'GET', path: '/api/gaia-inspection/snapshot', for: '巡店判断回放看板' },
  { method: 'GET', path: '/api/gaia-inspection/evidence', for: '证据挂图卡片' },
  { method: 'POST', path: '/api/gaia-inspection/scan', for: '立即扫描按钮' },
  { method: 'GET', path: '/api/gaia-inspection/model-calls', for: '模型调用日志面板' },
  { method: 'POST', path: '/api/gaia-inspection/review-action', for: '动作行（通过/退回并说明/催办）写记录', status: 'needs-backend' },
  { method: 'GET', path: '/api/gaia-inspection/photo', for: '快照缩略图/原图读图' },
]

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

/** 只读地看一眼"另一个前端包在不在"（不持有引用、不改它）。 */
function viewChannelPresent() {
  const value = globalThis.__gaia_inspection_view__
  return Boolean(value && typeof value === 'object' && typeof value.getRole === 'function')
}

export function apply(ctx) {
  const webServer = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : undefined
  if (!webServer || typeof webServer.register !== 'function') {
    console.warn('[gaia-inspection-oversight-ui] 宿主未提供 webServer：自检路由未注册（两个面板不受影响，取数走 gaia-inspection-core）')
    return
  }

  const dispose = webServer.register({
    kind: 'exact',
    path: '/api/gaia-inspection-oversight-ui/selfcheck',
    handler: (req, res) => {
      try {
        sendJson(res, {
          ok: true,
          package: 'gaia-inspection-oversight-ui',
          capabilities: UPSTREAM_ROUTES.map((item) => item.for),
          upstream: UPSTREAM_ROUTES,
          viewChannel: viewChannelPresent(),
          note: '本口只报装载状态；看板/证据/扫描/日志的数据一律来自 /api/gaia-inspection/*（gaia-inspection-core）。',
        })
      } catch (error) {
        sendJson(res, { ok: false, error: { code: 'ROUTE_THREW', message: String((error && error.message) || error) } })
      }
    },
  })

  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        /* 幂等 */
      }
    }, 'gaia-inspection-oversight-ui: selfcheck route')
  }
}

/** 供自测/宿主内省用的导出（不参与运行期路由）。 */
export const __internals = { UPSTREAM_ROUTES, viewChannelPresent }
