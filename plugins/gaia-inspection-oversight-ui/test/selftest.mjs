// gaia-inspection-oversight-ui / fe 交接前自测（Node 下跑，零第三方依赖）。
//
// 对齐《给盖亚-前端重做指令（终版）》+《实施契约》：
//   挂载：sidebar.panellist(id=gaia-inspection/order=30/label=巡店自查) + main(key=gaia-inspection)；
//        会话 header 三枚入口；**不再注册 shell.overlay**；右侧栏 logs tab 保留。
//   外壳 InspectionApp（已定稿）：首屏角色选择 → 店长端（内嵌采集包屏）/ 总部督导端 / 模型调用日志。
//   屏 B（督导端）：`.giou-b` = `.giou-blist`（`.giou-filters` + `.giou-list`）+ `.giou-bdetail`；
//        列表项 `.giou-thumb/.giou-item-id/.giou-item-meta/.giou-item-chips + .giou-chip`；**本组件不再有统计/动作 topbar**。
//   证据：`.giou-photos/.giou-shot/.giou-mark/.giou-frame/.giou-basis/.giou-field`，标题＝能力词「证据挂图卡片」；
//        有坐标画框 + 框心标点、无坐标标点 + 旁边写依据、都没有就不画（**绝不画空框**）。
//   日志：`.giou-logs`（`.giou-logbar` + `.giou-tablewrap` + `.giou-table`）、7 列逐字、空态「暂无调用记录」、脱敏说明逐字。
//
// 覆盖：① 宿主半 import / inject / 自检口；② client 装载契约；③ 槽位/通道契约；④ 外壳首屏与两端进入；
// ⑤ 在最小 React/DOM/fetch 垫片下把四个面渲染一遍（含三态）；⑥ 只靠 store 通知就重渲染的回归；
// ⑦ manifest.keywords 逐字；⑧ 纯函数（统计/筛选/置信度/定位降级/扫描回执/短编号/脱敏白名单）。
// 用法：node test/selftest.mjs
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
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
check('宿主半 name 与包名一致', host.name === 'gaia-inspection-oversight-ui', host.name)

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
check('宿主半注册了 1 条只读自检路由', hostRoutes.filter((r) => r && r.path).length === 1, JSON.stringify(hostRoutes.filter((r) => r && r.path).map((r) => r.path)))
check('自检口如实列出下游依赖（含需后端补的 review）', JSON.stringify(host.__internals.UPSTREAM_ROUTES).indexOf('review') !== -1, '')

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

// ── 最小 React 垫片 ───────────────────────────────────────────────────────
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
  // 快照没变 → bailout → 组件永不重渲染」这类真 bug 全掩盖了（面板打不开就是这一类）。
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
/** 按 className（含多类名）收集元素，便于断言「换到新类」而不是断言旧类。 */
function byClass(node, className) {
  const out = []
  const walk = (n) => {
    if (!n) return
    const raw = n.props && typeof n.props.className === 'string' ? n.props.className : ''
    if (raw.split(/\s+/).indexOf(className) !== -1) out.push(n)
    if (n.children) for (const child of n.children) walk(child)
    if (n.rendered) walk(n.rendered)
  }
  walk(node)
  return out
}
function byLabel(tree, tag, label) {
  return findAll(tree, tag).find((node) => vnodeText(node).indexOf(label) !== -1)
}
/**
 * 点一下左栏筛选档（按钮文案是「标签＋条数」，用前缀匹配）。
 *
 * 注意：本垫片的 useState 按**组件名**存在 holder 里、跨重挂存活 —— 切过档之后，
 * 后面每个 `renderAndText` 都还在那一档里。所以「切走 → 断言 → 切回来」必须成对写。
 */
function clickFilter(tree, label) {
  const bar = byClass(tree, 'giou-filters')[0]
  if (!bar) throw new Error('no .giou-filters in tree')
  const btn = findAll(bar, 'button').find((n) => textOfTree(n).indexOf(label) === 0)
  if (!btn) throw new Error('filter not found: ' + label)
  btn.props.onClick()
}
/** 档位在不在（注意：byLabel 用的 vnodeText 看不到"孙子节点里的纯文字"，筛选按钮要这样查）。 */
function hasFilter(tree, label) {
  const bar = byClass(tree, 'giou-filters')[0]
  return Boolean(bar && findAll(bar, 'button').some((n) => textOfTree(n).indexOf(label) === 0))
}
/** 点「第 N 轮」（多轮订单右栏的轮次行）。 */
function clickRound(tree, index) {
  const rows = byClass(tree, 'giou-round')
  const row = rows[index - 1]
  if (!row) throw new Error('round not found: ' + index + '（只有 ' + rows.length + ' 轮）')
  row.props.onClick()
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
  for (let round = 0; round < 6; round += 1) {
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
 * React bailout 的表现，也是「面板永远不出现 / 提交后界面看起来还是死的」那类 bug 的判定口径。
 */
function flushStoreDriven(component, props) {
  let last = null
  for (let round = 0; round < 4; round += 1) {
    if (!lastRenderHolders.some((holder) => holder.dirty)) break
    last = renderAndText(component, props)
  }
  return last
}
/** 一步：先按 store 通知重渲染，没有可重渲染的就整棵重挂（等价用户下一次交互触发的渲染）。 */
function step(component, props) {
  const driven = flushStoreDriven(component, props)
  return driven || renderAndText(component, props)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── DOM / fetch 垫片（响应形状与 be 的 routes.js 同形）─────────────────────
globalThis.document = {
  createElement: () => ({ setAttribute() {}, dataset: {}, textContent: '' }),
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = {
  __ModuleLoader__: { load: (spec) => { globalThis.__loaded = spec } },
  setInterval: () => 0,
  clearInterval: () => {},
}
// 采集包（另一个包）发布的通道：角色真源 + 店长端屏。本包只消费，不假装有界面。
let roleValue = 'supervisor'
const roleListeners = new Set()
globalThis.__gaia_inspection_view__ = {
  getRole: () => roleValue,
  setRole: (role) => { roleValue = role === 'manager' ? 'manager' : 'supervisor'; roleListeners.forEach((listener) => { try { listener() } catch (error) { /* 忽略 */ } }) },
  subscribe: (listener) => { roleListeners.add(listener); return () => roleListeners.delete(listener) },
}
const CaptureStub = function CaptureScreen() {
  return ReactShim.createElement('div', { className: 'gicu-root' }, '店长端屏（采集包占位）：照片投放区 + 一句话说明')
}
globalThis.__gaia_inspection_ui__ = { version: 1, getScreen: () => CaptureStub, subscribe: () => () => {} }

const SNAPSHOT = {
  ok: true,
  ts: '2026-10-02T20:10:00.000Z',
  stores: [
    { storeId: 'S-001', storeName: '示例门店·快餐档口甲', storeType: '快餐档口' },
    { storeId: 'S-002', storeName: '示例门店·正餐堂食乙', storeType: '正餐堂食' },
  ],
  inspections: [
    {
      id: 'INS-20261002-201530-ab12',
      storeId: 'S-001',
      storeName: '示例门店·快餐档口甲',
      storeType: '快餐档口',
      note: '接班时拍的，后门那堆货还没清，上一个班次留下的',
      status: 'pending_rectify',
      source: 'selfcheck',
      demo: false,
      createdAt: '2026-10-02T20:05:00.000Z',
      dueAt: '2026-10-02T20:30:00.000Z',
      overdue: true,
      escalated: true,
      items: [{ itemId: 'IT-1', name: '消防通道占用', why: '照片显示通道口整箱堆放' }],
      // 后端按 inspectionId 统计的真实调用次数（一次提交 = checklist_generate + vision_judge 两次）
      modelCallCount: 2,
      // 退回闭环：被督导退回过 2 次；**最近一条动作是系统自动催办**（真机 #uzrn 就是这个形状）——
      // A-5 的回归就靠这个夹具：退回人/退回原因必须取"退回那一条"，不能取 lastAction。
      returnedAt: '2026-10-02T20:12:00.000Z',
      returnedCount: 2,
      reworkOf: null,
      lastAction: { id: 'ACT-9b', type: '催办', actionCode: 'review_remind', at: '2026-10-02T20:20:00.000Z', actor: '系统', actorName: null, actorIsHuman: false, reason: '截止时间已过（系统自动催办）', result: '已催办', target: '示例门店·快餐档口甲·整改截止已过' },
      reasons: '· 照片显示通道口整箱堆放 → 查「消防通道占用」\n· 原话提到「进货」 → 查「收货区堆放与离地」\n· 门店类型＝快餐档口、近期无同类问题 → 不查油炸区换油记录',
      unreadable: ['IMG-模糊-1'],
      findings: [
        {
          findingId: 'FND-20261002-001',
          itemName: '消防通道占用',
          severity: '高',
          confidence: '高',
          confidenceSource: 'model',
          reason: '通道口堆放整箱货物，通行宽度不足',
          suggestion: '30 分钟内清空通道并回拍照片',
          dueAt: '2026-10-02T20:30:00.000Z',
          status: 'pending_rectify',
          // 这条判断被退回过的痕迹（店长端整改要看的原文）
          rejectedAt: '2026-10-02T20:12:00.000Z',
          rejectedReason: '复看仍有油污，退回重做',
          boxes: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.25 }],
          fallbackPoint: { x: 0.55, y: 0.62, text: '通道口地面标识线处' },
          thumbUrl: '/api/gaia-inspection/photo?id=aaaaaaaaaaaaaaaa&kind=thumb',
          originalUrl: '/api/gaia-inspection/photo?id=aaaaaaaaaaaaaaaa&kind=original',
        },
        {
          findingId: 'FND-20261002-002',
          itemName: '收货区堆放与离地',
          severity: '中',
          confidence: null,
          confidenceSource: 'missing',
          reason: '纸箱直接落地，未见离地架',
          suggestion: '加离地架并回拍',
          dueAt: '2026-10-03T04:00:00.000Z',
          status: 'pending_rectify',
          boxes: [],
          fallbackPoint: { x: 0.4, y: 0.7, text: '后门内侧地面纸箱处' },
          thumbPath: 'thumbs/b.png',
          originalPath: 'photos/b.png',
        },
        {
          findingId: 'FND-20261002-003',
          itemName: '地面油污',
          severity: '低',
          reason: '地面反光疑似油渍',
          suggestion: '湿拖一遍',
          dueAt: '2026-10-03T04:00:00.000Z',
          status: 'pending_rectify',
          boxes: [],
          thumbPath: 'thumbs/c.png',
          originalPath: 'photos/c.png',
        },
      ],
      actions: [
        { id: 'ACT-9', type: '退回并说明', actionCode: 'review_reject', target: '消防通道占用', createdAt: '2026-10-02T20:12:00.000Z', reason: '复看仍有油污，退回重做', actor: '督导（演示视图）', actorName: '督导（演示视图）', actorIsHuman: true, result: '退回' },
        { id: 'ACT-9b', type: '催办', actionCode: 'review_remind', target: '示例门店·快餐档口甲·整改截止已过', createdAt: '2026-10-02T20:20:00.000Z', reason: '截止时间已过（系统自动催办）', actor: '系统', actorName: null, actorIsHuman: false, result: '已催办' },
      ],
    },
  ],
  counts: { 检查单: 1, 判断: 3, 证据: 3, 动作: 2, 待整改: 1, 逾期: 1, 已升级: 1 },
  offline: { offline: false, source: 'capture' },
  pendingQueue: { pending: 0, judged: 0, items: [] },
}
const EVIDENCE_BOX = {
  ok: true,
  data: {
    findingId: 'FND-20261002-001', inspectionId: 'INS-20261002-201530-ab12', storeId: 'S-001', itemName: '消防通道占用', severity: '高',
    reason: '通道口堆放整箱货物，通行宽度不足', suggestion: '30 分钟内清空通道并回拍照片', dueAt: '2026-10-02T20:30:00.000Z', status: 'pending_rectify',
    boxes: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.25 }], boxesUnit: 'ratio', hasBoxes: true, fallbackPoint: null,
    photo: { photoId: 'aaaaaaaaaaaaaaaa', originalUrl: '/api/gaia-inspection/photo?id=aaaaaaaaaaaaaaaa&kind=original', thumbUrl: '/api/gaia-inspection/photo?id=aaaaaaaaaaaaaaaa&kind=thumb', width: 640, height: 480 },
    unreadable: [], source: 'selfcheck',
  },
  summary: '消防通道占用（高）',
}
const EVIDENCE_POINT = {
  ok: true,
  data: {
    findingId: 'FND-20261002-003', inspectionId: 'INS-20261002-201530-ab12', storeId: 'S-001', itemName: '地面油污', severity: '低',
    reason: '地面反光疑似油渍', suggestion: '湿拖一遍', dueAt: '2026-10-03T04:00:00.000Z', status: 'pending_rectify',
    boxes: [], boxesUnit: 'ratio', hasBoxes: false, fallbackPoint: { x: 0.55, y: 0.62, unit: 'ratio', source: 'model', text: '通道口地面标识线处' }, photo: { originalUrl: '/api/gaia-inspection/photo?path=photos%2Fc.png', thumbUrl: '', width: 640, height: 480 }, unreadable: [],
  },
  summary: '地面油污（低）',
}
const MODEL_CALLS = {
  ok: true,
  count: 2,
  logFile: 'D:/dsh-home/gaia-inspection/db/model_calls.jsonl',
  calls: [
    { callId: 'MC-1', ts: '2026-10-02T20:05:20.000Z', provider: 'deepseek', model: 'deepseek-vl', kind: 'photo_judge', promptVersion: 'vision-judge-v2', inspectionId: 'INS-20261002-201530-ab12', storeId: 'S-001', latencyMs: 3210, usage: { inputTokens: 900, outputTokens: 220 }, status: 'ok', errorCode: null, requestSummary: '门店 示例门店·快餐档口甲（快餐档口）；照片 1 张；检查项 0 项；店长说明 23 字', responseSummary: '{"findings":[{"itemName":"消防通道占用","severity":"高","confidence":"高"}]}' },
    { callId: 'MC-2', ts: '2026-10-02T20:05:30.000Z', provider: 'deepseek', model: 'deepseek-chat', kind: 'checklist_generate', promptVersion: 'checklist-v1', inspectionId: 'INS-20261002-201530-ab12', storeId: 'S-001', latencyMs: 1500, usage: null, status: 'error', errorCode: 'MODEL_TIMEOUT', requestSummary: '门店 示例门店·快餐档口甲；本次采集 1 张照片', responseSummary: null },
  ],
}
const SCAN_RESULT = { ok: true, scanned: 3, markedOverdue: ['INS-20261002-201530-ab12'], actionsCreated: [{ id: 'ACT-3', type: 'escalate' }] }
const requests = []
let reviewActionOverride = null
globalThis.fetch = async (url, options) => {
  const path = String(url)
  const method = (options && options.method) || 'GET'
  requests.push({ path, method, body: options && options.body ? JSON.parse(options.body) : null })
  if (path.indexOf('/evidence') !== -1) {
    const wantPoint = path.indexOf('FND-20261002-003') !== -1
    return { ok: true, status: 200, json: async () => (wantPoint ? EVIDENCE_POINT : EVIDENCE_BOX) }
  }
  if (path.indexOf('/model-calls') !== -1) return { ok: true, status: 200, json: async () => MODEL_CALLS }
  if (path.indexOf('/scan') !== -1) return { ok: true, status: 200, json: async () => SCAN_RESULT }
  if (path.indexOf('/review') !== -1) {
    if (reviewActionOverride) {
      const failure = new Error('HTTP ' + (reviewActionOverride.__status || 200))
      failure.status = reviewActionOverride.__status || 200
      failure.payload = reviewActionOverride
      if (reviewActionOverride.__status && reviewActionOverride.__status !== 200) throw failure
      return { ok: true, status: 200, json: async () => reviewActionOverride }
    }
    const sent = options && options.body ? JSON.parse(options.body) : {}
    const actionCode = sent.action === '通过' ? 'review_approve' : sent.action === '退回并说明' ? 'review_reject' : 'review_remind'
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        runId: 'ACT-20261002-202000-zz99',
        status: 'completed',
        summary: '督导动作已记录：' + sent.action,
        data: { inspectionId: 'INS-20261002-201530-ab12', actionId: 'ACT-9', action: sent.action, inspectionStatus: sent.action === '通过' ? 'rectified' : 'pending_rectify', dueAt: '2026-10-03T04:00:00.000Z' },
        action: { id: 'ACT-9', type: sent.action, actionCode, target: 'INS-20261002-201530-ab12', createdAt: '2026-10-02T20:20:00.000Z', reason: sent.reason || null, actor: sent.operator, actorName: sent.operator, actorIsHuman: true, result: sent.action === '通过' ? '通过' : sent.action === '退回并说明' ? '退回' : '已催办' },
        artifacts: [],
        traceRef: 'action/ACT-9',
        error: null,
      }),
    }
  }
  return { ok: true, status: 200, json: async () => SNAPSHOT }
}

// ── ③ 加载 client 半并渲染 ─────────────────────────────────────────────────
const clientCode = readFileSync(join(root, clientRel), 'utf8')
let clientError = ''
try {
  ;(0, eval)(clientCode)
} catch (error) {
  clientError = String((error && error.message) || error)
}
check('client 半脚本可执行（不抛错）', !clientError, clientError)
const loaded = globalThis.__loaded
check('client 半注册了 bundle id', loaded && loaded.id === 'gaia-inspection-oversight-ui', loaded && loaded.id)

const bundle = loaded.factory((spec) => {
  if (spec === 'react') return ReactShim
  throw new Error('unexpected require: ' + spec)
})
const test = bundle.__test || {}
check('__test 可用', Boolean(test && test.normalizeSnapshot && test.recordAction), Object.keys(test || {}).join(','))

const slotSpecs = []
const tabTypes = []
const layoutCalls = []
const ctxForClient = {
  get: (key) => {
    if (key === 'slots') return { register: (spec, component) => { slotSpecs.push({ spec, component }); return () => {} }, inject: (name, fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} } }
    if (key === 'sidebarRightTabs') return { register: (def) => { tabTypes.push(def); return () => {} } }
    // 平台事实 §1.4：插件自切主区域走 ctx.layout.selectPanel(panelId)；测试里记下发出去的 id。
    if (key === 'layout') return { selectPanel: (id) => { layoutCalls.push(id) } }
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

// ── ④ 槽位 / 通道契约（指令 §1 + 契约 §1/§2）──────────────────────────────
const panellistSpec = slotSpecs.find((s) => s.spec.name === 'sidebar.panellist')
check(
  '左栏入口注册在 sidebar.panellist，id/order/label 逐字（gaia-inspection / 30 / 巡店自查）',
  Boolean(panellistSpec) && panellistSpec.spec.id === 'gaia-inspection' && panellistSpec.spec.order === 30 && panellistSpec.spec.label === '巡店自查',
  JSON.stringify(panellistSpec && panellistSpec.spec),
)
const mainSpec = slotSpecs.find((s) => s.spec.name === 'main')
check('主区域正文注册在 main，key=gaia-inspection（keyed 槽必须有 key）', Boolean(mainSpec) && mainSpec.spec.key === 'gaia-inspection', JSON.stringify(mainSpec && mainSpec.spec))
check('不占用 conversation 这个已存在的 key（不遮蔽官方会话）', slotSpecs.filter((s) => s.spec.name === 'main').every((s) => s.spec.key !== 'conversation'), '')
check('list id 与 main key 是同一个（Each list id addresses the matching main panel）', Boolean(panellistSpec && mainSpec) && panellistSpec.spec.id === mainSpec.spec.key, '')
// 2026-10-03 改判（用户反馈「界面只是嵌在 DSH 里的一个入口，我要的是全覆盖」）：
// 内核槽位契约（dsh-cordis-client-runner 里 shell.overlay 词条）原话是「要一个覆盖整个 app 的
// 自己的表层，就注册进 shell.overlay」—— 它是 list/root 槽，追加式，不替换任何已有条目，
// 宿主把它渲染在 absolute/inset:0/z-index:20 的浮层里。主界面因此改挂这里，main 只留「席位」。
const overlaySpec = slotSpecs.find((s) => s.spec.name === 'shell.overlay')
check(
  '整窗表层注册在 shell.overlay，id/order/label 逐字（gaia-inspection.app / 100 / 门店督导）',
  Boolean(overlaySpec) && overlaySpec.spec.id === 'gaia-inspection.app' && overlaySpec.spec.order === 100 && overlaySpec.spec.label === '门店督导',
  JSON.stringify(overlaySpec && overlaySpec.spec),
)
check('启动即进入：apply 期间就 selectPanel("gaia-inspection")（首屏不先落在 DSH 对话上）', layoutCalls.indexOf('gaia-inspection') !== -1, JSON.stringify(layoutCalls))
test.surfaceState.setSeat(false)
const dormant = renderAndText(overlaySpec.component, {})
check('整窗表层在「没进本面板」时不渲染任何东西（不抢会话首屏）', dormant.text === '', dormant.text.slice(0, 80))
const seatRender = renderAndText(mainSpec.component, {})
const winRender = renderAndText(overlaySpec.component, {})
check(
  '两个承载面互斥：整窗可用时 main 席位让位（不渲染界面），整窗表层渲染出真界面',
  !seatRender.text.includes('门店端') && winRender.text.includes('门店端'),
  JSON.stringify({ seat: seatRender.text.slice(0, 60), win: winRender.text.slice(0, 60) }),
)
check('不再占 conversation.input.dock（该槽由采集包登记「门店自查采集入口」）', !slotSpecs.some((s) => s.spec.name === 'conversation.input.dock'), '')
check('注册了模型调用日志独立 tab 类型', tabTypes.some((t) => t.kind === 'gaia-inspection-oversight-ui/logs'), JSON.stringify(tabTypes.map((t) => t.kind)))
check('注册了该 tab 的 keyed 正文（正文容器为 .giou-root）', slotSpecs.some((s) => s.spec.name === 'sidebar.right.pane.tab' && s.spec.key === 'gaia-inspection-oversight-ui/logs'), '')
const headerSlots = slotSpecs.filter((s) => s.spec.name === 'conversation.session.header.actions')
check('会话 header 三枚入口（看板 / 立即扫描 / 模型调用日志）', headerSlots.length === 3, JSON.stringify(headerSlots.map((s) => s.spec.id)))
const shellChannel = globalThis.__gaia_inspection_shell__
check('注册 main 之后发布 __gaia_inspection_shell__（version:1 + open() + subscribe()）', Boolean(shellChannel) && shellChannel.version === 1 && typeof shellChannel.open === 'function' && typeof shellChannel.subscribe === 'function', JSON.stringify(shellChannel && Object.keys(shellChannel)))

layoutCalls.length = 0
test.panelState.setEntered(false)
test.panelState.setView('logs')
shellChannel.open('board')
check('shell.open("board") = 进入外壳 + 切看板视图 + selectPanel("gaia-inspection")', test.panelState.entered === true && test.panelState.view === 'board' && layoutCalls.indexOf('gaia-inspection') !== -1, JSON.stringify({ entered: test.panelState.entered, view: test.panelState.view, layoutCalls }))
shellChannel.open('logs')
check('shell.open("logs") = 切日志视图', test.panelState.view === 'logs', test.panelState.view)
const offShell = shellChannel.subscribe(() => {})
check('shell.subscribe(listener) 返回退订函数', typeof offShell === 'function', typeof offShell)
offShell()
const iconNode = renderAndText(panellistSpec.component, {})
check('左栏入口渲染出图标（svg）', findAll(iconNode.tree, 'svg').length > 0, JSON.stringify(iconNode.text))

// ── ⑤ 外壳：首屏角色选择 → 两端 ─────────────────────────────────────────────
// 渲染断言统一走 test.InspectionApp（整窗表层与 main 兜底渲染的是同一棵树，surface 只是承载面标记）。
const appComponent = test.InspectionApp
roleValue = 'supervisor'
test.panelState.setEntered(false)
test.panelState.setView('board')
const first = renderAndText(appComponent, {})
check('外壳首屏是角色选择（不是看板 / 日志正文）', first.text.includes('门店端') && first.text.includes('总部督导端') && first.text.indexOf('（本次动态决定）') === -1 && byClass(first.tree, 'giou-blist').length === 0, first.text.slice(0, 160))
check('首屏两块文案逐字（定稿 10-03 14:45 §4：标题 / 职责说明 / 底部提示 / 全局演示替身）', first.text.includes('交接班时拍一张照片，再写一句话。Agent 看完照片与这句话，当场决定该查哪几项。') && first.text.includes('3 分钟内可提交完') && first.text.includes('先看『为什么查这几项』，再看判断与依据。有坐标就框选原图，没坐标就标点并说明。') && first.text.includes('逾期自动升级') && first.text.includes('演示替身：真实场景中门店在手机上提交，本面板为演示视图。'), '')
check('首屏＝斜线分屏（.giou-root / .giou-splitwrap / 两块 .giou-split / 中央 .giou-knob），不再是两张错位卡', byClass(first.tree, 'giou-root').length === 1 && byClass(first.tree, 'giou-splitwrap').length === 1 && byClass(first.tree, 'giou-split').length === 2 && byClass(first.tree, 'giou-knob').length === 1, '')
check('首屏两块**整块可点**：两块都是 button（不是只有卡片里的按钮可点）', byClass(first.tree, 'giou-split').every((n) => n.tag === 'button'), '')
check('首屏**不再套左栏/顶栏**（圆钮要骑在整屏中点才成立；也是"完全去掉 DSH 面板"的落地）', byClass(first.tree, 'giou-nav').length === 0 && byClass(first.tree, 'giou-top').length === 0, '')
check('中央圆钮＝模型调用日志入口（内是内联 SVG，不是 emoji）', byClass(first.tree, 'giou-knob').length === 1 && byClass(first.tree, 'giou-knob')[0].children.some((c) => c && c.tag === 'svg'), '')

// 斜线分屏的两块：按类名取（`byLabel` 只看一层 children，块内文案在嵌套 div 里，取不到）
const splitHalf = (tree, role) => byClass(tree, 'giou-split').find((n) => String(n.props && n.props.className).indexOf(role) !== -1)
check('首屏两块按角色分（manager 块在上、supervisor 块在下，两块都能取到）', Boolean(splitHalf(first.tree, 'manager')) && Boolean(splitHalf(first.tree, 'supervisor')), '')

splitHalf(first.tree, 'supervisor').props.onClick()
await sleep(10)
let shell = step(appComponent, {})
await sleep(10)
shell = step(appComponent, {})
let boardText = shell.text
// 10-03 客户裁定：待复核与「已退回」按"有没有被退回过"**互斥**分档（"退回和未办放一起了"）。
// 这条夹具 returnedAt 非空 → 它**不该**再出现在默认的「待复核」档里。先断言分档，
// 再切到「已退回」档跑后面所有详情断言（详情内容与旧断言逐字一致）。
check('默认「待复核」档不再混入被退回的单（客户裁定：退回的和没办结的不许混一档）',
  byClass(shell.tree, 'giou-item').length === 0 && hasFilter(shell.tree, '已退回'), 'list=' + byClass(shell.tree, 'giou-item').length)
clickFilter(shell.tree, '已退回')
await sleep(10)
shell = step(appComponent, {})
boardText = shell.text
check('「已退回」档收下被退回的单（1 条，详情正文照旧）', byClass(shell.tree, 'giou-item').length === 1 && boardText.includes('为什么查这几项'), boardText.slice(0, 120))
check('点「进入督导端」→ 进督导端界面（role=supervisor + 屏 B 正文）', roleValue === 'supervisor' && boardText.includes('为什么查这几项'), boardText.slice(0, 120))
check('顶部一行含屏标题与副标题 + 角色视图切换 + 模型调用日志面板 + 切换角色', boardText.includes('巡店判断回放看板') && boardText.includes('角色视图切换') && boardText.includes('模型调用日志面板') && boardText.includes('切换角色'), '')
check('统计与动作在 InspectionApp 顶部（A3：累计/待你判断/逾期/已办结 四枚 chip，不再出现"今日"）', boardText.includes('累计 1 条') && boardText.includes('待你判断 1 条') && boardText.includes('逾期 1 条') && boardText.includes('已办结 0 条') && boardText.includes('立即扫描按钮') && boardText.indexOf('今日') === -1, boardText.slice(0, 400))
// 教练级审查会挑这类"看着像数字其实写死"的地方：旧实现是 `badgeFinding ? '1' : '0'`，
// 而一次提交实际是 checklist_generate + vision_judge 两次调用。现在数字必须来自后端的 modelCallCount。
check('详情里的「模型调用 N 次」用后端真实计数（快照给 2 就显示 2，不再写死 1）', boardText.includes('模型调用 2 次'), boardText.slice(0, 400))
// 退回闭环（用户实测反馈："点完退回并说明，看不到退到哪去了"）：
// ① 详情头要有醒目的「已退回·待整改」；② 退回原因要上屏；③ 动作记录要挪到详情**上半区**
// （改前在整列最底部，判断项一多就得滚很久）；④ 被退回的判断项按钮要变「重新退回并说明」。
check('被退回的检查单在详情里标「已退回·待整改」+ 退回次数', boardText.includes('已退回·待整改') && boardText.includes('共退回 2 次'), boardText.slice(0, 400))
check('退回原因上屏（督导端一眼看到退的是什么原因）', boardText.includes('复看仍有油污，退回重做'), '')
check('动作记录挪到详情上半区（出现在「为什么查这几项（本次动态决定）」之前，不必滚到底部）', boardText.indexOf('动作记录') !== -1 && boardText.indexOf('动作记录') < boardText.indexOf('为什么查这几项（本次动态决定）'), 'idx=' + boardText.indexOf('动作记录') + '/' + boardText.indexOf('为什么查这几项（本次动态决定）'))
// ④ 被退回的判断项：显示退回痕迹；按 10-03 的状态矩阵（通过/打回互斥）**只能催办** ——
//    通过、退回都停用（改前这里给的是可点的「重新退回并说明」，与"打回后还能再点通过"是一对反向缺口）。
check('被退回的判断项显示退回痕迹，且**只能催办**（通过/退回都停用）', (() => {
  if (!boardText.includes('本项已退回')) return false
  const bars = byClass(shell.tree, 'giou-actions')
  const card = bars.filter((bar) => findAll(bar, 'button').some((n) => textOfTree(n).endsWith('已退回') || textOfTree(n).endsWith('退回并说明')))[0]
  if (!card) return false
  const btns = findAll(card, 'button').map((n) => ({ t: textOfTree(n).slice(-6), dis: n.props.disabled }))
  const approve = btns.filter((b) => b.t.endsWith('通过'))[0]
  const reject = btns.filter((b) => b.t.endsWith('已退回') || b.t.endsWith('退回并说明'))[0]
  const remind = btns.filter((b) => b.t.endsWith('催办'))[0]
  return Boolean(approve) && approve.dis === true && Boolean(reject) && reject.dis === true && Boolean(remind) && remind.dis !== true
})(), JSON.stringify(byClass(shell.tree, 'giou-actions').map((bar) => findAll(bar, 'button').map((n) => textOfTree(n).slice(-6) + ':' + n.props.disabled))))
// A-5：退回横幅必须认「退回那一条动作」，不能认"最近一条动作"（后者可能是系统的催办/升级）
{
  const clock = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return p(d.getHours()) + ':' + p(d.getMinutes()) }
  const rejectClock = clock('2026-10-02T20:12:00.000Z')
  const systemClock = clock('2026-10-02T20:20:00.000Z')
  check('A5 退回横幅写明是人工退回 + 时间取「退回那条」（不是系统催办那条）', boardText.includes('由 督导（演示视图）（人工）') && boardText.includes('已退回 · 待整改：' + rejectClock) && !boardText.includes('已退回 · 待整改：' + systemClock), boardText.slice(boardText.indexOf('已退回 · 待整改'), boardText.indexOf('已退回 · 待整改') + 140))
}
check('A5 退回原因取退回那条（不是系统催办的原因）', boardText.includes('退回原因：「复看仍有油污，退回重做」') && boardText.indexOf('退回原因：「截止时间已过（系统自动催办）」') === -1, '')
check('A5 动作记录的操作者列写真实主体（系统动作标「系统（系统自动）」，不再拿 target 冒充操作者）', boardText.includes('系统（系统自动）') && boardText.includes('对象：示例门店·快餐档口甲·整改截止已过'), boardText.slice(boardText.indexOf('动作记录'), boardText.indexOf('动作记录') + 220))
{
  const ins = test.normalizeSnapshot(SNAPSHOT).inspections[0]
  const rej = test.lastRejectOf(ins)
  check('A5 lastRejectOf 从动作列表里挑出退回那条（不是 lastAction）', Boolean(rej) && rej.id === 'ACT-9' && rej.reason === '复看仍有油污，退回重做', JSON.stringify(rej && { id: rej.id, type: rej.type }))
  check('A5 actorLabelOf 区分人工与系统自动', test.actorLabelOf(rej) === '督导（演示视图）（人工）' && test.actorLabelOf(ins.actions[1]) === '系统（系统自动）' && test.actorLabelOf(null) === '', test.actorLabelOf(rej) + ' / ' + test.actorLabelOf(ins.actions[1]))
}
// 切回「待复核」档：下面的整改回拍夹具**不是**退回单，归「待复核」（垫片的档位跨重挂存活，必须成对切）。
clickFilter(shell.tree, '待复核')
await sleep(10)
shell = step(appComponent, {})
boardText = shell.text
// 「整改回拍」来的单要能看出来源（后端快照给 reworkOf）。
// 注意顺序：组件挂载会触发一次 pullSnapshot（异步），先等它落地再设夹具，否则夹具会被默认快照覆盖。
{
  const reworkSnapshot = JSON.parse(JSON.stringify(SNAPSHOT))
  reworkSnapshot.inspections[0].reworkOf = 'INS-20261002-190000-zz99'
  reworkSnapshot.inspections[0].returnedAt = null
  reworkSnapshot.inspections[0].lastAction = null
  await sleep(20)
  test.snapshotSource.data = test.normalizeSnapshot(reworkSnapshot)
  test.snapshotSource.failure = ''
  test.snapshotSource.notify()
  const reworkText = renderAndText(appComponent, {}).text
  check('整改回拍单标出「整改回拍自 #zz99」（退回→整改→复交这条链看得见）', reworkText.includes('整改回拍自 #zz99'), reworkText.slice(reworkText.indexOf('提交 #'), reworkText.indexOf('提交 #') + 120))
  await test.pullSnapshot()
  await sleep(10)
}
// 逾期档「责任方」两标（客户 10-03 裁定）：已退回 → 等门店整改；从未退回 → 待你复核。
{
  const mk = (over) => ({ status: 'overdue', overdue: true, escalated: false, returnedAt: null, ...over })
  const labels = (x) => test.statusChipsOf(x).map((c) => c.label)
  check('逾期档责任方：已退回 →「等门店整改」', labels(mk({ returnedAt: '2026-10-03T02:11:00.000Z' })).indexOf('等门店整改') !== -1, JSON.stringify(labels(mk({ returnedAt: 'x' }))))
  check('逾期档责任方：从未退回 →「待你复核」', labels(mk({})).indexOf('待你复核') !== -1, JSON.stringify(labels(mk({}))))
  check('没过期的普通单不挂责任方标（不污染其它档）', labels({ status: 'pending_rectify', overdue: false, escalated: false, returnedAt: null }).every((l) => l !== '等门店整改' && l !== '待你复核'), JSON.stringify(labels({ status: 'pending_rectify', overdue: false, escalated: false, returnedAt: null })))
}

// ① 原单「回执」（客户 10-03：打回去之后督导看不到动静）——用快照里已有的 reworkOf 反查，不加后端字段。
{
  const base = JSON.parse(JSON.stringify(SNAPSHOT))
  const original = base.inspections[0]
  const child = JSON.parse(JSON.stringify(original))
  child.id = 'INS-20261003-160000-rework'
  child.reworkOf = original.id
  child.status = 'pending_rectify'
  child.rejectedAt = null
  child.returnedAt = null
  child.lastAction = null
  await sleep(20)
  // 订单口径（客户 10-03 裁定）：原单 + 回拍单 = **一个订单**，最新一轮（回拍轮）在督导手上 → 这一档是「待复核」。
  // 情形一：两次提交 → 左栏一行、右栏给「上级栏 + 两轮」，点第 1 轮才看原单那条回执行。
  test.snapshotSource.data = test.normalizeSnapshot({ ...base, inspections: [original, child] })
  test.snapshotSource.failure = ''
  test.snapshotSource.notify()
  const twoRounds = renderAndText(appComponent, {})
  check('订单口径：两次提交合成**一行**（左栏 1 行，不是 2 行）', byClass(twoRounds.tree, 'giou-item').length === 1, 'items=' + byClass(twoRounds.tree, 'giou-item').length)
  check('右栏出现「上级栏」：订单 #ab12 · 共 2 轮 · 首交/最新第 2 轮', byClass(twoRounds.tree, 'giou-order').length === 1 && twoRounds.text.includes('订单 #ab12') && twoRounds.text.includes('共 2 轮') && twoRounds.text.includes('最新第 2 轮'), twoRounds.text.slice(0, 260))
  check('轮次列表两行：第 1 轮 #ab12「原始提交」/ 第 2 轮 #rework「回拍自 #ab12」', byClass(twoRounds.tree, 'giou-round').length === 2 && twoRounds.text.includes('第 1 轮') && twoRounds.text.includes('第 2 轮') && twoRounds.text.includes('原始提交') && twoRounds.text.includes('回拍自 #ab12'), twoRounds.text.slice(twoRounds.text.indexOf('第 1 轮'), twoRounds.text.indexOf('第 1 轮') + 120))
  check('默认落在**最新一轮**（不是原单）：详情标题是「本轮提交 #rework」+ 标「整改回拍自 #ab12」', twoRounds.text.includes('本轮提交 #rework') && twoRounds.text.includes('整改回拍自 #ab12'), twoRounds.text.slice(0, 200))
  // 情形一（续）：点「第 1 轮」→ 看到原单的回执行
  clickRound(twoRounds.tree, 1)
  const withChild = step(appComponent, {}).text
  const idx = withChild.indexOf('整改回拍：')
  check('① 原单回执：切到第 1 轮 → 已有回拍单写明「已回拍 #新单（状态）」', idx !== -1 && withChild.slice(idx, idx + 60).includes('已回拍') && withChild.slice(idx, idx + 80).includes('#rework'), withChild.slice(idx, idx + 90))
  check('切轮次真的换内容（第 1 轮详情不再说"本轮提交 #rework"）', withChild.includes('本轮提交 #ab12') && withChild.indexOf('本轮提交 #rework') === -1, withChild.slice(0, 120))
  // 情形二：只留下原单（没有回拍单）→ 这一单回到「已退回」档，回执行写"还没回拍 + 已超期"
  test.snapshotSource.data = test.normalizeSnapshot({ ...base, inspections: [original] })
  test.snapshotSource.notify()
  clickFilter(renderAndText(appComponent, {}).tree, '已退回')
  const noChild = step(appComponent, {}).text
  const idx2 = noChild.indexOf('整改回拍：')
  check('① 原单回执：还没回拍 → 写明已超期多久（不静默、不留空）', idx2 !== -1 && noChild.slice(idx2, idx2 + 60).includes('还没有回拍单') && noChild.slice(idx2, idx2 + 80).includes('已超期'), noChild.slice(idx2, idx2 + 90))
  check('单轮订单**不渲染**上级栏/轮次列表（老界面逐字不变，不给常态加噪音）', byClass(step(appComponent, {}).tree, 'giou-order').length === 0 && byClass(step(appComponent, {}).tree, 'giou-round').length === 0, '')
  await test.pullSnapshot()
  await sleep(10)
}
// ── 老轮 vs 最新轮（客户 10-03 抓到：「办结是工单完成的标志，办结之后再开一轮是反逻辑的」）────
// 夹具＝真机 #1xek 那个形状：第 1 轮被督导逐项点通过（rectified）、门店随后回拍的第 2 轮还挂着待复核。
{
  const base = JSON.parse(JSON.stringify(SNAPSHOT))
  const round1 = base.inspections[0]
  round1.status = 'rectified'
  round1.overdue = false
  round1.escalated = false
  const round2 = JSON.parse(JSON.stringify(round1))
  round2.id = 'INS-20261003-122007-f19f'
  round2.reworkOf = round1.id
  round2.status = 'pending_rectify'
  round2.returnedAt = null
  round2.rejectedAt = null
  round2.lastAction = null
  const s = test.statsOf({ ok: true, inspections: [round1, round2] })
  check('统计不受"老轮已办结"影响：最新一轮待复核 → 整单算待你判断（不是已办结）', s.pending === 1 && s.done === 0 && s.total === 1, JSON.stringify(s))
  await sleep(20)
  test.snapshotSource.data = test.normalizeSnapshot({ ...base, inspections: [round1, round2] })
  test.snapshotSource.failure = ''
  test.snapshotSource.notify()
  clickFilter(renderAndText(appComponent, {}).tree, '待复核')
  const t = renderAndText(appComponent, {})
  const roundTexts = byClass(t.tree, 'giou-round').map((n) => textOfTree(n))
  check('中间轮的「rectified」不许写「已办结」，改说「本轮已通过」（办结是订单级结论）', roundTexts.length === 2 && roundTexts[0].indexOf('本轮已通过') !== -1 && roundTexts[0].indexOf('已办结') === -1, JSON.stringify(roundTexts))
  check('订单级「已办结」不出现（最新一轮还待复核；筛选栏那个「已办结」档按钮不算）', (() => {
    const scope = byClass(t.tree, 'giou-order').map((n) => textOfTree(n)).join(' ') + ' ' + roundTexts.join(' ')
    return scope.indexOf('订单 #ab12') !== -1 && scope.indexOf('已办结') === -1
  })(), JSON.stringify(roundTexts))
  check('默认/最新一轮：动作可用（通过/退回并说明/催办都不是灰的）', (() => {
    clickRound(t.tree, 2)
    let cur = step(appComponent, {})
    if (cur.text.indexOf('本轮提交 #f19f') === -1) {
      // 垫片的 useState 跨重挂存活，上一次点过的轮次可能又落回来 → 再点一次
      clickRound(cur.tree, 2)
      cur = step(appComponent, {})
    }
    const btns = []
    for (const bar of byClass(cur.tree, 'giou-actions')) for (const b of findAll(bar, 'button')) btns.push(b)
    // 注意：本轮夹具的"最新一轮"= #f19f（0 条判断项）→ 它的卡里没有三枚动作按钮，
    // 所以这里只断言"没被 locked 停用"（老轮才有 locked 的 title）。
    return cur.text.indexOf('本轮提交 #f19f') !== -1 && btns.every((n) => String(n.props.title || '').indexOf('已经被第') === -1)
  })(), JSON.stringify(findAll(t.tree, 'button').map((n) => textOfTree(n)).slice(-9)))
  // 切到第 1 轮（被取代的老轮）→ 说明行 + 动作全部停用
  clickRound(t.tree, 1)
  const old = step(appComponent, {})
  check('点老轮 → 详情写明「已被第 2 轮取代」并指路最新那一轮', old.text.indexOf('这一轮已经被第 2 轮取代') !== -1, old.text.slice(old.text.indexOf('这一轮已经被'), old.text.indexOf('这一轮已经被') + 90))
  check('老轮的动作全部停用（不再能把被取代的轮次点办结）', (() => {
    // 只看判断卡的动作行（页面其它按钮的 title 里也有"通过"这种字）
    const btns = []
    for (const bar of byClass(old.tree, 'giou-actions')) for (const b of findAll(bar, 'button')) btns.push(b)
    return btns.length >= 3 && btns.every((n) => n.props.disabled === true)
  })(), JSON.stringify(byClass(old.tree, 'giou-actions').map((bar) => findAll(bar, 'button').map((n) => textOfTree(n).slice(-8) + ':' + n.props.disabled))))
}

// ── 已通过的项 = 本项办结：**三个动作全停用**（客户 10-03："已办结、也就是通过的项目，还能重新打回"）──
// 夹具：单轮订单 + 两条判断项，一条已通过、一条没过 → 已通过那张卡三个按钮全灰（含"退回并说明/催办"），
// 没过那张卡照常可点（不能因为一项过了就把整单锁死）。
{
  const base = JSON.parse(JSON.stringify(SNAPSHOT))
  const ins = base.inspections[0]
  ins.returnedAt = null
  ins.overdue = false
  ins.escalated = false
  ins.status = 'pending_rectify'
  const f1 = ins.findings[0]
  // f1 要当"未处置"那一项：夹具里的 rejectedAt 必须清掉（10-03 矩阵：已打回的项只能催办，
  // 留着它就会把 通过/退回 也一并禁用，测不到"照常可点"）
  f1.rejectedAt = null
  f1.rejectedReason = null
  f1.status = 'pending_rectify'
  const f2 = JSON.parse(JSON.stringify(f1))
  f2.findingId = 'FND-PASSED-2'
  f2.itemName = '台面与设备'
  f2.status = 'rectified'
  ins.findings = [f1, f2]
  await sleep(20)
  test.snapshotSource.data = test.normalizeSnapshot({ ...base, inspections: [ins] })
  test.snapshotSource.failure = ''
  test.snapshotSource.notify()
  clickFilter(renderAndText(appComponent, {}).tree, '待复核')
  const t = renderAndText(appComponent, {})
  const cards = byClass(t.tree, 'giou-actions')
  const perCard = cards.map((bar) => findAll(bar, 'button').map((n) => ({ t: textOfTree(n).slice(-8), dis: n.props.disabled })))
  check('已通过的那一项：通过 / 退回并说明 / 催办 **三个全灰**（不能把办结的项重新打开）',
    perCard.length === 2 && perCard[1].length === 3 && perCard[1].every((x) => x.dis === true) && t.text.indexOf('本项已通过') !== -1,
    JSON.stringify(perCard))
  check('没过的那一项照常可点（不因为另一项过了就把整单锁死）',
    perCard[0].length === 3 && perCard[0].every((x) => x.dis !== true),
    JSON.stringify(perCard[0]))
  await test.pullSnapshot()
  await sleep(10)
}
// 屏 B 正文 / 证据区那几组看的又是 SNAPSHOT 那张**退回单** → 把夹具与档位都切回来（并重新取 shell/boardText）。
test.snapshotSource.data = test.normalizeSnapshot(SNAPSHOT)
test.snapshotSource.failure = ''
test.snapshotSource.notify()
clickFilter(renderAndText(appComponent, {}).tree, '已退回')
shell = step(appComponent, {})
boardText = shell.text
check('**BoardView 自己那行统计/动作 topbar 已删掉**（.giou-stats 不出现、正文里没有「收起面板」）', byClass(shell.tree, 'giou-stats').length === 0 && byLabel(shell.tree, 'button', '收起面板') === undefined, '')

// 两端另一端：点「门店端」那块 → 外壳内嵌采集包屏（采集包只渲染店长端屏主体，屏标题由外壳给）
test.panelState.setEntered(false)
const rolesAgain = step(appComponent, {})
check('能回到首屏角色选择（面板关闭再打开状态可复现）', Boolean(splitHalf(rolesAgain.tree, 'manager')), rolesAgain.text.slice(0, 80))
splitHalf(rolesAgain.tree, 'manager').props.onClick()
await sleep(10)
const managerView = step(appComponent, {})
check('点「门店端」→ role=manager + 内嵌采集包屏 + 屏标题用能力词「门店自查采集入口」', roleValue === 'manager' && managerView.text.includes('店长端屏（采集包占位）') && managerView.text.includes('门店自查采集入口'), managerView.text.slice(0, 200))
check('店长端视图下不渲染督导端看板正文', managerView.text.indexOf('（本次动态决定）') === -1 && byClass(managerView.tree, 'giou-blist').length === 0, '')
// 回到督导端，继续后面屏 B / 日志的断言
roleValue = 'supervisor'
test.panelState.setEntered(true)
test.panelState.setView('board')
step(appComponent, {})

// ── ⑥ 屏 B 正文（新类 + 逐字文案）──────────────────────────────────────────
check('屏 B 容器换成 .giou-b + .giou-blist + .giou-bdetail（旧 .giou-body/.giou-left/.giou-right 已无）', byClass(shell.tree, 'giou-b').length === 1 && byClass(shell.tree, 'giou-blist').length === 1 && byClass(shell.tree, 'giou-bdetail').length === 1 && byClass(shell.tree, 'giou-body').length === 0 && byClass(shell.tree, 'giou-left').length === 0 && byClass(shell.tree, 'giou-right').length === 0, '')
check('左栏 .giou-filters + .giou-list，筛选五档 待复核·已退回·逾期·已办结·全部（每档带命中条数）', byClass(shell.tree, 'giou-filters').length === 1 && byClass(shell.tree, 'giou-list').length === 1 && boardText.includes('待复核') && boardText.includes('已退回') && boardText.includes('逾期') && boardText.includes('已办结') && boardText.includes('全部') && byClass(shell.tree, 'giou-filter-n').length === 5, '')
check('列表项用 .giou-item + .giou-thumb + .giou-item-id(.giou-num) + .giou-item-meta + .giou-item-chips', byClass(shell.tree, 'giou-item').length === 1 && byClass(shell.tree, 'giou-thumb').length === 1 && byClass(shell.tree, 'giou-item-id').length === 1 && byClass(shell.tree, 'giou-item-id')[0].props.className.indexOf('giou-num') !== -1 && byClass(shell.tree, 'giou-item-meta').length >= 2 && byClass(shell.tree, 'giou-item-chips').length === 1, '')
check('列表项编号是 #ab12 形式、门店名与时间在 .giou-item-meta', boardText.includes('#ab12') && boardText.includes('示例门店·快餐档口甲') && /\d{2}:\d{2}/.test(boardText), boardText.slice(0, 240))
check('逾期项 data-overdue=1 且状态/逾期/已升级改用独立 .giou-chip（不再拼「#ab12 · 待复核 · 已升级」）', findAll(shell.tree, 'button').some((n) => n.props && n.props['data-overdue'] === '1') && boardText.includes('已升级') && boardText.indexOf('#ab12 · ') === -1 && boardText.includes('逾期'), '')
check('详情含门店原话引述', boardText.includes('门店原话：「接班时拍的，后门那堆货还没清，上一个班次留下的」'), '')
check('详情有「为什么查这几项（本次动态决定）」视觉主角块（.giou-why + .h 用标题字号）', boardText.includes('为什么查这几项（本次动态决定）') && boardText.includes('查「消防通道占用」') && boardText.includes('不查油炸区换油记录') && byClass(shell.tree, 'giou-why').length === 1, '')
check('逐项判断卡含项名 / 判断 / 依据 / 回看原图 / 整改要求与截止', boardText.includes('消防通道占用') && boardText.includes('回看原图') && boardText.includes('判断') && boardText.includes('依据') && boardText.includes('整改要求') && boardText.includes('截止'), '')
// A-1.3：模型给的坐标有三种情况，界面都必须说清楚（给框 / 只给落点 / 都没有），不许静默不画
check('A-1.3 坐标三种情况都说清楚（给框 1 处 / 只给落点 / 没有可回指的坐标）', boardText.includes('模型给了 1 处区域框') && boardText.includes('只给了落点') && boardText.includes('没有可回指的坐标'), '')
check('A-1.3 没有坐标时如实说明"绝不画空框"（不假装有标记）', boardText.includes('绝不画空框'), '')
check('置信度用文字（高/中/低/未标注）+ .giou-chip[data-tone]，不用百分比', boardText.includes('置信度 高') && boardText.includes('置信度 未标注') && boardText.indexOf('%') === -1, boardText.slice(0, 200))
check('动作行逐字 通过 / 退回并说明 / 催办', boardText.includes('通过') && boardText.includes('退回并说明') && boardText.includes('催办'), '')
check('A4 材料不可判读的下一步写清楚了（决定是否让店长重拍）', boardText.includes('看不清的照片 1 张') && boardText.includes('决定是否让店长重拍'), boardText.slice(0, 400))
check('详情含动作记录（时间 · 操作者 · 结果）与时间线（催办 / 升级）', boardText.includes('动作记录（时间 · 操作者 · 结果）') && boardText.includes('升级') && byClass(shell.tree, 'giou-timeline').length === 1, '')

// 证据：有坐标 → 画框 + 框心标点（元素数依赖 onLoad 后的尺寸；纯函数另测降级口径）
const cardTree = renderAndText(appComponent, {})
byLabel(cardTree.tree, 'button', '回看原图').props.onClick()
await sleep(10)
const withBox = renderAndText(appComponent, {})
check('证据区标题用能力词「证据挂图卡片」（本区第一次可见时展示）', withBox.text.includes('证据挂图卡片'), '')
check('证据区用新类 .giou-photos / .giou-shot / .giou-basis / .giou-field', byClass(withBox.tree, 'giou-photos').length > 0 && byClass(withBox.tree, 'giou-shot').length > 0 && byClass(withBox.tree, 'giou-basis').length > 0 && byClass(withBox.tree, 'giou-field').length > 0, '')
check('有坐标：说明「已在原图上框出 1 处证据区域」+ 原图就位', withBox.text.includes('已在原图上框出 1 处证据区域') && findAll(withBox.tree, 'img').length > 0, withBox.text.slice(0, 240))
check('未拿到图片尺寸时不画空框（frame/mark 元素数 = 0，等 onLoad 后才标）', byClass(withBox.tree, 'giou-frame').length === 0 && byClass(withBox.tree, 'giou-mark').length === 0, '')
check('证据依据文字与整改要求同屏', withBox.text.includes('通道口堆放整箱货物') && withBox.text.includes('30 分钟内清空通道并回拍照片'), '')

// 证据三态
const normalized = test.normalizeSnapshot(SNAPSHOT)
const firstFinding = normalized.inspections[0].findings[0]
test.evidenceState.byId[firstFinding.findingId] = { phase: 'loading', data: null, summary: '', error: '' }
const evLoading = renderAndText(appComponent, {})
check('证据三态①加载中：骨架 .giou-skel +「正在回查原图…」', evLoading.text.includes('正在回查原图') && byClass(evLoading.tree, 'giou-skel').length > 0, '')
test.evidenceState.byId[firstFinding.findingId] = { phase: 'error', data: null, summary: '', error: '证据接口不可用：HTTP 500' }
const evFail = renderAndText(appComponent, {})
check('证据三态③失败：原因上屏 + 重试按钮', evFail.text.includes('证据接口不可用：HTTP 500') && Boolean(byLabel(evFail.tree, 'button', '重试')), '')
test.evidenceState.byId[firstFinding.findingId] = { phase: 'miss', data: null, summary: '未找到该证据', error: '' }
const evMiss = renderAndText(appComponent, {})
check('证据三态②空：居中提示 +「没有可回查的证据记录」+ 重试按钮', evMiss.text.includes('未找到该证据') && evMiss.text.includes('没有可回查的证据记录') && Boolean(byLabel(evMiss.tree, 'button', '重试')), '')
test.evidenceState.byId[firstFinding.findingId] = { phase: 'hit', data: { ...EVIDENCE_BOX.data, unreadable: ['IMG-模糊-1'] }, summary: EVIDENCE_BOX.summary, error: '' }
const evUnreadable = renderAndText(appComponent, {})
check('证据区如实标注「看不清」（未据此下结论，不假装有框）', evUnreadable.text.includes('看不清的照片 1 张：未据此下结论（模型侧已标「看不清」）。'), '')
test.evidenceState.byId[firstFinding.findingId] = { phase: 'hit', data: EVIDENCE_BOX.data, summary: EVIDENCE_BOX.summary, error: '' }

// ── ⑦ 日志面板（右栏 tab 正文；同一容器规格 + 三态）────────────────────────
const logsBody = slotSpecs.find((s) => s.spec.name === 'sidebar.right.pane.tab').component
const logsOuter = renderAndText(logsBody, {})
check('日志 tab 正文容器换成新的 .giou-root 包裹（旧 .giou-panel 已删）', byClass(logsOuter.tree, 'giou-root').length === 1 && byClass(logsOuter.tree, 'giou-panel').length === 0, '')
await sleep(10)
const logsRendered = step(logsBody, {})
const logsText = logsRendered.text
check('日志容器 .giou-logs + .giou-logbar + .giou-tablewrap + .giou-table', byClass(logsRendered.tree, 'giou-logs').length === 1 && byClass(logsRendered.tree, 'giou-logbar').length === 1 && byClass(logsRendered.tree, 'giou-tablewrap').length === 1 && byClass(logsRendered.tree, 'giou-table').length === 1, '')
check('日志 tab 渲染不抛错且带能力词', logsText.includes('模型调用日志面板'), logsText.slice(0, 160))
const headers = findAll(logsRendered.tree, 'th').map((th) => vnodeText(th))
const needColumns = ['时间', '模型', '提示词版本', '提交编号', '请求摘要', '响应摘要', '耗时']
check('日志 7 列逐字（时间/模型/提示词版本/提交编号/请求摘要/响应摘要/耗时）', needColumns.every((col) => headers.indexOf(col) !== -1), JSON.stringify(headers))
check('日志行含 model 与耗时', logsText.includes('deepseek-vl') && logsText.includes('3.21s'), '')
check('编号列 / 耗时列用 .mono + .giou-num（tabular-nums）', byClass(logsRendered.tree, 'mono').every((n) => n.props.className.indexOf('giou-num') !== -1) && byClass(logsRendered.tree, 'mono').length === 6, String(byClass(logsRendered.tree, 'mono').length))
check('日志按 be 就绪字段展示提示词版本（vision-judge-v2 / checklist-v1，不再退成「类型」）', logsText.includes('vision-judge-v2') && logsText.includes('checklist-v1'), logsText.slice(0, 260))
check('请求/响应摘要按后端字段展示（提示词版本/请求摘要/响应摘要都不再显示 —）', logsText.includes('照片 1 张') && logsText.includes('消防通道占用'), logsText.slice(0, 300))
const missingWarned = logsText.indexOf(test.LOGS_MISSING_TEXT) !== -1
check('失败调用 responseSummary=null 属正常空值：不误报「后端真缺字段」', missingWarned === false, 'missingWarned=' + String(missingWarned))
check('日志脱敏说明按固定文案渲染（.giou-mask-note，不展示凭据类字段）', logsText.includes(test.LOGS_MASKING_TEXT) && byClass(logsRendered.tree, 'giou-mask-note').length === 1, '')
check('日志 DOM 里不出现凭据字段名（apiKey / authorization / sk-）', (() => {
  const dump = []
  const walk = (n) => {
    if (!n) return
    if (n.props) {
      for (const key of Object.keys(n.props)) dump.push(key)
      dump.push(vnodeText(n))
    }
    if (n.children) for (const child of n.children) walk(child)
    if (n.rendered) walk(n.rendered)
  }
  walk(logsRendered.tree)
  const text = dump.join(' ')
  return !/apiKey|authorization|bearer|sk-[A-Za-z0-9]/i.test(text)
})(), '')
const callNorm = test.normalizeCall({ callId: 'X', model: 'm', apiKey: 'sk-secret', authorization: 'Bearer x', requestSummary: '业务摘要' })
check('normalizeCall 丢弃 apiKey / authorization 字段（不读取、不透传）', callNorm.apiKey === undefined && callNorm.authorization === undefined && callNorm.requestSummary === '业务摘要', JSON.stringify(callNorm))
const emptyLogs = test.normalizeCall(null)
check('normalizeCall 对空行返回 null（不造记录）', emptyLogs === null, String(emptyLogs))

// 日志三态：加载中 / 空（逐字「暂无调用记录」）/ 失败（原因 + 重试）
function setLogsSource(data, failure) {
  test.logsSource.data = data
  test.logsSource.failure = failure || ''
  test.logsSource.notify()
}
setLogsSource(null, '')
const logsLoading = renderAndText(logsBody, {})
check('日志三态①加载中：骨架 .giou-skel 上屏（不留白屏）', byClass(logsLoading.tree, 'giou-skel').length > 0, '')
await sleep(10)
setLogsSource({ calls: [], count: 0, logFile: '' }, '')
const logsEmpty = renderAndText(logsBody, {})
check('日志三态②空：逐字「暂无调用记录」+ 下一步动作按钮', logsEmpty.text.includes('暂无调用记录') && Boolean(byLabel(logsEmpty.tree, 'button', '刷新')), logsEmpty.text.slice(0, 160))
await sleep(10)
setLogsSource(null, '日志后端未就绪（路由 404）')
const logsFail = renderAndText(logsBody, {})
check('日志三态③失败：原因上屏 + 重试按钮', logsFail.text.includes('模型调用记录不可用') && logsFail.text.includes('路由 404') && Boolean(byLabel(logsFail.tree, 'button', '重试')), logsFail.text.slice(0, 200))
await sleep(10)
await test.pullLogs()

// ── ⑧ 屏 B 列表三态 ───────────────────────────────────────────────────────
function setSnapshotSource(data, failure) {
  test.snapshotSource.data = data
  test.snapshotSource.failure = failure || ''
  test.snapshotSource.notify()
}
test.panelState.setEntered(true)
test.panelState.setView('board')
// 这一组测的是**默认「待复核」档**的空态文案与档位条数 → 先切回「待复核」（上一组留在「已退回」）。
clickFilter(evUnreadable.tree, '待复核')
setSnapshotSource(null, '')
const boardLoading = renderAndText(appComponent, {})
check('看板列表三态①加载中：骨架 .giou-skel 上屏（不留白屏）', byClass(boardLoading.tree, 'giou-skel').length > 0, '')
await sleep(10)
setSnapshotSource(null, '看板后端未就绪（路由 404）')
const boardFail = renderAndText(appComponent, {})
check('看板列表三态③失败：原因上屏 + 重试按钮', boardFail.text.includes('看板数据不可用') && boardFail.text.includes('路由 404') && Boolean(byLabel(boardFail.tree, 'button', '重试')), boardFail.text.slice(0, 200))
await sleep(10)
setSnapshotSource({ ok: true, ts: null, stores: [], inspections: [], counts: {}, offline: null, pendingQueue: null }, '')
const boardEmpty = renderAndText(appComponent, {})
check('看板列表三态②空：居中提示 + 下一步动作按钮', boardEmpty.text.includes('当前没有待复核') && Boolean(byLabel(boardEmpty.tree, 'button', '看全部')), boardEmpty.text.slice(0, 200))
await sleep(10)
// 已办结的单子必须在界面上**找得到**（用户实测提问「是不是差一个已办结」）：
// 默认「待复核」为空 → 空态如实说自己空（不偷换逾期列表）；「已办结」档按钮带命中数 1。
setSnapshotSource({ ok: true, ts: null, stores: [], inspections: [
  { id: 'INS-20261002-010000-done', storeId: 'S-001', storeName: '示例门店·快餐档口甲', status: 'rectified', createdAt: '2026-10-02T01:00:00.000Z', dueAt: null, note: '演示：本次无异常', items: [], findings: [], actions: [], unreadable: [], modelCallCount: 0, returnedCount: 0, reworkOf: null, lastAction: null, overdue: false, escalated: false },
], counts: {}, offline: null, pendingQueue: null }, '')
const boardDoneOnly = renderAndText(appComponent, {})
const filterNums = byClass(boardDoneOnly.tree, 'giou-filter-n').map((node) => textOfTree(node))
check('五档按钮各带命中条数（待复核0/已退回0/逾期0/已办结1/全部1）', JSON.stringify(filterNums) === JSON.stringify(['0', '0', '0', '1', '1']), JSON.stringify(filterNums))
check('「待复核」为空时如实说空并指路（不偷换逾期列表）', boardDoneOnly.text.includes('当前没有待复核的单子') && boardDoneOnly.text.includes('已办结') && boardDoneOnly.text.includes('全部'), boardDoneOnly.text.slice(0, 220))
// 下面几组（扫描回执 / 动作回执 / 回归）用的还是 SNAPSHOT 那张**退回单**夹具，详情要可见 → 切到「已退回」档。
clickFilter(boardDoneOnly.tree, '已退回')
await sleep(10)
await test.pullSnapshot()
await sleep(10)

// ── ⑨ 回归：useSyncExternalStore 的快照必须换引用 ───────────────────────────
// 病根：getSnapshot 永远返回同一个被原地改属性的 const 对象 → React 用 Object.is 判定「快照没变」→ bailout
// → 订阅它的组件永不重渲染。用户看到的就是：点入口面板永远不出现。
check(
  '源码里没有「getSnapshot 返回 store 本体」的残留',
  ['snapshotSource', 'logsSource', 'scanState', 'actionState', 'panelState'].every((name) => clientCode.indexOf('() => ' + name + ', () => ' + name) === -1),
  '',
)

test.panelState.setEntered(false)
test.panelState.setView('board')
const rolesOnly = renderAndText(appComponent, {})
check('回归前置：未进入时只渲染角色选择（不渲染看板正文）', rolesOnly.text.indexOf('（本次动态决定）') === -1 && byClass(rolesOnly.tree, 'giou-blist').length === 0, rolesOnly.text.slice(0, 80))
test.panelState.setEntered(true)
const panelByStore = flushStoreDriven(appComponent, {})
check('回归：只靠 store 通知，督导端正文就出现（getSnapshot 换引用）', Boolean(panelByStore) && panelByStore.text.includes('为什么查这几项'), panelByStore ? '' : 'store 通知后订阅者未被标脏 → React bailout → 面板永远不出现')

// 每个 store 都必须「notify 就换快照引用」（同一类 bug 的完整口径，不止面板开关这一处）
const storeContracts = [
  ['snapshotSource', () => test.snapshotSource, async () => { await test.pullSnapshot() }],
  ['logsSource', () => test.logsSource, async () => { await test.pullLogs() }],
  ['scanState', () => test.scanState, async () => { test.scanState.phase = 'idle'; await test.runScan() }],
  ['actionState', () => test.actionState, async () => { await test.recordAction({ inspectionId: 'INS-20261002-201530-ab12', findingId: 'FND-20261002-001', type: 'approve', reason: '' }) }],
  ['panelState', () => test.panelState, async () => { test.panelState.setView('logs') }],
]
for (const [name, storeOf, mutate] of storeContracts) {
  const before = storeOf().snapshot
  await mutate()
  check('回归：' + name + ' 在 notify 后换快照引用', before !== storeOf().snapshot, '')
}
test.panelState.setView('board')
await sleep(10)

// ── ⑩ 扫描：真 POST + 回执按后端返回值 ──────────────────────────────────────
const scanOk = await test.runScan()
await sleep(10)
const afterScan = renderAndText(appComponent, {}).text
const scanReq = requests.find((r) => r.path.indexOf('/scan') !== -1)
check('立即扫描真的 POST 到后端 /scan', Boolean(scanReq) && scanReq.method === 'POST', JSON.stringify(scanReq && scanReq.path))
check('扫描回执按后端返回值渲染（.giou-line ok）', scanOk && afterScan.includes('扫描 3 条') && afterScan.includes('新增催办·升级 1 条'), afterScan.slice(0, 200))

// ── ⑪ 动作行：通过 / 退回并说明 → 写记录（优先后端；口缺失时标「未同步」，不假装成功）──
const passReqBefore = requests.filter((r) => r.path.indexOf('/review') !== -1).length
const passEntry = await test.recordAction({ inspectionId: 'INS-20261002-201530-ab12', findingId: 'FND-20261002-001', type: 'approve', reason: '' })
await sleep(10)
check('「通过」把动作 POST 到 /api/gaia-inspection/review', requests.filter((r) => r.path.indexOf('/review') !== -1).length === passReqBefore + 1 && passEntry.synced === true, JSON.stringify(passEntry))
check('请求体形状与 be 一致（inspectionId/findingId/action 中文/operator/at）', (() => {
  const sent = requests.filter((item) => item.path.indexOf('/review') !== -1).slice(-1)[0]
  return Boolean(sent && sent.body && sent.body.inspectionId === 'INS-20261002-201530-ab12' && sent.body.action === '通过' && sent.body.operator && sent.body.at)
})(), JSON.stringify(requests.filter((item) => item.path.indexOf('/review') !== -1).slice(-1)[0]))
check('回执按 be 的 action{actionCode,result,actorName} + data{inspectionStatus} 展示', passEntry.actionCode === 'review_approve' && passEntry.resultNote.indexOf('通过') !== -1 && passEntry.resultNote.indexOf('检查单状态 rectified') !== -1 && passEntry.who === '督导（演示视图）', JSON.stringify(passEntry))

const missingReason = await test.recordAction({ inspectionId: 'INS-20261002-201530-ab12', findingId: 'FND-20261002-002', type: 'reject', reason: '   ' })
check('「退回并说明」不写原因时前端就拦（并提示后端口径 REASON_REQUIRED）', missingReason === null && test.actionState.error.indexOf('必须写原因') !== -1 && test.actionState.error.indexOf('REASON_REQUIRED') !== -1, test.actionState.error)

test.actionState.error = ''
reviewActionOverride = { ok: false, error: { code: 'REASON_REQUIRED', message: '退回并说明必须给出原因' } }
const rejectedEntry = await test.recordAction({ inspectionId: 'INS-20261002-201530-ab12', findingId: 'FND-20261002-002', type: 'reject', reason: '照片看不清，请重拍' })
await sleep(10)
const afterReject = renderAndText(appComponent, {}).text
check('后端拒收时该动作标「未同步到后端」并显示后端原文（不假装成功）', rejectedEntry && rejectedEntry.synced === false && afterReject.includes('未同步') && afterReject.includes('退回并说明必须给出原因'), JSON.stringify(rejectedEntry))
reviewActionOverride = null

// ── ⑫ header 三枚入口：点了真的切过去（肉眼可见变化，§5.1）──────────────────
const headerTexts = headerSlots.map((slot) => renderAndText(slot.component, {}).text)
check('header 三枚入口文案逐字（巡店判断回放看板 / 立即扫描 / 模型调用日志面板，按第二单 §2.3 无 emoji、按钮不加图标）',
  headerTexts.some((t) => t.includes('巡店判断回放看板')) && headerTexts.some((t) => t.includes('立即扫描')) && headerTexts.some((t) => t.includes('模型调用日志面板')) && !headerTexts.join(' ').match(/[\u{1F300}-\u{1FAFF}]/u),
  JSON.stringify(headerTexts))
const headerOf = (id) => slotSpecs.find((s) => s.spec.id === id).component

roleValue = 'manager'
test.panelState.setEntered(false)
test.panelState.setView('logs')
layoutCalls.length = 0
byLabel(renderAndText(headerOf('gaia-inspection-oversight-board'), {}).tree, 'button', '巡店判断回放看板').props.onClick()
check('点「巡店判断回放看板」→ 切督导端 + 进外壳 + 看板视图 + selectPanel(gaia-inspection)',
  roleValue === 'supervisor' && test.panelState.entered === true && test.panelState.view === 'board' && layoutCalls.indexOf('gaia-inspection') !== -1,
  JSON.stringify({ roleValue, entered: test.panelState.entered, view: test.panelState.view, layoutCalls }))

const scanReqBefore = requests.filter((r) => r.path.indexOf('/scan') !== -1).length
roleValue = 'manager'
test.panelState.setEntered(false)
test.panelState.setView('logs')
layoutCalls.length = 0
byLabel(renderAndText(headerOf('gaia-inspection-oversight-scan'), {}).tree, 'button', '立即扫描').props.onClick()
await sleep(10)
check('点「立即扫描」→ 切督导端 + 进外壳 + 看板视图 + selectPanel + 真的触发扫描',
  roleValue === 'supervisor' && test.panelState.entered === true && test.panelState.view === 'board' && layoutCalls.indexOf('gaia-inspection') !== -1 && requests.filter((r) => r.path.indexOf('/scan') !== -1).length > scanReqBefore,
  JSON.stringify({ roleValue, view: test.panelState.view, layoutCalls }))

roleValue = 'manager'
test.panelState.setEntered(false)
test.panelState.setView('board')
layoutCalls.length = 0
byLabel(renderAndText(headerOf('gaia-inspection-oversight-logs'), {}).tree, 'button', '模型调用日志面板').props.onClick()
check('点「模型调用日志面板」→ 进外壳 + 日志视图 + selectPanel，且**不改角色**',
  roleValue === 'manager' && test.panelState.entered === true && test.panelState.view === 'logs' && layoutCalls.indexOf('gaia-inspection') !== -1,
  JSON.stringify({ roleValue, view: test.panelState.view, layoutCalls }))
roleValue = 'supervisor'
test.panelState.setView('board')

// ── ⑬ keywords ────────────────────────────────────────────────────────────
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))
const wanted = ['巡店判断回放看板', '证据挂图卡片', '立即扫描按钮', '模型调用日志面板']
check('manifest.keywords 逐字包含四个能力词', wanted.every((word) => manifest.keywords.includes(word)), JSON.stringify(manifest.keywords))
check('manifest.keywords 不含别的订单词', manifest.keywords.every((word) => ['科研综述自审', '自审链路看板', '溯源查看面板', '门店自查采集入口', '角色视图切换'].indexOf(word) === -1), JSON.stringify(manifest.keywords))
check('六个能力词都真的进了界面文案（巡店判断回放看板 / 证据挂图卡片 / 立即扫描 / 角色视图切换 / 模型调用日志面板 / 门店自查采集入口）',
  boardText.includes('巡店判断回放看板') && withBox.text.includes('证据挂图卡片') && boardText.includes('立即扫描') && boardText.includes('角色视图切换') && boardText.includes('模型调用日志面板') && managerView.text.includes('门店自查采集入口'),
  '')

// ── ⑭ 纯函数 ──────────────────────────────────────────────────────────────
check('normalizeSnapshot 归一门店与检查单', normalized.stores.length === 2 && normalized.inspections.length === 1, '')
check('normalizeSnapshot 保留逾期/升级/动作/理由', normalized.inspections[0].overdue === true && normalized.inspections[0].escalated === true && normalized.inspections[0].actions.length === 2 && normalized.inspections[0].reasons.length > 10, '')
check('normalizeSnapshot 直接消费后端拼好的图片 URL（?id=，不再拼 ?path=）', normalized.inspections[0].findings[0].thumbUrl.indexOf('/api/gaia-inspection/photo?id=') === 0, normalized.inspections[0].findings[0].thumbUrl)
check('normalizeSnapshot 对 ok:false 保持空数据（不造数）', test.normalizeSnapshot({ ok: false, error: { code: 'DEPENDENCY_MISSING' } }).inspections.length === 0, '')

const stats = test.statsOf(normalized)
check('statsOf 统计累计/待判断/逾期/已办结（A3：不再算"今日"）', stats.total === 1 && stats.pending === 1 && stats.overdue === 1 && stats.done === 0 && stats.today === undefined, JSON.stringify(stats))
check('filterInspections 五档可用（这张夹具是被退回的单 → 落在「已退回」档）', test.filterInspections(normalized.inspections, 'pending').length === 0 && test.filterInspections(normalized.inspections, 'returned').length === 1 && test.filterInspections(normalized.inspections, 'overdue').length === 1 && test.filterInspections(normalized.inspections, 'all').length === 1, '')

// ── ⑭b 状态分档：待复核 / 逾期 / 已办结 / 全部 ──────────────────────────────
// 用户实测提问：「待复核、逾期、全部，是不是差一个已办结」——
// 改前「待复核」为空时会静默返回逾期列表（标签说假话），而 rectified 的单子除「全部」外没有入口。
const FILTER_KEYS = test.FILTERS.map((f) => f.key)
check('筛选五档 = 待复核·已退回·逾期·已办结·全部', JSON.stringify(FILTER_KEYS) === JSON.stringify(['pending', 'returned', 'overdue', 'done', 'all']), JSON.stringify(FILTER_KEYS))

const MIX = [
  { id: 'a', status: 'pending_rectify' },
  { id: 'b', status: 'overdue', overdue: true },
  { id: 'c', status: 'rectified' },
  { id: 'd', status: 'closed' },
  { id: 'e', status: 'escalated', overdue: true },
  { id: 'f', status: 'unreadable' },
]
const idsOf = (list) => list.map((i) => i.id).join(',')
check('「已办结」档 = 后端 status rectified/closed（通过过的单子有地方可看）', idsOf(test.filterInspections(MIX, 'done')) === 'c,d', idsOf(test.filterInspections(MIX, 'done')))
check('「待复核」档 = 还没办结的单（补集口径：含已逾期/已升级/材料不可判读）', idsOf(test.filterInspections(MIX, 'pending')) === 'a,b,e,f', idsOf(test.filterInspections(MIX, 'pending')))
check('顶部恒等式：待你判断 + 已办结 = 累计（四枚数字不可能自相矛盾）', test.countInspections(MIX, 'pending') + test.countInspections(MIX, 'done') === test.countInspections(MIX, 'all') && test.countInspections(MIX, 'overdue') <= test.countInspections(MIX, 'pending'), '')
check('状态被后端改成 overdue/escalated 后**不会从「待复核」消失**（白名单写法会）', test.filterInspections([{ id: 'x', status: 'overdue', overdue: true }], 'pending').length === 1 && test.filterInspections([{ id: 'y', status: 'escalated', overdue: true }], 'pending').length === 1, '')
check('「待复核」为空时返回空列表（不再静默偷换成逾期 —— 标签不许说假话）', test.filterInspections([{ id: 'b', status: 'rectified' }], 'pending').length === 0, '')
check('「逾期」档只看后端 overdue 标记（与状态正交：逾期也能是待复核的单）', idsOf(test.filterInspections(MIX, 'overdue')) === 'b,e', idsOf(test.filterInspections(MIX, 'overdue')))
check('「全部」档一条不丢', idsOf(test.filterInspections(MIX, 'all')) === 'a,b,c,d,e,f', idsOf(test.filterInspections(MIX, 'all')))
check('countInspections 与筛选同一套谓词（按钮上的数字）', test.countInspections(MIX, 'pending') === 4 && test.countInspections(MIX, 'overdue') === 2 && test.countInspections(MIX, 'done') === 2 && test.countInspections(MIX, 'all') === 6, JSON.stringify(FILTER_KEYS.map((k) => test.countInspections(MIX, k))))
const statsMix = test.statsOf({ ok: true, inspections: MIX })
check('statsOf：累计/待你判断/逾期/已办结 + 交集数（逾期 ⊆ 待你判断）', stats.done === 0 && statsMix.pending === 4 && statsMix.done === 2 && statsMix.overdue === 2 && statsMix.pendingAndOverdue === 2 && statsMix.total === 6, JSON.stringify(statsMix))
check('rectified 中文名统一成「已办结」、unreadable 有中文名（改前直出英文状态码）', test.statusLabelOf('rectified') === '已办结' && test.statusLabelOf('unreadable') === '材料不可判读' && test.statusToneOf({ status: 'rectified' }) === 'rectified', test.statusLabelOf('rectified') + '/' + test.statusLabelOf('unreadable'))

// ── ⑭b2 「已退回」档（客户 10-03 用完真机的裁定："退回和未办放一起了，少一个已退回栏"）──
// 口径：待复核与已退回按"有没有被退回过"**互斥**切分；已办结的退回单留在「已办结」，不进这一档。
const RET_MIX = [
  { id: 'a', status: 'pending_rectify' },
  { id: 'b', status: 'overdue', overdue: true },
  { id: 'g', status: 'pending_rectify', returnedAt: '2026-10-03T01:00:00.000Z' },
  { id: 'h', status: 'escalated', overdue: true, returnedAt: '2026-10-02T18:00:00.000Z' },
  { id: 'i', status: 'rectified', returnedAt: '2026-10-02T04:00:00.000Z' },
]
check('「已退回」档 = 被退回过且**还没办结**的单（含已逾期 / 已升级的退回单）', idsOf(test.filterInspections(RET_MIX, 'returned')) === 'g,h', idsOf(test.filterInspections(RET_MIX, 'returned')))
check('「待复核」档不再混入退回单（退回的从待复核移走）', idsOf(test.filterInspections(RET_MIX, 'pending')) === 'a,b', idsOf(test.filterInspections(RET_MIX, 'pending')))
check('曾退回但已办结的单留在「已办结」，不进「已退回」（不跟"球在门店"的混一档）', idsOf(test.filterInspections(RET_MIX, 'done')) === 'i' && test.filterInspections(RET_MIX, 'returned').every((x) => x.id !== 'i'), '')
check('新恒等式：待复核 + 已退回 = 顶栏「待你判断」；再加已办结 = 累计', test.countInspections(RET_MIX, 'pending') + test.countInspections(RET_MIX, 'returned') === test.statsOf({ ok: true, inspections: RET_MIX }).pending && test.countInspections(RET_MIX, 'pending') + test.countInspections(RET_MIX, 'returned') + test.countInspections(RET_MIX, 'done') === test.countInspections(RET_MIX, 'all'), JSON.stringify({ pending: test.countInspections(RET_MIX, 'pending'), returned: test.countInspections(RET_MIX, 'returned'), done: test.countInspections(RET_MIX, 'done'), all: test.countInspections(RET_MIX, 'all'), stat: test.statsOf({ ok: true, inspections: RET_MIX }).pending }))
check('isReturnedItem：已办结不算、没退回过不算', test.isReturnedItem({ status: 'rectified', returnedAt: 'x' }) === false && test.isReturnedItem({ status: 'pending_rectify', returnedAt: 'x' }) === true && test.isReturnedItem({ status: 'pending_rectify' }) === false, '')
check('每档都带口径提示（悬停可见，不占版面）', test.FILTERS.every((f) => typeof f.hint === 'string' && f.hint.length > 0), JSON.stringify(test.FILTERS.map((f) => f.hint)))
check('五档空态各说各的事（新增「已退回」档，且待复核档指向它）', test.EMPTY_TEXT.returned.title.indexOf('已退回') !== -1 && test.EMPTY_TEXT.pending.detail.indexOf('已退回') !== -1, JSON.stringify({ ret: test.EMPTY_TEXT.returned.title, pend: test.EMPTY_TEXT.pending.detail }))

// ── ⑭b3 订单（链根）与轮次（客户 10-03 裁定：「同一订单右侧多一轮，点进去看那一轮」）──────────
// 一个订单 = 一个链根（reworkOf 走到头）；轮次 = 一次提交，按 createdAt 升序；
// 订单的状态/档位一律看**最新一轮**（球在谁手里看最新一轮）。
{
  const CHAIN = [
    { id: 'INS-A', status: 'overdue', overdue: true, returnedAt: '2026-10-03T02:11:00.000Z', createdAt: '2026-10-03T02:10:00.000Z', reworkOf: null },
    { id: 'INS-B', status: 'pending_rectify', returnedAt: '2026-10-03T08:21:00.000Z', createdAt: '2026-10-03T08:20:00.000Z', reworkOf: 'INS-A' },
    { id: 'INS-C', status: 'pending_rectify', returnedAt: null, createdAt: '2026-10-03T08:25:00.000Z', reworkOf: 'INS-B' },
    { id: 'INS-D', status: 'rectified', createdAt: '2026-10-03T05:00:00.000Z', reworkOf: null },
  ]
  const orders = test.groupOrders(CHAIN)
  check('订单 = 链根：A→B→C 三轮归成一个订单（D 独立成单），订单按最新一轮倒序', orders.length === 2 && orders[0].rootId === 'INS-A' && orders[0].size === 3 && orders[0].root.id === 'INS-A' && orders[0].latest.id === 'INS-C' && orders[1].rootId === 'INS-D', JSON.stringify(orders.map((o) => o.rootId + 'x' + o.size)))
  check('轮次按提交时间升序（第 1 轮 = 初交）', idsOf(orders[0].rounds) === 'INS-A,INS-B,INS-C', idsOf(orders[0].rounds))
  check('退回次数按"哪几轮带退回标记"数（2 轮被退回过）', test.orderReturnedCount(orders[0]) === 2, String(test.orderReturnedCount(orders[0])))
  check('父亲不在快照里时自己就是链根（不把订单吞掉）', test.groupOrders([{ id: 'X', reworkOf: 'MISSING', status: 'pending_rectify' }])[0].rootId === 'X', '')
  check('档位看**最新一轮**：最新一轮待复核 → 这一单在「待复核」；老轮逾期**不**把它拖进「逾期」', test.filterOrders(CHAIN, 'pending').map((o) => o.rootId).join(',') === 'INS-A' && test.filterOrders(CHAIN, 'overdue').length === 0 && test.filterOrders(CHAIN, 'done').map((o) => o.rootId).join(',') === 'INS-D', JSON.stringify({ pending: test.filterOrders(CHAIN, 'pending').map((o) => o.rootId), overdue: test.filterOrders(CHAIN, 'overdue').length, done: test.filterOrders(CHAIN, 'done').map((o) => o.rootId) }))
  const returnedCase = CHAIN.map((row) => (row.id === 'INS-C' ? { ...row, returnedAt: '2026-10-03T09:00:00.000Z' } : row))
  check('最新一轮被退回 → 整单落到「已退回」（门店回拍后自然回到「待复核」）', test.filterOrders(returnedCase, 'returned').map((o) => o.rootId).join(',') === 'INS-A' && test.filterOrders(returnedCase, 'pending').length === 0, JSON.stringify(test.filterOrders(returnedCase, 'returned').map((o) => o.rootId)))
  const doneChain = [{ id: 'INS-E', status: 'pending_rectify', createdAt: '2026-10-03T01:00:00.000Z', reworkOf: null }, { id: 'INS-F', status: 'rectified', createdAt: '2026-10-03T03:00:00.000Z', reworkOf: 'INS-E' }]
  check('最新一轮办结 → 整单落到「已办结」（回拍后复核通过的形状）', test.filterOrders(doneChain, 'done').map((o) => o.rootId).join(',') === 'INS-E' && test.orderIsDone(test.groupOrders(doneChain)[0]) === true, '')
  const chainStats = test.statsOf({ ok: true, inspections: CHAIN })
  check('顶栏统计按订单计：累计 = 订单数（不是提交数），且 待你判断 + 已办结 = 累计', chainStats.total === 2 && chainStats.rounds === 4 && chainStats.pending === 1 && chainStats.done === 1 && chainStats.pending + chainStats.done === chainStats.total, JSON.stringify(chainStats))
  check('订单级条数 = filterOrders 的同一套谓词（按钮上的数字）', test.countOrders(CHAIN, 'pending') === 1 && test.countOrders(CHAIN, 'done') === 1 && test.countOrders(CHAIN, 'all') === 2 && test.countOrders(CHAIN, 'returned') === 0, JSON.stringify(['pending', 'returned', 'overdue', 'done', 'all'].map((k) => test.countOrders(CHAIN, k))))
}

// ── ⑭c A1/A2：已办结两句必须分情况 + 单档进度 ──────────────────────────────
// A1 的判据是"该单 findings 里有没有曾经判过不符合的真实记录"（findings 只收模型判过问题的项）：
const cleanCase = { status: 'rectified', findings: [] }
const fixedCase = { status: 'rectified', findings: [{ status: 'rectified' }, { status: 'rectified' }] }
const halfCase = { status: 'overdue', findings: [{ status: 'rectified' }, { status: 'pending_rectify' }] }
const noneCase = { status: 'pending_rectify', findings: [{ status: 'pending_rectify' }] }
check('A1 情况一：本次全部判「符合」→ 本次未发现问题（无需整改项）', test.doneSummaryOf(cleanCase).kind === 'clean' && test.doneSummaryOf(cleanCase).text === '本次未发现问题（无需整改项）', JSON.stringify(test.doneSummaryOf(cleanCase)))
check('A1 情况二：有问题→整改→通过 → 全部 N 项判断已通过', test.doneSummaryOf(fixedCase).kind === 'fixed' && test.doneSummaryOf(fixedCase).text === '全部 2 项判断已通过', JSON.stringify(test.doneSummaryOf(fixedCase)))
check('A1 两句**必须不同**（混用会把"整改通过"说成"本来没问题"）', test.doneSummaryOf(cleanCase).text !== test.doneSummaryOf(fixedCase).text, '')
const halfProgress = test.progressOf(halfCase)
check('A2 progressOf 数的是真实判断项（干净单 0 项 / 全通过 2/2 / 部分 1/2；一项没通过不给进度字）', test.progressOf(cleanCase).total === 0 && test.progressOf(fixedCase).passed === 2 && test.progressOf(fixedCase).allPassed === true && halfProgress.passed === 1 && halfProgress.total === 2 && halfProgress.partial === true && test.progressTextOf(noneCase) === '', JSON.stringify({ clean: test.progressOf(cleanCase), fixed: test.progressOf(fixedCase), half: halfProgress }))
check('A2 详情文案逐字「已通过 1/2 项」', test.progressTextOf(halfCase) === '已通过 1/2 项', test.progressTextOf(halfCase))

// ── ⑭d A2/A4 渲染级：部分通过 + 材料不可判读 ───────────────────────────────
// 这两个夹具都**不是**退回单 → 切回「待复核」档（垫片档位跨重挂存活，前面几组停在「已退回」）。
clickFilter(renderAndText(appComponent, {}).tree, '待复核')
// 部分通过：只通过 2 项里的 1 项，详情顶部与列表都必须写出「已通过 1/2 项」
setSnapshotSource({ ok: true, ts: null, stores: [], inspections: [
  { id: 'INS-20261002-020000-half', storeId: 'S-001', storeName: '示例门店·快餐档口甲', status: 'pending_rectify', createdAt: '2026-10-02T02:00:00.000Z', dueAt: null, note: '部分通过', items: [], actions: [], unreadable: [], modelCallCount: 0, returnedCount: 0, reworkOf: null, lastAction: null, overdue: true, escalated: false,
    findings: [
      { findingId: 'FND-H1', itemName: '地面与通道', status: 'rectified', reason: 'r1', suggestion: 's1', boxes: [], confidence: null, confidenceSource: 'missing' },
      { findingId: 'FND-H2', itemName: '台面与设备', status: 'pending_rectify', reason: 'r2', suggestion: 's2', boxes: [], confidence: null, confidenceSource: 'missing' },
    ] },
], counts: {}, offline: null, pendingQueue: null }, '')
const boardHalf = renderAndText(appComponent, {})
check('A2 详情顶部逐字「状态：… · 已通过 1/2 项」', boardHalf.text.includes('状态：待复核') && boardHalf.text.includes('已通过 1/2 项'), boardHalf.text.slice(0, 300))
// A-1.8：已通过的那一项不能再点（改前按钮永远可点：真机验收里同一项连点 8 次、单子还是待复核）
// A-1.8：已通过的那一项不能再点（改前按钮永远可点：真机验收里同一项连点 8 次、单子还是待复核）
{
  // 注意 byLabel 是**子串**匹配（'通过' 会命中 '已通过'），这里按精确文案取按钮；
  // 而"已通过"那枚现在带 title（说明为什么停用），textOfTree 会把 title 也算进去 → 用结尾匹配。
  const btns = findAll(boardHalf.tree, 'button').map((n) => ({ t: textOfTree(n), dis: Boolean(n.props && n.props.disabled) }))
  const passedBtn = btns.filter((b) => b.t.endsWith('已通过'))[0]
  const normalBtn = btns.filter((b) => b.t === '通过')[0]
  check('A-1.8 已通过项标「本项已通过」且「通过」按钮禁用（不再重复写动作）',
    boardHalf.text.includes('本项已通过') && Boolean(passedBtn) && passedBtn.dis === true && Boolean(normalBtn) && normalBtn.dis === false,
    JSON.stringify({ passedChip: boardHalf.text.includes('本项已通过'), passedBtn, normalBtn }))
}
check('A2 列表也看得出部分通过（同一句话进列表 chip）', byClass(boardHalf.tree, 'giou-chip').some((n) => textOfTree(n) === '已通过 1/2 项'), '')
await sleep(10)

// 材料不可判读：徽标 + 下一步（决定是否让店长重拍）
setSnapshotSource({ ok: true, ts: null, stores: [], inspections: [
  { id: 'INS-20261002-030000-unread', storeId: 'S-001', storeName: '示例门店·快餐档口甲', status: 'unreadable', createdAt: '2026-10-02T03:00:00.000Z', dueAt: null, note: '这张照片拍偏又失焦。', items: [], findings: [], actions: [], modelCallCount: 0, returnedCount: 0, reworkOf: null, lastAction: null, overdue: false, escalated: false,
    unreadable: [{ photoIndex: 0, why: '整幅失焦、明显过暗' }] },
], counts: {}, offline: null, pendingQueue: null }, '')
const boardUnread = renderAndText(appComponent, {})
check('A4 列表徽标逐字「材料不可判读」且带独立色档（不与「待复核」混在一起）', byClass(boardUnread.tree, 'giou-chip').some((n) => textOfTree(n) === '材料不可判读' && n.props && n.props['data-tone'] === 'unreadable'), JSON.stringify(byClass(boardUnread.tree, 'giou-chip').map((n) => textOfTree(n) + ':' + (n.props && n.props['data-tone']))))
check('A4 详情写出下一步是"决定是否让店长重拍"', boardUnread.text.includes('材料不可判读（本单 0 条问题判断）') && boardUnread.text.includes('决定是否让店长重拍'), boardUnread.text.slice(0, 300))
// 0 条判断项的轮次必须**有办结路径**（改前只能永远挂待复核，真机 #f19f 就是）
check('0 条判断项的轮次出现「确认无需整改，办结本单」（可点）', (() => {
  const btn = byLabel(boardUnread.tree, 'button', '确认无需整改，办结本单')
  return Boolean(btn) && btn.props.disabled !== true
})(), boardUnread.text.slice(boardUnread.text.indexOf('暂无问题项'), boardUnread.text.indexOf('暂无问题项') + 90))
{
  const before = requests.length
  byLabel(boardUnread.tree, 'button', '确认无需整改，办结本单').props.onClick()
  await sleep(20)
  const sent = requests.slice(before).filter((r) => r.path.indexOf('/review') !== -1).slice(-1)[0]
  check('「办结本单」发的是中文「办结」（后端 actionCode=review_close）', Boolean(sent) && sent.body && sent.body.action === '办结' && sent.body.inspectionId, JSON.stringify(sent && sent.body))
}
check('ACTION_WORDS / ACTION_CODE_WORDS 含「办结」（前后端口径同表）', test.ACTION_WORDS.close === '办结' && test.ACTION_CODE_WORDS.review_close === '办结', JSON.stringify(test.ACTION_WORDS))
await sleep(10)
await test.pullSnapshot()
await sleep(10)
check('四档空态各说各的事（不再一律写"当前没有待复核"）', test.EMPTY_TEXT.done.title.indexOf('办结') !== -1 && test.EMPTY_TEXT.pending.title === '当前没有待复核的单子' && test.EMPTY_TEXT.overdue.title.indexOf('逾期') !== -1, JSON.stringify(test.EMPTY_TEXT))
check('sortByTimeDesc 倒序', test.sortByTimeDesc([{ id: 'a', createdAt: '2026-10-02T01:00:00.000Z' }, { id: 'b', createdAt: '2026-10-02T05:00:00.000Z' }])[0].id === 'b', '')

check('confidenceOf 用后端文字档 + confidenceSource=model 直接展示', test.confidenceOf({ confidence: '高', confidenceSource: 'model' }).display === true && test.confidenceOf({ confidence: '高', confidenceSource: 'model' }).from === 'backend', JSON.stringify(test.confidenceOf({ confidence: '高', confidenceSource: 'model' })))
check('confidenceSource=missing 时不折算、显示「未标注」', test.confidenceOf({ confidence: null, confidenceSource: 'missing', severity: '高' }).display === false && test.confidenceOf({ confidence: null, confidenceSource: 'missing', severity: '高' }).label === '未标注', JSON.stringify(test.confidenceOf({ confidence: null, confidenceSource: 'missing', severity: '高' })))
check('旧数据（无 confidence 字段）才按严重度折算并标注来源', test.confidenceOf({ severity: '中' }).from === 'severity' && test.confidenceOf({ severity: '中' }).label === '中', JSON.stringify(test.confidenceOf({ severity: '中' })))
check('confidenceNoteOf 说明来源', test.confidenceNoteOf({ from: 'backend', label: '高' }).indexOf('模型置信度') === 0 && test.confidenceNoteOf({ from: 'backend-empty', label: '未标注' }).indexOf('missing') !== -1, test.confidenceNoteOf({ from: 'backend-empty', label: '未标注' }))
check('confidenceOf 按分值折算（0.85→高）', test.confidenceOf({ confidenceScore: 0.85 }).label === '高' && test.confidenceOf({ confidenceScore: 0.4 }).label === '低', '')
check('ACTION_WORDS / ACTION_CODE_WORDS 与 be 口径一致', test.ACTION_WORDS.approve === '通过' && test.ACTION_WORDS.reject === '退回并说明' && test.ACTION_WORDS.remind === '催办' && test.ACTION_CODE_WORDS.review_approve === '通过' && test.ACTION_CODE_WORDS.review_remind === '催办', JSON.stringify(test.ACTION_WORDS))

check('scanSummaryOf 按后端字段拼回执', test.scanSummaryOf(SCAN_RESULT) === '扫描 3 条、标记逾期 1 条、新增催办·升级 1 条', test.scanSummaryOf(SCAN_RESULT))
check('scanSummaryOf 缺字段时不臆造数字', test.scanSummaryOf({ ok: true }) === '扫描已完成（后端未返回计数）', test.scanSummaryOf({ ok: true }))
check('shortNo 短编号', test.shortNo('INS-20261002-201530-ab12') === '#ab12', test.shortNo('INS-20261002-201530-ab12'))
check('statusLabelOf / statusToneOf 中文状态与色档', test.statusLabelOf('pending_rectify') === '待复核' && test.statusToneOf({ status: 'pending_rectify', overdue: true }) === 'overdue' && test.statusToneOf({ status: 'escalated', escalated: true }) === 'escalated', '')
check('measureSuffix 对 ratio 单位给出百分比', test.measureSuffix({ x: 0.1, y: 0.2, w: 0.3, h: 0.25 }, 'ratio').indexOf('x=10.0%') === 0, test.measureSuffix({ x: 0.1, y: 0.2, w: 0.3, h: 0.25 }, 'ratio'))
check('actionLabelOf 中文动作名', test.actionLabelOf('remind') === '催办' && test.actionLabelOf('escalate') === '升级' && test.actionLabelOf('approve') === '通过' && test.actionLabelOf('reject') === '退回', '')
check('tokensOf 无 usage 显示 —', test.tokensOf(null) === '—' && test.tokensOf({ inputTokens: 900, outputTokens: 220 }) === '900/220', test.tokensOf({ inputTokens: 900, outputTokens: 220 }))
check('photoUrlOf 对后端拼好的 URL 原样透传（?id=）', test.photoUrlOf('/api/gaia-inspection/photo?id=aaaaaaaaaaaaaaaa&kind=thumb') === '/api/gaia-inspection/photo?id=aaaaaaaaaaaaaaaa&kind=thumb', test.photoUrlOf('/api/gaia-inspection/photo?id=aaaaaaaaaaaaaaaa&kind=thumb'))

// 证据定位降级口径：有框画框 / 无框有点标点 / 都没有就不画（绝不画空框）
const noPoint = test.locateEvidence({ boxes: [], boxesUnit: 'ratio', hasBoxes: false, fallbackPoint: null })
const withPoint = test.locateEvidence({ boxes: [], hasBoxes: false, fallbackPoint: { x: 0.4, y: 0.7, unit: 'ratio', source: 'model', text: '后门内侧纸箱处' } })
const badBox = test.locateEvidence({ boxes: [{ x: 0.1, y: 0.2, w: 0, h: 0.3 }, { x: -1, y: 0, w: 0.2, h: 0.2 }], hasBoxes: true, fallbackPoint: null })
const boxCase = test.locateEvidence(EVIDENCE_BOX.data)
check('有框：hasBoxes=true 且 fallbackPoint 为 null → strategy=box（只画框）', boxCase.strategy === 'box' && boxCase.point === null && boxCase.hasBoxesField === true, JSON.stringify(boxCase))
check('坐标缺失且无 fallbackPoint → strategy=none（图上什么都不画，绝不画空框）', noPoint.strategy === 'none' && noPoint.boxes.length === 0 && noPoint.point === null, JSON.stringify(noPoint))
check('坐标缺失但有 fallbackPoint → strategy=point（图上标点）', withPoint.strategy === 'point' && withPoint.point && withPoint.point.x === 0.4 && withPoint.point.unit === 'ratio', JSON.stringify(withPoint))
check('非法/零尺寸框被丢弃（不画空框）', badBox.strategy === 'none' && badBox.boxes.length === 0, JSON.stringify(badBox))

// ── ⑯ B 组 5 条通用值（机检 CSS 串；与交付目录 harness/css-invariants.mjs 同一口径）──
// 这 5 条"后续怎么改都不用重做"，所以必须由包自己的自测锁住，而不是只在报告里写一句。
const cssText = clientCode.slice(clientCode.indexOf('const CSS = `'), clientCode.indexOf('`', clientCode.indexOf('const CSS = `') + 13))
const blackUse = cssText.match(/rgba\(0,\s*0,\s*0,[^)]*\)|#000\b/gi) || []
check('B2 阴影只有两级且不许纯黑（两个 token 值逐字 + 全表 0 处纯黑）',
  cssText.indexOf('--gi-shadow-card: 0 2px 8px rgba(16,19,25,.06);') !== -1 &&
  cssText.indexOf('--gi-shadow-pop: 0 10px 28px rgba(16,19,25,.18);') !== -1 &&
  blackUse.length === 0, blackUse.join(','))
check('B3 字号只三档且正文 ≥13 / 辅助 ≥11（token 逐字）',
  cssText.indexOf('--gi-fs-title: 20px; --gi-fs-body: 13px; --gi-fs-aux: 11px;') !== -1 &&
  (cssText.match(/font-size:\s*(?!var\(--gi-fs-)(\d+(?:\.\d+)?)px/g) || []).every((v) => Number(v.replace(/[^\d.]/g, '')) >= 13), '')
check('B5 间距只用 4/8/12/16/24/32/40（七个 token 逐字 + 不再出现 6px 这类越界值）',
  ['--gi-s1: 4px', '--gi-s2: 8px', '--gi-s3: 12px', '--gi-s4: 16px', '--gi-s6: 24px', '--gi-s8: 32px', '--gi-s10: 40px'].every((t) => cssText.indexOf(t) !== -1) &&
  cssText.indexOf('padding: 0 6px') === -1, '')
check('B4 禁用态一律灰化（不保留品牌色）',
  cssText.indexOf('.giou-btn[disabled]') !== -1 && cssText.indexOf('.giou-btn.primary[disabled]') !== -1 &&
  cssText.indexOf('.giou-select[disabled]') !== -1 && /\.giou-btn\[disabled\][^}]*var\(--gi-surface-soft\)/.test(cssText), '')
check('B1 同心圆角：卡片 18 = 内块 10 + 内边距 8（列表项与卡片都按这一对写死）',
  ['--gi-r-card: 18px', '--gi-r-block: 12px', '--gi-r-ctl: 10px', '--gi-r-pill: 999px'].every((t) => cssText.indexOf(t) !== -1) &&
  cssText.indexOf('.giou-card { padding: var(--gi-s2); }') !== -1 &&
  cssText.indexOf('.giou-item { padding: var(--gi-s2); border-radius: var(--gi-r-card); }') !== -1 &&
  cssText.indexOf('.giou-card .giou-line, .giou-card .giou-shot { border-radius: var(--gi-r-ctl); }') !== -1, '')

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
