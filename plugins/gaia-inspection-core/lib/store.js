// gaia-inspection-core / lib/store.js
// 巡店业务本地库（能力词：巡店数据落库、模型调用日志留存）。
//
// 形态：**追加式 JSONL**（每表一个文件），零第三方依赖，只用 node: 内置模块。
//   · 启动时把每个表的 JSONL 回放成内存索引（重启后可读，不丢历史）；
//   · 写入 = 追加一行 `{op:'put'|'patch'|'del', ...}`，再更新内存索引；
//   · 表：stores / inspections / findings / evidences / actions / model_calls（六张）；
//   · model_calls 单独一表，**重置流程绝不触碰它**（§4 红线：日志不许事后补写或清空）。
//
// 根目录解析（可预期、可被总工程师亲自核对）：
//   1) 环境变量 GAIA_INSPECTION_DATA（显式指定，测试用）；
//   2) 否则 $DSH_HOME/gaia-inspection（客户端可写区 home 下的固定位置）；
//   3) 再否则 <cwd>/gaia-inspection-data。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 六张表（逐字，与规格书一致）。 */
export const TABLES = ['stores', 'inspections', 'findings', 'evidences', 'actions', 'model_calls']
/** 演示重置要清的业务表（不含 stores 档案与 model_calls 日志）。 */
export const BUSINESS_TABLES = ['inspections', 'findings', 'evidences', 'actions']

const ID_PREFIX = {
  stores: 'ST',
  inspections: 'INS',
  findings: 'FND',
  evidences: 'EVD',
  actions: 'ACT',
  model_calls: 'MC',
}

export function dataRoot() {
  const explicit = String(process.env.GAIA_INSPECTION_DATA || '').trim()
  if (explicit) return explicit
  const home = String(process.env.DSH_HOME || '').trim()
  if (home) return join(home, 'gaia-inspection')
  return join(process.cwd(), 'gaia-inspection-data')
}

export function dbDir(root = dataRoot()) {
  return join(root, 'db')
}
export function photoDir(root = dataRoot()) {
  return join(root, 'photos')
}
export function thumbDir(root = dataRoot()) {
  return join(root, 'thumbs')
}
export function queueDir(root = dataRoot()) {
  return join(root, 'queue')
}
export function logDir(root = dataRoot()) {
  return join(root, 'logs')
}

export function tablePath(table, root = dataRoot()) {
  return join(dbDir(root), `${table}.jsonl`)
}

export function nowIso() {
  return new Date().toISOString()
}

export function ensureDirs(root = dataRoot()) {
  for (const d of [dbDir(root), photoDir(root), thumbDir(root), queueDir(root), logDir(root)]) mkdirSync(d, { recursive: true })
  return root
}

let seq = 0
export function newId(table, at) {
  const p = ID_PREFIX[table] || 'ID'
  seq += 1
  const d = at ? new Date(at) : new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${p}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${String(seq).padStart(3, '0')}`
}

/** 内存索引（进程内单例）。 */
const maps = new Map()
let loadedRoot = ''

function mapOf(table) {
  if (!maps.has(table)) maps.set(table, new Map())
  return maps.get(table)
}

function readLines(file) {
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      // 损坏行跳过（不臆造数据，也不让整库不可用）
    }
  }
  return out
}

/** 回放一个表的 JSONL 到内存索引。幂等：重复调用等价于重新加载。 */
export function load(table, root = dataRoot()) {
  ensureDirs(root)
  const file = tablePath(table, root)
  const m = new Map()
  for (const rec of readLines(file)) {
    if (!rec || typeof rec !== 'object') continue
    if (rec.op === 'put' && rec.row && rec.row.id) m.set(rec.row.id, rec.row)
    else if (rec.op === 'patch' && rec.id && m.has(rec.id)) m.set(rec.id, { ...m.get(rec.id), ...(rec.patch || {}) })
    else if (rec.op === 'del' && rec.id) m.delete(rec.id)
  }
  maps.set(table, m)
  loadedRoot = root
  return m.size
}

export function loadAll(root = dataRoot()) {
  const counts = {}
  for (const t of TABLES) counts[t] = load(t, root)
  return counts
}

function append(table, rec, root = dataRoot()) {
  ensureDirs(root)
  appendFileSync(tablePath(table, root), `${JSON.stringify(rec)}\n`, 'utf8')
}

/** 写入一行（不存在则建，存在则覆盖同名字段）。 */
export function put(table, row, root = dataRoot()) {
  const at = row && row.createdAt ? row.createdAt : nowIso()
  const id = row && row.id ? String(row.id) : newId(table, at)
  const prev = mapOf(table).get(id)
  const next = { ...(prev || {}), ...row, id, createdAt: (prev && prev.createdAt) || at, updatedAt: nowIso() }
  append(table, { op: 'put', row: next, ts: next.updatedAt }, root)
  mapOf(table).set(id, next)
  return next
}

/** 局部更新（用于模型调用日志在调用结束时补耗时/状态）。 */
export function patch(table, id, fields, root = dataRoot()) {
  const prev = mapOf(table).get(id)
  if (!prev) return null
  const next = { ...prev, ...fields, id, updatedAt: nowIso() }
  append(table, { op: 'patch', id, patch: { ...fields, updatedAt: next.updatedAt }, ts: next.updatedAt }, root)
  mapOf(table).set(id, next)
  return next
}

export function get(table, id) {
  return mapOf(table).get(String(id)) || null
}

/** 删除一行（只用于演示样例的自我清理；业务删除不开放给工具）。 */
export function del(table, id, root = dataRoot()) {
  const key = String(id)
  if (!mapOf(table).has(key)) return false
  append(table, { op: 'del', id: key, ts: nowIso() }, root)
  mapOf(table).delete(key)
  return true
}

export function all(table) {
  return [...mapOf(table).values()]
}

export function where(table, pred) {
  return all(table).filter(pred)
}

export function counts() {
  const out = {}
  for (const t of TABLES) out[t] = mapOf(t).size
  out.files = Object.fromEntries(TABLES.map((t) => [t, tablePath(t)]))
  return out
}

/** 清空若干表（演示重置用）。日志表由调用方保证不在列表里。 */
export function clearTables(tables, root = dataRoot()) {
  const cleared = []
  for (const t of tables) {
    ensureDirs(root)
    writeFileSync(tablePath(t, root), '', 'utf8')
    mapOf(t).clear()
    cleared.push(t)
  }
  return cleared
}

/** model_calls 读取面：按开始时间排序，供 GET /api/gaia-inspection/model-calls。 */
export function modelCalls() {
  return all('model_calls')
    .slice()
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')))
}

/** 一条模型调用的重试/失败状态归一（不造假数据：缺的字段保持 null）。 */
export function normalizeCallRow(rec) {
  return {
    callId: rec.callId || rec.id || null,
    ts: rec.ts || rec.createdAt || null,
    provider: rec.provider || null,
    model: rec.model || null,
    kind: rec.kind || null,
    promptVersion: rec.promptVersion ?? null,
    storeId: rec.storeId ?? null,
    inspectionId: rec.inspectionId ?? null,
    latencyMs: typeof rec.latencyMs === 'number' ? rec.latencyMs : null,
    usage: rec.usage ?? null,
    status: rec.status || 'unknown',
    errorCode: rec.errorCode ?? null,
    // 画面级要求：面板要显示"请求摘要 / 响应摘要"，只给业务内容（写日志前已脱敏、截断）
    requestSummary: rec.requestSummary ?? null,
    responseSummary: rec.responseSummary ?? null,
    tsEnd: rec.tsEnd ?? null,
  }
}

export function currentRoot() {
  return loadedRoot || dataRoot()
}
