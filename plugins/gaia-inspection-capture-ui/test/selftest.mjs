// gaia-inspection-capture-ui / fe 交接前自测（Node 下跑，零第三方依赖）。
//
// 对齐《界面实现说明（画面级）》屏 A：视图标签 / 演示替身提示条 / 门店下拉 / 单张照片（jpg·png、不调摄像头）
// / 一句话 1–200 字与实时字数 / [载入示例] [提交并分析] / 五态状态行逐字 / 失败保留输入与照片 / 同门店不许重复提交。
//
// 覆盖：① 宿主半 import / inject / 只读内省路由；② client 装载契约；③ **在最小 React/DOM/fetch 垫片下把屏 A
// 渲染出来并跑真实提交流程**；④ manifest.keywords 逐字；⑤ 纯函数（单张与类型校验、回执读取、编号短化、离线归一）。
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
function buttonByLabel(tree, label) {
  return findAll(tree, 'button').find((b) => vnodeText(b).indexOf(label) !== -1)
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
globalThis.document = {
  createElement: (tag) => {
    if (tag === 'canvas') return canvasShim.canvas
    return { setAttribute() {}, dataset: {}, textContent: '' }
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

// ── ③ 加载 client 半并渲染屏 A ─────────────────────────────────────────────
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
check('注册了输入区入口（视图标签 + 采集入口）', slotSpecs.some((s) => s.spec.name === 'conversation.input.dock'), JSON.stringify(slotSpecs.map((s) => s.spec.name)))
check('注册了屏 A 浮层（无遮罩）', slotSpecs.some((s) => s.spec.name === 'shell.overlay'), '')
check('注册了会话 header 入口', slotSpecs.some((s) => s.spec.name === 'conversation.session.header.actions'), '')

// 打开采集面 → 渲染屏 A
test.panel.setOpen(true)
const panelComponent = slotSpecs.find((s) => s.spec.name === 'shell.overlay').component
renderAndText(panelComponent, {})
await new Promise((r) => setTimeout(r, 10)) // 等 snapshot 取数落地
const opened = renderAndText(panelComponent, {})
const panelText = opened.text

check('屏 A 出现视图标签「店长端」「督导端」', panelText.includes('店长端') && panelText.includes('督导端'), panelText.slice(0, 120))
check('屏 A 保留「演示替身」提示条（不能删的文案）', panelText.includes('演示替身：真实场景中门店在手机上提交，本面板为演示视图'), '')
check('屏 A 门店下拉含两家示例门店（画面级文案）', panelText.includes('示例门店 A · 快餐档口') && panelText.includes('示例门店 B · 正餐堂食'), panelText.slice(0, 220))
check('屏 A 照片区文案为「点击选择照片，或把图片拖到这里」+ jpg/png 单张', panelText.includes('点击选择照片，或把图片拖到这里') && panelText.includes('支持 jpg / png，单张'), '')
check('屏 A 一句话说明含示例占位文案与实时字数 0 / 200', panelText.includes('接班时拍的，后门那堆货还没清，上一个班次留下的') && panelText.includes('0 / 200 字'), '')
check('屏 A 有 [载入示例] 与 [提交并分析]', panelText.includes('载入示例') && panelText.includes('提交并分析'), '')
check('屏 A 空态状态行逐字', panelText.includes('待提交（照片与文字都填写后按钮可用）'), '')

const emptySubmit = buttonByLabel(opened.tree, '提交并分析')
check('空表单时「提交并分析」不可用', Boolean(emptySubmit) && emptySubmit.props.disabled === true, JSON.stringify(emptySubmit && emptySubmit.props.disabled))

check('只收 jpg/png：png·jpg 通过，gif·无后缀拒绝', test.isAcceptedImage('a.png', 'image/png') === true && test.isAcceptedImage('a.jpg', 'image/jpeg') === true && test.isAcceptedImage('a.gif', 'image/gif') === false && test.isAcceptedImage('a', '') === false, '')
check('采集面只收单张（MAX_PHOTOS = 1，与后端 MAX_PHOTOS_SUBMIT 对齐）', test.MAX_PHOTOS === 1, String(test.MAX_PHOTOS))
check('单张上限 2MB（与后端 MAX_PHOTO_BYTES 对齐）', test.MAX_PHOTO_BYTES === 2 * 1024 * 1024, String(test.MAX_PHOTO_BYTES))
check('一句话上限 200 字', test.NOTE_MAX === 200, String(test.NOTE_MAX))

// 载入示例 → 真实提交 → 成功态
const loadBtn = buttonByLabel(opened.tree, '载入示例')
let loadError = ''
try {
  await loadBtn.props.onClick()
  await new Promise((r) => setTimeout(r, 10))
} catch (error) {
  loadError = String((error && error.message) || error)
}
const sampleReq = requests.find((r) => r.path.indexOf('/sample-photo') !== -1)
check('「载入示例」从后端取内置示例图（真取数，不写死）', !loadError && Boolean(sampleReq), loadError || JSON.stringify(sampleReq))
const afterSample = renderAndText(panelComponent, {})
check('载入示例后照片区显示文件名与合成标注', afterSample.text.includes('sample-issue.png') && afterSample.text.includes('合成示例图'), afterSample.text.slice(0, 240))
check('载入示例后一句话被填入（仍须真实调用模型）', afterSample.text.includes('接班时拍的，后门那堆货还没清，上一个班次留下的'), '')
const readySubmit = buttonByLabel(afterSample.tree, '提交并分析')
check('照片与文字齐备后「提交并分析」可用', Boolean(readySubmit) && readySubmit.props.disabled === false, JSON.stringify(readySubmit && readySubmit.props.disabled))

// 后端的示例图口不存在时 → 退回前端内置示例图（不硬依赖后端口）
sampleAvailable = false
const loadBtnAgain = buttonByLabel(renderAndText(panelComponent, {}).tree, '载入示例')
await loadBtnAgain.props.onClick()
await sleep(10)
const fallbackText = renderAndText(panelComponent, {}).text
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
await new Promise((r) => setTimeout(r, 10))
const submitReqs = requests.filter((r) => r.path.indexOf('/submit') !== -1 && r.path.indexOf('report') === -1)
const submitReq = submitReqs[submitReqs.length - 1]
check('「提交并分析」走 POST /api/gaia-inspection/submit', submitReqs.length === beforeCount + 1 && submitReq.method === 'POST', JSON.stringify(submitReq && submitReq.path))
check('提交体含 storeId / note / photos[{name,mediaType,dataBase64}]（单张）', Boolean(submitReq && submitReq.body && submitReq.body.storeId === 'S-001' && Array.isArray(submitReq.body.photos) && submitReq.body.photos.length === 1 && submitReq.body.photos[0].mediaType === 'image/png'), JSON.stringify(submitReq && submitReq.body))
check('成功态状态行逐字（含编号 #ab12）', renderAndText(panelComponent, {}).text.includes('已提交，编号 #ab12，等待督导复核'), '')
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

test.panel.setOpen(false)
renderAndText(panelComponent, {})
test.panel.setOpen(true)
const openedByStore = flushStoreDriven(panelComponent)
check('回归：采集面只靠 store 通知就重渲染出来（getSnapshot 换引用）', Boolean(openedByStore) && openedByStore.text.indexOf('提交并分析') !== -1, openedByStore ? '' : 'store 通知后订阅者未被标脏 → React 不会重渲染')

// 提交中：按钮必须变「正在分析…」（同样只靠 store 通知驱动，不手动重挂）
const realFetch = globalThis.fetch
let releaseSubmit = null
globalThis.fetch = async (url, options) => {
  if (String(url).indexOf('/submit') !== -1 && String(url).indexOf('report') === -1) await new Promise((resolve) => { releaseSubmit = resolve })
  return realFetch(url, options)
}
test.submitState.lastSubmittedAt = 0
const inFlight = test.submitSelfCheck({ storeId: 'S-001', note: test.SAMPLE_NOTE, photos: [samplePhoto] })
for (let i = 0; i < 50 && !releaseSubmit; i += 1) await sleep(10)
const busyDriven = flushStoreDriven(panelComponent)
check('回归：提交中按钮变「正在分析…」（store 通知驱动重渲染）', Boolean(busyDriven) && busyDriven.text.indexOf('正在分析…') !== -1, busyDriven ? busyDriven.text.slice(0, 160) : '未重渲染')
if (releaseSubmit) releaseSubmit()
await inFlight
await sleep(20)
const doneDriven = flushStoreDriven(panelComponent)
check('回归：提交成功状态行出「已提交，编号 #ab12」', Boolean(doneDriven) && doneDriven.text.indexOf('已提交，编号 #ab12') !== -1, doneDriven ? doneDriven.text.slice(0, 160) : '未重渲染')
globalThis.fetch = realFetch
const snapBefore = test.snapshotSource.snapshot
await test.pullSnapshot()
check('回归：snapshotSource 在 notify 后换快照引用（门店下拉 / 离线提示条）', snapBefore !== test.snapshotSource.snapshot, '')

// 失败态：保留输入与照片 + [重试]
submitOverride = { ok: false, status: 'failed', summary: '模型不可用', error: { code: 'NO_PROVIDER', message: '宿主 llm 服务不可用：请先在模型设置里配置 provider' } }
test.submitState.lastSubmittedAt = 0
await test.submitSelfCheck({ storeId: 'S-001', note: test.SAMPLE_NOTE, photos: [samplePhoto] })
await new Promise((r) => setTimeout(r, 10))
const failedText = renderAndText(panelComponent, {}).text
check('失败态状态行形如「分析失败：<原因摘要> [重试]」', failedText.indexOf('分析失败：') !== -1 && failedText.indexOf('宿主 llm 服务不可用') !== -1 && failedText.indexOf('重试') !== -1, failedText.slice(0, 260))
check('失败时输入与照片保留（不清空）', failedText.includes(test.SAMPLE_NOTE) && failedText.includes('sample-issue.png'), '')
submitOverride = null

// 断网：排队、不产生模型判断
snapshotOverride = { ...SNAPSHOT, offline: { offline: true, source: 'capture' }, pendingQueue: { pending: 2, judged: 0, items: [] } }
await test.pullSnapshot()
test.submitState.lastSubmittedAt = 0
submitOverride = { ok: true, runId: 'Q-1', status: 'queued', summary: '离线：仅采集排队，不产生模型判断；联网后自动补判', data: { offline: true, accepted: 1, modelCallsAdded: 0 } }
await test.submitSelfCheck({ storeId: 'S-001', note: '离线时提交', photos: [samplePhoto] })
await new Promise((r) => setTimeout(r, 10))
check('断网态状态行含不能删的离线文案', renderAndText(panelComponent, {}).text.includes('离线：仅采集排队，不产生模型判断；联网后自动补判'), '')

// 断网恢复
snapshotOverride = { ...SNAPSHOT, offline: { offline: false, source: 'capture' }, pendingQueue: { pending: 2, judged: 0, items: [] } }
await test.pullSnapshot()
check('断网恢复状态行「已联网，正在补判排队中的 N 条…」', renderAndText(panelComponent, {}).text.indexOf('已联网，正在补判排队中的 2 条…') !== -1, '')

// 同一门店不允许重复提交未完成的分析
const lockReason = test.busyReasonOf({ inspections: [{ id: 'INS-X', storeId: 'S-001', status: 'analyzing' }] }, 'S-001', Date.now())
check('同门店有进行中的分析时给出锁理由', typeof lockReason === 'string' && lockReason.indexOf('正在分析') !== -1, lockReason)
test.submitState.lastStoreId = 'S-001'
test.submitState.lastSubmittedAt = Date.now()
check('刚提交过 60s 内同门店再提交被拦', test.busyReasonOf({ inspections: [] }, 'S-001', Date.now()).indexOf('不允许重复提交') !== -1, test.busyReasonOf({ inspections: [] }, 'S-001', Date.now()))
check('其它门店不受影响', test.busyReasonOf({ inspections: [] }, 'S-002', Date.now()) === '', test.busyReasonOf({ inspections: [] }, 'S-002', Date.now()))

// 角色视图切换（本地状态，无登录）
test.localView.setRole('supervisor')
check('角色可切到督导端（本地视图状态）', test.localView.role === 'supervisor' && test.localView.roleLabel() === '督导端', test.localView.role)
test.localView.setRole('manager')
check('角色可切回店长端', test.localView.role === 'manager' && test.localView.roleLabel() === '店长端', test.localView.role)
check('视图通道已发布（跨包共享，不含登录态）', typeof globalThis.__gaia_inspection_view__.getRole === 'function', '')
test.panel.setOpen(false)
snapshotOverride = null
submitOverride = null

// ── ④ keywords ────────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const wanted = ['门店自查采集入口', '角色视图切换']
check('manifest.keywords 逐字包含两个能力词', wanted.every((word) => manifest.keywords.includes(word)), JSON.stringify(manifest.keywords))
check('manifest.keywords 不含别的订单词', manifest.keywords.every((word) => ['科研综述自审', '自审链路看板', '溯源查看面板', '巡店判断回放看板', '证据挂图卡片', '立即扫描按钮', '模型调用日志面板'].indexOf(word) === -1), JSON.stringify(manifest.keywords))

// ── ⑤ 纯函数 ──────────────────────────────────────────────────────────────
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
