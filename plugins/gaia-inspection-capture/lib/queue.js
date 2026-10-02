// gaia-inspection-capture / lib/queue.js
// 断网降级与待判队列（能力词：断网降级与待判队列）。
//
// 约定（§13 + 本单指令）：
//   · 模型不可达 / 断网 / 离线开关打开时，采集**仍然受理**，照片落原图后进**待判队列**；
//   · 离线期间**不产生任何模型判断**，因此 `model_calls` **不新增**一行（这是可核对的硬事实）；
//   · 恢复联网后自动补判（也支持手动 flush），补判结果回填队列状态并补派整改单；
//   · 队列是独立文件（`<数据根>/queue/pending.jsonl`），演示重置会清它，`model_calls` 永不清。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { nowIso } from './modellog.js'

export function queuePath(queueDir) {
  return join(queueDir, 'pending.jsonl')
}

export function loadQueue(queueDir) {
  const file = queuePath(queueDir)
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const v = JSON.parse(t)
      if (v && typeof v === 'object') out.push(v)
    } catch {
      /* 损坏行跳过 */
    }
  }
  return out
}

/** 队列状态：pending = 还没补判的；judged = 已补判的。 */
export function queueState(queueDir) {
  const rows = loadQueue(queueDir)
  return {
    file: queuePath(queueDir),
    pending: rows.filter((r) => r.status === 'pending').length,
    judged: rows.filter((r) => r.status === 'judged').length,
    failed: rows.filter((r) => r.status === 'failed').length,
    items: rows,
  }
}

export function enqueue(queueDir, item) {
  const row = {
    qid: item.qid || `Q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    ts: nowIso(),
    status: 'pending',
    ...item,
  }
  appendFileSync(queuePath(queueDir), `${JSON.stringify(row)}\n`, 'utf8')
  return row
}

/** 覆盖写整个队列文件（补判回填用；保持追加式的语义等价结果）。 */
export function rewrite(queueDir, rows) {
  writeFileSync(queuePath(queueDir), rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
  return rows
}

export function clear(queueDir) {
  writeFileSync(queuePath(queueDir), '', 'utf8')
}
