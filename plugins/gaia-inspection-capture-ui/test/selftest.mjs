// gaia-inspection-capture-ui / fe 交接前自测（Node 下跑，零第三方依赖）。
//
// 对齐《实施契约》§2/§3.5（前端重做）后本包的新形态：
//   · 挂载点只有两处：conversation.input.dock（1 枚「门店自查采集入口」）+ conversation.session.header.actions，
//     **不再注册 shell.overlay**（也不注册督导包的 sidebar.panellist / main）。
//   · 通道两件：__gaia_inspection_view__ {getRole,setRole,subscribe}（角色唯一真源）
//     + __gaia_inspection_ui__ {version:1, getScreen, subscribe}（店长端屏组件，供督导包外壳内嵌）。
//   · 屏 A = CaptureScreen：整屏两栏（左 .gicu-hero 照片投放区＝视觉主角 / 右 .gicu-form），无手机壳浮层。
//   · CSS 令牌与硬口径（间距/圆角同心/两级阴影/四态/具名 transition/按钮 44px/禁用灰化/tabular-nums/
//     图片 1px 令牌色 10% outline/禁 `·` 拼元数据/禁按钮 `→`）逐条机检。
//
// 覆盖：① 宿主半 import / inject / 只读内省路由；② client 装载契约；③ **在最小 React/DOM/fetch 垫片下把屏 A
// 渲染出来并跑真实提交流程**（垫片忠实模拟 useSyncExternalStore 的 Object.is 契约，不许退回旧垫片）；
// ④ manifest.keywords 逐字；⑤ 纯函数不变量（单张与类型校验、回执读取、编号短化、离线归一、门店文案、同门店锁）。
// 用法：node test/selftest.mjs
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const fail = []
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? '' : String(detail) })
  if (!ok) fail.push(name + (detail ? ' — ' + detail : ''))
}

// ── ① 宿主半 ──────────────────────────────────────────────────────────────
const host = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
check('宿主半可 import', Boolean(host && host.apply), typeof (host && host.apply))
check('宿主半 inject 是字符串数组', Array.isArray(host.inject) && host.inject.every((v) => typeof v === 'string'), JSON.stringify(host.inject))
check('宿主半 name 与包名一致', host.name === 'gaia-inspection-capture-ui', host.name)

const hostRoutes = []
const hostCtx = {
  get: (key) => (key === 'webServer' ? { register: (spec) => { hostRoutes.push(spec); return () => {} } } : undefined),
  effect: (fn, label) => { hostRoutes.push({ __effect: label }); const d = fn(); return () => { if (typeof d === 'function') d() } },
}
let hostApplyError = ''
try {
  host.apply(hostCtx)
} catch (error) {
  hostApplyError = String((error && error.message) || error)
}
check('宿主半 apply 不抛错', !hostApplyError, hostApplyError)
check('宿主半注册了 3 条只读内省路由', hostRoutes.filter((r) => r && r.path).length === 3, JSON.stringify(hostRoutes.filter((r) => r && r.path).map((r) => r.path)))

// ── ② 装载契约 ────────────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const clientRel = pkg.exports && pkg.exports['./client']
check('package.json 有 exports["./client"]', Boolean(clientRel), String(clientRel))
check('exports["./client"] 指向的文件真实存在', Boolean(clientRel) && existsSync(join(root, clientRel)), String(clientRel))
check('dsh.client.platform === "web"', pkg.dsh && pkg.dsh.client && pkg.dsh.client.platform === 'web', JSON.stringify(pkg.dsh && pkg.dsh.client))
const patchText = readFileSync(join(root, pkg.dsh.bundle.patch), 'utf8')
check('补丁存在且含 - insert:', patchText.includes('- insert:'), '')
check('补丁行 id 唯一', (patchText.match(/^\s*- id:/gm) || []).length === 1, '')
check('零第三方 dependencies', !pkg.dependencies || Object.keys(pkg.dependencies).length === 0, JSON.stringify(pkg.dependencies))

// ── 最小 React 垫片（够把屏 A 渲染出来并驱动交互）────────────────────────
const renderLog = []
let current = null
let stateCursor = 0
let storeCursor = 0
function createElement(type, props, ...children) {
  const incoming = props && Object.prototype.hasOwnProperty.call(props, 'children') ? [...children, props.children] : children
  const flat = []
  const push = (value) => {
    if (value === null || value === undefined || value === false || value === true) return
    if (Array.isArray(value)) { for (const item of value) push(item); return }
    flat.push(value)
  }
  for (const child of incoming) push(child)
  const nextProps = props ? { ...props } : {}
  delete nextProps.children
  return { type, props: nextProps, children: flat }
}
const ReactShim = {
  createElement,
  useState(initial) {
    const holder = current
    const index = stateCursor++
    if (!holder.hooks[index]) holder.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    const entry = holder.hooks[index]
    return [entry.value, (next) => { entry.value = typeof next === 'function' ? next(entry.value) : next; holder.dirty = true }]
  },
  useEffect(fn) {
    current.effects.push(fn)
  },
  useRef(initial) {
    const holder = current
    const index = stateCursor++
    if (!holder.hooks[index]) holder.hooks[index] = { value: { current: initial } }
    return holder.hooks[index].value
  },
  // 忠实模拟 React 的 useSyncExternalStore 契约：**只有 getSnapshot() 换引用（Object.is 不等）才重渲染**。
  // 旧垫片每次渲染都直接调 getSnapshot()，把「getSnapshot 永远返回同一个被原地改属性的对象 → React 判定
  // 快照没变 → bailout → 组件永不重渲染」这类真 bug 全掩盖了（面板打不开、提交后状态行不变都是这一类）。
  useSyncExternalStore(subscribe, getSnapshot) {
    const holder = current
    const index = storeCursor++
    if (!holder.storeHooks[index]) holder.storeHooks[index] = { value: undefined, subscribe, getSnapshot }
    const entry = holder.storeHooks[index]
    entry.subscribe = subscribe
    entry.getSnapshot = getSnapshot
    entry.value = getSnapshot()
    holder.storeBindings.push(entry)
    return entry.value
  },
}
const holders = new Map()
function holderOf(key) {
  if (!holders.has(key)) holders.set(key, { hooks: [], effects: [], subscribes: [], storeHooks: [], storeBindings: [], dirty: false })
  return holders.get(key)
}
function instantiate(element) {
  if (element === null || element === undefined || element === false) return null
  if (typeof element === 'string' || typeof element === 'number') return { text: String(element) }
  if (Array.isArray(element)) return { children: element.map(instantiate).filter(Boolean) }
  const { type, props, children } = element
  if (typeof type === 'function') {
    // 组件状态持久化：按组件函数缓存 hook 容器（等价于 React 的 fiber），否则每次渲染都重置 useState。
    const holder = holderOf(type.name || String(type))
    const prev = current
    const prevCursor = stateCursor
    const prevStoreCursor = storeCursor
    current = holder
    stateCursor = 0
    storeCursor = 0
    holder.effects = []
    holder.storeBindings = []
    let out
    try {
      out = type({ ...props, children: children.length === 1 ? children[0] : children.length ? children : undefined })
    } finally {
      current = prev
      stateCursor = prevCursor
      storeCursor = prevStoreCursor
    }
    const node = { component: type.name || 'Anonymous', rendered: instantiate(out), holder }
    renderLog.push(node)
    return node
  }
  return { tag: String(type), props, children: children.map(instantiate).filter(Boolean) }
}
function textOfTree(node) {
  if (!node) return ''
  if (node.text !== undefined) return node.text
  const parts = []
  if (node.props) {
    for (const key of ['placeholder', 'value', 'title']) {
      const value = node.props[key]
      if (typeof value === 'string' && value) parts.push(value)
    }
  }
  if (node.children) for (const child of node.children) parts.push(textOfTree(child))
  if (node.rendered) parts.push(textOfTree(node.rendered))
  return parts.filter(Boolean).join(' ')
}
function vnodeText(node) {
  if (!node) return ''
  const parts = []
  const push = (value) => {
    if (value === null || value === undefined || value === false || value === true) return
    if (Array.isArray(value)) { for (const item of value) push(item); return }
    if (typeof value === 'string' || typeof value === 'number') { parts.push(String(value)); return }
    if (value.props) push(value.props.children)
  }
  if (node.props) push(node.props.children)
  for (const child of node.children || []) push(child.text !== undefined ? child.text : child.props && child.props.children)
  return parts.join(' ')
}
function findAll(node, tag) {
  const out = []
  const walk = (n) => {
    if (!n) return
    if (n.tag === tag) out.push(n)
    if (n.children) for (const child of n.children) walk(child)
    if (n.rendered) walk(n.rendered)
  }
  walk(node)
  return out
}
/** 按类名找元素（类名可能是一串，按空白切分后精确比对）。 */
function findByClass(node, cls) {
  const out = []
  const walk = (n) => {
    if (!n) return
    const name = n.props && n.props.className
    if (typeof name === 'string' && name.split(/\s+/).indexOf(cls) !== -1) out.push(n)
    if (n.children) for (const child of n.children) walk(child)
    if (n.rendered) walk(n.rendered)
  }
  walk(node)
  return out
}
function buttonByLabel(tree, label) {
  return findAll(tree, 'button').find((b) => vnodeText(b).indexOf(label) !== -1)
}
/** 屏 A 的五态状态行：.gicu-state[data-line="1"]（data-kind = idle/running/ok/bad/off）。 */
function stateLineOf(tree) {
  return findByClass(tree, 'gicu-state').find((n) => n.props && n.props['data-line'] === '1') || null
}
/** 提交阶段：登记 store 订阅（等价 React 的 subscribe），快照换引用时把宿主组件标脏。 */
function commitStoreSubscriptions() {
  for (const node of renderLog) {
    const holder = node.holder
    for (const entry of holder.storeBindings) {
      if (entry.unsub) entry.unsub()
      entry.unsub = entry.subscribe(() => {
        const next = entry.getSnapshot()
        if (!Object.is(next, entry.value)) holder.dirty = true
      })
    }
  }
}
let lastRenderHolders = []
function renderAndText(component, props) {
  renderLog.length = 0
  const tree = instantiate(ReactShim.createElement(component, props || {}))
  commitStoreSubscriptions()
  for (let round = 0; round < 4; round += 1) {
    const pending = renderLog.filter((node) => node.holder.effects.length > 0)
    if (pending.length === 0) break
    for (const node of pending) for (const effect of node.holder.effects.splice(0)) effect()
  }
  commitStoreSubscriptions()
  for (const node of renderLog) node.holder.dirty = false
  lastRenderHolders = renderLog.map((node) => node.holder)
  return { tree, text: textOfTree(tree) }
}
/**
 * 只由 store 通知驱动的重渲染（**不手动重挂**）：屏幕上这些组件没有任何一个被标脏时返回 null —— 这正是
 * React bailout 的表现，也是本包曾出的「面板永远不出现 / 提交后界面看起来还是死的」那类 bug 的判定口径。
 */
function flushStoreDriven(component, props) {
  let last = null
  for (let round = 0; round < 4; round += 1) {
    if (!lastRenderHolders.some((holder) => holder.dirty)) break
    last = renderAndText(component, props)
  }
  return last
}

// ── DOM / fetch 垫片 ───────────────────────────────────────────────────────
/** 最小 Canvas 2D 垫片：记录调用，toDataURL 返回固定 PNG data URL（用来验"内置示例图"这条降级）。 */
function makeCanvasShim() {
  const calls = []
  const ctx2d = new Proxy(
    {},
    {
      get: (target, key) => {
        if (key === 'canvas') return null
        return (...args) => {
          calls.push({ fn: String(key), args })
        }
      },
      set: () => true,
    },
  )
  return {
    canvas: { width: 0, height: 0, getContext: () => ctx2d, toDataURL: () => 'data:image/png;base64,' + SAMPLE_BYTES },
    calls,
  }
}
const canvasShim = makeCanvasShim()
const styleEls = []
globalThis.document = {
  createElement: (tag) => {
    if (tag === 'canvas') return canvasShim.canvas
    const el = { setAttribute() {}, dataset: {}, textContent: '', addEventListener() {}, removeEventListener() {} }
    if (tag === 'style') styleEls.push(el)
    return el
  },
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = {
  __ModuleLoader__: { load: (spec) => { globalThis.__loaded = spec } },
  localStorage: { getItem: () => null, setItem() {} },
  setInterval: () => 0,
  clearInterval: () => {},
}
const SAMPLE_BYTES = 'QUJD'
const SNAPSHOT = {
  ok: true,
  stores: [
    { storeId: 'S-001', storeName: '示例门店·快餐档口甲', storeType: '快餐档口' },
    { storeId: 'S-002', storeName: '示例门店·正餐堂食乙', storeType: '正餐堂食' },
  ],
  inspections: [],
  counts: { 待整改: 0, 逾期: 0, 已升级: 0 },
  offline: { offline: false, source: 'capture' },
  pendingQueue: { pending: 0, judged: 0, items: [] },
}
const requests = []
let snapshotOverride = null
let submitOverride = null
let sampleAvailable = true
globalThis.fetch = async (url, options) => {
  const path = String(url)
  const method = (options && options.method) || 'GET'
  requests.push({ path, method, body: options && options.body ? JSON.parse(options.body) : null })
  if (path.indexOf('/sample-photo') !== -1) {
    if (!sampleAvailable) {
      const failure = new Error('HTTP 404')
      failure.status = 404
      throw failure
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: { name: 'sample-issue.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,' + SAMPLE_BYTES, label: '合成示例图（几何图形合成，非真实门店照片）' } }) }
  }
  if (path.indexOf('/submit') !== -1 && path.indexOf('report') === -1) {
    return { ok: true, status: 200, json: async () => submitOverride || { ok: true, runId: 'INS-20261002-201530-ab12', status: 'pending_rectify', summary: '已生成检查单', data: { accepted: 1 }, error: null } }
  }
  if (path.indexOf('/report-submit') !== -1) return { ok: true, status: 200, json: async () => ({ ok: true, count: 1 }) }
  return { ok: true, status: 200, json: async () => snapshotOverride || SNAPSHOT }
}
globalThis.FileReader = class {
  constructor() {
    this.result = 'data:image/png;base64,' + SAMPLE_BYTES
  }
  readAsDataURL() {
    this.onload && this.onload()
  }
}

// ── ③ 加载 client 半：挂载点 / 通道 / 屏 A ─────────────────────────────────
const clientCode = readFileSync(join(root, clientRel), 'utf8')
let clientError = ''
try {
  ;(0, eval)(clientCode)
} catch (error) {
  clientError = String((error && error.message) || error)
}
check('client 半脚本可执行（不抛错）', !clientError, clientError)
const loaded = globalThis.__loaded
check('client 半注册了 bundle id', loaded && loaded.id === 'gaia-inspection-capture-ui', loaded && loaded.id)

const bundle = loaded.factory((spec) => {
  if (spec === 'react') return ReactShim
  throw new Error('unexpected require: ' + spec)
})
const test = bundle.__test || {}
check('__test 可用', Boolean(test && test.submitSelfCheck && test.readReceipt), Object.keys(test || {}).join(','))

const slotSpecs = []
const ctxForClient = {
  get: (key) => {
    if (key === 'slots') return { register: (spec, component) => { slotSpecs.push({ spec, component }); return () => {} }, inject: (name, fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} } }
    return undefined
  },
  effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
}
let clientApplyError = ''
try {
  bundle.apply(ctxForClient)
} catch (error) {
  clientApplyError = String((error && error.message) || error)
}
check('client apply 不抛错', !clientApplyError, clientApplyError)

const slotNames = slotSpecs.map((s) => s.spec.name)
check('注册了输入区入口（1 枚「门店自查采集入口」）', slotSpecs.some((s) => s.spec.name === 'conversation.input.dock' && s.spec.label === '门店自查采集入口'), JSON.stringify(slotNames))
check('注册了会话 header 入口', slotSpecs.some((s) => s.spec.name === 'conversation.session.header.actions'), JSON.stringify(slotNames))
check('不再注册 shell.overlay（主界面不再用浮层）', !slotNames.includes('shell.overlay'), JSON.stringify(slotNames))
check('不注册督导包的 sidebar.panellist / main', !slotNames.includes('sidebar.panellist') && !slotNames.includes('main'), JSON.stringify(slotNames))
check('只注册两个会话侧挂载点（采集包边界）', slotNames.length === 2 && slotNames.every((n) => n === 'conversation.input.dock' || n === 'conversation.session.header.actions'), JSON.stringify(slotNames))
check(
  '源码不再留浮层外壳与浮层开关（不许留死代码路径）',
  !/\.gicu-panel\s*\{|\.gicu-phone\s*\{|\.gicu-notch\s*\{/.test(clientCode) &&
    clientCode.indexOf('gicu-phone') === -1 &&
    clientCode.indexOf('gicu-notch') === -1 &&
    clientCode.indexOf('panel.setOpen') === -1 &&
    clientCode.indexOf('Escape') === -1 &&
    clientCode.indexOf('const panel = {') === -1,
  '',
)

// 通道契约（《实施契约》§2）
const uiApi = globalThis.__gaia_inspection_ui__
const viewApi = globalThis.__gaia_inspection_view__
check('发布角色通道 __gaia_inspection_view__（getRole/setRole/subscribe）', Boolean(viewApi) && typeof viewApi.getRole === 'function' && typeof viewApi.setRole === 'function' && typeof viewApi.subscribe === 'function', Object.keys(viewApi || {}).join(','))
check('发布屏组件通道 __gaia_inspection_ui__（version:1 + getScreen + subscribe）', Boolean(uiApi) && uiApi.version === 1 && typeof uiApi.getScreen === 'function' && typeof uiApi.subscribe === 'function', JSON.stringify(uiApi && { version: uiApi.version, getScreen: typeof uiApi.getScreen, subscribe: typeof uiApi.subscribe }))
check('getScreen() 返回组件函数（= CaptureScreen）', typeof uiApi.getScreen() === 'function' && uiApi.getScreen() === test.CaptureScreen, typeof uiApi.getScreen())
check('getScreen() 引用稳定（不换函数，否则外壳白重渲染）', uiApi.getScreen() === uiApi.getScreen(), '')
let uiPinged = 0
const uiUnsub = uiApi.subscribe(() => { uiPinged += 1 })
test.exposeChannels()
check('屏通道 subscribe 返回退订函数且能收到通知', typeof uiUnsub === 'function' && uiPinged === 1, String(uiPinged))
uiUnsub()
test.exposeChannels()
check('屏通道退订后不再被通知', uiPinged === 1, String(uiPinged))

// ── CSS：令牌 + 硬口径机检 ─────────────────────────────────────────────────
const cssText = styleEls.map((el) => el.textContent).join('\n')
check('样式已注入（<style data-plugin>）', cssText.indexOf('.gicu-root') !== -1, String(cssText.length))
const TOKENS = [
  '--gi-bg:#F4F0E8', '--gi-card:#FFFFFF', '--gi-ink:#17191D', '--gi-ink-2:#66635E', '--gi-ink-3:#8A909C', '--gi-line:#DED8CE',
  '--gi-accent:#A84300', '--gi-dark:#111318', '--gi-warn-bg:#FFF3E6', '--gi-warn-ink:#9A4A00',
  '--gi-r-card:18px', '--gi-r-block:12px', '--gi-r-ctl:10px', '--gi-r-pill:999px',
  '--gi-s1:4px', '--gi-s2:8px', '--gi-s3:12px', '--gi-s4:16px', '--gi-s6:24px', '--gi-s8:32px', '--gi-s10:40px',
  '--gi-shadow-card:0 2px 8px rgba(16,19,25,.06)', '--gi-shadow-pop:0 10px 28px rgba(16,19,25,.18)',
  '--gi-fs-title:20px', '--gi-fs-body:13px', '--gi-fs-aux:11px', '--gi-ease:cubic-bezier(.2,0,0,1)',
]
check('令牌与 §3.1 同名同值', TOKENS.every((token) => cssText.indexOf(token) !== -1), TOKENS.filter((t) => cssText.indexOf(t) === -1).join(' '))
const radiusValues = (cssText.match(/border-radius:\s*([^;]+)/g) || []).map((v) => v.replace(/border-radius:\s*/, '').trim())
check(
  '圆角只有 18/12/10/999（其余走令牌）',
  radiusValues.length > 0 && radiusValues.every((v) => /^var\(--gi-r-(card|block|ctl|pill)\)$/.test(v) || /^(18|12|10|999)px$/.test(v)),
  radiusValues.join(' | '),
)
const spacingDecls = (cssText.match(/(?:padding|margin|margin-left|gap|row-gap|column-gap):\s*[^;]+/g) || []).map((v) => v.split(':')[1])
const spacingNumbers = []
for (const decl of spacingDecls) for (const num of decl.match(/\d+px/g) || []) spacingNumbers.push(Number(num.replace('px', '')))
check('间距只用 4/8/12/16/24/32/40（其余走令牌）', spacingNumbers.every((n) => [0, 4, 8, 12, 16, 24, 32, 40].indexOf(n) !== -1), Array.from(new Set(spacingNumbers)).join(','))
const fontSizes = (cssText.match(/font-size:\s*([^;]+)/g) || []).map((v) => v.replace(/font-size:\s*/, '').trim())
check(
  '字号只有三档（20/13/11；.gicu-root 内全走令牌，会话侧入口用同值字面量）',
  fontSizes.length > 0 && fontSizes.every((v) => /^var\(--gi-fs-(title|body|aux)\)$/.test(v) || /^(20|13|11)px$/.test(v)),
  Array.from(new Set(fontSizes)).join(' | '),
)
const shadows = (cssText.match(/box-shadow:\s*([^;]+)/g) || []).map((v) => v.replace(/box-shadow:\s*/, '').trim())
const ringOnly = (value) => value.split(',').every((part) => /^(inset )?0 0 0 \d+px .+$/.test(part.trim()))
check(
  '阴影只有两级（其余 1px 圈一律 box-shadow 0 0 0 1px）',
  shadows.length > 0 &&
    shadows.every(
      (v) =>
        v === 'none' ||
        v.indexOf('var(--gi-shadow') !== -1 ||
        v.indexOf('0 2px 8px rgba(16,19,25,.06)') !== -1 ||
        v.indexOf('0 10px 28px rgba(16,19,25,.18)') !== -1 ||
        ringOnly(v),
    ),
  shadows.join(' | '),
)
check('按钮 ≥44px 且左右内边距 ≥16px', cssText.indexOf('min-height:44px') !== -1 && cssText.indexOf('padding:0 var(--gi-s4)') !== -1, '')
check('按下反馈 scale:.96（不得更小）', cssText.indexOf('scale:.96') !== -1, '')
check('四态齐全（hover / active / focus-visible / disabled）', [':hover', ':active', ':focus-visible', '[disabled]'].every((state) => cssText.indexOf(state) !== -1), '')
check('禁用态一律灰化（不保留品牌色）', cssText.indexOf('.gicu-btn.primary[disabled]') !== -1 && cssText.indexOf('.gicu-btn[disabled]') !== -1, '')
check('动效写属性名（transition-property）且无 transition: all', cssText.indexOf('transition-property') !== -1 && cssText.indexOf('transition: all') === -1, '')
check('prefers-reduced-motion 降级', cssText.indexOf('prefers-reduced-motion') !== -1, '')
check('动态数字 tabular-nums（.gicu-num）', cssText.indexOf('tabular-nums') !== -1 && cssText.indexOf('.gicu-num') !== -1, '')
check('B2 图片 outline 用令牌色 rgba(16,19,25,.10)（不再用纯黑）+ offset -1px', cssText.indexOf('outline:1px solid rgba(16,19,25,.10)') !== -1 && cssText.indexOf('outline-offset:-1px') !== -1, '')
const blackUsages = cssText.match(/rgba\(0,0,0,[^)]*\)/g) || []
check('B2 全表不用纯黑（rgba(0,0,0,…) 0 处、#000 0 处）', blackUsages.length === 0 && cssText.indexOf('#000') === -1, blackUsages.join(','))
check('文案排版 text-wrap（标题 balance / 正文 pretty）', cssText.indexOf('text-wrap:balance') !== -1 && cssText.indexOf('text-wrap:pretty') !== -1, '')
check('滚动条细且无彩色', cssText.indexOf('scrollbar-width:thin') !== -1 && cssText.indexOf('scrollbar-color:var(--gi-track) transparent') !== -1, '')
const NEW_CLASSES = ['gicu-root', 'gicu-screen', 'gicu-hero', 'gicu-form', 'gicu-banner', 'gicu-count', 'gicu-row', 'gicu-lbl', 'gicu-btn', 'gicu-dockbtn', 'gicu-input', 'gicu-note', 'gicu-select', 'gicu-num', 'gicu-state', 'gicu-skel', 'gicu-line', 'gicu-chip', 'gicu-actions', 'gicu-grow', 'gicu-scroll']
check('§4 类名齐备', NEW_CLASSES.every((cls) => cssText.indexOf('.' + cls) !== -1), NEW_CLASSES.filter((c) => cssText.indexOf('.' + c) === -1).join(' '))
const DEAD_CLASSES = ['gicu-panel', 'gicu-phone', 'gicu-notch', 'gicu-body', 'gicu-seg', 'gicu-tabs', 'gicu-drop', 'gicu-photo', 'gicu-ta', 'gicu-retry', 'gicu-off', 'gicu-inline']
check('旧浮层/手机壳类名已清空', DEAD_CLASSES.every((cls) => cssText.indexOf(cls) === -1), DEAD_CLASSES.filter((c) => cssText.indexOf(c) !== -1).join(' '))

// ── 渲染屏 A（整屏两栏）───────────────────────────────────────────────────
const capture = uiApi.getScreen()
renderAndText(capture, {})
await sleep(10) // 等 snapshot 取数落地
const opened = renderAndText(capture, {})
const panelText = opened.text

check('屏 A 根容器自带 .gicu-root（自声明令牌，可独立存活）', findByClass(opened.tree, 'gicu-root').length === 1, String(findByClass(opened.tree, 'gicu-root').length))
check('屏 A 是整屏两栏：.gicu-screen 里 .gicu-hero（左）+ .gicu-form（右）', findByClass(opened.tree, 'gicu-screen').length === 1 && findByClass(opened.tree, 'gicu-hero').length === 1 && findByClass(opened.tree, 'gicu-form').length === 1, '')
check('屏 A 不再有手机壳浮层（.gicu-panel/.gicu-phone/.gicu-notch 均不存在）', DEAD_CLASSES.every((cls) => findByClass(opened.tree, cls).length === 0), '')
check('屏 A 不自画角色切换段控件（由外壳统一提供）', findByClass(opened.tree, 'gicu-seg').length === 0 && panelText.indexOf('督导端') === -1, '')
check('屏 A 保留「演示替身」提示条（不能删的文案）', panelText.includes('演示替身：真实场景中门店在手机上提交，本面板为演示视图'), '')
check('屏 A 门店下拉含两家示例门店（画面级文案逐字）', panelText.includes('示例门店 A · 快餐档口') && panelText.includes('示例门店 B · 正餐堂食'), panelText.slice(0, 220))
check('屏 A 照片区文案为「点击选择照片，或把图片拖到这里」+ jpg/png 单张', panelText.includes('点击选择照片，或把图片拖到这里') && panelText.includes('支持 jpg / png，单张'), '')
check('屏 A 一句话说明含示例占位文案与实时字数 0 / 200 字', panelText.includes('接班时拍的，后门那堆货还没清，上一个班次留下的') && panelText.includes('0 / 200 字'), '')
check('屏 A 有 [载入示例] 与 [提交并分析]', panelText.includes('载入示例') && panelText.includes('提交并分析'), '')
check('屏 A 五态·待提交状态行逐字（data-kind=idle）', panelText.includes('待提交（照片与文字都填写后按钮可用）') && stateLineOf(opened.tree) !== null && stateLineOf(opened.tree).props['data-kind'] === 'idle', JSON.stringify(stateLineOf(opened.tree) && stateLineOf(opened.tree).props))
check('照片投放区是本屏视觉主角（.gicu-hero 里是整块投放区按钮）', findByClass(opened.tree, 'drop').length === 1 && findByClass(opened.tree, 'drop')[0].tag === 'button', '')
check('字数用 tabular-nums（.gicu-num）', findByClass(opened.tree, 'gicu-count').some((n) => String(n.props.className).indexOf('gicu-num') !== -1), '')
const textWithoutStoreLabels = panelText.split('示例门店 A · 快餐档口').join('').split('示例门店 B · 正餐堂食').join('')
check('不再用 `·` 拼元数据（既有门店下拉文案除外）', textWithoutStoreLabels.indexOf('·') === -1, textWithoutStoreLabels.slice(0, 200))
check('按钮文字不带 `→`', panelText.indexOf('→') === -1 && findAll(opened.tree, 'button').every((b) => vnodeText(b).indexOf('→') === -1), '')

const emptySubmit = buttonByLabel(opened.tree, '提交并分析')
check('空表单时「提交并分析」不可用', Boolean(emptySubmit) && emptySubmit.props.disabled === true, JSON.stringify(emptySubmit && emptySubmit.props.disabled))

// ── 三态（门店下拉这个数据面：加载中 / 空 / 失败）──────────────────────────
const savedSnapshotData = test.snapshotSource.data
test.snapshotSource.data = null
test.snapshotSource.failure = ''
test.snapshotSource.notify()
const loadingTree = renderAndText(capture, {})
check('三态·加载中：骨架 + 说明（不留白屏）', findByClass(loadingTree.tree, 'gicu-skel').length > 0 && loadingTree.text.includes('正在读取门店列表…'), loadingTree.text.slice(0, 160))

test.snapshotSource.data = null
test.snapshotSource.failure = '看板后端未就绪（路由 404）'
test.snapshotSource.notify()
const failedTree = renderAndText(capture, {})
check('三态·失败：给出原因 + 重试按钮', failedTree.text.includes('门店列表不可用') && failedTree.text.includes('看板后端未就绪（路由 404）') && Boolean(buttonByLabel(failedTree.tree, '重试')), failedTree.text.slice(0, 200))

test.snapshotSource.data = { stores: [], inspections: [] }
test.snapshotSource.failure = ''
test.snapshotSource.notify()
const emptyTree = renderAndText(capture, {})
check('三态·空：居中提示 + 下一步动作（重试）', emptyTree.text.includes('门店列表为空') && Boolean(buttonByLabel(emptyTree.tree, '重试')), emptyTree.text.slice(0, 200))

test.snapshotSource.data = savedSnapshotData
test.snapshotSource.failure = ''
test.snapshotSource.notify()
const restored = renderAndText(capture, {})
check('三态恢复：门店下拉回到两家示例门店（状态可复现）', restored.text.includes('示例门店 A · 快餐档口') && findByClass(restored.tree, 'gicu-select').length === 1, restored.text.slice(0, 160))

check('只收 jpg/png：png·jpg 通过，gif·无后缀拒绝', test.isAcceptedImage('a.png', 'image/png') === true && test.isAcceptedImage('a.jpg', 'image/jpeg') === true && test.isAcceptedImage('a.gif', 'image/gif') === false && test.isAcceptedImage('a', '') === false, '')

check('采集面只收单张（MAX_PHOTOS = 1，与后端 MAX_PHOTOS_SUBMIT 对齐）', test.MAX_PHOTOS === 1, String(test.MAX_PHOTOS))
check('单张上限 2MB（与后端 MAX_PHOTO_BYTES 对齐）', test.MAX_PHOTO_BYTES === 2 * 1024 * 1024, String(test.MAX_PHOTO_BYTES))
check('一句话上限 200 字', test.NOTE_MAX === 200, String(test.NOTE_MAX))

// 载入示例 → 真实提交 → 成功态
const loadBtn = buttonByLabel(restored.tree, '载入示例')
let loadError = ''
try {
  await loadBtn.props.onClick()
  await sleep(10)
} catch (error) {
  loadError = String((error && error.message) || error)
}
const sampleReq = requests.find((r) => r.path.indexOf('/sample-photo') !== -1)
check('「载入示例」从后端取内置示例图（真取数，不写死）', !loadError && Boolean(sampleReq), loadError || JSON.stringify(sampleReq))
const afterSample = renderAndText(capture, {})
check('载入示例后照片区显示文件名与合成标注', afterSample.text.includes('sample-issue.png') && afterSample.text.includes('合成示例图'), afterSample.text.slice(0, 240))
check('载入示例后文件名与体积分列（不再用 `·` 拼）', findByClass(afterSample.tree, 'nm').length === 1 && findByClass(afterSample.tree, 'gicu-chip').some((n) => String(n.props.className).indexOf('gicu-num') !== -1), '')
check('载入示例后一句话被填入（仍须真实调用模型）', afterSample.text.includes('接班时拍的，后门那堆货还没清，上一个班次留下的'), '')
check('选中后是大图预览 + 删除按钮', findByClass(afterSample.tree, 'frame').length === 1 && Boolean(buttonByLabel(afterSample.tree, '删除')), '')
const readySubmit = buttonByLabel(afterSample.tree, '提交并分析')
check('照片与文字齐备后「提交并分析」可用', Boolean(readySubmit) && readySubmit.props.disabled === false, JSON.stringify(readySubmit && readySubmit.props.disabled))
// 真机截图里的自相矛盾：材料齐、按钮亮蓝，状态行却还说「（照片与文字都填写后按钮可用）」。
check('就绪态不再说「填写后按钮可用」（同一 data-kind=idle，换成就绪文案）', afterSample.text.includes(test.STATE_READY) && !afterSample.text.includes(test.STATE_EMPTY), afterSample.text.slice(0, 200))

// 后端的示例图口不存在时 → 退回前端内置示例图（不硬依赖后端口）
sampleAvailable = false
const loadBtnAgain = buttonByLabel(renderAndText(capture, {}).tree, '载入示例')
await loadBtnAgain.props.onClick()
await sleep(10)
const fallbackText = renderAndText(capture, {}).text
check('示例图口 404 时退回前端内置示例图（不必占后端口）', fallbackText.includes('内置合成示例图') && fallbackText.includes('后端的示例图口暂不可用'), fallbackText.slice(0, 260))
check('内置示例图确实由 Canvas 合成（几何图形画法被调用）', canvasShim.calls.length > 0 && canvasShim.calls.some((c) => c.fn === 'fillRect'), String(canvasShim.calls.length))
check('载入示例后一句话仍被填入（真实调用模型不写死结果）', fallbackText.includes(test.SAMPLE_NOTE), '')
sampleAvailable = true

// 提交并分析（真实 POST；成功后状态行逐字）
test.submitState.phase = 'idle'
test.submitState.lastSubmittedAt = 0
test.submitState.lastStoreId = ''
const beforeCount = requests.filter((r) => r.path.indexOf('/submit') !== -1 && r.path.indexOf('report') === -1).length
const samplePhoto = { name: 'sample-issue.png', size: 12345, mediaType: 'image/png', file: null, dataUrl: 'data:image/png;base64,' + SAMPLE_BYTES }
await test.submitSelfCheck({ storeId: 'S-001', note: test.SAMPLE_NOTE, photos: [samplePhoto] })
await sleep(10)
const submitReqs = requests.filter((r) => r.path.indexOf('/submit') !== -1 && r.path.indexOf('report') === -1)
const submitReq = submitReqs[submitReqs.length - 1]
check('「提交并分析」走 POST /api/gaia-inspection/submit', submitReqs.length === beforeCount + 1 && submitReq.method === 'POST', JSON.stringify(submitReq && submitReq.path))
check('提交体含 storeId / note / photos[{name,mediaType,dataBase64}]（单张）', Boolean(submitReq && submitReq.body && submitReq.body.storeId === 'S-001' && Array.isArray(submitReq.body.photos) && submitReq.body.photos.length === 1 && submitReq.body.photos[0].mediaType === 'image/png'), JSON.stringify(submitReq && submitReq.body))
const doneTree = renderAndText(capture, {})
check('五态·成功：状态行逐字（含编号 #ab12）+ data-kind=ok', doneTree.text.includes('已提交，编号 #ab12，等待督导复核') && stateLineOf(doneTree.tree).props['data-kind'] === 'ok', JSON.stringify(stateLineOf(doneTree.tree).props))
check('提交后回执回报给宿主半内省口', requests.some((r) => r.path.indexOf('/report-submit') !== -1), '')

// ── 回归：useSyncExternalStore 的快照必须换引用 ─────────────────────────────
// 病根：getSnapshot 永远返回同一个被原地改属性的 const 对象 → React 用 Object.is 判定「快照没变」→ bailout
// → 订阅它的组件永不重渲染。用户看到的就是：点「提交并分析」后按钮不变「正在分析…」、状态行也不变
// 「已提交，编号 #xxxx」，界面看起来还是死的。
check(
  '源码里没有「getSnapshot 返回 store 本体」的残留',
  ['snapshotSource', 'submitState'].every((name) => clientCode.indexOf('() => ' + name + ', () => ' + name) === -1),
  '',
)

// 提交中：状态行必须变「正在分析…」（只靠 store 通知驱动，不手动重挂）
const realFetch = globalThis.fetch
let releaseSubmit = null
globalThis.fetch = async (url, options) => {
  if (String(url).indexOf('/submit') !== -1 && String(url).indexOf('report') === -1) await new Promise((resolve) => { releaseSubmit = resolve })
  return realFetch(url, options)
}
test.submitState.lastSubmittedAt = 0
renderAndText(capture, {})
const inFlight = test.submitSelfCheck({ storeId: 'S-001', note: test.SAMPLE_NOTE, photos: [samplePhoto] })
for (let i = 0; i < 50 && !releaseSubmit; i += 1) await sleep(10)
const busyDriven = flushStoreDriven(capture, {})
check('回归：提交中状态行/按钮变「正在分析…」（store 通知驱动重渲染）', Boolean(busyDriven) && busyDriven.text.indexOf('正在分析…') !== -1, busyDriven ? busyDriven.text.slice(0, 160) : '未重渲染')
check('五态·分析中：data-kind=running', Boolean(busyDriven) && stateLineOf(busyDriven.tree) !== null && stateLineOf(busyDriven.tree).props['data-kind'] === 'running', busyDriven ? JSON.stringify(stateLineOf(busyDriven.tree).props) : '未重渲染')
if (releaseSubmit) releaseSubmit()
await inFlight
await sleep(20)
const doneDriven = flushStoreDriven(capture, {})
check('回归：提交成功状态行出「已提交，编号 #ab12」（只靠 store 通知）', Boolean(doneDriven) && doneDriven.text.indexOf('已提交，编号 #ab12') !== -1, doneDriven ? doneDriven.text.slice(0, 160) : '未重渲染')
globalThis.fetch = realFetch
const snapBefore = test.snapshotSource.snapshot
await test.pullSnapshot()
check('回归：snapshotSource 在 notify 后换快照引用（门店下拉 / 离线提示条）', snapBefore !== test.snapshotSource.snapshot, '')

// 失败态：保留输入与照片 + [重试]
submitOverride = { ok: false, status: 'failed', summary: '模型不可用', error: { code: 'NO_PROVIDER', message: '宿主 llm 服务不可用：请先在模型设置里配置 provider' } }
test.submitState.lastSubmittedAt = 0
await test.submitSelfCheck({ storeId: 'S-001', note: test.SAMPLE_NOTE, photos: [samplePhoto] })
await sleep(10)
const failedSubmit = renderAndText(capture, {})
const failedText = failedSubmit.text
check('五态·失败：状态行形如「分析失败：<原因摘要> [重试]」+ data-kind=bad', failedText.indexOf('分析失败：') !== -1 && failedText.indexOf('宿主 llm 服务不可用') !== -1 && failedText.indexOf('重试') !== -1 && stateLineOf(failedSubmit.tree).props['data-kind'] === 'bad', failedText.slice(0, 260))
check('失败时输入与照片保留（不清空）', failedText.includes(test.SAMPLE_NOTE) && failedText.includes('sample-issue.png'), '')
submitOverride = null

// 断网：排队、不产生模型判断
snapshotOverride = { ...SNAPSHOT, offline: { offline: true, source: 'capture' }, pendingQueue: { pending: 2, judged: 0, items: [] } }
await test.pullSnapshot()
test.submitState.lastSubmittedAt = 0
submitOverride = { ok: true, runId: 'Q-1', status: 'queued', summary: '离线：仅采集排队，不产生模型判断；联网后自动补判', data: { offline: true, accepted: 1, modelCallsAdded: 0 } }
await test.submitSelfCheck({ storeId: 'S-001', note: '离线时提交', photos: [samplePhoto] })
await sleep(10)
const offlineTree = renderAndText(capture, {})
check('五态·离线：状态行含不能删的离线文案 + data-kind=off', offlineTree.text.includes('离线：仅采集排队，不产生模型判断；联网后自动补判') && stateLineOf(offlineTree.tree).props['data-kind'] === 'off', JSON.stringify(stateLineOf(offlineTree.tree).props))

// 断网恢复
snapshotOverride = { ...SNAPSHOT, offline: { offline: false, source: 'capture' }, pendingQueue: { pending: 2, judged: 0, items: [] } }
await test.pullSnapshot()
check('断网恢复状态行「已联网，正在补判排队中的 N 条…」', renderAndText(capture, {}).text.indexOf('已联网，正在补判排队中的 2 条…') !== -1, '')

// 同一门店不允许重复提交未完成的分析
const lockReason = test.busyReasonOf({ inspections: [{ id: 'INS-X', storeId: 'S-001', status: 'analyzing' }] }, 'S-001', Date.now())
check('同门店有进行中的分析时给出锁理由', typeof lockReason === 'string' && lockReason.indexOf('正在分析') !== -1, lockReason)
test.submitState.lastStoreId = 'S-001'
test.submitState.lastSubmittedAt = Date.now()
check('刚提交过 60s 内同门店再提交被拦', test.busyReasonOf({ inspections: [] }, 'S-001', Date.now()).indexOf('不允许重复提交') !== -1, test.busyReasonOf({ inspections: [] }, 'S-001', Date.now()))
check('其它门店不受影响', test.busyReasonOf({ inspections: [] }, 'S-002', Date.now()) === '', test.busyReasonOf({ inspections: [] }, 'S-002', Date.now()))
snapshotOverride = null

// ── 入口：点了必须有肉眼可见变化；督导包没装载必须给可见提示 ────────────────
const dockComponent = slotSpecs.find((s) => s.spec.name === 'conversation.input.dock').component
const headerComponent = slotSpecs.find((s) => s.spec.name === 'conversation.session.header.actions').component
check('输入区入口是组件（1 枚按钮 + 提示），header 入口同源', typeof dockComponent === 'function' && typeof headerComponent === 'function', dockComponent.name + '/' + headerComponent.name)

delete globalThis.__gaia_inspection_shell__
test.shellBridge.sync()
test.localView.setRole('supervisor')
const missingShell = renderAndText(dockComponent, {})
const missingBtn = buttonByLabel(missingShell.tree, '门店自查采集入口')
check('督导包未装载：按钮旁有可见内联提示（不留点了没反应的按钮）', missingShell.text.includes('巡店自查面板未装载（gaia-inspection-oversight-ui）') && Boolean(missingBtn), missingShell.text.slice(0, 160))
missingBtn.props.onClick()
check('未装载时点入口仍写入店长端角色（不是死按钮）', test.localView.role === 'manager', test.localView.role)

const shellCalls = []
globalThis.__gaia_inspection_shell__ = { version: 1, open: (view) => shellCalls.push(view), subscribe: () => () => {} }
test.shellBridge.sync()
test.localView.setRole('supervisor')
const readyShell = renderAndText(dockComponent, {})
check('督导包装载后提示消失', readyShell.text.indexOf('未装载') === -1, readyShell.text.slice(0, 120))
const openBtn = buttonByLabel(readyShell.tree, '门店自查采集入口')
openBtn.props.onClick()
check('点入口 → 切店长端 + 请外壳 open("board")（肉眼可见变化）', test.localView.role === 'manager' && shellCalls.length === 1 && shellCalls[0] === 'board', JSON.stringify(shellCalls))

// 离线时 dock 保留离线提示 chip（说明 §4 屏 A）
snapshotOverride = { ...SNAPSHOT, offline: { offline: true, source: 'capture' }, pendingQueue: { pending: 2, judged: 0, items: [] } }
await test.pullSnapshot()
const offlineDock = renderAndText(dockComponent, {})
check('离线时 dock 保留「离线：仅采集排队，不产生模型判断」提示 chip', offlineDock.text.includes('离线：仅采集排队，不产生模型判断'), offlineDock.text.slice(0, 160))
snapshotOverride = null
await test.pullSnapshot()

// 角色通道（本地状态，无登录）
test.localView.setRole('supervisor')
check('角色可切到督导端（本地视图状态）', test.localView.role === 'supervisor' && test.localView.roleLabel() === '督导端' && globalThis.__gaia_inspection_view__.getRole() === 'supervisor', test.localView.role)
test.localView.setRole('manager')
check('角色可切回店长端（角色通道是唯一真源）', test.localView.role === 'manager' && test.localView.roleLabel() === '店长端' && globalThis.__gaia_inspection_view__.getRole() === 'manager', test.localView.role)
check('角色通道还提供 subscribe（跨包共享，不含登录态）', typeof globalThis.__gaia_inspection_view__.subscribe === 'function', '')

// ── ④ keywords ────────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const wanted = ['门店自查采集入口', '角色视图切换']
check('manifest.keywords 逐字包含两个能力词', wanted.every((word) => manifest.keywords.includes(word)), JSON.stringify(manifest.keywords))
check('manifest.keywords 不含别的订单词', manifest.keywords.every((word) => ['科研综述自审', '自审链路看板', '溯源查看面板', '巡店判断回放看板', '证据挂图卡片', '立即扫描按钮', '模型调用日志面板'].indexOf(word) === -1), JSON.stringify(manifest.keywords))

// ── ⑤ 纯函数（逻辑层不变量）───────────────────────────────────────────────
const split = test.splitDataUrl('data:image/png;base64,AAAA')
check('splitDataUrl 正确拆分', split && split.mediaType === 'image/png' && split.dataBase64 === 'AAAA', JSON.stringify(split))
check('splitDataUrl 对非法输入返回 null', test.splitDataUrl('not-a-data-url') === null, '')
check('shortNo 把 runId 短化成 #ab12', test.shortNo('INS-20261002-201530-ab12') === '#ab12', test.shortNo('INS-20261002-201530-ab12'))
const receipt = test.readReceipt({ ok: true, runId: 'INS-20261002-201530-ab12', status: 'queued', summary: '排队', data: { offline: true } })
check('readReceipt 识别排队态', receipt.accepted === true && receipt.queued === true && receipt.no === 'INS-20261002-201530-ab12', JSON.stringify(receipt))
const rejected = test.readReceipt({ ok: false, error: { code: 'TOO_MANY_PHOTOS', message: '采集面只收单张照片' } })
check('readReceipt 对 ok:false 保留错误码与原文', rejected.accepted === false && rejected.errorCode === 'TOO_MANY_PHOTOS' && rejected.errorMessage.indexOf('单张') !== -1, JSON.stringify(rejected))
const off = test.normalizeOffline({ offline: { offline: true, source: 'capture' }, pendingQueue: { pending: 3 } })
check('normalizeOffline 读到离线与队列', off.known === true && off.offline === true && off.pending === 3, JSON.stringify(off))
check('normalizeOffline 无数据时标为未知（不假装在线）', test.normalizeOffline(null).known === false, '')
check('门店标签映射到画面级文案', test.storeLabelOf({ storeId: 'S-001', storeType: '快餐档口' }) === '示例门店 A · 快餐档口' && test.storeLabelOf({ storeId: 'S-002', storeType: '正餐堂食' }) === '示例门店 B · 正餐堂食', test.storeLabelOf({ storeId: 'S-001', storeType: '快餐档口' }))

// ── 退回闭环 · 店长侧承接面（用户实测反馈："点完退回并说明，看不到退到哪去了"）────
// 后端把退回写下来了，但店长端此前完全没有承接面 → 退回石沉大海。这一组盯住：
//   ① 店长端有「待整改（被督导退回）」区（退回原因/时间/次数/整改回拍入口）；
//   ② 点整改回拍 → 状态提示 + 提交体带 reworkOf（选择放在 store 里，跨重渲染存活）；
//   ③ 已经有回拍单的原单从待整改里消失（不重复催）。
// 放在文件末尾：这一组会真实调一次 submitSelfCheck（会写 submitState），不影响前面的断言。
const RETURNED_SNAPSHOT = {
  ok: true,
  stores: SNAPSHOT.stores,
  inspections: [
    {
      id: 'DEMO-20261003-010000-abcd-ISSUE',
      storeId: 'S-001',
      storeName: '示例门店·快餐档口甲',
      status: 'pending_rectify',
      returnedAt: '2026-10-03T01:00:00.000Z',
      returnedCount: 2,
      reworkOf: null,
      dueAt: '2026-10-03T09:00:00.000Z',
      // A-5 真机形状（#uzrn）：退回之后系统又自动催办过 → **lastAction 是系统的催办**，
      // 店长端必须认「退回那一条」的原话与主体，不能拿 lastAction 当退回人/退回原因。
      lastAction: { type: '催办', actionCode: 'review_remind', at: '2026-10-03T02:00:00.000Z', actor: '系统', actorIsHuman: false, reason: '截止时间已过（系统自动催办）' },
      actions: [
        { id: 'A1', type: '退回并说明', actionCode: 'review_reject', target: '后门堆货', createdAt: '2026-10-03T01:00:00.000Z', reason: '后门堆货未清，请清理后回拍', actor: '督导（演示视图）', actorName: '督导（演示视图）', actorIsHuman: true, result: '退回' },
        { id: 'A2', type: '催办', actionCode: 'review_remind', target: '示例门店·快餐档口甲·整改截止已过', createdAt: '2026-10-03T02:00:00.000Z', reason: '截止时间已过（系统自动催办）', actor: '系统', actorName: null, actorIsHuman: false, result: '已催办' },
      ],
    },
  ],
  counts: {},
  offline: { offline: false, source: 'capture' },
  pendingQueue: { pending: 0, judged: 0, items: [] },
}
check('pendingReworkOf：只收"被退回过且还没有回拍单"的本店单', test.pendingReworkOf(RETURNED_SNAPSHOT, 'S-001').length === 1 && test.pendingReworkOf(RETURNED_SNAPSHOT, 'S-002').length === 0 && test.pendingReworkOf({ inspections: [{ id: 'A', storeId: 'S-001', returnedAt: 'x', reworkOf: null }, { id: 'B', storeId: 'S-001', reworkOf: 'A' }] }, 'S-001').length === 0, JSON.stringify(test.pendingReworkOf(RETURNED_SNAPSHOT, 'S-001')))
// 真机实测漏过一条：督导把**原单**逐项点通过办结、又没有产生回拍单时（例：#flsq），
// 已办结的单还挂在店长端「待整改」里，等于让店长去整改一条已经办结的单。
check('已办结（rectified/closed/approved）的单不再进「待整改」',
  test.pendingReworkOf({ inspections: [
    { id: 'A', storeId: 'S-001', returnedAt: 'x', status: 'rectified', reworkOf: null },
    { id: 'B', storeId: 'S-001', returnedAt: 'x', status: 'pending_rectify', reworkOf: null },
    { id: 'C', storeId: 'S-001', returnedAt: 'x', status: 'overdue', reworkOf: null },
  ] }, 'S-001').map((r) => r.id).join(',') === 'B,C',
  JSON.stringify(test.pendingReworkOf({ inspections: [
    { id: 'A', storeId: 'S-001', returnedAt: 'x', status: 'rectified', reworkOf: null },
    { id: 'B', storeId: 'S-001', returnedAt: 'x', status: 'pending_rectify', reworkOf: null },
    { id: 'C', storeId: 'S-001', returnedAt: 'x', status: 'overdue', reworkOf: null },
  ] }, 'S-001').map((r) => r.id)))
{
  const row = test.pendingReworkOf(RETURNED_SNAPSHOT, 'S-001')[0]
  check('A5 待整改项的退回原因取「退回那条」（不是系统催办原因）', row.reason === '后门堆货未清，请清理后回拍' && row.reason.indexOf('系统自动催办') === -1, JSON.stringify(row.reason))
  check('A5 待整改项标明是人工退回（不再显示"由 系统"）', row.actor === '督导（演示视图）（人工退回）' && row.hasRejectRow === true, row.actor)
  check('A5 退回时间取退回那条（01:00，不是催办的 02:00）', row.returnedAt === '2026-10-03T01:00:00.000Z', row.returnedAt)
  // 客户 10-03 用完真机的裁定：「催办」不能是摆设 —— 督导端写了一条记录，门店端必须看得见。
  // 数据同样不新增字段：同一张单的 actions 里已有催办记录（人工 type='催办' / 系统 actionCode='review_remind'）。
  check('催办痕迹进门店端：次数 + 最近时刻 + 谁催的（系统自动要说清）', row.remindCount === 1 && row.remindAt === '2026-10-03T02:00:00.000Z' && row.remindBy === '系统自动', JSON.stringify({ count: row.remindCount, at: row.remindAt, by: row.remindBy }))
}
{
  const human = test.pendingReworkOf({ inspections: [{
    id: 'A', storeId: 'S-001', returnedAt: 'x', status: 'pending_rectify', reworkOf: null,
    actions: [
      { type: '催办', actionCode: 'review_remind', createdAt: '2026-10-03T03:00:00.000Z', actor: '督导（演示视图）', actorIsHuman: true },
      { type: '催办', actionCode: 'review_remind', createdAt: '2026-10-03T04:00:00.000Z', actor: '督导（演示视图）', actorIsHuman: true },
    ],
  }] }, 'S-001')[0]
  check('催办取总次数 + 最近一条；人工催办不写成「系统自动」', human.remindCount === 2 && human.remindAt === '2026-10-03T04:00:00.000Z' && human.remindBy === '督导（演示视图）', JSON.stringify(human))
  const none = test.pendingReworkOf({ inspections: [{ id: 'A', storeId: 'S-001', returnedAt: 'x', status: 'pending_rectify', reworkOf: null, actions: [] }] }, 'S-001')[0]
  check('没被催过的单不写催办行（count=0，界面不出现这一行）', none.remindCount === 0 && none.remindAt === null && none.remindBy === '', JSON.stringify(none))
}

test.snapshotSource.data = RETURNED_SNAPSHOT
test.snapshotSource.failure = ''
test.snapshotSource.notify()
const reworkTree = renderAndText(capture, {})
check('店长端出现「待整改（被督导退回）」+ 退回原因 + 整改回拍入口', reworkTree.text.includes('待整改（被督导退回）') && reworkTree.text.includes('后门堆货未清，请清理后回拍') && Boolean(buttonByLabel(reworkTree.tree, '整改后重新提交')), reworkTree.text.slice(0, 240))
check('待整改项显示退回次数（共退回 2 次，重复退回也看得出来）', reworkTree.text.includes('共退回 2 次'), '')
check('门店端「待整改」卡上真的显示催办痕迹（"催办是摆设"这条修掉）', reworkTree.text.includes('被催办 1 次') && reworkTree.text.includes('最近') && reworkTree.text.includes('系统自动'), reworkTree.text.slice(0, 420))

buttonByLabel(reworkTree.tree, '整改后重新提交').props.onClick()
// 点击后到断言之间**不能 await**：组件挂载会触发一次 pullSnapshot，异步回填会把夹具覆盖成默认快照。
test.snapshotSource.data = RETURNED_SNAPSHOT
test.snapshotSource.notify()
const afterPickRework = renderAndText(capture, {})
check('点整改回拍 → 提示「正在整改回拍 …」且按钮变「取消整改回拍」', afterPickRework.text.includes('正在整改回拍') && Boolean(buttonByLabel(afterPickRework.tree, '取消整改回拍')), afterPickRework.text.slice(0, 200))

await test.submitSelfCheck({ storeId: 'S-001', note: '已清理后门堆货并回拍', photos: [{ name: 'rework.png', size: 1234, mediaType: 'image/png', dataUrl: 'data:image/png;base64,QUJD' }], reworkOf: 'DEMO-20261003-010000-abcd-ISSUE' })
const reworkSubmitReq = requests.filter((r) => r.path.indexOf('/submit') !== -1 && r.path.indexOf('report') === -1).slice(-1)[0]
check('整改回拍提交体带 reworkOf（后端据此把新单标成"整改回拍自 原单"）', Boolean(reworkSubmitReq && reworkSubmitReq.body && reworkSubmitReq.body.reworkOf === 'DEMO-20261003-010000-abcd-ISSUE'), JSON.stringify(reworkSubmitReq && reworkSubmitReq.body))
check('提交被受理后「正在整改回拍」标记自动清掉（这次回拍用掉了）', test.reworkState.snapshot.id === '', JSON.stringify(test.reworkState.snapshot))

test.snapshotSource.data = { ...RETURNED_SNAPSHOT, inspections: [...RETURNED_SNAPSHOT.inspections, { id: 'INS-REWORK-1', storeId: 'S-001', status: 'pending_rectify', reworkOf: 'DEMO-20261003-010000-abcd-ISSUE' }] }
test.snapshotSource.notify()
const afterReworkSnap = renderAndText(capture, {})
// 已经有回拍单的原单从「待整改」里消失（不会重复催）
check('已经有回拍单的原单从「待整改」里消失（不会重复催）', afterReworkSnap.text.indexOf('待整改（被督导退回）') === -1, afterReworkSnap.text.slice(0, 160))

// A-1.6：整改回拍**不受本地 60s 重复提交锁**限制（刚提交完就点「整改后重新提交」必须能交上去；
// 真机验收时就是被这条锁按住，按钮 disabled、提示"同一门店不允许重复提交"，与用户意图相反）。
{
  test.submitState.lastStoreId = 'S-001'
  test.submitState.lastSubmittedAt = Date.now()
  test.submitState.notify()
  const locked = test.busyReasonOf({ ok: true, inspections: [] }, 'S-001', Date.now(), false)
  const reworkFree = test.busyReasonOf({ ok: true, inspections: [] }, 'S-001', Date.now(), true)
  check('A-1.6 普通重复提交仍被 60s 锁拦住（防手抖）', locked.indexOf('刚提交过') !== -1, locked)
  check('A-1.6 整改回拍豁免该锁（回拍是督导要求做的下一步）', reworkFree === '', JSON.stringify(reworkFree))
  const analyzing = test.busyReasonOf({ ok: true, inspections: [{ id: 'X', storeId: 'S-001', status: 'analyzing' }] }, 'S-001', Date.now(), true)
  check('A-1.6 但"该店有正在分析/排队的单"仍拦（并发保护不受豁免影响）', analyzing.indexOf('正在分析') !== -1, analyzing)
}

// 收尾：把这组用到的 store 复位，便于以后在文件后面继续追加断言
test.reworkState.setId('')
test.submitState.phase = 'idle'
test.submitState.receipt = null
test.submitState.lastStoreId = ''
test.submitState.lastSubmittedAt = 0
test.submitState.notify()
test.snapshotSource.data = savedSnapshotData
test.snapshotSource.failure = ''
test.snapshotSource.notify()

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log('')
for (const item of results) console.log((item.ok ? 'PASS ' : 'FAIL ') + item.name + (item.detail ? '  [' + item.detail + ']' : ''))
console.log('')
console.log('通过 ' + results.filter((r) => r.ok).length + '/' + results.length)
if (fail.length > 0) {
  console.log('未通过：')
  for (const line of fail) console.log(' - ' + line)
  process.exitCode = 1
}
