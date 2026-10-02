// gaia-inspection-capture-ui — 客户端半（纯浏览器 ESM，手写 ModuleLoader bundle）。
//
// 逐字对齐《界面实现说明（画面级）》屏 A · 店长端（采集）：
//   顶部 视图标签（店长端 / 督导端）→ 浅橙提示条「演示替身：真实场景中门店在手机上提交，本面板为演示视图」
//   → 门店下拉（示例门店 A · 快餐档口 / 示例门店 B · 正餐堂食）→ 照片区（点击或拖入，**只收 jpg/png、单张**，
//   选中后显示缩略图 + 文件名 + 可删除，**不调用摄像头**）→ 一句话说明（1–200 字 + 实时字数）
//   → [载入示例] [提交并分析] → 状态行（五态逐字）。
//
// 能力词（逐字）：「门店自查采集入口」（C 档）、「角色视图切换」（E 档）。
//
// 纪律：
//   · 纯浏览器 ESM：不引 node: 内置模块；React 由宿主模块表提供（拿不到就不挂载，不报错）。
//   · 提交走 POST /api/gaia-inspection/submit（后端真分析，**前端不做假回执、不写死结果**）。
//   · 离线/待判信号取 GET /api/gaia-inspection/snapshot 的 offline / pendingQueue；读不到就说"未知"，不假装在线。
//   · 不做美术层、不做登录/权限、不做门店增删改、不做勾选表、不做响应式（"手机形状卡片"只是桌面上的视觉形态）。

window.__ModuleLoader__.load({
  id: 'gaia-inspection-capture-ui',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    let React = null
    try {
      React = require('react')
    } catch (error) {
      React = null
    }

    // ── 常量（能力词与逐字文案，不得改写）───────────────────────────────────
    const CAPABILITY_CAPTURE = '门店自查采集入口'
    const CAPABILITY_ROLE = '角色视图切换'

    const SUBMIT_PATH = '/api/gaia-inspection/submit'
    const SNAPSHOT_PATH = '/api/gaia-inspection/snapshot'
    const SAMPLE_PATH = '/api/gaia-inspection/sample-photo'
    const REPORT_PATH = '/api/gaia-inspection-capture-ui/report-submit'

    /** 采集面**只收单张**（后端 MAX_PHOTOS_SUBMIT = 1）；单张解码后 ≤2MB（后端 MAX_PHOTO_BYTES）。 */
    const MAX_PHOTOS = 1
    const MAX_PHOTO_BYTES = 2 * 1024 * 1024
    const ACCEPT_MEDIA = ['image/jpeg', 'image/png']
    const ACCEPT_EXT = ['.jpg', '.jpeg', '.png']
    const NOTE_MIN = 1
    const NOTE_MAX = 200

    /** 演示替身提示条（说明里标注"不能删"）。 */
    const DEMO_NOTICE = '演示替身：真实场景中门店在手机上提交，本面板为演示视图'
    /** 离线提示（说明里标注"不能删"）。 */
    const OFFLINE_NOTICE = '离线：仅采集排队，不产生模型判断；联网后自动补判'

    /** 五态状态行逐字文案。 */
    const STATE_EMPTY = '待提交（照片与文字都填写后按钮可用）'
    const STATE_RUNNING = '正在分析…（本次为真实模型调用）'

    const SAMPLE_NOTE = '接班时拍的，后门那堆货还没清，上一个班次留下的'
    const SAMPLE_PHOTO_NAME = 'sample-issue.png'

    /** 示例照片说明（后端 `sample-photo` 口 / 前端内置示例各一份，都写明"合成示例图"）。 */
    const SAMPLE_LABEL_FROM_BACKEND = '后端合成示例图（几何图形合成，非真实门店照片）'
    const SAMPLE_LABEL_BUILTIN = '内置合成示例图（几何图形合成，非真实门店照片）'

    const ROLE_MANAGER = 'manager'
    const ROLE_SUPERVISOR = 'supervisor'
    const ROLE_STORAGE_KEY = 'gaia-inspection.view-role'
    const VIEW_CHANNEL = '__gaia_inspection_view__'

    /** 采集面与角色切换都挂在输入区（说明要求顶部两个视图标签；输入区就在会话顶部，且切面板时始终可见）。 */
    const DOCK_SLOT = 'conversation.input.dock'
    const HEADER_SLOT = 'conversation.session.header.actions'

    const CSS = `
.gicu-dock { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.gicu-lbl { font-size: 11px; color: #8a9099; }
.gicu-seg { display: inline-flex; border: 1px solid var(--dsw-color-border, #e5e6eb); border-radius: 999px; overflow: hidden; }
.gicu-seg button { border: 0; background: transparent; color: inherit; font-size: 11px; padding: 2px 11px; cursor: pointer; }
.gicu-seg button[data-on="1"] { background: var(--dsw-color-primary, #4e6ef2); color: #fff; }
.gicu-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-color-border, #e5e6eb); border-radius: 6px; padding: 4px 12px; font: inherit; font-size: 12px; cursor: pointer; background: transparent; color: inherit; }
.gicu-btn:hover:not([disabled]) { border-color: var(--dsw-color-primary, #4e6ef2); color: var(--dsw-color-primary, #4e6ef2); }
.gicu-btn[disabled] { opacity: .5; cursor: not-allowed; }
.gicu-btn.primary { border-color: var(--dsw-color-primary, #4e6ef2); color: var(--dsw-color-primary, #4e6ef2); }
.gicu-off { display: inline-flex; align-items: center; gap: 5px; border: 1px solid #ffe58f; background: rgba(255,229,143,.16); color: #ad6800; border-radius: 999px; padding: 2px 9px; font-size: 11px; }
.gicu-panel { position: absolute; inset: 0; z-index: 30; background: rgba(20,24,32,.22); display: flex; align-items: flex-start; justify-content: center; padding: 22px 12px; overflow-y: auto; box-sizing: border-box; }
.gicu-phone { width: min(430px, 94vw); background: var(--dsw-color-bg, #fff); color: var(--dsw-color-fg, #1f2329); border-radius: 20px; box-shadow: 0 14px 44px rgba(0,0,0,.30); border: 1px solid var(--dsw-color-border, #e5e6eb); display: flex; flex-direction: column; }
.gicu-notch { height: 22px; border-radius: 20px 20px 0 0; background: linear-gradient(90deg, rgba(78,110,242,.10), rgba(78,110,242,.02)); display: flex; align-items: center; justify-content: center; font-size: 10px; color: #8a9099; letter-spacing: .04em; }
.gicu-body { padding: 10px 14px 14px; display: flex; flex-direction: column; gap: 9px; font-size: 12px; }
.gicu-tabs { display: inline-flex; border: 1px solid var(--dsw-color-border, #e5e6eb); border-radius: 999px; overflow: hidden; align-self: flex-start; }
.gicu-tabs button { border: 0; background: transparent; color: inherit; font: inherit; font-size: 11px; padding: 3px 12px; cursor: pointer; }
.gicu-tabs button[data-on="1"] { background: var(--dsw-color-primary, #4e6ef2); color: #fff; }
.gicu-banner { border: 1px solid #ffd591; background: #fff7e6; color: #ad4e00; border-radius: 8px; padding: 6px 9px; font-size: 11px; line-height: 1.5; }
.gicu-row { display: flex; align-items: center; gap: 8px; }
.gicu-select { flex: 1; border: 1px solid var(--dsw-color-border, #e5e6eb); border-radius: 8px; padding: 5px 8px; font: inherit; font-size: 12px; background: transparent; color: inherit; }
.gicu-drop { border: 1px dashed var(--dsw-color-border, #e5e6eb); border-radius: 12px; padding: 18px 12px; display: flex; flex-direction: column; align-items: center; gap: 5px; color: #8a9099; background: var(--dsw-color-bg-2, #f7f8fa); text-align: center; cursor: pointer; }
.gicu-drop[data-over="1"] { border-color: var(--dsw-color-primary, #4e6ef2); color: var(--dsw-color-primary, #4e6ef2); }
.gicu-drop .cam { font-size: 22px; line-height: 1; }
.gicu-drop .t1 { font-size: 12px; color: inherit; }
.gicu-drop .t2 { font-size: 10px; }
.gicu-photo { display: flex; align-items: center; gap: 9px; border: 1px solid var(--dsw-color-border, #e5e6eb); border-radius: 10px; padding: 7px; }
.gicu-photo img { width: 62px; height: 62px; object-fit: cover; border-radius: 8px; flex: none; background: #000; }
.gicu-photo .nm { flex: 1; min-width: 0; font-size: 11px; word-break: break-all; }
.gicu-photo .del { border: 1px solid var(--dsw-color-border, #e5e6eb); background: transparent; border-radius: 6px; padding: 2px 8px; cursor: pointer; color: inherit; font-size: 11px; }
.gicu-ta { width: 100%; min-height: 64px; resize: vertical; box-sizing: border-box; border: 1px solid var(--dsw-color-border, #e5e6eb); border-radius: 10px; padding: 8px 10px; font: inherit; font-size: 12px; color: inherit; background: transparent; }
.gicu-count { font-size: 10px; color: #8a9099; text-align: right; }
.gicu-actions { display: flex; align-items: center; gap: 8px; }
.gicu-actions .grow { flex: 1; }
.gicu-state { border: 1px solid var(--dsw-color-border, #e5e6eb); border-radius: 8px; padding: 6px 9px; font-size: 11px; line-height: 1.6; color: #646a73; word-break: break-word; }
.gicu-state[data-kind="running"] { border-color: #91caff; background: rgba(145,202,255,.10); color: #0958d9; }
.gicu-state[data-kind="ok"] { border-color: #b7eb8f; background: rgba(183,235,143,.14); color: #237804; }
.gicu-state[data-kind="bad"] { border-color: #ffccc7; background: rgba(255,204,199,.14); color: #cf1322; }
.gicu-state[data-kind="off"] { border-color: #ffd591; background: #fff7e6; color: #ad4e00; }
.gicu-inline { display: inline-flex; align-items: center; gap: 4px; }
.gicu-retry { border: 1px solid currentColor; background: transparent; color: inherit; border-radius: 6px; padding: 0 7px; font: inherit; font-size: 11px; cursor: pointer; margin-left: 6px; }
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

    function fmtBytes(bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes)) return '—'
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
      return (bytes / 1024 / 1024).toFixed(2) + ' MB'
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

    function extOf(name) {
      const match = /(\.[A-Za-z0-9]+)$/.exec(textOf(name))
      return match ? match[1].toLowerCase() : ''
    }

    // ── 内置示例图（前端自给；示例照片属演示素材，不硬依赖后端口）─────────────
    /**
     * 用 Canvas 2D 画一张确定性的"问题态"合成图（后门角落堆纸箱 + 地面油渍 + 浅色地砖网格）。
     * 只画几何形状，**不冒充真实门店照片**（标签一律写明"合成示例图"）。
     * 画布不可用时返回 null → 调用方提示"内置示例不可用，请手动选图"。
     */
    function builtinSampleDataUrl() {
      try {
        if (typeof document === 'undefined' || typeof document.createElement !== 'function') return null
        const canvas = document.createElement('canvas')
        if (!canvas || typeof canvas.getContext !== 'function' || typeof canvas.toDataURL !== 'function') return null
        canvas.width = 640
        canvas.height = 480
        const g = canvas.getContext('2d')
        if (!g) return null
        g.fillStyle = '#d6d8d6'
        g.fillRect(0, 0, 640, 480)
        g.strokeStyle = '#babcbA'
        g.lineWidth = 2
        for (let x = 0; x <= 640; x += 80) {
          g.beginPath()
          g.moveTo(x, 0)
          g.lineTo(x, 480)
          g.stroke()
        }
        for (let y = 0; y <= 480; y += 80) {
          g.beginPath()
          g.moveTo(0, y)
          g.lineTo(640, y)
          g.stroke()
        }
        g.fillStyle = '#9aa0a6'
        g.fillRect(470, 90, 130, 250)
        g.fillStyle = '#6b7075'
        g.fillRect(482, 102, 106, 226)
        const cartons = [
          { x: 120, y: 300, w: 120, h: 90 },
          { x: 150, y: 220, w: 100, h: 80 },
          { x: 190, y: 150, w: 90, h: 70 },
          { x: 300, y: 320, w: 130, h: 80 },
        ]
        for (const carton of cartons) {
          g.fillStyle = '#c8a165'
          g.fillRect(carton.x, carton.y, carton.w, carton.h)
          g.strokeStyle = '#8a6d3b'
          g.lineWidth = 3
          g.strokeRect(carton.x, carton.y, carton.w, carton.h)
          g.beginPath()
          g.moveTo(carton.x, carton.y + carton.h / 2)
          g.lineTo(carton.x + carton.w, carton.y + carton.h / 2)
          g.stroke()
        }
        g.fillStyle = 'rgba(108,96,78,.55)'
        g.beginPath()
        g.ellipse(300, 400, 62, 26, 0.3, 0, Math.PI * 2)
        g.fill()
        g.fillStyle = 'rgba(84,78,70,.45)'
        g.beginPath()
        g.ellipse(210, 430, 34, 16, 0, 0, Math.PI * 2)
        g.fill()
        // 轻噪声：固定线性同余序列（确定性，不引随机源）
        let seed = 20261002
        for (let i = 0; i < 6000; i += 1) {
          seed = (seed * 1103515245 + 12345) % 2147483648
          const x = seed % 640
          seed = (seed * 1103515245 + 12345) % 2147483648
          const y = seed % 480
          const v = seed % 40
          g.fillStyle = 'rgba(' + (40 + v) + ',' + (40 + v) + ',' + (40 + v) + ',0.05)'
          g.fillRect(x, y, 1, 1)
        }
        return canvas.toDataURL('image/png')
      } catch (error) {
        return null
      }
    }

    /** 文件名后缀 + MIME 都要是 jpg/png（说明：只收 jpg/png）。 */
    function isAcceptedImage(name, mediaType) {
      const ext = extOf(name)
      const byExt = ACCEPT_EXT.indexOf(ext) !== -1
      const mime = textOf(mediaType).toLowerCase()
      const byMime = !mime ? byExt : ACCEPT_MEDIA.indexOf(mime) !== -1
      return byExt && byMime
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

    function readFileAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        try {
          const reader = new FileReader()
          reader.onload = () => resolve(textOf(reader.result))
          reader.onerror = () => reject(reader.error || new Error('读取文件失败'))
          reader.readAsDataURL(file)
        } catch (error) {
          reject(error)
        }
      })
    }

    /** 从 dataURL 里拆出 mediaType 与 base64；拆不出返回 null（不猜）。 */
    function splitDataUrl(dataUrl) {
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(textOf(dataUrl))
      if (!match) return null
      return { mediaType: match[1], dataBase64: match[2] }
    }

    function bytesOfDataUrl(dataUrl) {
      const split = splitDataUrl(dataUrl)
      if (!split) return null
      try {
        return atob(split.dataBase64).length
      } catch (error) {
        return null
      }
    }

    /** 提交编号展示：后端 runId 形如 `INS-20261002-201530-ab12` → 显示 `#ab12`（取尾段；无尾段就原样）。 */
    function shortNo(rawNo) {
      const raw = trim(rawNo)
      if (!raw) return ''
      const parts = raw.split('-').filter(Boolean)
      const tail = parts.length > 1 ? parts[parts.length - 1] : raw
      return '#' + tail
    }

    // ── 本地视图状态（角色视图切换；跨包共享）───────────────────────────────
    function readStoredRole() {
      try {
        const raw = window.localStorage.getItem(ROLE_STORAGE_KEY)
        return raw === ROLE_SUPERVISOR ? ROLE_SUPERVISOR : ROLE_MANAGER
      } catch (error) {
        return ROLE_MANAGER
      }
    }

    const localView = {
      role: readStoredRole(),
      listeners: new Set(),
      subscribe(listener) {
        localView.listeners.add(listener)
        return () => localView.listeners.delete(listener)
      },
      notify() {
        localView.listeners.forEach((listener) => {
          try {
            listener()
          } catch (error) {
            /* 单个订阅者出错不影响其它 */
          }
        })
      },
      setRole(next) {
        const role = next === ROLE_SUPERVISOR ? ROLE_SUPERVISOR : ROLE_MANAGER
        if (role === localView.role) return role
        localView.role = role
        try {
          window.localStorage.setItem(ROLE_STORAGE_KEY, role)
        } catch (error) {
          /* 存不下就只在本次会话生效 */
        }
        localView.notify()
        return role
      },
      roleLabel() {
        return localView.role === ROLE_SUPERVISOR ? '督导端' : '店长端'
      },
    }

    function exposeViewChannel() {
      const api = {
        getRole: () => localView.role,
        setRole: (role) => localView.setRole(role),
        subscribe: (listener) => localView.subscribe(listener),
      }
      globalThis[VIEW_CHANNEL] = api
      return api
    }

    // ── 取数：snapshot（离线 / 待判队列 → 状态行与提示条）────────────────────
    // 【必须换引用的快照】React 的 useSyncExternalStore 用 Object.is 比对 getSnapshot() 的返回值：
    // 若 getSnapshot 永远返回同一个被原地改属性的对象，React 判定「快照没变」直接 bailout，
    // 订阅它的组件永不重渲染（提交后按钮不变「正在分析…」、状态行不出「已提交，编号 #xxxx」都由此而来）。
    // 所以每个 store 都维护一份只在 notify() 时重建的不可变快照，getSnapshot 一律返回它。
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
          snapshotSource.data = raw && typeof raw === 'object' ? raw : null
          snapshotSource.failure = ''
          snapshotSource.lastOkAt = clockOf(Date.now())
        })
        .catch((error) => {
          const status = error && error.status
          snapshotSource.failure = status === 404 ? '采集后端未就绪（路由 404）' : textOf((error && error.message) || error) || '请求失败'
        })
        .then(() => {
          if (snapshotSource.pending === inflight) snapshotSource.pending = null
          snapshotSource.notify()
        })
      snapshotSource.pending = inflight
      return inflight
    }

    function normalizeOffline(snapshot) {
      const data = snapshot && typeof snapshot === 'object' ? snapshot : null
      const offline = data && data.offline && typeof data.offline === 'object' ? data.offline : null
      const queue = data && data.pendingQueue && typeof data.pendingQueue === 'object' ? data.pendingQueue : null
      const flag = offline ? offline.offline : null
      return {
        known: flag === true || flag === false,
        offline: flag === true,
        source: offline ? textOf(offline.source) : '',
        pending: queue && typeof queue.pending === 'number' ? queue.pending : null,
        judged: queue && typeof queue.judged === 'number' ? queue.judged : null,
      }
    }

    /** 「已联网，正在补判排队中的 N 条…」的触发：离线 → 在线的沿跳变，显示若干秒。 */
    const offlineEdge = {
      wasOffline: null,
      recoveringUntil: 0,
      lastPending: null,
      onSnapshot(off) {
        if (off.known) {
          if (offlineEdge.wasOffline === true && off.offline === false) offlineEdge.recoveringUntil = Date.now() + 12000
          offlineEdge.wasOffline = off.offline
        }
        if (off.pending !== null) offlineEdge.lastPending = off.pending
      },
      recovering(now) {
        return now < offlineEdge.recoveringUntil
      },
    }

    // ── 提交（真实走后端；回执来自后端返回值）──────────────────────────────
    const submitState = {
      phase: 'idle', // idle | busy | done | failed
      receipt: null,
      error: '',
      lastStoreId: '',
      lastSubmittedAt: 0,
      snapshot: { phase: 'idle', receipt: null, error: '' },
      listeners: new Set(),
      subscribe(listener) {
        submitState.listeners.add(listener)
        return () => submitState.listeners.delete(listener)
      },
      notify() {
        submitState.snapshot = { phase: submitState.phase, receipt: submitState.receipt, error: submitState.error }
        submitState.listeners.forEach((listener) => {
          try {
            listener()
          } catch (error) {
            /* 忽略 */
          }
        })
      },
    }

    /** 从后端回执读「单号 / 状态 / 是否排队 / 摘要」；缺就空着，**不臆造**。 */
    function readReceipt(payload) {
      const root = payload && typeof payload === 'object' ? payload : {}
      const data = root.data && typeof root.data === 'object' ? root.data : {}
      const pick = (keys) => {
        for (const key of keys) {
          for (const bag of [root, data]) {
            const value = bag ? bag[key] : undefined
            if (value !== undefined && value !== null && value !== '') return value
          }
        }
        return null
      }
      const status = textOf(pick(['status', 'state'])) || ''
      const queued = pick(['queued']) === true || data.offline === true || status.toLowerCase() === 'queued'
      return {
        accepted: root.ok !== false,
        no: textOf(pick(['runId', 'receiptNo', 'inspectionId', 'id', 'qid'])) || '',
        status,
        queued,
        summary: textOf(pick(['summary', 'message'])) || '',
        errorCode: root.error ? textOf(root.error.code) : '',
        errorMessage: root.error ? textOf(root.error.message) : '',
      }
    }

    /** 把选中/示例照片读成提交形态；拆不出图片数据就抛错（不静默丢张、不造假）。 */
    async function encodePhotos(photos) {
      const encoded = []
      for (const item of photos) {
        const dataUrl = item.dataUrl ? item.dataUrl : await readFileAsDataUrl(item.file)
        const split = splitDataUrl(dataUrl)
        if (!split) throw new Error('照片「' + item.name + '」读取结果不是可用的图片数据')
        encoded.push({ name: item.name, mediaType: split.mediaType || item.mediaType || 'application/octet-stream', dataBase64: split.dataBase64 })
      }
      return encoded
    }

    async function submitSelfCheck({ storeId, note, photos }) {
      submitState.phase = 'busy'
      submitState.error = ''
      submitState.receipt = null
      submitState.lastStoreId = textOf(storeId)
      submitState.notify()

      let body
      try {
        body = { storeId: storeId || null, note: textOf(note), photos: await encodePhotos(photos) }
      } catch (error) {
        submitState.phase = 'failed'
        submitState.error = '照片读取失败：' + textOf((error && error.message) || error)
        submitState.notify()
        return null
      }

      try {
        const payload = await postJson(SUBMIT_PATH, body)
        const receipt = readReceipt(payload)
        if (payload && payload.ok === false) {
          submitState.phase = 'failed'
          submitState.error = receipt.errorMessage || receipt.errorCode || '后端未受理本次提交'
          submitState.receipt = receipt
        } else {
          submitState.phase = 'done'
          submitState.receipt = receipt
          submitState.lastSubmittedAt = Date.now()
        }
        try {
          await postJson(REPORT_PATH, {
            ok: submitState.phase === 'done',
            receiptNo: receipt.no,
            status: receipt.status,
            queued: receipt.queued,
            offline: normalizeOffline(snapshotSource.data).offline,
            storeId: textOf(storeId),
            noteChars: textOf(note).length,
            photoCount: photos.length,
            code: receipt.errorCode,
            message: submitState.phase === 'done' ? receipt.summary : submitState.error,
          })
        } catch (error) {
          /* 内省口不可用不影响提交结果 */
        }
        pullSnapshot()
        submitState.notify()
        return submitState.receipt
      } catch (error) {
        const payload = error && error.payload
        const inner = payload && payload.error ? payload.error : null
        submitState.phase = 'failed'
        if (inner) {
          submitState.error = textOf(inner.message || inner.code)
        } else if (error && error.status) {
          submitState.error = '提交失败：' + textOf(error.message)
        } else {
          submitState.error = '连不上采集服务：' + textOf((error && error.message) || error) + '（本次未提交成功，请稍后重试）'
        }
        submitState.notify()
        return null
      }
    }

    // ── 采集面的开关 ────────────────────────────────────────────────────────
    const panel = {
      open: false,
      listeners: new Set(),
      subscribe(listener) {
        panel.listeners.add(listener)
        return () => panel.listeners.delete(listener)
      },
      notify() {
        panel.listeners.forEach((listener) => {
          try {
            listener()
          } catch (error) {
            /* 忽略 */
          }
        })
      },
      setOpen(next) {
        const value = next === true
        if (panel.open === value) return
        panel.open = value
        panel.notify()
      },
    }

    // ── 门店下拉：两家静态示例门店（不做增删改）────────────────────────────
    /** 后端门店名（示例门店·快餐档口甲 / 示例门店·正餐堂食乙）→ 画面级说明要求的下拉文案。 */
    function storeLabelOf(store) {
      const format = textOf(store && (store.storeType || store.format))
      const storeId = textOf(store && (store.storeId || store.id))
      const rawName = textOf(store && (store.storeName || store.name))
      if (format.indexOf('快餐') !== -1) return '示例门店 A · 快餐档口'
      if (format.indexOf('正餐') !== -1 || format.indexOf('堂食') !== -1) return '示例门店 B · 正餐堂食'
      if (storeId === 'S-001') return '示例门店 A · 快餐档口'
      if (storeId === 'S-002') return '示例门店 B · 正餐堂食'
      return rawName || storeId || '未标注门店'
    }

    function storesOf(snapshot) {
      const data = snapshot && typeof snapshot === 'object' ? snapshot : null
      const list = data && Array.isArray(data.stores) ? data.stores : []
      const out = []
      for (const store of list) {
        const storeId = textOf(store && (store.storeId || store.id))
        if (!storeId) continue
        out.push({ storeId, label: storeLabelOf(store), storeType: textOf(store && (store.storeType || store.format)) })
      }
      return out
    }

    /** 同一门店不允许重复提交未完成的分析：后端有该店「进行中」检查单 → 锁；本地刚提交过 60s 内也锁。 */
    function busyReasonOf(snapshot, storeId, now) {
      const data = snapshot && typeof snapshot === 'object' ? snapshot : null
      const list = data && Array.isArray(data.inspections) ? data.inspections : []
      const key = textOf(storeId)
      for (const item of list) {
        if (!item || textOf(item.storeId) !== key) continue
        const status = textOf(item.status).toLowerCase()
        if (status === 'analyzing' || status === 'running' || status === 'pending_analysis' || status === 'queued') {
          return '这家门店已有一条正在分析 / 排队中的提交（' + textOf(item.id) + '）：请等它完成后再说。'
        }
      }
      if (submitState.lastStoreId === key && submitState.lastSubmittedAt && now - submitState.lastSubmittedAt < 60000) {
        return '刚提交过（' + clockOf(submitState.lastSubmittedAt) + '）：同一门店不允许重复提交未完成的分析，请稍后再试。'
      }
      return ''
    }

    // ── 组件：视图标签 + 采集入口（输入区常驻）──────────────────────────────
    function ViewTabs({ role, onRole }) {
      return React.createElement(
        'span',
        { className: 'gicu-seg', title: CAPABILITY_ROLE + '：演示用视图切换，不做登录/权限' },
        [ROLE_MANAGER, ROLE_SUPERVISOR].map((value) =>
          React.createElement('button', { key: value, type: 'button', 'data-on': role === value ? '1' : '0', onClick: () => onRole(value) }, value === ROLE_MANAGER ? '店长端' : '督导端'),
        ),
      )
    }

    function CaptureDock() {
      const view = React.useSyncExternalStore(localView.subscribe, () => localView.role, () => localView.role)
      const snap = React.useSyncExternalStore(snapshotSource.subscribe, () => snapshotSource.snapshot, () => snapshotSource.snapshot)

      React.useEffect(() => {
        exposeViewChannel()
        pullSnapshot()
        const timer = window.setInterval(() => {
          pullSnapshot()
        }, 5000)
        return () => window.clearInterval(timer)
      }, [])

      const offline = normalizeOffline(snap.data)
      offlineEdge.onSnapshot(offline)

      const children = [
        React.createElement('span', { className: 'gicu-lbl', key: 'lbl' }, '视图'),
        React.createElement(ViewTabs, { role: view, onRole: (role) => localView.setRole(role), key: 'tabs' }),
      ]

      if (view === ROLE_MANAGER) {
        children.push(
          React.createElement('button', { className: 'gicu-btn primary', type: 'button', key: 'cap', title: CAPABILITY_CAPTURE, onClick: () => panel.setOpen(true) }, '📷 ' + CAPABILITY_CAPTURE),
        )
      } else {
        children.push(React.createElement('span', { className: 'gicu-lbl', key: 'sup' }, '督导端：判断回放看板见右侧/会话面板'))
      }

      if (offline.known && offline.offline) {
        children.push(React.createElement('span', { className: 'gicu-off', key: 'off' }, '离线：仅采集排队，不产生模型判断'))
      } else if (snap.failure) {
        children.push(React.createElement('span', { className: 'gicu-lbl', key: 'nf' }, '采集状态未知（' + snap.failure + '）'))
      }

      return React.createElement('div', { className: 'gicu-dock' }, children)
    }

    // ── 组件：屏 A（手机形状卡片）──────────────────────────────────────────
    function CapturePanel() {
      const opened = React.useSyncExternalStore(panel.subscribe, () => panel.open, () => panel.open)
      const submission = React.useSyncExternalStore(submitState.subscribe, () => submitState.snapshot, () => submitState.snapshot)
      const snap = React.useSyncExternalStore(snapshotSource.subscribe, () => snapshotSource.snapshot, () => snapshotSource.snapshot)

      const [storeId, setStoreId] = React.useState('')
      const [note, setNote] = React.useState('')
      const [photo, setPhoto] = React.useState(null)
      const [localError, setLocalError] = React.useState('')
      const [dragOver, setDragOver] = React.useState(false)
      const [sampleBusy, setSampleBusy] = React.useState(false)
      const inputRef = React.useRef(null)

      React.useEffect(() => {
        if (!opened) return undefined
        const onKey = (event) => {
          if (event && (event.key === 'Escape' || event.key === 'Esc')) panel.setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        pullSnapshot()
        return () => document.removeEventListener('keydown', onKey)
      }, [opened])

      if (!opened) return null

      const stores = storesOf(snap.data)
      const offline = normalizeOffline(snap.data)
      offlineEdge.onSnapshot(offline)
      const effectiveStore = storeId || (stores.length > 0 ? stores[0].storeId : '')
      const now = Date.now()
      const busyReason = busyReasonOf(snap.data, effectiveStore, now)

      const noteLen = Array.from(note).length
      const noteOk = noteLen >= NOTE_MIN && noteLen <= NOTE_MAX
      const photoOk = Boolean(photo)
      const running = submission.phase === 'busy'
      const canSubmit = photoOk && noteOk && !running && !busyReason

      const addFiles = (fileList) => {
        const incoming = Array.from(fileList || [])
        if (incoming.length === 0) return
        const file = incoming[0]
        if (incoming.length > 1) setLocalError('只收单张照片：已取第一张「' + textOf(file.name) + '」')
        else setLocalError('')
        if (!isAcceptedImage(file.name, file.type)) {
          setLocalError('只收 jpg / png：这张是「' + textOf(file.name) + '」（' + (textOf(file.type) || '类型未标注') + '），请换一张')
          return
        }
        if (file.size > MAX_PHOTO_BYTES) {
          setLocalError('单张不能超过 ' + fmtBytes(MAX_PHOTO_BYTES) + '：这张 ' + fmtBytes(file.size) + '，请压缩后重试')
          return
        }
        setPhoto({ name: textOf(file.name) || 'photo.jpg', size: file.size, mediaType: textOf(file.type), file, dataUrl: '' })
        readFileAsDataUrl(file)
          .then((dataUrl) => setPhoto((current) => (current && current.file === file ? { ...current, dataUrl } : current)))
          .catch(() => setLocalError('本地预览生成失败（不影响提交，可继续）'))
      }

      /**
       * 载入示例：**优先**取后端的合成示例图（`GET /api/gaia-inspection/sample-photo`）；
       * 该口不存在 / 不可用 / 形状不符时，**退回前端内置示例图**（Canvas 合成，同为演示素材）。
       * 两条路都只是"填表"——提交仍走 `/submit` 的真实模型调用，**不写死任何判断结果**。
       */
      const loadSample = async () => {
        setSampleBusy(true)
        setLocalError('')
        try {
          let backendIssue = ''
          try {
            const payload = await getJson(SAMPLE_PATH)
            const data = payload && payload.data ? payload.data : {}
            const dataUrl = textOf(data.dataUrl)
            if (!dataUrl) throw new Error(textOf((payload && payload.error && payload.error.message) || '示例照片接口未返回图片'))
            setPhoto({ name: textOf(data.name) || SAMPLE_PHOTO_NAME, size: bytesOfDataUrl(dataUrl) || 0, mediaType: textOf(data.mediaType) || 'image/png', file: null, dataUrl, sampleLabel: textOf(data.label) || SAMPLE_LABEL_FROM_BACKEND })
            setNote(SAMPLE_NOTE)
            setLocalError('已载入示例（' + (textOf(data.label) || SAMPLE_LABEL_FROM_BACKEND) + '）：点「提交并分析」仍会真实调用模型。')
            return
          } catch (error) {
            backendIssue = textOf((error && error.message) || error)
          }
          const builtin = builtinSampleDataUrl()
          if (builtin) {
            setPhoto({ name: SAMPLE_PHOTO_NAME, size: bytesOfDataUrl(builtin) || 0, mediaType: 'image/png', file: null, dataUrl: builtin, sampleLabel: SAMPLE_LABEL_BUILTIN })
            setNote(SAMPLE_NOTE)
            setLocalError('已载入示例（' + SAMPLE_LABEL_BUILTIN + '）：后端的示例图口暂不可用（' + (backendIssue || '未就绪') + '）；点「提交并分析」仍会真实调用模型。')
            return
          }
          setLocalError('载入示例失败：后端示例图口不可用（' + (backendIssue || '未就绪') + '），且本机画布不可用；请改用「点击选择照片」自己传一张。')
        } finally {
          setSampleBusy(false)
        }
      }

      const doSubmit = async () => {
        if (running) return
        if (!photoOk) {
          setLocalError('先选一张照片（jpg / png，单张）')
          return
        }
        if (!noteOk) {
          setLocalError(noteLen === 0 ? '写一句话说明（1–200 字）' : '一句话说明最多 200 字（当前 ' + noteLen + ' 字）')
          return
        }
        setLocalError('')
        await submitSelfCheck({ storeId: effectiveStore, note, photos: [photo] })
        // 失败时输入与照片都保留（说明 §1.3）：这里**不清空**任何字段。
      }

      // 状态行（五态逐字）
      let stateNode
      const noText = submission.receipt ? shortNo(submission.receipt.no) : ''
      if (offlineEdge.recovering(now)) {
        const n = offlineEdge.lastPending === null ? 'N' : String(offlineEdge.lastPending)
        stateNode = React.createElement('div', { className: 'gicu-state', 'data-kind': 'off' }, '已联网，正在补判排队中的 ' + n + ' 条…')
      } else if (running) {
        stateNode = React.createElement('div', { className: 'gicu-state', 'data-kind': 'running' }, STATE_RUNNING)
      } else if (submission.phase === 'failed') {
        stateNode = React.createElement(
          'div',
          { className: 'gicu-state', 'data-kind': 'bad' },
          '分析失败：' + (submission.error || '未收到原因摘要'),
          React.createElement('button', { className: 'gicu-retry', type: 'button', onClick: doSubmit }, '重试'),
        )
      } else if (submission.phase === 'done' && submission.receipt) {
        const receipt = submission.receipt
        if (receipt.queued || (offline.known && offline.offline)) {
          stateNode = React.createElement('div', { className: 'gicu-state', 'data-kind': 'off' }, OFFLINE_NOTICE + (receipt.summary ? '（' + receipt.summary + '）' : ''))
        } else {
          stateNode = React.createElement('div', { className: 'gicu-state', 'data-kind': 'ok' }, '已提交，编号 ' + (noText || '（后端未返回编号）') + '，等待督导复核')
        }
      } else {
        stateNode = React.createElement('div', { className: 'gicu-state', 'data-kind': 'idle' }, STATE_EMPTY)
      }

      const body = []

      body.push(React.createElement(ViewTabs, { key: 'tabs', role: localView.role, onRole: (role) => localView.setRole(role) }))
      body.push(React.createElement('div', { className: 'gicu-banner', key: 'notice' }, DEMO_NOTICE))

      body.push(
        React.createElement(
          'div',
          { className: 'gicu-row', key: 'store' },
          React.createElement('span', { className: 'gicu-lbl' }, '门店'),
          stores.length > 0
            ? React.createElement(
                'select',
                { className: 'gicu-select', value: effectiveStore, onChange: (event) => setStoreId(event && event.target ? event.target.value : '') },
                stores.map((store) => React.createElement('option', { key: store.storeId, value: store.storeId }, store.label)),
              )
            : React.createElement('span', { className: 'gicu-lbl' }, '门店列表不可用（' + (snap.failure || '后端未就绪') + '）'),
        ),
      )

      if (photo) {
        body.push(
          React.createElement(
            'div',
            { className: 'gicu-photo', key: 'photo' },
            photo.dataUrl ? React.createElement('img', { src: photo.dataUrl, alt: photo.name }) : React.createElement('span', { style: { width: '62px', height: '62px', background: '#000', borderRadius: '8px', flex: 'none' } }),
            React.createElement('span', { className: 'nm' }, photo.name + (photo.size ? ' · ' + fmtBytes(photo.size) : '') + (photo.sampleLabel ? '\n' + photo.sampleLabel : '')),
            React.createElement('button', { className: 'del', type: 'button', onClick: () => { setPhoto(null); setLocalError('') } }, '删除'),
          ),
        )
      } else {
        body.push(
          React.createElement(
            'div',
            {
              className: 'gicu-drop',
              key: 'drop',
              'data-over': dragOver ? '1' : '0',
              onClick: () => inputRef.current && inputRef.current.click(),
              onDragOver: (event) => {
                if (event && event.preventDefault) event.preventDefault()
                setDragOver(true)
              },
              onDragLeave: () => setDragOver(false),
              onDrop: (event) => {
                if (event && event.preventDefault) event.preventDefault()
                setDragOver(false)
                addFiles(event && event.dataTransfer ? event.dataTransfer.files : null)
              },
            },
            React.createElement('span', { className: 'cam' }, '📷'),
            React.createElement('span', { className: 't1' }, '点击选择照片，或把图片拖到这里'),
            React.createElement('span', { className: 't2' }, '支持 jpg / png，单张'),
          ),
        )
      }
      body.push(
        React.createElement('input', {
          key: 'file',
          ref: inputRef,
          type: 'file',
          accept: 'image/jpeg,image/png',
          style: { display: 'none' },
          onChange: (event) => {
            addFiles(event && event.target ? event.target.files : null)
            if (event && event.target) event.target.value = ''
          },
        }),
      )

      body.push(React.createElement('div', { className: 'gicu-lbl', key: 'note-lbl' }, '一句话说明'))
      body.push(
        React.createElement('textarea', {
          key: 'note',
          className: 'gicu-ta',
          value: note,
          maxLength: NOTE_MAX,
          placeholder: '例：接班时拍的，后门那堆货还没清，上一个班次留下的',
          onChange: (event) => setNote(event && event.target ? event.target.value : ''),
        }),
      )
      body.push(React.createElement('div', { className: 'gicu-count', key: 'count' }, noteLen + ' / ' + NOTE_MAX + ' 字'))

      if (localError) body.push(React.createElement('div', { className: 'gicu-state', key: 'local', 'data-kind': 'idle' }, localError))
      if (busyReason) body.push(React.createElement('div', { className: 'gicu-state', key: 'busy-store', 'data-kind': 'off' }, busyReason))

      body.push(
        React.createElement(
          'div',
          { className: 'gicu-actions', key: 'actions' },
          React.createElement('button', { className: 'gicu-btn', type: 'button', disabled: sampleBusy || running, onClick: loadSample }, sampleBusy ? '载入中…' : '载入示例'),
          React.createElement('span', { className: 'grow' }),
          React.createElement('button', { className: 'gicu-btn primary', type: 'button', disabled: !canSubmit, onClick: doSubmit }, running ? '正在分析…' : '提交并分析'),
        ),
      )

      body.push(React.createElement('div', { key: 'state' }, stateNode))

      return React.createElement(
        'div',
        {
          className: 'gicu-panel',
          onClick: (event) => {
            if (event && event.target === event.currentTarget) panel.setOpen(false)
          },
        },
        React.createElement(
          'div',
          { className: 'gicu-phone' },
          React.createElement('div', { className: 'gicu-notch' }, '门店端 · ' + CAPABILITY_CAPTURE),
          React.createElement(
            'div',
            { className: 'gicu-body' },
            [
              React.createElement('div', { className: 'gicu-row', key: 'close' }, React.createElement('span', { className: 'grow', style: { flex: 1 } }), React.createElement('button', { className: 'gicu-btn', type: 'button', onClick: () => panel.setOpen(false) }, '收起')),
              ...body,
            ],
          ),
        ),
      )
    }

    // ── 挂载 ────────────────────────────────────────────────────────────────
    function apply(ctx) {
      const styleEl = document.createElement('style')
      styleEl.setAttribute('data-plugin', 'gaia-inspection-capture-ui')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)

      exposeViewChannel()

      const slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : undefined
      if (!slots) {
        console.warn('[gaia-inspection-capture-ui] 宿主未提供 slots 服务，采集入口与视图切换均未挂载')
        return
      }

      // ① 输入区常驻：视图标签（角色视图切换）+「门店自查采集入口」按钮。
      ctx.effect(
        () => slots.inject(DOCK_SLOT, () => slots.register({ name: DOCK_SLOT, id: 'gaia-inspection-capture-ui', order: 42, label: CAPABILITY_CAPTURE }, CaptureDock)),
        'gaia-inspection-capture-ui: input dock entry',
      )

      // ② 屏 A（手机形状卡片）挂在无遮罩浮层里：不挡会话（说明 §四 6 只禁"全屏遮窗"）。
      ctx.effect(
        () => slots.inject('shell.overlay', () => slots.register({ name: 'shell.overlay', id: 'gaia-inspection-capture-screen', order: 42, label: CAPABILITY_CAPTURE, children: {} }, CapturePanel)),
        'gaia-inspection-capture-ui: capture screen',
      )

      // ③ 会话 header 也放一枚入口，便于在会话顶部一步打开。
      ctx.effect(
        () =>
          slots.inject(HEADER_SLOT, () =>
            slots.register({ name: HEADER_SLOT, id: 'gaia-inspection-capture-open', order: 46, label: CAPABILITY_CAPTURE }, () =>
              React.createElement(
                'button',
                { className: 'gicu-btn', type: 'button', title: '打开' + CAPABILITY_CAPTURE, onClick: () => panel.setOpen(true) },
                '📷 提交并分析',
              ),
            ),
          ),
        'gaia-inspection-capture-ui: header entry',
      )

      pullSnapshot()
    }

    exports.apply = apply
    exports.__test = {
      CAPABILITY_CAPTURE,
      CAPABILITY_ROLE,
      MAX_PHOTOS,
      MAX_PHOTO_BYTES,
      NOTE_MAX,
      DEMO_NOTICE,
      OFFLINE_NOTICE,
      STATE_EMPTY,
      STATE_RUNNING,
      SAMPLE_NOTE,
      splitDataUrl,
      encodePhotos,
      readReceipt,
      shortNo,
      isAcceptedImage,
      builtinSampleDataUrl,
      storeLabelOf,
      normalizeOffline,
      busyReasonOf,
      offlineEdge,
      localView,
      submitState,
      panel,
      snapshotSource,
      pullSnapshot,
      submitSelfCheck,
      CaptureDock,
      CapturePanel,
      ViewTabs,
      hasReact: React !== null,
    }
    return module.exports
  },
})
