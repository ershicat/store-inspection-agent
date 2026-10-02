// gaia-inspection-oversight-ui — 客户端半（纯浏览器 ESM，手写 ModuleLoader bundle）。
//
// 逐字对齐《界面实现说明（画面级）》屏 B · 督导端：
//   顶部：视图标签（店长端/督导端）+「模型调用日志」独立入口 + 统计行 `今日 N 条 · 待你判断 M 条 · 逾期 K 条`
//   → 左右两栏（左：筛选「待复核·逾期·全部」+ 倒序列表（缩略图+编号+门店+时间+状态，逾期整条标红并显示「已升级」）；
//     右：提交详情 = 门店原话 · 状态行 · 「为什么查这几项」浅底块（3–5 条）· 检查项卡（项名/判断/依据/回看原图/
//     整改要求与截止，置信度用文字高·中·低）· 动作行 `通过`/`退回并说明`/`催办`（每次动作写入记录））。
//   宽度：右栏要能完整展开、**不出现横向滚动**；因此本面板是**不遮挡的右侧全高面板**（说明 §四 6 只禁全屏遮窗浮层，
//   且 §二 允许挂主区域整屏面板）。证据「回看原图」是**面板内放大区**，不是浮层。
//
// 能力词（逐字）：「巡店判断回放看板」、「证据挂图卡片」、「立即扫描按钮」、「模型调用日志面板」。
//
// 纪律：数据只走 /api/gaia-inspection/* 只读路由（前端不造数、不改本地状态）；圈框 boxesUnit:'ratio'、
// 无坐标 → 图上标点 + 旁边写依据文字（**绝不画空框**）；日志不得出现 API Key / Authorization（前端不请求也不展示这类字段）。

window.__ModuleLoader__.load({
  id: 'gaia-inspection-oversight-ui',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    let React = null
    try {
      React = require('react')
    } catch (error) {
      React = null
    }

    // ── 常量（能力词与逐字文案）─────────────────────────────────────────────
    const CAPABILITY_BOARD = '巡店判断回放看板'
    const CAPABILITY_EVIDENCE = '证据挂图卡片'
    const CAPABILITY_SCAN = '立即扫描按钮'
    const CAPABILITY_LOGS = '模型调用日志面板'

    const SNAPSHOT_PATH = '/api/gaia-inspection/snapshot'
    const EVIDENCE_PATH = '/api/gaia-inspection/evidence'
    const MODELCALLS_PATH = '/api/gaia-inspection/model-calls'
    const SCAN_PATH = '/api/gaia-inspection/scan'
    /** 督导动作的浏览器侧入口（be 已注册 `/review` 与 `/review-action` 两条等价路径，本包用前者）。 */
    const REVIEW_ACTION_PATH = '/api/gaia-inspection/review'
    /** 与动作码对应的中文词（be 两种都认，本包按中文词发，回执里另有 actionCode 可匹配）。 */
    const ACTION_WORDS = { approve: '通过', reject: '退回并说明', remind: '催办' }
    /** 动作码（be 回执 action.actionCode）→ 中文词，用于匹配"这条动作到底做了什么"。 */
    const ACTION_CODE_WORDS = { review_approve: '通过', review_reject: '退回并说明', review_remind: '催办' }
    const PHOTO_PATH = '/api/gaia-inspection/photo'

    const BOARD_TAB_KIND = 'gaia-inspection-oversight-ui/board'
    const LOGS_TAB_KIND = 'gaia-inspection-oversight-ui/logs'

    const TAB_SLOT = 'sidebar.right.pane.tab'
    const OVERLAY_SLOT = 'shell.overlay'
    const HEADER_SLOT = 'conversation.session.header.actions'
    const DOCK_SLOT = 'conversation.input.dock'

    const POLL_MS = 2000
    const LOGS_POLL_MS = 5000

    const STATUS_LABELS = {
      pending_rectify: '待复核',
      pending: '待复核',
      analyzing: '分析中',
      running: '分析中',
      queued: '排队中',
      overdue: '逾期',
      escalated: '已升级',
      rectified: '已通过',
      approved: '已通过',
      rejected: '已退回',
      closed: '已关闭',
      ok: '正常',
      failed: '分析失败',
      unknown: '未知',
    }

    const FILTERS = [
      { key: 'pending', label: '待复核' },
      { key: 'overdue', label: '逾期' },
      { key: 'all', label: '全部' },
    ]

    /** 日志面板的固定说明（脱敏口径写在这里，便于自测**原样断言**而不与正文里的禁词说明混淆）。 */
    const LOGS_EMPTY_TEXT = '暂无调用记录'
    const LOGS_MASKING_TEXT = '记录来自后端 model_calls 表（真实调用留痕、不许事后补写）；前端只读，且只展示业务摘要——不请求、不展示凭据类字段。'
    const LOGS_MISSING_TEXT = '的这几列「提示词版本 / 请求摘要 / 响应摘要」后端暂未提供（显示 —）：口径需 gaia-inspection-core 的 model_calls 记录补齐；前端不代填、不臆造。'

    const CSS = `
.giou-panel { position: absolute; top: 0; right: 0; bottom: 0; width: min(1080px, 82vw); display: flex; flex-direction: column; background: var(--dsw-color-bg, #fff); color: var(--dsw-color-fg, #1f2329); border-left: 1px solid var(--dsw-color-border, #e5e6eb); box-shadow: -10px 0 34px rgba(0,0,0,.16); font-size: 12px; line-height: 1.55; box-sizing: border-box; overflow: hidden; }
.giou-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 9px 12px; border-bottom: 1px solid var(--dsw-color-border, #e5e6eb); }
.giou-title { font-weight: 600; font-size: 13px; margin-right: auto; }
.giou-stats { font-size: 12px; color: #646a73; white-space: nowrap; }
.giou-stats b { color: #1f2329; }
.giou-stats .bad { color: #cf1322; }
.giou-btn { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--dsw-color-border, #e5e6eb); border-radius: 6px; padding: 2px 9px; font: inherit; font-size: 11px; line-height: 1.7; cursor: pointer; background: transparent; color: inherit; }
.giou-btn:hover:not([disabled]) { border-color: var(--dsw-color-primary, #4e6ef2); color: var(--dsw-color-primary, #4e6ef2); }
.giou-btn[disabled] { opacity: .5; cursor: not-allowed; }
.giou-btn.primary { border-color: var(--dsw-color-primary, #4e6ef2); color: var(--dsw-color-primary, #4e6ef2); }
.giou-tabs { display: inline-flex; border: 1px solid var(--dsw-color-border, #e5e6eb); border-radius: 999px; overflow: hidden; }
.giou-tabs button { border: 0; background: transparent; color: inherit; font: inherit; font-size: 11px; padding: 3px 12px; cursor: pointer; }
.giou-tabs button[data-on="1"] { background: var(--dsw-color-primary, #4e6ef2); color: #fff; }
.giou-line { border: 1px solid var(--dsw-color-border, #e5e6eb); border-radius: 8px; padding: 5px 8px; font-size: 11px; color: #646a73; }
.giou-line.warn { border-color: #ffe58f; background: rgba(255,229,143,.16); color: #ad6800; }
.giou-line.err { border-color: #ffccc7; background: rgba(255,204,199,.16); color: #cf1322; }
.giou-line.ok { border-color: #b7eb8f; background: rgba(183,235,143,.16); color: #237804; }
.giou-body { flex: 1; min-height: 0; display: flex; }
.giou-left { width: 320px; flex: none; border-right: 1px solid var(--dsw-color-border, #e5e6eb); display: flex; flex-direction: column; min-height: 0; }
.giou-filters { display: flex; gap: 4px; padding: 7px 9px; border-bottom: 1px solid var(--dsw-color-border, #e5e6eb); }
.giou-filters button { border: 1px solid var(--dsw-color-border, #e5e6eb); background: transparent; color: inherit; font: inherit; font-size: 11px; border-radius: 999px; padding: 2px 10px; cursor: pointer; }
.giou-filters button[data-on="1"] { border-color: var(--dsw-color-primary, #4e6ef2); color: var(--dsw-color-primary, #4e6ef2); }
.giou-list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 5px; }
.giou-item { display: flex; gap: 8px; border: 1px solid var(--dsw-color-border, #e5e6eb); border-radius: 9px; padding: 6px 7px; background: transparent; color: inherit; text-align: left; cursor: pointer; width: 100%; box-sizing: border-box; font: inherit; }
.giou-item[data-on="1"] { border-color: var(--dsw-color-primary, #4e6ef2); background: rgba(78,110,242,.06); }
.giou-item[data-overdue="1"] { border-color: #ff7875; background: rgba(255,120,117,.07); }
.giou-item[data-overdue="1"] .id, .giou-item[data-overdue="1"] .meta { color: #cf1322; }
.giou-item img { width: 46px; height: 46px; object-fit: cover; border-radius: 6px; flex: none; background: #000; }
.giou-item .ph { width: 46px; height: 46px; border-radius: 6px; flex: none; background: var(--dsw-color-bg-2, #f7f8fa); color: #8a9099; font-size: 9px; display: flex; align-items: center; justify-content: center; text-align: center; }
.giou-item .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.giou-item .id { font-weight: 600; font-size: 11px; }
.giou-item .meta { font-size: 10px; color: #8a9099; }
.giou-badge { border-radius: 999px; padding: 0 8px; font-size: 10px; border: 1px solid var(--dsw-color-border, #e5e6eb); color: #646a73; white-space: nowrap; }
.giou-badge[data-tone="overdue"], .giou-badge[data-tone="escalated"] { border-color: #ff7875; color: #cf1322; background: rgba(255,120,117,.10); }
.giou-badge[data-tone="pending_rectify"] { border-color: #ffe58f; color: #ad6800; background: rgba(255,229,143,.16); }
.giou-badge[data-tone="rectified"], .giou-badge[data-tone="approved"] { border-color: #b7eb8f; color: #237804; background: rgba(183,235,143,.16); }
.giou-right { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; padding: 10px 12px 18px; display: flex; flex-direction: column; gap: 9px; }
.giou-h2 { font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.giou-quote { border-left: 3px solid var(--dsw-color-border, #e5e6eb); padding: 2px 9px; color: #646a73; font-size: 12px; }
.giou-statusrow { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; font-size: 11px; color: #646a73; }
.giou-why { border: 1px solid #d6e4ff; background: #f0f5ff; border-radius: 9px; padding: 8px 10px; display: flex; flex-direction: column; gap: 3px; }
.giou-why .h { font-weight: 600; font-size: 11px; color: #0958d9; }
.giou-why .r { font-size: 11px; color: #1f2329; }
.giou-card { border: 1px solid var(--dsw-color-border, #e5e6eb); border-radius: 9px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.giou-card .head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.giou-card .nm { font-weight: 600; }
.giou-conf { border-radius: 999px; padding: 0 8px; font-size: 10px; border: 1px solid var(--dsw-color-border, #e5e6eb); }
.giou-conf[data-level="high"] { border-color: #b7eb8f; color: #237804; }
.giou-conf[data-level="mid"] { border-color: #ffe58f; color: #ad6800; }
.giou-conf[data-level="low"] { border-color: #ffccc7; color: #cf1322; }
.giou-field { display: grid; grid-template-columns: 58px 1fr; gap: 2px 8px; font-size: 11px; }
.giou-field .k { color: #8a9099; }
.giou-field .v { word-break: break-word; }
.giou-photos { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; }
.giou-shot { border: 1px solid var(--dsw-color-border, #e5e6eb); border-radius: 9px; overflow: hidden; background: #000; position: relative; max-width: 100%; }
.giou-shot img { display: block; max-width: 100%; max-height: 340px; }
.giou-mark { position: absolute; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; background: #ff3b30; box-shadow: 0 0 0 2px rgba(255,255,255,.85); pointer-events: none; }
.giou-frame { position: absolute; border: 2px solid #ff3b30; border-radius: 3px; box-shadow: 0 0 0 1px rgba(255,255,255,.65) inset; pointer-events: none; }
.giou-basis { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: 5px; }
.giou-timeline { display: flex; flex-direction: column; gap: 2px; border-left: 2px solid var(--dsw-color-border, #e5e6eb); padding-left: 8px; margin-left: 2px; font-size: 10px; color: #646a73; }
.giou-timeline b { color: #1f2329; }
.giou-actions { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
.giou-note { width: 100%; min-height: 40px; border: 1px solid var(--dsw-color-border, #e5e6eb); border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 11px; background: transparent; color: inherit; box-sizing: border-box; }
.giou-empty { border: 1px dashed var(--dsw-color-border, #e5e6eb); border-radius: 9px; padding: 14px; text-align: center; color: #8a9099; font-size: 11px; }
.giou-skel { height: 52px; border-radius: 9px; background: linear-gradient(90deg, rgba(0,0,0,.05), rgba(0,0,0,.10), rgba(0,0,0,.05)); }
.giou-table { width: 100%; border-collapse: collapse; font-size: 11px; }
.giou-table th { text-align: left; color: #8a9099; font-weight: 600; border-bottom: 1px solid var(--dsw-color-border, #e5e6eb); padding: 4px 5px; white-space: nowrap; }
.giou-table td { border-bottom: 1px solid var(--dsw-color-border, #e5e6eb); padding: 4px 5px; vertical-align: top; word-break: break-word; }
.giou-table tr[data-bad="1"] td { color: #cf1322; }
.giou-table .mono { font-family: ui-monospace, Menlo, Consolas, monospace; }
.giou-dockbtn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-color-border, #e5e6eb); border-radius: 6px; padding: 3px 10px; font-size: 12px; cursor: pointer; background: transparent; color: inherit; }
.giou-dockbtn:hover { border-color: var(--dsw-color-primary, #4e6ef2); color: var(--dsw-color-primary, #4e6ef2); }
`

    // ── 纯工具 ──────────────────────────────────────────────────────────────
    function textOf(value) {
      if (value === undefined || value === null) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return String(value)
    }

    function trim(value) {
      return textOf(value).replace(/^\s+|\s+$/g, '')
    }

    function numOrNull(value) {
      return typeof value === 'number' && isFinite(value) ? value : null
    }

    function pad2(value) {
      return value < 10 ? '0' + value : String(value)
    }

    function clockOf(value) {
      if (typeof value === 'number' && isFinite(value)) {
        const date = new Date(value)
        return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
      }
      const parsed = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null
      if (parsed && !isNaN(parsed.getTime())) return pad2(parsed.getHours()) + ':' + pad2(parsed.getMinutes())
      return ''
    }

    function dateTimeOf(value) {
      const parsed = typeof value === 'string' || typeof value === 'number' ? new Date(value) : null
      if (!parsed || isNaN(parsed.getTime())) return textOf(value)
      return pad2(parsed.getMonth() + 1) + '-' + pad2(parsed.getDate()) + ' ' + pad2(parsed.getHours()) + ':' + pad2(parsed.getMinutes())
    }

    function latencyOf(ms) {
      const value = numOrNull(ms)
      if (value === null) return '—'
      if (value < 1000) return value + 'ms'
      return (value / 1000).toFixed(2) + 's'
    }

    function tokensOf(usage) {
      if (!usage || typeof usage !== 'object') return '—'
      const direct = numOrNull(usage.totalTokens)
      if (direct !== null) return String(direct)
      const input = numOrNull(usage.inputTokens)
      const output = numOrNull(usage.outputTokens)
      if (input !== null || output !== null) return (input === null ? '—' : String(input)) + '/' + (output === null ? '—' : String(output))
      return '—'
    }

    function statusLabelOf(raw) {
      const key = trim(textOf(raw)).toLowerCase()
      if (!key) return '未知'
      return STATUS_LABELS[key] || textOf(raw)
    }

    /** 状态色档（逾期 / 已升级 / 待复核 / 已通过 …）。 */
    function statusToneOf(item) {
      const key = trim(textOf(item && item.status)).toLowerCase()
      if (item && item.escalated) return 'escalated'
      if (item && item.overdue) return 'overdue'
      return key || 'unknown'
    }

    /** 短编号：`INS-20261002-201530-ab12` → `#ab12`。 */
    function shortNo(id) {
      const raw = trim(textOf(id))
      if (!raw) return ''
      if (raw.charAt(0) === '#' || raw.charAt(0) === 'Q') return raw.charAt(0) === '#' ? raw : '#' + raw
      const parts = raw.split('-').filter(Boolean)
      const tail = parts.length > 1 ? parts[parts.length - 1] : raw
      return '#' + tail
    }

    /**
     * 置信度（画面级 §二 2.2：**用文字 高/中/低，不用百分比**）。
     * be 已就绪：`finding.confidence`（高/中/低）+ `finding.confidenceSource`（'model' | 'missing'）。
     *   · `confidenceSource === 'model'` 且值非空 → 直接展示（卡上写"模型置信度：高"）；
     *   · `'missing'` / 空值 → **不显示、不折算**（避免拿严重度冒充置信度）；
     *   · 字段整个不存在（旧数据）→ 才按 severity 折算，并**在卡上标注来源**。
     */
    function confidenceOf(finding) {
      const source = trim(textOf(finding && finding.confidenceSource))
      const explicit = trim(textOf(finding && (finding.confidence || finding.confidenceLabel)))
      if (explicit) {
        const level = /高/.test(explicit) || explicit.toLowerCase() === 'high' ? 'high' : /低/.test(explicit) || explicit.toLowerCase() === 'low' ? 'low' : 'mid'
        return { level, label: /^(高|中|低)$/.test(explicit) ? explicit : level === 'high' ? '高' : level === 'low' ? '低' : '中', from: source === 'missing' ? 'backend-empty' : 'backend', display: true }
      }
      if (source === 'missing' || source === 'backend') return { level: 'none', label: '未标注', from: 'backend-empty', display: false }
      const score = numOrNull(finding && finding.confidenceScore)
      if (score !== null) {
        if (score >= 0.8) return { level: 'high', label: '高', from: 'score', display: true }
        if (score >= 0.6) return { level: 'mid', label: '中', from: 'score', display: true }
        return { level: 'low', label: '低', from: 'score', display: true }
      }
      const sev = trim(textOf(finding && finding.severity))
      if (sev === '高') return { level: 'high', label: '高', from: 'severity', display: true }
      if (sev === '低') return { level: 'low', label: '低', from: 'severity', display: true }
      if (sev) return { level: 'mid', label: '中', from: 'severity', display: true }
      return { level: 'none', label: '未标注', from: 'unknown', display: false }
    }

    /** 置信度来源说明（只在非"模型直接给"时标注，避免口径混淆）。 */
    function confidenceNoteOf(confidence) {
      if (confidence.from === 'backend') return '模型置信度：' + confidence.label
      if (confidence.from === 'backend-empty') return '模型未给置信度（后端标注 missing）'
      if (confidence.from === 'score') return '按后端置信度分值折算：' + confidence.label
      if (confidence.from === 'severity') return '后端未给置信度，按严重度折算：' + confidence.label
      return '未标注'
    }

    /**
     * 证据定位（本条命门；字段口径以 be 最终实现为准）：
     *   · `data.hasBoxes === true` / `boxes[]` 非空 → 画框 + 框心标点；
     *   · `boxes` 空但 `fallbackPoint {x,y,unit:'ratio',text,source}` 非 null → 图上标点（不画框）+ 旁边写依据文字；
     *   · 两者都空（后端明确返回 `fallbackPoint: null` = **模型确实无法定位**）→ 图上什么都不画，**绝不画空框**。
     */
    function locateEvidence(data) {
      const boxes = []
      const raw = data && Array.isArray(data.boxes) ? data.boxes : []
      for (const box of raw) {
        if (!box || typeof box !== 'object') continue
        const x = Number(box.x)
        const y = Number(box.y)
        const w = Number(box.w)
        const h = Number(box.h)
        if (!isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) continue
        if (w <= 0 || h <= 0) continue
        if (w > 1 || h > 1 || x < 0 || y < 0 || x > 1 || y > 1) continue
        boxes.push({ x, y, w, h })
      }
      const pointRaw = data && data.fallbackPoint && typeof data.fallbackPoint === 'object' ? data.fallbackPoint : null
      let point = null
      if (pointRaw) {
        const x = Number(pointRaw.x)
        const y = Number(pointRaw.y)
        const unit = trim(textOf(pointRaw.unit)) || 'ratio'
        if (isFinite(x) && isFinite(y) && unit === 'ratio' && x >= 0 && x <= 1 && y >= 0 && y <= 1) {
          point = { x, y, unit, text: trim(textOf(pointRaw.text)), source: trim(textOf(pointRaw.source)) || 'model' }
        }
      }
      // 只信 boxes 与 fallbackPoint；hasBoxes 只作交叉印证（不一致时以实际坐标为准，不臆造）
      const strategy = boxes.length > 0 ? 'box' : point ? 'point' : 'none'
      return { boxes, point, strategy, unit: trim(textOf(data && data.boxesUnit)) || 'ratio', hasBoxesField: data && data.hasBoxes === true }
    }

    function measureSuffix(box, unit) {
      if (unit === 'ratio') return 'x=' + (box.x * 100).toFixed(1) + '% y=' + (box.y * 100).toFixed(1) + '% w=' + (box.w * 100).toFixed(1) + '% h=' + (box.h * 100).toFixed(1) + '%'
      return 'x=' + box.x + ' y=' + box.y + ' w=' + box.w + ' h=' + box.h
    }

    async function getJson(path) {
      const response = await fetch(path, { headers: { accept: 'application/json' } })
      if (!response.ok) {
        const error = new Error('HTTP ' + response.status)
        error.status = response.status
        throw error
      }
      return response.json()
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body === undefined ? {} : body),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch (error) {
        payload = null
      }
      if (!response.ok) {
        const failure = new Error(payload && payload.error ? textOf(payload.error.message || payload.error.code) : 'HTTP ' + response.status)
        failure.status = response.status
        failure.payload = payload
        throw failure
      }
      return payload
    }

    /**
     * 图片 URL：**只消费后端拼好的 URL**（snapshot 的 `findings[].thumbUrl/originalUrl`、
     * evidence 的 `data.photo.thumbUrl/originalUrl`）。**不自拼 `/photo?path=`**——后端按库内
     * `photoId` 取图（`?id=<16位小写hex>&kind=thumb|original`），裸路径口已不存在。
     * 这里仅在后端只给了裸路径（旧形状）时做一次兼容，且明确标注为兼容分支。
     */
    function photoUrlOf(rawUrlOrPath) {
      const p = trim(textOf(rawUrlOrPath))
      if (!p) return ''
      if (/^https?:/i.test(p) || p.charAt(0) === '/') return p
      return PHOTO_PATH + '?path=' + encodeURIComponent(p) // 兼容旧形状；后端已改为 ?id=
    }

    // ── 数据归一 ────────────────────────────────────────────────────────────
    function normalizeFinding(raw) {
      if (!raw || typeof raw !== 'object') return null
      const findingId = textOf(raw.findingId || raw.id)
      if (!findingId) return null
      return {
        findingId,
        itemName: textOf(raw.itemName || raw.name) || '未命名检查项',
        severity: textOf(raw.severity),
        confidence: textOf(raw.confidence || raw.confidenceLabel),
        confidenceSource: textOf(raw.confidenceSource),
        confidenceScore: numOrNull(raw.confidenceScore),
        reason: textOf(raw.reason),
        suggestion: textOf(raw.suggestion),
        dueAt: raw.dueAt === undefined ? null : raw.dueAt,
        status: textOf(raw.status) || 'unknown',
        boxesCount: Array.isArray(raw.boxes) ? raw.boxes.length : 0,
        thumbUrl: photoUrlOf(raw.thumbUrl || raw.thumbPath),
        originalUrl: photoUrlOf(raw.originalUrl || raw.originalPath),
      }
    }

    function normalizeInspection(raw) {
      if (!raw || typeof raw !== 'object') return null
      const id = textOf(raw.id || raw.inspectionId)
      if (!id) return null
      const findings = Array.isArray(raw.findings) ? raw.findings.map(normalizeFinding).filter(Boolean) : []
      return {
        id,
        storeId: textOf(raw.storeId),
        storeName: textOf(raw.storeName) || textOf(raw.storeId),
        storeType: textOf(raw.storeType),
        note: textOf(raw.note),
        status: textOf(raw.status) || 'unknown',
        source: textOf(raw.source),
        demo: raw.demo === true,
        judgeFailure: raw.judgeFailure && typeof raw.judgeFailure === 'object' ? raw.judgeFailure : null,
        createdAt: raw.createdAt === undefined ? null : raw.createdAt,
        dueAt: raw.dueAt === undefined ? null : raw.dueAt,
        overdue: raw.overdue === true,
        escalated: raw.escalated === true || trim(textOf(raw.status)).toLowerCase() === 'escalated',
        items: Array.isArray(raw.items) ? raw.items : [],
        reasons: textOf(raw.reasons),
        unreadable: Array.isArray(raw.unreadable) ? raw.unreadable : [],
        findings,
        actions: Array.isArray(raw.actions) ? raw.actions.filter((item) => item && typeof item === 'object') : [],
      }
    }

    function normalizeSnapshot(raw) {
      const data = raw && typeof raw === 'object' ? raw : {}
      if (data.ok === false) {
        return { ok: false, error: data.error || null, stores: [], inspections: [], counts: {}, offline: null, pendingQueue: null, ts: null }
      }
      const stores = Array.isArray(data.stores)
        ? data.stores
            .map((store) => (store && typeof store === 'object' ? { storeId: textOf(store.storeId || store.id), storeName: textOf(store.storeName || store.name) } : null))
            .filter((store) => store && store.storeId)
        : []
      const inspections = Array.isArray(data.inspections) ? data.inspections.map(normalizeInspection).filter(Boolean) : []
      return {
        ok: true,
        error: null,
        ts: data.ts === undefined ? null : data.ts,
        stores,
        inspections,
        counts: data.counts && typeof data.counts === 'object' ? data.counts : {},
        offline: data.offline && typeof data.offline === 'object' ? data.offline : null,
        pendingQueue: data.pendingQueue && typeof data.pendingQueue === 'object' ? data.pendingQueue : null,
      }
    }

    /** 统计行：`今日 N 条 · 待你判断 M 条 · 逾期 K 条`（今日按本地日界算）。 */
    function statsOf(snapshot, now) {
      const data = snapshot && snapshot.ok !== false ? snapshot : null
      const list = data ? data.inspections : []
      const day = new Date(now)
      const startOfDay = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime()
      let today = 0
      let pending = 0
      let overdue = 0
      for (const item of list) {
        const created = item.createdAt ? new Date(item.createdAt).getTime() : NaN
        if (isFinite(created) ? created >= startOfDay : true) today += 1
        const status = trim(item.status).toLowerCase()
        if (status === 'pending_rectify' || status === 'pending' || status === 'analyzing' || status === 'running') pending += 1
        if (item.overdue) overdue += 1
      }
      return { today, pending, overdue, total: list.length }
    }

    function filterInspections(list, filter) {
      if (filter === 'overdue') return list.filter((item) => item.overdue)
      if (filter === 'all') return list.slice()
      const pending = list.filter((item) => {
        const status = trim(item.status).toLowerCase()
        return status === 'pending_rectify' || status === 'pending' || status === 'analyzing' || status === 'running'
      })
      return pending.length > 0 ? pending : list.filter((item) => item.overdue)
    }

    function sortByTimeDesc(list) {
      return list.slice().sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return (isFinite(tb) ? tb : 0) - (isFinite(ta) ? ta : 0)
      })
    }

    function actionLabelOf(type, target) {
      const key = trim(textOf(type)).toLowerCase()
      if (ACTION_CODE_WORDS[key]) return ACTION_CODE_WORDS[key]
      if (key === 'rectify_request' || key === 'rectify' || key === 'request') return '整改要求'
      if (key === 'remind' || key === 'urge' || key === 'notify') return '催办'
      if (key === 'escalate' || key === 'escalation') return '升级'
      if (key === 'scan') return '扫描'
      if (key === 'approve' || key === 'review_approve') return '通过'
      if (key === 'reject' || key === 'review_reject') return '退回'
      return textOf(type) || textOf(target) || '动作'
    }

    // ── 取数：snapshot ──────────────────────────────────────────────────────
    // 【必须换引用的快照】React 的 useSyncExternalStore 用 Object.is 比对 getSnapshot() 的返回值：
    // 若 getSnapshot 永远返回同一个被原地改属性的对象，React 判定「快照没变」直接 bailout，
    // 订阅它的组件永不重渲染（面板打不开、状态行不更新都由此而来）。所以每个 store 都维护一份
    // 只在 notify() 时重建的不可变快照，getSnapshot 一律返回它。
    const snapshotSource = {
      data: null,
      failure: '',
      lastOkAt: null,
      pending: null,
      snapshot: { data: null, failure: '', lastOkAt: null },
      listeners: new Set(),
      subscribe(listener) {
        snapshotSource.listeners.add(listener)
        return () => snapshotSource.listeners.delete(listener)
      },
      notify() {
        snapshotSource.snapshot = { data: snapshotSource.data, failure: snapshotSource.failure, lastOkAt: snapshotSource.lastOkAt }
        snapshotSource.listeners.forEach((listener) => {
          try {
            listener()
          } catch (error) {
            /* 忽略 */
          }
        })
      },
    }

    function pullSnapshot() {
      if (snapshotSource.pending) return snapshotSource.pending
      let inflight = null
      inflight = getJson(SNAPSHOT_PATH)
        .then((raw) => {
          const next = normalizeSnapshot(raw)
          if (next.ok === false) {
            snapshotSource.failure = textOf(next.error && (next.error.message || next.error.code)) || '后端未就绪'
            return
          }
          snapshotSource.data = next
          snapshotSource.failure = ''
          snapshotSource.lastOkAt = clockOf(Date.now())
        })
        .catch((error) => {
          const status = error && error.status
          snapshotSource.failure = status === 404 ? '看板后端未就绪（路由 404）' : textOf((error && error.message) || error) || '请求失败'
        })
        .then(() => {
          if (snapshotSource.pending === inflight) snapshotSource.pending = null
          snapshotSource.notify()
        })
      snapshotSource.pending = inflight
      return inflight
    }

    // ── 取数：模型调用日志 ──────────────────────────────────────────────────
    const logsSource = {
      data: null,
      failure: '',
      lastOkAt: null,
      auto: false,
      pending: null,
      snapshot: { data: null, failure: '', lastOkAt: null, auto: false },
      listeners: new Set(),
      subscribe(listener) {
        logsSource.listeners.add(listener)
        return () => logsSource.listeners.delete(listener)
      },
      notify() {
        logsSource.snapshot = { data: logsSource.data, failure: logsSource.failure, lastOkAt: logsSource.lastOkAt, auto: logsSource.auto }
        logsSource.listeners.forEach((listener) => {
          try {
            listener()
          } catch (error) {
            /* 忽略 */
          }
        })
      },
    }

    /**
     * 日志行归一。**脱敏红线**：只透传业务摘要字段；即便后端误带 apiKey / Authorization 之类字段，
     * 这里也**不读取、不展示**（前端只认下面这张白名单）。
     */
    function normalizeCall(raw) {
      if (!raw || typeof raw !== 'object') return null
      return {
        callId: textOf(raw.callId || raw.id),
        ts: raw.ts === undefined ? null : raw.ts,
        provider: textOf(raw.provider),
        model: textOf(raw.model),
        kind: textOf(raw.kind),
        // 「提示词版本」：后端若给 promptVersion 用之；没给就沿用调用类型（如实标注为类型）
        promptVersion: textOf(raw.promptVersion || raw.prompt),
        // 字段**是否存在**与"空值"分开：失败调用本来就 responseSummary=null（不是"后端缺字段"）
        hasPromptVersion: raw.promptVersion !== undefined,
        requestSummary: textOf(raw.requestSummary),
        hasRequestSummary: raw.requestSummary !== undefined,
        responseSummary: textOf(raw.responseSummary),
        hasResponseSummary: raw.responseSummary !== undefined && raw.responseSummary !== null,
        inspectionId: textOf(raw.inspectionId),
        storeId: textOf(raw.storeId),
        latencyMs: numOrNull(raw.latencyMs),
        usage: raw.usage === undefined ? null : raw.usage,
        status: textOf(raw.status) || 'unknown',
        errorCode: textOf(raw.errorCode),
      }
    }

    function pullLogs() {
      if (logsSource.pending) return logsSource.pending
      let inflight = null
      inflight = getJson(MODELCALLS_PATH)
        .then((raw) => {
          const data = raw && typeof raw === 'object' ? raw : {}
          if (data.ok === false) {
            logsSource.failure = textOf(data.error && (data.error.message || data.error.code)) || '后端未就绪'
            return
          }
          const calls = Array.isArray(data.calls) ? data.calls.map(normalizeCall).filter(Boolean) : []
          logsSource.data = { calls, count: typeof data.count === 'number' ? data.count : calls.length, logFile: textOf(data.logFile) }
          logsSource.failure = ''
          logsSource.lastOkAt = clockOf(Date.now())
        })
        .catch((error) => {
          const status = error && error.status
          logsSource.failure = status === 404 ? '日志后端未就绪（路由 404）' : textOf((error && error.message) || error) || '请求失败'
        })
        .then(() => {
          if (logsSource.pending === inflight) logsSource.pending = null
          logsSource.notify()
        })
      logsSource.pending = inflight
      return inflight
    }

    // ── 动作：立即扫描（真动作）─────────────────────────────────────────────
    const scanState = {
      phase: 'idle',
      receipt: null,
      error: '',
      snapshot: { phase: 'idle', receipt: null, error: '' },
      listeners: new Set(),
      subscribe(listener) {
        scanState.listeners.add(listener)
        return () => scanState.listeners.delete(listener)
      },
      notify() {
        scanState.snapshot = { phase: scanState.phase, receipt: scanState.receipt, error: scanState.error }
        scanState.listeners.forEach((listener) => {
          try {
            listener()
          } catch (error) {
            /* 忽略 */
          }
        })
      },
    }

    function scanSummaryOf(payload) {
      const root = payload && typeof payload === 'object' ? payload : {}
      const data = root.data && typeof root.data === 'object' ? root.data : root
      const scanned = numOrNull(data.scanned) !== null ? data.scanned : numOrNull(root.scanned)
      const created = Array.isArray(data.actionsCreated) ? data.actionsCreated.length : Array.isArray(root.actionsCreated) ? root.actionsCreated.length : null
      const marked = Array.isArray(data.markedOverdue) ? data.markedOverdue.length : Array.isArray(root.markedOverdue) ? root.markedOverdue.length : null
      const parts = []
      if (scanned !== null) parts.push('扫描 ' + scanned + ' 条')
      if (marked !== null) parts.push('标记逾期 ' + marked + ' 条')
      if (created !== null) parts.push('新增催办·升级 ' + created + ' 条')
      const summary = textOf(data.summary || root.summary)
      if (parts.length === 0 && !summary) return '扫描已完成（后端未返回计数）'
      return parts.join('、') + (summary ? (parts.length ? '｜' : '') + summary : '')
    }

    async function runScan() {
      if (scanState.phase === 'busy') return null
      scanState.phase = 'busy'
      scanState.error = ''
      scanState.receipt = null
      scanState.notify()
      try {
        const payload = await postJson(SCAN_PATH, { reason: 'manual' })
        if (payload && payload.ok === false) {
          scanState.phase = 'failed'
          scanState.error = textOf((payload.error && (payload.error.message || payload.error.code)) || '后端未执行扫描')
        } else {
          scanState.phase = 'done'
          scanState.receipt = { summary: scanSummaryOf(payload), at: clockOf(Date.now()) }
        }
        pullSnapshot()
        scanState.notify()
        return scanState.receipt
      } catch (error) {
        const payload = error && error.payload
        scanState.phase = 'failed'
        scanState.error = payload && payload.error ? textOf(payload.error.message || payload.error.code) : '扫描失败：' + textOf((error && error.message) || error)
        scanState.notify()
        return null
      }
    }

    // ── 动作：督导复核（通过 / 退回并说明 / 催办）────────────────────────────
    const actionState = {
      busy: '',
      error: '',
      records: [],
      snapshot: { busy: '', error: '', records: [] },
      listeners: new Set(),
      subscribe(listener) {
        actionState.listeners.add(listener)
        return () => actionState.listeners.delete(listener)
      },
      notify() {
        actionState.snapshot = { busy: actionState.busy, error: actionState.error, records: actionState.records.slice() }
        actionState.listeners.forEach((listener) => {
          try {
            listener()
          } catch (error) {
            /* 忽略 */
          }
        })
      },
    }

    /**
     * 督导动作记录。画面级说明 §二 2.2：`通过` / `退回并说明` / `催办`，**每次动作写入记录（时间、操作者、结果）**。
     * be 已注册 `POST /api/gaia-inspection/review`（与 `/review-action` 等价、同一 handler），本包用前者：
     *   body `{inspectionId, findingId, action, operator, reason, at}`，`action` 中文三种都认；
     *   回执 `{ok, runId, status, summary, data:{inspectionId,actionId,action,inspectionStatus,dueAt?},
     *          action:{id,type,actionCode,target,createdAt,reason,actor,actorName,actorIsHuman,result}}`。
     * 失败码按结构化处理（不当成功）：`BAD_BODY`（两 id 都没给）/ `REASON_REQUIRED`（退回没写原因）/
     * `BAD_ACTION` / `INSPECTION_NOT_FOUND` / `FINDING_NOT_FOUND`。
     * 口不可用时：本机留痕并标「⚠ 未同步到后端」，**不假装成功**。
     */
    async function recordAction({ inspectionId, findingId, type, reason }) {
      const at = new Date().toISOString()
      if (actionState.busy) return null
      const actionWord = ACTION_WORDS[type] || ''
      if (!actionWord) {
        actionState.error = '未知动作：' + textOf(type)
        actionState.notify()
        return null
      }
      if (!trim(textOf(inspectionId)) && !trim(textOf(findingId))) {
        actionState.error = '缺少检查单与判断标识（后端会返回 BAD_BODY）'
        actionState.notify()
        return null
      }
      if (actionWord === '退回并说明' && trim(reason).length === 0) {
        actionState.error = '退回并说明必须写原因（后端会返回 REASON_REQUIRED）'
        actionState.notify()
        return null
      }
      actionState.busy = type
      actionState.error = ''
      actionState.notify()
      const payload = {
        inspectionId: trim(textOf(inspectionId)) || undefined,
        findingId: trim(textOf(findingId)) || undefined,
        action: actionWord,
        operator: '督导（演示视图）',
        reason: trim(reason) || undefined,
        at,
      }
      const entry = { at, type, actionWord, target: trim(textOf(inspectionId)), reason: trim(reason), synced: false, resultNote: '', actionCode: '', who: '督导（演示视图）' }
      try {
        const response = await postJson(REVIEW_ACTION_PATH, payload)
        if (response && response.ok === false) {
          actionState.error = textOf((response.error && (response.error.message || response.error.code)) || '后端未接受该动作')
        } else {
          entry.synced = true
          const back = response && response.action && typeof response.action === 'object' ? response.action : null
          const data = response && response.data && typeof response.data === 'object' ? response.data : null
          entry.actionCode = textOf(back && back.actionCode)
          entry.who = textOf((back && (back.actorName || back.actor)) || entry.who)
          const parts = []
          if (back && back.id) parts.push('记录 ' + textOf(back.id))
          if (back && back.result) parts.push(textOf(back.result))
          if (data && data.inspectionStatus) parts.push('检查单状态 ' + textOf(data.inspectionStatus))
          if (data && data.dueAt) parts.push('新截止 ' + (dateTimeOf(data.dueAt) || textOf(data.dueAt)))
          entry.resultNote = parts.join('｜')
        }
      } catch (error) {
        const failure = error && error.payload
        actionState.error = failure && failure.error
          ? textOf(failure.error.message || failure.error.code)
          : '动作未同步到后端：' + textOf((error && error.message) || error)
      }
      actionState.records.unshift(entry)
      while (actionState.records.length > 30) actionState.records.pop()
      actionState.busy = ''
      actionState.notify()
      pullSnapshot()
      return entry
    }

    // ── 取数：证据（面板内放大区，不是浮层）────────────────────────────────
    const evidenceState = {
      byId: {},
      loadingId: '',
      listeners: new Set(),
      subscribe(listener) {
        evidenceState.listeners.add(listener)
        return () => evidenceState.listeners.delete(listener)
      },
      notify() {
        evidenceState.listeners.forEach((listener) => {
          try {
            listener()
          } catch (error) {
            /* 忽略 */
          }
        })
      },
      get(findingId) {
        return evidenceState.byId[findingId] || null
      },
      load(findingId) {
        const id = trim(textOf(findingId))
        if (!id) return Promise.resolve(null)
        const existing = evidenceState.byId[id]
        if (existing && existing.phase === 'hit') return Promise.resolve(existing)
        if (evidenceState.loadingId === id) return Promise.resolve(existing)
        evidenceState.byId[id] = { phase: 'loading', data: null, summary: '', error: '' }
        evidenceState.loadingId = id
        evidenceState.notify()
        return getJson(EVIDENCE_PATH + '?id=' + encodeURIComponent(id))
          .then((payload) => {
            const data = payload && typeof payload === 'object' ? payload : {}
            if (data.ok === false) {
              evidenceState.byId[id] = { phase: 'error', data: null, summary: '', error: textOf(data.error && (data.error.message || data.error.code)) || '证据接口不可用' }
            } else if (!data.data) {
              evidenceState.byId[id] = { phase: 'miss', data: null, summary: textOf(data.summary) || '未找到该证据', error: '' }
            } else {
              evidenceState.byId[id] = { phase: 'hit', data: data.data, summary: textOf(data.summary), error: '' }
            }
            return evidenceState.byId[id]
          })
          .catch((error) => {
            const status = error && error.status
            evidenceState.byId[id] = {
              phase: status === 404 ? 'miss' : 'error',
              data: null,
              summary: status === 404 ? '证据接口未就绪（该 id 无法回查）' : '',
              error: status === 404 ? '' : '证据接口不可用：' + textOf((error && error.message) || error),
            }
            return evidenceState.byId[id]
          })
          .then((value) => {
            if (evidenceState.loadingId === id) evidenceState.loadingId = ''
            evidenceState.notify()
            return value
          })
      },
    }

    // ── 面板开关（督导端主入口）────────────────────────────────────────────
    const panelState = {
      open: false,
      view: 'board', // board | logs
      snapshot: { open: false, view: 'board' },
      listeners: new Set(),
      subscribe(listener) {
        panelState.listeners.add(listener)
        return () => panelState.listeners.delete(listener)
      },
      notify() {
        panelState.snapshot = { open: panelState.open, view: panelState.view }
        panelState.listeners.forEach((listener) => {
          try {
            listener()
          } catch (error) {
            /* 忽略 */
          }
        })
      },
      setOpen(next, view) {
        const value = next === true
        if (view) panelState.view = view === 'logs' ? 'logs' : 'board'
        if (panelState.open === value) {
          panelState.notify()
          return
        }
        panelState.open = value
        panelState.notify()
        if (value) {
          pullSnapshot()
          if (panelState.view === 'logs') pullLogs()
        }
      },
      setView(view) {
        panelState.view = view === 'logs' ? 'logs' : 'board'
        panelState.notify()
        if (panelState.view === 'logs') pullLogs()
      },
    }

    // ── 右侧栏「模型调用日志」独立 tab（与面板入口并存，二者都一步可点）────
    const rightbarTabState = {
      opened: false,
      listeners: new Set(),
      subscribe(listener) {
        rightbarTabState.listeners.add(listener)
        return () => rightbarTabState.listeners.delete(listener)
      },
      notify() {
        rightbarTabState.listeners.forEach((listener) => {
          try {
            listener()
          } catch (error) {
            /* 忽略 */
          }
        })
      },
      setOpened(next) {
        rightbarTabState.opened = next === true
        rightbarTabState.notify()
      },
      toggle() {
        rightbarTabState.setOpened(!rightbarTabState.opened)
      },
    }

    function exposeChannels() {
      globalThis.__gaia_inspection_oversight__ = {
        openPanel: (view) => panelState.setOpen(true, view),
        closePanel: () => panelState.setOpen(false),
        runScan: () => runScan(),
        refresh: () => pullSnapshot(),
        scanState,
        actionState,
        evidenceState,
        panelState,
      }
    }

    // ── 组件：日志表（独立面板/独立 tab 共用）───────────────────────────────
    function LogsView() {
      const source = React.useSyncExternalStore(logsSource.subscribe, () => logsSource.snapshot, () => logsSource.snapshot)
      const [storeFilter, setStoreFilter] = React.useState('')
      const [statusFilter, setStatusFilter] = React.useState('')

      React.useEffect(() => {
        pullLogs()
        return undefined
      }, [])

      React.useEffect(() => {
        if (!source.auto) return undefined
        const timer = window.setInterval(pullLogs, LOGS_POLL_MS)
        return () => window.clearInterval(timer)
      }, [source.auto])

      const data = source.data
      const calls = data ? data.calls : []
      const stores = []
      for (const call of calls) if (call.storeId && stores.indexOf(call.storeId) === -1) stores.push(call.storeId)
      const visible = calls.filter((call) => {
        if (storeFilter && call.storeId !== storeFilter) return false
        if (statusFilter && call.status !== statusFilter) return false
        return true
      })

      const children = []

      children.push(
        React.createElement(
          'div',
          { className: 'giou-statusrow', key: 'toolbar', style: { gap: '6px' } },
          React.createElement('span', { className: 'giou-title' }, CAPABILITY_LOGS),
          React.createElement('button', { className: 'giou-btn primary', type: 'button', onClick: () => pullLogs() }, '刷新'),
          React.createElement(
            'button',
            { className: 'giou-btn', type: 'button', onClick: () => { logsSource.auto = !logsSource.auto; logsSource.notify() } },
            (source.auto ? '✓ ' : '') + '每 5 秒自动刷新',
          ),
          React.createElement(
            'select',
            { className: 'giou-btn', value: storeFilter, onChange: (event) => setStoreFilter(event && event.target ? event.target.value : '') },
            [React.createElement('option', { key: '__all', value: '' }, '全部门店'), ...stores.map((id) => React.createElement('option', { key: id, value: id }, id))],
          ),
          React.createElement(
            'select',
            { className: 'giou-btn', value: statusFilter, onChange: (event) => setStatusFilter(event && event.target ? event.target.value : '') },
            [
              React.createElement('option', { key: '__all_st', value: '' }, '全部状态'),
              ...Array.from(new Set(calls.map((call) => call.status).filter(Boolean))).map((status) => React.createElement('option', { key: status, value: status }, status)),
            ],
          ),
          React.createElement('span', null, '本机 ' + String(data ? data.count : '—') + ' 条 · 显示 ' + String(visible.length) + ' 条'),
        ),
      )

      if (source.failure) {
        children.push(
          React.createElement(
            'div',
            { className: 'giou-line warn', key: 'fail' },
            data && source.lastOkAt ? '调用日志不可用 · 上次成功 ' + source.lastOkAt + '（显示的是上次成功的数据）' : '调用日志不可用 · ' + source.failure + '（尚无成功数据）',
          ),
        )
      }

      if (!data) {
        children.push(
          React.createElement('div', { className: 'giou-skel', key: 'skel-a' }),
          React.createElement('div', { className: 'giou-skel', key: 'skel-b' }),
          React.createElement('div', { className: 'giou-line', key: 'none' }, source.failure ? '后端未就绪：装好 gaia-inspection-core 后，这里会逐条列出模型调用记录。' : '正在读取模型调用记录…'),
        )
        return React.createElement('div', { className: 'giou-right', style: { flex: '1' } }, children)
      }

      if (visible.length === 0) {
        children.push(React.createElement('div', { className: 'giou-empty', key: 'zero' }, calls.length === 0 ? LOGS_EMPTY_TEXT : '当前筛选条件下没有记录。'))
      } else {
        const columns = ['时间', '模型', '提示词版本', '提交编号', '请求摘要', '响应摘要', '耗时']
        children.push(
          React.createElement(
            'div',
            { key: 'table', style: { overflowX: 'auto' } },
            React.createElement(
              'table',
              { className: 'giou-table' },
              React.createElement('thead', null, React.createElement('tr', null, columns.map((label) => React.createElement('th', { key: label }, label)))),
              React.createElement(
                'tbody',
                null,
                visible.map((call, index) =>
                  React.createElement(
                    'tr',
                    { key: call.callId || String(index), 'data-bad': call.status === 'failed' || call.status === 'error' ? '1' : '0' },
                    React.createElement('td', { className: 'mono' }, clockOf(call.ts) || textOf(call.ts) || '—'),
                    React.createElement('td', null, call.model || '—'),
                    React.createElement('td', null, call.hasPromptVersion ? call.promptVersion : call.kind ? call.kind + '（类型）' : '—'),
                    React.createElement('td', { className: 'mono' }, call.inspectionId ? shortNo(call.inspectionId) : '—'),
                    React.createElement('td', null, call.hasRequestSummary ? call.requestSummary : '—'),
                    React.createElement('td', null, call.hasResponseSummary ? call.responseSummary : '（本次无响应）'),
                    React.createElement('td', null, latencyOf(call.latencyMs) + (call.status && call.status !== 'ok' ? '｜' + call.status + (call.errorCode ? ' ' + call.errorCode : '') : '')),
                  ),
                ),
              ),
            ),
          ),
        )
        const missing = visible.filter((call) => !call.hasPromptVersion || !call.hasRequestSummary || (!call.hasResponseSummary && call.status === 'ok')).length
        if (missing > 0) {
          children.push(React.createElement('div', { className: 'giou-line warn', key: 'missing' }, '有 ' + missing + ' 条' + LOGS_MISSING_TEXT))
        }
      }

      children.push(React.createElement('div', { className: 'giou-line', key: 'note' }, LOGS_MASKING_TEXT))

      return React.createElement('div', { className: 'giou-right', style: { flex: '1' } }, children)
    }

    // ── 组件：证据区（面板内放大区；有框画框、无框标点、都没有就不画）────────
    function EvidenceArea({ finding, evidence }) {
      const [size, setSize] = React.useState(null)
      const data = evidence && evidence.phase === 'hit' ? evidence.data : null
      const locate = data ? locateEvidence(data) : { boxes: [], point: null, strategy: 'none', unit: 'ratio' }
      const photo = data && data.photo && typeof data.photo === 'object' ? data.photo : {}
      const url = textOf(photo.originalUrl) || textOf(photo.thumbUrl) || finding.originalUrl || finding.thumbUrl

      React.useEffect(() => {
        setSize(null)
      }, [finding.findingId])

      const children = []

      if (evidence && evidence.phase === 'loading') {
        children.push(React.createElement('div', { className: 'giou-line', key: 'loading' }, '正在回查原图…'))
      } else if (evidence && evidence.phase === 'error') {
        children.push(React.createElement('div', { className: 'giou-line err', key: 'err' }, '证据接口不可用：' + evidence.error))
      } else if (evidence && evidence.phase === 'miss') {
        children.push(React.createElement('div', { className: 'giou-line warn', key: 'miss' }, (evidence.summary || '未找到该证据') + '（这条判断没有可回查的证据记录）'))
      }

      if (url) {
        children.push(
          React.createElement(
            'div',
            { className: 'giou-shot', key: 'shot' },
            React.createElement('img', {
              src: url,
              alt: finding.itemName,
              onLoad: (event) => {
                const image = event && event.target
                if (image && image.naturalWidth) setSize({ w: image.naturalWidth, h: image.naturalHeight })
              },
            }),
            size
              ? locate.boxes.map((box, index) =>
                  React.createElement('span', { key: 'f-' + index, className: 'giou-frame', style: { left: box.x * 100 + '%', top: box.y * 100 + '%', width: box.w * 100 + '%', height: box.h * 100 + '%' }, title: '证据区域 ' + (index + 1) + '（' + measureSuffix(box, locate.unit) + '）' }),
                )
              : null,
            size && locate.boxes.length > 0
              ? locate.boxes.map((box, index) =>
                  React.createElement('span', { key: 'p-' + index, className: 'giou-mark', style: { left: (box.x + box.w / 2) * 100 + '%', top: (box.y + box.h / 2) * 100 + '%' }, title: '定位点 ' + (index + 1) }),
                )
              : null,
            size && locate.boxes.length === 0 && locate.point ? React.createElement('span', { className: 'giou-mark', style: { left: locate.point.x * 100 + '%', top: locate.point.y * 100 + '%' }, title: '定位点（模型未给区域框）' }) : null,
          ),
        )
      }

      const basis = []
      if (data) {
        if (locate.strategy === 'box') {
          basis.push(React.createElement('div', { className: 'giou-line ok', key: 'pos' }, '已在原图上框出 ' + locate.boxes.length + ' 处证据区域（归一化比例 0–1，单位 ' + locate.unit + '），框心带定位点。'))
        } else if (locate.strategy === 'point') {
          basis.push(
            React.createElement(
              'div',
              { className: 'giou-line warn', key: 'pos' },
              '模型未给区域框，已在图上标出定位点' + (locate.point && locate.point.text ? '（' + locate.point.text + '）' : '') + '；位置以该点为准，依据文字如下。',
            ),
          )
        } else {
          basis.push(React.createElement('div', { className: 'giou-line warn', key: 'pos' }, '模型确实无法定位（无区域框、也无定位点）：本次降级为「图上不标任何框或点、只写依据文字」——不画空框、不假装有框。'))
        }
        basis.push(React.createElement('div', { className: 'giou-field', key: 'reason' }, React.createElement('span', { className: 'k' }, '依据'), React.createElement('span', { className: 'v' }, textOf(data.reason) || finding.reason || '（模型未给依据文字）')))
        basis.push(React.createElement('div', { className: 'giou-field', key: 'sugg' }, React.createElement('span', { className: 'k' }, '整改要求'), React.createElement('span', { className: 'v' }, textOf(data.suggestion) || finding.suggestion || '未标注')))
        basis.push(React.createElement('div', { className: 'giou-field', key: 'due' }, React.createElement('span', { className: 'k' }, '截止'), React.createElement('span', { className: 'v' }, dateTimeOf(data.dueAt || finding.dueAt) || '未标注')))
      } else {
        basis.push(React.createElement('div', { className: 'giou-line', key: 'pending' }, '点「回看原图」后在这里显示定位与依据。'))
      }

      return React.createElement('div', { className: 'giou-photos' }, [children, React.createElement('div', { className: 'giou-basis', key: 'basis' }, basis)].flat())
    }

    // ── 组件：检查项卡 ──────────────────────────────────────────────────────
    function FindingCard({ finding, storeName, onAction, busyAction }) {
      const [open, setOpen] = React.useState(false)
      const [note, setNote] = React.useState('')
      const [askReason, setAskReason] = React.useState(false)
      const evidence = React.useSyncExternalStore(evidenceState.subscribe, () => evidenceState.get(finding.findingId), () => evidenceState.get(finding.findingId))
      const confidence = confidenceOf(finding)
      const confidenceNote = confidenceNoteOf(confidence)

      const toggle = () => {
        const next = !open
        setOpen(next)
        if (next) evidenceState.load(finding.findingId)
      }

      return React.createElement(
        'div',
        { className: 'giou-card' },
        React.createElement(
          'div',
          { className: 'head' },
          React.createElement('span', { className: 'nm' }, finding.itemName),
          confidence.display
            ? React.createElement('span', { className: 'giou-conf', 'data-level': confidence.level, title: confidenceNote }, '置信度 ' + confidence.label)
            : React.createElement('span', { className: 'giou-conf', 'data-level': 'none', title: confidenceNote }, '置信度 未标注'),
          React.createElement('span', { className: 'giou-badge', 'data-tone': statusToneOf(finding) }, statusLabelOf(finding.status) + (finding.overdue ? ' · 逾期' : '')),
          React.createElement('span', { style: { flex: '1' } }),
          React.createElement('button', { className: 'giou-btn', type: 'button', onClick: toggle }, open ? '收起原图' : '回看原图'),
        ),
        React.createElement('div', { className: 'giou-field' }, React.createElement('span', { className: 'k' }, '判断'), React.createElement('span', { className: 'v' }, textOf(finding.reason) || '（模型未给依据文字）')),
        React.createElement('div', { className: 'giou-field' }, React.createElement('span', { className: 'k' }, '依据'), React.createElement('span', { className: 'v' }, textOf(finding.reason) || '（无）')),
        React.createElement('div', { className: 'giou-field' }, React.createElement('span', { className: 'k' }, '整改'), React.createElement('span', { className: 'v' }, (textOf(finding.suggestion) || '未标注') + '｜截止 ' + (dateTimeOf(finding.dueAt) || '未标注') + (finding.overdue ? '（逾期自动升级）' : '）'))),
        finding.boxesCount > 0
          ? React.createElement('div', { className: 'giou-line', key: 'boxes' }, '模型给了 ' + finding.boxesCount + ' 处区域框（点「回看原图」在图上框出）')
          : null,
        open ? React.createElement(EvidenceArea, { finding, evidence }) : null,
        React.createElement(
          'div',
          { className: 'giou-actions' },
          React.createElement('button', { className: 'giou-btn', type: 'button', disabled: busyAction === 'approve', onClick: () => onAction({ type: 'approve', findingId: finding.findingId, reason: '' }) }, '通过'),
          React.createElement('button', { className: 'giou-btn', type: 'button', onClick: () => setAskReason(!askReason) }, '退回并说明'),
          React.createElement('button', { className: 'giou-btn', type: 'button', disabled: busyAction === 'remind', onClick: () => onAction({ type: 'remind', findingId: finding.findingId, reason: '' }) }, '催办'),
        ),
        askReason
          ? React.createElement(
              'div',
              null,
              React.createElement('textarea', { className: 'giou-note', value: note, placeholder: '写一句退回原因（会写入这条提交的动作记录）', onChange: (event) => setNote(event && event.target ? event.target.value : '') }),
              React.createElement(
                'div',
                { className: 'giou-actions', style: { marginTop: '5px' } },
                React.createElement('button', { className: 'giou-btn primary', type: 'button', disabled: busyAction === 'reject' || trim(note).length === 0, onClick: () => onAction({ type: 'reject', findingId: finding.findingId, reason: note }) }, '确认退回'),
                React.createElement('button', { className: 'giou-btn', type: 'button', onClick: () => { setAskReason(false); setNote('') } }, '取消'),
              ),
            )
          : null,
      )
    }

    // ── 组件：屏 B（左右两栏）──────────────────────────────────────────────
    function BoardView() {
      const source = React.useSyncExternalStore(snapshotSource.subscribe, () => snapshotSource.snapshot, () => snapshotSource.snapshot)
      const scan = React.useSyncExternalStore(scanState.subscribe, () => scanState.snapshot, () => scanState.snapshot)
      const actions = React.useSyncExternalStore(actionState.subscribe, () => actionState.snapshot, () => actionState.snapshot)
      const view = React.useSyncExternalStore(panelState.subscribe, () => panelState.snapshot, () => panelState.snapshot)
      const [filter, setFilter] = React.useState('pending')
      const [selectedId, setSelectedId] = React.useState('')

      React.useEffect(() => {
        pullSnapshot()
        const timer = window.setInterval(pullSnapshot, POLL_MS)
        return () => window.clearInterval(timer)
      }, [])

      const data = source.data
      const list = sortByTimeDesc(data ? data.inspections : [])
      const visible = filterInspections(list, filter)
      const stats = statsOf(data, Date.now())
      const selected = visible.find((item) => item.id === selectedId) || visible[0] || null

      const onAction = async (payload) => {
        if (!selected) return
        await recordAction({ inspectionId: selected.id, findingId: payload.findingId, type: payload.type, reason: payload.reason })
        if (payload.type === 'approve' || payload.type === 'reject') pullSnapshot()
      }

      const children = []

      children.push(
        React.createElement(
          'div',
          { className: 'giou-filters', key: 'filters' },
          FILTERS.map((item) =>
            React.createElement('button', { key: item.key, type: 'button', 'data-on': filter === item.key ? '1' : '0', onClick: () => setFilter(item.key) }, item.label),
          ),
        ),
      )

      if (!data && !source.failure) children.push(React.createElement('div', { className: 'giou-list', key: 'skel' }, [React.createElement('div', { className: 'giou-skel', key: 's1' }), React.createElement('div', { className: 'giou-skel', key: 's2' }), React.createElement('div', { className: 'giou-skel', key: 's3' })]))
      else if (visible.length === 0) children.push(React.createElement('div', { className: 'giou-list', key: 'empty' }, React.createElement('div', { className: 'giou-empty' }, filter === 'overdue' ? '当前没有逾期条目。' : '当前没有待复核')))
      else {
        children.push(
          React.createElement(
            'div',
            { className: 'giou-list', key: 'list' },
            visible.map((item) =>
              React.createElement(
                'button',
                {
                  key: item.id,
                  type: 'button',
                  className: 'giou-item',
                  'data-on': selected && selected.id === item.id ? '1' : '0',
                  'data-overdue': item.overdue ? '1' : '0',
                  onClick: () => setSelectedId(item.id),
                },
                item.findings[0] && item.findings[0].thumbUrl
                  ? React.createElement('img', { src: item.findings[0].thumbUrl, alt: item.id, loading: 'lazy' })
                  : React.createElement('span', { className: 'ph' }, '无缩略图'),
                React.createElement(
                  'span',
                  { className: 'txt' },
                  React.createElement('span', { className: 'id' }, shortNo(item.id) + ' · ' + statusLabelOf(item.status) + (item.overdue ? ' · 已升级' : '')),
                  React.createElement('span', { className: 'meta' }, item.storeName + ' · ' + (clockOf(item.createdAt) || '时间未标注')),
                  React.createElement('span', { className: 'meta' }, (item.note ? trim(item.note).slice(0, 26) : '（无门店原话）')),
                ),
              ),
            ),
          ),
        )
      }

      const detail = []

      if (!selected) {
        detail.push(
          React.createElement('div', { className: 'giou-empty', key: 'nodetail' }, data ? '当前没有待复核：点左侧列表换筛选，或在店长端提交一次新的自查。' : source.failure ? '看板数据不可用：' + source.failure : '正在读取巡店数据…'),
        )
      } else {
        const badgeFinding = selected.findings[0] || null
        detail.push(
          React.createElement(
            'div',
            { className: 'giou-h2', key: 'head' },
            '提交 ' + shortNo(selected.id) + ' · ' + selected.storeName + (selected.storeType ? ' · ' + selected.storeType : ''),
            React.createElement('span', { className: 'giou-badge', 'data-tone': statusToneOf(selected) }, statusLabelOf(selected.status) + (selected.overdue ? ' · 已升级' : '')),
            selected.demo ? React.createElement('span', { className: 'giou-badge' }, '演示样例') : null,
          ),
        )
        detail.push(React.createElement('div', { className: 'giou-quote', key: 'note' }, '门店原话：「' + (trim(selected.note) || '（无）') + '」'))
        detail.push(
          React.createElement(
            'div',
            { className: 'giou-statusrow', key: 'status' },
            React.createElement('span', null, '状态：' + statusLabelOf(selected.status)),
            React.createElement('span', null, '提交 ' + (clockOf(selected.createdAt) || '—')),
            React.createElement('span', null, '截止 ' + (dateTimeOf(selected.dueAt) || '未标注')),
            React.createElement('span', null, '模型调用 ' + (badgeFinding ? '1' : '0') + ' 次'),
            selected.source ? React.createElement('span', null, '来源 ' + selected.source) : null,
          ),
        )

        if (selected.judgeFailure) {
          detail.push(
            React.createElement(
              'div',
              { className: 'giou-line err', key: 'fail' },
              '分析失败：' + textOf(selected.judgeFailure.message || selected.judgeFailure.code) + '（后端未产生判断；可让店长端重试，前端不显示假结果）',
            ),
          )
        }

        const reasons = trim(selected.reasons)
        detail.push(
          React.createElement(
            'div',
            { className: 'giou-why', key: 'why' },
            React.createElement('div', { className: 'h' }, '为什么查这几项（本次动态决定）'),
            reasons
              ? React.createElement('div', { className: 'r' }, reasons)
              : React.createElement('div', { className: 'r' }, selected.items.length > 0
                  ? selected.items
                      .map((item) => {
                        const name = textOf(item && (item.name || item.itemId))
                        const why = textOf(item && item.why)
                        return '· ' + name + (why ? '（' + why + '）' : '')
                      })
                      .join('　')
                  : '（后端未给理由文本：本次检查项由检查项动态生成工具产出，理由应随检查单返回）'),
          ),
        )

        if (selected.unreadable.length > 0) {
          detail.push(React.createElement('div', { className: 'giou-line warn', key: 'unreadable' }, '看不清的照片 ' + selected.unreadable.length + ' 张：未据此下结论（模型侧已标「看不清」）。'))
        }

        if (selected.findings.length === 0) {
          detail.push(React.createElement('div', { className: 'giou-empty', key: 'nofinding' }, '这条提交暂无问题项判断。'))
        }
        selected.findings.forEach((finding) => {
          detail.push(React.createElement(FindingCard, { key: finding.findingId, finding, storeName: selected.storeName, onAction, busyAction: actions.busy }))
        })

        detail.push(React.createElement('div', { className: 'giou-title', key: 'tl-h', style: { fontSize: '11px' } }, '动作记录（时间 · 操作者 · 结果）'))
        const timeline = selected.actions.map((action) => ({
          at: action.createdAt,
          label: actionLabelOf(action.type, action.target),
          who: textOf(action.target) || '系统',
          reason: textOf(action.reason),
          synced: true,
        }))
        for (const record of actions.records) {
          if (record.target !== selected.id) continue
          timeline.push({ at: record.at, label: textOf(record.actionWord) || actionLabelOf(record.actionCode || record.type), who: textOf(record.who) || '督导（演示视图）', reason: record.reason, synced: record.synced, resultNote: textOf(record.resultNote) })
        }
        detail.push(
          timeline.length === 0
            ? React.createElement('div', { className: 'giou-line', key: 'tl-empty' }, '（还没有动作记录：点「通过 / 退回并说明 / 催办」会写入一条）')
            : React.createElement(
                'div',
                { className: 'giou-timeline', key: 'tl' },
                timeline.map((row, index) =>
                  React.createElement(
                    'div',
                    { key: String(index) },
                    React.createElement('b', null, row.label),
                    ' · ' + (clockOf(row.at) || '—') + ' · ' + row.who + (row.reason ? ' · ' + row.reason : '') + (row.resultNote ? ' · ' + row.resultNote : '') + (row.synced ? '' : ' · ⚠ 未同步到后端'),
                  ),
                ),
              ),
        )

        if (actions.error) detail.push(React.createElement('div', { className: 'giou-line err', key: 'act-err' }, '动作未写入后端：' + actions.error + '（已在本机留痕，标为「未同步」；需 gaia-inspection-core 提供督导动作的 HTTP 口，见 README §七）'))
        if (scan.phase === 'done' && scan.receipt) detail.push(React.createElement('div', { className: 'giou-line ok', key: 'scan-ok' }, '扫描回执（' + scan.receipt.at + '）：' + scan.receipt.summary))
        else if (scan.phase === 'failed') detail.push(React.createElement('div', { className: 'giou-line err', key: 'scan-fail' }, '扫描未执行：' + scan.error))
      }

      return React.createElement(
        'div',
        { className: 'giou-body' },
        React.createElement('div', { className: 'giou-left' }, children),
        React.createElement(
          'div',
          { className: 'giou-right' },
          source.failure
            ? React.createElement(
                'div',
                { className: 'giou-line warn', key: 'fail' },
                data && source.lastOkAt ? '看板数据不可用 · 上次成功 ' + source.lastOkAt + '（显示的是上次成功的数据）' : '看板数据不可用 · ' + source.failure + '（尚无成功数据）',
              )
            : null,
          React.createElement(
            'div',
            { className: 'giou-statusrow', key: 'topbar' },
            React.createElement(
              'span',
              { className: 'giou-stats' },
              '今日 ' + stats.today + ' 条 · 待你判断 ' + stats.pending + ' 条 · ',
              React.createElement('span', { className: stats.overdue > 0 ? 'bad' : '' }, '逾期 ' + stats.overdue + ' 条'),
            ),
            React.createElement('span', { style: { flex: '1' } }),
            React.createElement('button', { className: 'giou-btn primary', type: 'button', disabled: scan.phase === 'busy', title: CAPABILITY_SCAN + '：触发后端逾期扫描（与真定时器互为备份）', onClick: () => runScan() }, scan.phase === 'busy' ? '扫描中…' : '⏱ 立即扫描'),
            React.createElement('button', { className: 'giou-btn', type: 'button', onClick: () => pullSnapshot() }, '刷新'),
            React.createElement('button', { className: 'giou-btn', type: 'button', onClick: () => panelState.setView('logs') }, '模型调用日志'),
            React.createElement('button', { className: 'giou-btn', type: 'button', onClick: () => panelState.setOpen(false) }, '收起面板'),
          ),
          view.view === 'logs' ? React.createElement(LogsView, { key: 'logs' }) : null,
          view.view === 'board' ? React.createElement('div', { key: 'board' }, detail) : null,
        ),
      )
    }

    // ── 组件：督导端主面板（不遮挡右侧全高面板）────────────────────────────
    function OversightPanel() {
      const view = React.useSyncExternalStore(panelState.subscribe, () => panelState.snapshot, () => panelState.snapshot)
      const scan = React.useSyncExternalStore(scanState.subscribe, () => scanState.snapshot, () => scanState.snapshot)
      const source = React.useSyncExternalStore(snapshotSource.subscribe, () => snapshotSource.snapshot, () => snapshotSource.snapshot)

      React.useEffect(() => {
        if (!view.open) return undefined
        pullSnapshot()
        return undefined
      }, [view.open])

      if (!view.open) return null

      const stats = statsOf(source.data, Date.now())
      const offline = source.data && source.data.offline ? source.data.offline.offline === true : false
      const queue = source.data && source.data.pendingQueue ? source.data.pendingQueue : null

      return React.createElement(
        'div',
        { className: 'giou-panel' },
        React.createElement(
          'div',
          { className: 'giou-top' },
          React.createElement('span', { className: 'giou-tabs' }, [
            React.createElement('button', { key: 'board', type: 'button', 'data-on': view.view === 'board' ? '1' : '0', onClick: () => panelState.setView('board') }, CAPABILITY_BOARD),
            React.createElement('button', { key: 'logs', type: 'button', 'data-on': view.view === 'logs' ? '1' : '0', onClick: () => panelState.setView('logs') }, CAPABILITY_LOGS),
          ]),
          React.createElement(
            'span',
            { className: 'giou-stats' },
            '今日 ' + stats.today + ' 条 · 待你判断 ' + stats.pending + ' 条 · ',
            React.createElement('span', { className: stats.overdue > 0 ? 'bad' : '' }, '逾期 ' + stats.overdue + ' 条'),
          ),
          React.createElement('span', { style: { flex: '1' } }),
          React.createElement('button', { className: 'giou-btn', type: 'button', disabled: scan.phase === 'busy', onClick: () => runScan() }, scan.phase === 'busy' ? '扫描中…' : '⏱ 立即扫描'),
          React.createElement('button', { className: 'giou-btn', type: 'button', onClick: () => pullSnapshot() }, '刷新'),
          React.createElement('button', { className: 'giou-btn', type: 'button', onClick: () => panelState.setOpen(false) }, '关闭'),
        ),
        offline
          ? React.createElement('div', { className: 'giou-line warn', style: { margin: '8px 12px 0' } }, '离线：仅采集排队，不产生模型判断' + (queue && typeof queue.pending === 'number' ? '（待判队列 ' + queue.pending + ' 条）' : '') + '；联网后自动补判。')
          : null,
        view.view === 'logs' ? React.createElement(LogsView, { key: 'logs' }) : React.createElement(BoardView, { key: 'board' }),
      )
    }

    /** 右侧栏里的独立 tab：模型调用日志（与面板入口并存，两个入口都一步可点）。 */
    function LogsTabBody() {
      React.useEffect(() => {
        pullLogs()
        return undefined
      }, [])
      return React.createElement('div', { className: 'giou-panel', style: { position: 'static', width: '100%', boxShadow: 'none', borderLeft: 'none' } }, React.createElement(LogsView, {}))
    }

    /** 输入区的督导端入口（只在督导端视图显示；店长端视图由采集包负责）。 */
    function OversightDockEntry() {
      const role = React.useSyncExternalStore(
        (listener) => {
          const channel = globalThis.__gaia_inspection_view__
          if (!channel || typeof channel.subscribe !== 'function') return () => {}
          return channel.subscribe(listener)
        },
        () => {
          const channel = globalThis.__gaia_inspection_view__
          return channel && typeof channel.getRole === 'function' ? channel.getRole() : 'supervisor'
        },
        () => 'supervisor',
      )
      if (role === 'manager') return null
      return React.createElement(
        'div',
        { style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } },
        React.createElement('button', { className: 'giou-dockbtn', type: 'button', onClick: () => panelState.setOpen(true, 'board') }, '🧾 ' + CAPABILITY_BOARD),
        React.createElement('button', { className: 'giou-dockbtn', type: 'button', onClick: () => panelState.setOpen(true, 'logs') }, '📜 ' + CAPABILITY_LOGS),
      )
    }

    // ── 挂载 ────────────────────────────────────────────────────────────────
    function apply(ctx) {
      const styleEl = document.createElement('style')
      styleEl.setAttribute('data-plugin', 'gaia-inspection-oversight-ui')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)

      exposeChannels()

      const slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : undefined
      const tabs = ctx && typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : undefined
      const sidebarRight = ctx && typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined
      if (!slots) {
        console.warn('[gaia-inspection-oversight-ui] 宿主未提供 slots 服务，四个界面都未挂载')
        return
      }

      // ① 主面板（屏 B）：不遮挡的右侧全高面板，会话照常可读。
      ctx.effect(
        () => slots.inject(OVERLAY_SLOT, () => slots.register({ name: OVERLAY_SLOT, id: 'gaia-inspection-oversight-panel', order: 44, label: CAPABILITY_BOARD, children: {} }, OversightPanel)),
        'gaia-inspection-oversight-ui: oversight panel',
      )

      // ② 右侧栏「模型调用日志」独立 tab（tab 类型 + keyed 正文）。
      if (tabs && typeof tabs.register === 'function') {
        ctx.effect(
          () =>
            tabs.register({
              id: LOGS_TAB_KIND,
              kind: LOGS_TAB_KIND,
              priority: 'extension',
              title: () => CAPABILITY_LOGS,
              guide: [{ kind: LOGS_TAB_KIND, title: () => CAPABILITY_LOGS, description: () => '逐条模型调用记录：时间 / 模型 / 提示词版本 / 提交编号 / 请求摘要 / 响应摘要 / 耗时' }],
            }),
          'gaia-inspection-oversight-ui: logs tab type',
        )
      } else {
        console.warn('[gaia-inspection-oversight-ui] 宿主未提供 sidebarRightTabs：右侧栏日志 tab 未注册（面板与 header 入口仍可用）')
      }
      ctx.effect(
        () => slots.inject(TAB_SLOT, () => slots.register({ name: TAB_SLOT, key: LOGS_TAB_KIND, children: {} }, LogsTabBody)),
        'gaia-inspection-oversight-ui: logs tab body',
      )

      const openPanel = (view) => panelState.setOpen(true, view)
      const openRightbarLogs = () => {
        try {
          if (sidebarRight && typeof sidebarRight.openTab === 'function') {
            sidebarRight.openTab(LOGS_TAB_KIND, {})
            return
          }
        } catch (error) {
          console.warn('[gaia-inspection-oversight-ui] 打开右侧栏失败：', error)
        }
        openPanel('logs')
      }

      // ③ 会话 header 入口：看板面板 / 立即扫描 / 模型调用日志（后两个是独立入口，一步可点）。
      ctx.effect(
        () =>
          slots.inject(HEADER_SLOT, () =>
            slots.register({ name: HEADER_SLOT, id: 'gaia-inspection-oversight-board', order: 43, label: CAPABILITY_BOARD }, () =>
              React.createElement('button', { className: 'giou-dockbtn', type: 'button', title: '打开' + CAPABILITY_BOARD, onClick: () => openPanel('board') }, '🧾 ' + CAPABILITY_BOARD),
            ),
          ),
        'gaia-inspection-oversight-ui: header entry board',
      )
      ctx.effect(
        () =>
          slots.inject(HEADER_SLOT, () =>
            slots.register({ name: HEADER_SLOT, id: 'gaia-inspection-oversight-scan', order: 44, label: CAPABILITY_SCAN }, () =>
              React.createElement('button', { className: 'giou-dockbtn', type: 'button', title: CAPABILITY_SCAN + '：触发一次后端逾期扫描', onClick: () => runScan() }, '⏱ 立即扫描'),
            ),
          ),
        'gaia-inspection-oversight-ui: header entry scan',
      )
      ctx.effect(
        () =>
          slots.inject(HEADER_SLOT, () =>
            slots.register({ name: HEADER_SLOT, id: 'gaia-inspection-oversight-logs', order: 45, label: CAPABILITY_LOGS }, () =>
              React.createElement('button', { className: 'giou-dockbtn', type: 'button', title: '打开' + CAPABILITY_LOGS, onClick: openRightbarLogs }, '📜 模型调用日志'),
            ),
          ),
        'gaia-inspection-oversight-ui: header entry logs',
      )

      // ④ 输入区入口（督导端视图下显示）。
      ctx.effect(
        () => slots.inject(DOCK_SLOT, () => slots.register({ name: DOCK_SLOT, id: 'gaia-inspection-oversight-entry', order: 43, label: CAPABILITY_BOARD }, OversightDockEntry)),
        'gaia-inspection-oversight-ui: input dock entry',
      )

      pullSnapshot()
    }

    exports.apply = apply
    exports.__test = {
      CAPABILITY_BOARD,
      CAPABILITY_EVIDENCE,
      CAPABILITY_SCAN,
      CAPABILITY_LOGS,
      FILTERS,
      LOGS_EMPTY_TEXT,
      LOGS_MASKING_TEXT,
      LOGS_MISSING_TEXT,
      normalizeSnapshot,
      normalizeCall,
      statsOf,
      filterInspections,
      sortByTimeDesc,
      confidenceOf,
      confidenceNoteOf,
      ACTION_WORDS,
      ACTION_CODE_WORDS,
      locateEvidence,
      measureSuffix,
      scanSummaryOf,
      shortNo,
      statusLabelOf,
      statusToneOf,
      photoUrlOf,
      latencyOf,
      tokensOf,
      actionLabelOf,
      BoardView,
      LogsView,
      OversightPanel,
      LogsTabBody,
      OversightDockEntry,
      EvidenceArea,
      FindingCard,
      snapshotSource,
      logsSource,
      scanState,
      actionState,
      evidenceState,
      panelState,
      pullSnapshot,
      pullLogs,
      runScan,
      recordAction,
      hasReact: React !== null,
    }
    return module.exports
  },
})
