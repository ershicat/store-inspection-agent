// gaia-inspection-oversight-ui — 客户端半（纯浏览器 ESM，手写 ModuleLoader bundle）。
//
// 逐字对齐《界面实现说明（画面级）》屏 B · 督导端：
//   顶部：视图标签（店长端/督导端）+「模型调用日志」独立入口 + 统计行 `累计 N 条 · 待你判断 M 条（其中 x 条已逾期）· 逾期 K 条 · 已办结 J 条`
//   → 左右两栏（左：筛选「待复核·逾期·已办结·全部」，每档带命中条数 + 倒序列表（缩略图+编号+门店+时间+状态，逾期整条标红并显示「已升级」）；
//     右：提交详情 = 门店原话 · 状态行（含「已通过 x/y 项」部分通过进度）· 退回/办结横幅 · 动作记录 · 「为什么查这几项」浅底块（3–5 条）· 检查项卡（项名/判断/依据/回看原图/
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
    // InspectionApp（已定稿）里的店长端屏标题读的就是这个能力词；补齐定义，否则进店长端即 ReferenceError。
    const CAPABILITY_CAPTURE = '门店自查采集入口'

    const SNAPSHOT_PATH = '/api/gaia-inspection/snapshot'
    const EVIDENCE_PATH = '/api/gaia-inspection/evidence'
    const MODELCALLS_PATH = '/api/gaia-inspection/model-calls'
    const SCAN_PATH = '/api/gaia-inspection/scan'
    /** 督导动作的浏览器侧入口（be 已注册 `/review` 与 `/review-action` 两条等价路径，本包用前者）。 */
    const REVIEW_ACTION_PATH = '/api/gaia-inspection/review'
    /** 与动作码对应的中文词（be 两种都认，本包按中文词发，回执里另有 actionCode 可匹配）。 */
    const ACTION_WORDS = { approve: '通过', reject: '退回并说明', remind: '催办', close: '办结' }
    /** 动作码（be 回执 action.actionCode）→ 中文词，用于匹配"这条动作到底做了什么"。 */
    const ACTION_CODE_WORDS = { review_approve: '通过', review_reject: '退回并说明', review_remind: '催办', review_close: '办结' }
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
      rectified: '已办结',
      approved: '已通过',
      rejected: '已退回',
      closed: '已关闭',
      unreadable: '材料不可判读',
      ok: '正常',
      failed: '分析失败',
      unknown: '未知',
    }

    /**
     * 状态归组（列表筛选 / 空态文案 / 顶栏统计**共用同一套**）。
     *
     * 为什么要有这套常量：改前 `filterInspections` 只认 pending_rectify 几个状态，
     * 且「待复核」为空时会**静默退回成逾期列表** —— 用户实测看到"待复核 tab 里全是逾期条目"，
     * 同时**已经通过（rectified）的单子除了「全部」之外没有任何入口**（用户实测提问：
     * "待复核 / 逾期 / 全部，是不是差一个已办结"）。这里把口径写死在一处：
     *   · 已办结 = 全部判断项都通过（后端 status='rectified'）或已关闭
     *   · 待你判断 = **还没办结的单**（补集口径，不是白名单）
     *   · 逾期 = 后端按 dueAt 判定的超时，是待你判断里的一个**子集标记**，不单独成档
     */
    const DONE_STATUSES = ['rectified', 'closed', 'approved']

    const FILTERS = [
      { key: 'pending', label: '待复核', hint: '还没办结、也没被退回过（含已逾期 / 已升级 / 材料不可判读）' },
      { key: 'returned', label: '已退回', hint: '督导已退回、还没办结（等门店整改 / 等复核回拍单）' },
      { key: 'overdue', label: '逾期', hint: '截止时间已过且还没整改完（「待复核」与「已退回」里都可能出现）' },
      { key: 'done', label: '已办结', hint: '全部判断项已通过 / 已关闭' },
      { key: 'all', label: '全部', hint: '本机库里全部检查单' },
    ]

    const statusKeyOf = (item) => trim(textOf(item && item.status)).toLowerCase()
    const isDoneItem = (item) => DONE_STATUSES.indexOf(statusKeyOf(item)) !== -1
    /**
     * 待你判断＝**补集口径**：凡是没有办结的单都算"等你处理"。
     *
     * 为什么改成补集（真机实测踩到的）：白名单只列 `pending_rectify` 等几个状态，
     * 而后端逾期扫描会把单子改成 `overdue` / `escalated` —— 那些单**仍然是待整改、仍然等你判断**，
     * 却会从「待复核」里消失（真机上待复核从 11 条掉到 2 条）。
     * 补集口径下"没有结论就还在队列里"，也顺带让 **累计 = 待你判断 + 已办结** 成为恒等式
     * （顶栏四枚数字不再互相矛盾，逾期则是待你判断里的一个子集）。
     */
    const isPendingItem = (item) => !isDoneItem(item)

    /**
     * 「已退回」＝被督导退回过、**且还没办结**的单（客户 10-03 用完真机后的裁定：
     * "退回和未办放一起了，少一个已退回栏"）。
     *
     * 与「待复核」**互斥**，两者相加恰好是顶栏的「待你判断」（恒等式不变）：
     *   · 待复核 = 没被退回过、还没办结；
     *   · 已退回 = 被退回过、还没办结（含"门店已回拍、等督导复核"与"还没回拍、等门店整改"两种）。
     * 已经办结的退回单（整改通过 / 督导逐项点通过）留在「已办结」档，**不进这一档** ——
     * 否则这一档会同时装着"球在门店"和"已经完事"两种，跟用户抱怨的混档一样。
     */
    const isReturnedItem = (item) => !isDoneItem(item) && !!trim(textOf(item && item.returnedAt))

    /**
     * ── 订单（＝链根）与轮次（客户 10-03 裁定）────────────────────────────────
     *
     * 客户原话：「这家店这一次交单生成一个单号（已经有了）…… 被打回第二次发过来之后，在同一个订单
     * 右边新加一栏，点进去就是那一轮的内容 —— 这样有追溯，而且不复杂」。
     *
     * 口径（写死）：
     *   · **订单 = 一个链根**：`A`（初交）→ `B`（回拍，`reworkOf=A`）→ `C`（再回拍，`reworkOf=B`）算**一个订单**；
     *   · **轮次 = 一次提交**，按 `createdAt` 升序，就是 初交 → 第 2 轮回拍 → 第 3 轮回拍……
     *   · 订单的**状态/档位一律看最新一轮**（球在谁手里看最新一轮）：最新一轮未办结且未退回 = 待复核；
     *     最新一轮未办结且已退回 = 已退回（等门店整改）；最新一轮已办结 = 已办结；
     *   · 逾期 = **最新一轮**的 `overdue` 标记（老轮的逾期不把整个订单拖在逾期档里）。
     *
     * 数据来源只有快照里已有的 `reworkOf`：**不加后端字段、不加接口**。
     * 找不到父亲（父亲不在当前快照里）时，这一条自己就是链根 —— 不会把订单吞掉。
     */
    function timeOf(value) {
      const t = value ? new Date(value).getTime() : NaN
      return isFinite(t) ? t : 0
    }
    function orderRootOf(item, byId) {
      let cur = item
      const seen = new Set()
      let guard = 0
      while (cur && guard < 64) {
        guard += 1
        const parentId = trim(textOf(cur.reworkOf))
        const parent = parentId ? byId.get(parentId) : null
        if (!parent || seen.has(parentId)) break
        seen.add(parentId)
        cur = parent
      }
      return cur || item
    }
    /** 把一批检查单按「订单（链根）」归组；每个订单带升序的 `rounds` 与 `latest`。订单按最新一轮时间倒序。 */
    function groupOrders(list) {
      const rows = Array.isArray(list) ? list : []
      const byId = new Map()
      for (const row of rows) {
        const id = trim(textOf(row && row.id))
        if (id) byId.set(id, row)
      }
      const groups = new Map()
      for (const row of rows) {
        const root = orderRootOf(row, byId)
        const key = trim(textOf(root && root.id)) || trim(textOf(row && row.id))
        if (!groups.has(key)) groups.set(key, { rootId: key, rounds: [] })
        groups.get(key).rounds.push(row)
      }
      const out = []
      for (const group of groups.values()) {
        const rounds = group.rounds.slice().sort((a, b) => (timeOf(a.createdAt) - timeOf(b.createdAt)) || String(a.id).localeCompare(String(b.id)))
        out.push({ rootId: group.rootId, root: rounds[0], rounds, latest: rounds[rounds.length - 1], size: rounds.length })
      }
      return out.sort((a, b) => timeOf(b.latest && b.latest.createdAt) - timeOf(a.latest && a.latest.createdAt))
    }
    const orderIsDone = (order) => isDoneItem(order && order.latest)
    const orderIsReturned = (order) => Boolean(order) && !orderIsDone(order) && !!trim(textOf(order.latest && order.latest.returnedAt))
    /** 这个订单被退回过的**轮次数**（不是后端 returnedCount 的累加，是"哪几轮带着退回标记"）。 */
    const orderReturnedCount = (order) => (order && Array.isArray(order.rounds) ? order.rounds.filter((row) => trim(textOf(row && row.returnedAt))).length : 0)
    /** 订单级筛选（界面上的五档与条数一律走这里；单级的 `filterInspections` 只留给单元测试与责任方标）。 */
    function filterOrders(list, filter) {
      const orders = groupOrders(list)
      if (filter === 'returned') return orders.filter(orderIsReturned)
      if (filter === 'overdue') return orders.filter((order) => Boolean(order.latest && order.latest.overdue))
      if (filter === 'done') return orders.filter(orderIsDone)
      if (filter === 'all') return orders
      return orders.filter((order) => !orderIsDone(order) && !orderIsReturned(order))
    }
    function countOrders(list, filter) {
      return filterOrders(list, filter).length
    }

    /**
     * 单档进度：**已通过 x / 共 y 项**（A2）。
     *
     * 为什么要有它：后端只在**全部判断项都通过**时才把检查单置 `rectified`（action 里 `allDone` 判定），
     * 所以"只通过了其中一项"的单在界面上仍然是「逾期 / 待复核」—— 逻辑没错，但界面没把这件事说出来，
     * 督导看到动作记录里明明有「通过 00:50 · 地面与通道」会以为没生效。
     *
     * 分母取 `findings.length`：findings 只有模型判过「不符合」的问题项才会落库
     * （capture/lib persistJudgement 只写 `vision.data.findings`），所以它是**真实判断项记录**，不臆造。
     */
    function progressOf(item) {
      const findings = Array.isArray(item && item.findings) ? item.findings : []
      const total = findings.length
      const passed = findings.filter((f) => statusKeyOf(f) === 'rectified').length
      return { passed, total, partial: total > 0 && passed > 0 && passed < total, allPassed: total > 0 && passed === total }
    }

    /** 进度文案（详情与列表共用一套字：`已通过 1/2 项`）。 */
    function progressTextOf(item) {
      const p = progressOf(item)
      return p.total > 0 && p.passed > 0 ? '已通过 ' + p.passed + '/' + p.total + ' 项' : ''
    }

    /**
     * 已办结结论（A1）—— **必须分两种情况，判据是真实记录，不臆造**：
     *   · `clean`：findings 为空 = 本次全部判断项都判「符合」
     *     （findings 只有模型判过"不符合"的问题项才落库：capture/lib 只写 vision.data.findings）
     *     →「本次未发现问题（无需整改项）」
     *   · `fixed`：findings 非空且现在全部通过 = 曾经有问题、整改通过了 →「全部 N 项判断已通过」
     * 两句混用会把"整改通过"说成"本来就没问题"，等于把产品卖点抹掉，所以这里既不合并也不猜。
     */
    function doneSummaryOf(item) {
      const p = progressOf(item)
      if (p.total === 0) return { kind: 'clean', text: '本次未发现问题（无需整改项）' }
      if (p.allPassed) return { kind: 'fixed', text: '全部 ' + p.total + ' 项判断已通过' }
      return { kind: 'partial', text: '已通过 ' + p.passed + '/' + p.total + ' 项（后端已标记办结）' }
    }

    /** 每个筛选档的空态文案（各说各的事，不再一律写"当前没有待复核"）。 */
    const EMPTY_TEXT = {
      pending: { title: '当前没有待复核的单子', detail: '店长端提交自查后会出现在这里；一个订单只要**最新一轮**还没办结、也没被退回，就一直在这一档（含已逾期、已升级、材料不可判读的单）。被督导退回的单在「已退回」档；也可以切到「已办结」看已处理完的。' },
      returned: { title: '当前没有"已退回待整改"的单子', detail: '督导点「退回并说明」后，订单会从「待复核」移到这一档，一直留到**门店回拍**（回拍后新的一轮会把它带回「待复核」）或办结；已办结的留在「已办结」档。' },
      overdue: { title: '当前没有逾期条目。', detail: '**最新一轮**的截止时间过了但还没整改完的订单会进这一档（「待复核」与「已退回」里都可能出现），并由后端自动催办 / 升级。' },
      done: { title: '还没有办结的单子', detail: '一个订单的**最新一轮**判断项全部点「通过」后就办结（含门店回拍后复核通过）；它会从「待复核」移到这里。' },
      all: { title: '还没有任何巡店提交', detail: '在店长端选一家门店、拍一张照片、写一句话提交，就能看到链路跑起来。' },
    }

    /** 日志面板的固定说明（脱敏口径写在这里，便于自测**原样断言**而不与正文里的禁词说明混淆）。 */
    const LOGS_EMPTY_TEXT = '暂无调用记录'
    const LOGS_MASKING_TEXT = '记录来自后端 model_calls 表（真实调用留痕、不许事后补写）；前端只读，且只展示业务摘要——不请求、不展示凭据类字段。'
    const LOGS_MISSING_TEXT = '的这几列「提示词版本 / 请求摘要 / 响应摘要」后端暂未提供（显示 —）：口径需 gaia-inspection-core 的 model_calls 记录补齐；前端不代填、不臆造。'

    /**
     * 样式层（前端重做 §2 + make-interfaces-feel-better）。
     *
     * 令牌只此一套，值只许来自指令 §2 的三张表；本包自声明、不依赖另一个包。
     *   · 圆角四个值：卡片 18 / 内部块 12 / 按钮与输入框 10 / 胶囊 999
     *   · 同心规则：外圆角 = 内圆角 + 内边距。落地口径——含 10px 控件的卡片内边距取 8（18 = 10 + 8）；
     *     纯文字块不产生嵌套圆角，可用 12 / 16 内边距；贴边的动作条交给父级 overflow 裁切，不另造圆角。
     *   · 阴影只有两级，都用 rgba 透明黑，禁止纯黑。
     *   · 边框只表达结构与状态（分隔线 / 选中 / 焦点），不用来假装高度；按钮的 1px 圈一律用 box-shadow 画。
     *   · 字号只有三档：20 标题 / 13 正文 / 11 辅助。
     *   · 动效一律 transition 且写全属性名（禁止 transition: all），150–200ms ease-out；高频操作不加自定义动画。
     */
    const CSS = `
/* 令牌声明在 :root —— 会话 header / 输入区这些入口挂在 .giou-root 之外，落在 :root 上才取得到值。 */
:root {
  /* 暖调（客户裁定甲）：值逐条来自 openpencil-design-muqu4vgs-e37d.op 源文件。
     --gi-ink-3 设计稿未单列 → 按《美术层第二单》§三 保留现值。 */
  --gi-bg: #F4F0E8;
  --gi-card: #FFFFFF;
  --gi-ink: #17191D;
  --gi-ink-2: #66635E;
  --gi-ink-3: #8A909C;
  --gi-line: #DED8CE;
  --gi-accent: #A84300;
  --gi-dark: #111318;
  --gi-warn-bg: #FFF3E6;
  --gi-warn-ink: #9A4A00;
  --gi-r-card: 18px;
  --gi-r-block: 12px;
  --gi-r-ctl: 10px;
  --gi-r-pill: 999px;
  --gi-s1: 4px; --gi-s2: 8px; --gi-s3: 12px; --gi-s4: 16px;
  --gi-s6: 24px; --gi-s8: 32px; --gi-s10: 40px;
  --gi-shadow-card: 0 2px 8px rgba(16,19,25,.06);
  --gi-shadow-pop: 0 10px 28px rgba(16,19,25,.18);
  --gi-fs-title: 20px; --gi-fs-body: 13px; --gi-fs-aux: 11px;
  --gi-ease: cubic-bezier(.2,0,0,1);
}
.giou-root {
  box-sizing: border-box;
  height: 100%; min-height: 0; width: 100%;
  display: flex; flex-direction: column;
  background: var(--gi-bg); color: var(--gi-ink);
  font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: var(--gi-fs-body); line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
.giou-root *, .giou-root *::before, .giou-root *::after { box-sizing: border-box; }
.giou-num { font-variant-numeric: tabular-nums; }
.giou-scroll { min-height: 0; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--gi-track) transparent; }
.giou-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.giou-scroll::-webkit-scrollbar-thumb { background: var(--gi-track); border: 3px solid transparent; border-radius: var(--gi-r-pill); background-clip: content-box; }
@media (prefers-reduced-motion: reduce) { .giou-root * { transition-duration: 1ms !important; animation-duration: 1ms !important; } }

/* ── 控件（四态齐全；禁用态一律灰化，主 CTA 也不保留品牌色）────────────── */
.giou-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--gi-s2);
  min-height: 44px; padding: 0 var(--gi-s4);
  border: 0; border-radius: var(--gi-r-ctl);
  background: var(--gi-card); color: var(--gi-ink);
  box-shadow: 0 0 0 1px var(--gi-line);
  font: inherit; font-size: var(--gi-fs-body); cursor: pointer; white-space: nowrap;
  transition-property: background-color, box-shadow, color, scale;
  transition-duration: 160ms; transition-timing-function: var(--gi-ease);
}
.giou-btn:hover:not([disabled]) { background: var(--gi-surface-hover); box-shadow: 0 0 0 1px var(--gi-line-strong), var(--gi-shadow-card); }
.giou-btn:active:not([disabled]) { scale: .96; }
.giou-btn:focus-visible { outline: 2px solid var(--gi-accent); outline-offset: 2px; }
.giou-btn[disabled] { background: var(--gi-surface-soft); color: var(--gi-ink-disabled); box-shadow: 0 0 0 1px var(--gi-line-soft); cursor: not-allowed; }
.giou-btn.primary { background: var(--gi-accent); color: var(--gi-on-accent); box-shadow: var(--gi-shadow-card); }
.giou-btn.primary:hover:not([disabled]) { background: var(--gi-accent-hover); }
.giou-btn.primary[disabled] { background: var(--gi-surface-soft); color: var(--gi-ink-disabled); box-shadow: 0 0 0 1px var(--gi-line-soft); }
.giou-btn.quiet { background: transparent; color: var(--gi-ink-2); box-shadow: none; }
.giou-btn.quiet:hover:not([disabled]) { background: rgba(16,19,25,.05); box-shadow: none; }
.giou-btn.quiet[disabled] { background: transparent; box-shadow: none; color: var(--gi-ink-faint); }
.giou-btn.danger { background: var(--gi-dark); color: var(--gi-on-accent); box-shadow: var(--gi-shadow-card); }
.giou-btn.danger:hover:not([disabled]) { background: var(--gi-dark-hover); }
/* 开关类按钮的「开」态用深色块，不占强调色——一屏只给一个主 CTA 用 var(--gi-accent)。 */
.giou-btn[data-on="1"] { background: var(--gi-dark); color: var(--gi-on-accent); }
.giou-btn[data-on="1"]:hover:not([disabled]) { background: var(--gi-dark-hover); box-shadow: var(--gi-shadow-card); }

.giou-seg { display: inline-flex; align-items: center; gap: var(--gi-s2); padding: var(--gi-s1); border-radius: var(--gi-r-pill); background: var(--gi-line-soft); }
.giou-seg button {
  display: inline-flex; align-items: center; justify-content: center;
  min-height: 44px; padding: 0 var(--gi-s4);
  border: 0; border-radius: var(--gi-r-pill); background: transparent; color: var(--gi-ink-2);
  font: inherit; font-size: var(--gi-fs-body); cursor: pointer; white-space: nowrap;
  transition-property: background-color, color, box-shadow, scale; transition-duration: 160ms; transition-timing-function: var(--gi-ease);
}
.giou-seg button:hover:not([data-on="1"]) { color: var(--gi-ink); background: rgba(255,255,255,.6); }
.giou-seg button:active { scale: .96; }
.giou-seg button:focus-visible { outline: 2px solid var(--gi-accent); outline-offset: 2px; }
.giou-seg button[data-on="1"] { background: var(--gi-card); color: var(--gi-ink); box-shadow: var(--gi-shadow-card); }

.giou-input, .giou-note {
  width: 100%; border: 0; border-radius: var(--gi-r-ctl); padding: var(--gi-s3);
  background: var(--gi-card); color: var(--gi-ink); box-shadow: 0 0 0 1px var(--gi-line);
  font: inherit; font-size: var(--gi-fs-body);
  transition-property: box-shadow; transition-duration: 160ms; transition-timing-function: var(--gi-ease);
}
.giou-input:focus-visible, .giou-note:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--gi-accent); }
.giou-input[disabled], .giou-note[disabled] { background: var(--gi-surface-soft); color: var(--gi-ink-disabled); box-shadow: 0 0 0 1px var(--gi-line-soft); cursor: not-allowed; }
.giou-note { min-height: 88px; resize: vertical; }

/* ── 壳：顶部一行（标题 + 两端/日志切换 + 动作）──────────────────────── */
.giou-shell { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.giou-top { display: flex; align-items: center; gap: var(--gi-s3); padding: var(--gi-s3) var(--gi-s4); background: var(--gi-bg); border-bottom: 1px solid var(--gi-line); flex-wrap: wrap; }
.giou-topmain { display: flex; flex-direction: column; gap: var(--gi-s1); min-width: 0; }
.giou-title { font-size: var(--gi-fs-title); font-weight: 600; letter-spacing: -.01em; text-wrap: balance; }
.giou-sub { font-size: var(--gi-fs-aux); color: var(--gi-ink-3); text-wrap: pretty; }
.giou-grow { flex: 1 1 auto; }
.giou-content { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.giou-pad { padding: var(--gi-s6) var(--gi-s4); }

/* ── 首屏：斜线分屏（定稿 10-03 14:45；取代旧的"对角错位两卡"，旧样式一并删除）────
   甲（客户裁定）：斜线左上→右下。上侧三角＝门店端（贴顶边、右上方向），下侧三角＝总部督导端（贴底边、左下方向）。
   两块都用 clip-path 画出可点区域 —— **点三角形里的空白也算点中了这一块**（整块热区）。
   圆钮骑在斜线中点（即容器正中）、z-index 最高。 */
.giou-splitwrap { position: relative; flex: 1; min-height: 0; width: 100%; overflow: hidden; background: var(--gi-card); }
.giou-split {
  position: absolute; inset: 0; display: flex; margin: 0; padding: 0; border: 0;
  font: inherit; text-align: left; cursor: pointer;
  background: var(--gi-card); color: var(--gi-ink);
  transition-property: background-color; transition-duration: 160ms; transition-timing-function: var(--gi-ease);
}
.giou-split.manager { clip-path: polygon(0 0, 100% 0, 100% 100%); }
.giou-split.supervisor { clip-path: polygon(0 0, 0 100%, 100% 100%); background: var(--gi-dark); color: var(--gi-on-dark); }
.giou-split.manager:hover { background: var(--gi-surface-soft); }
.giou-split.supervisor:hover { background: var(--gi-dark-hover); }
.giou-split:focus-visible { outline: 2px solid var(--gi-accent); outline-offset: -6px; }
/* 两块文案各自坐在**所在三角形的重心**上、整块文字居中：
   直角三角 (0,0)(W,0)(W,H) 的重心 = (2W/3, H/3)，(0,0)(0,H)(W,H) 的重心 = (W/3, 2H/3)。
   贴在角上（真机首版）看着"字太偏"，重心位置才是这一块视觉的中心；也不会压到斜线或中央圆钮。 */
.giou-split-body {
  position: absolute; left: 66.7%; top: 33.3%; transform: translate(-50%, -50%);
  width: min(52ch, 44%);
  display: flex; flex-direction: column; align-items: center; gap: var(--gi-s2); text-align: center;
}
.giou-split.supervisor .giou-split-body { left: 33.3%; top: 66.7%; }
.giou-split-name { font-size: var(--gi-fs-title); font-weight: 600; text-wrap: balance; }
.giou-split-why { font-size: var(--gi-fs-body); color: var(--gi-ink-2); text-wrap: pretty; }
.giou-split.supervisor .giou-split-why { color: var(--gi-on-dark-3); }
.giou-split-hint { font-size: var(--gi-fs-aux); color: var(--gi-ink-3); }
.giou-split.supervisor .giou-split-hint { color: var(--gi-on-dark-faint); }
/* 演示替身那行是**说明文字、不是热区**（pointer-events:none，否则"整块热区"里就有死区）。
   位置钉在**左下角**：那一角永远落在深色三角里（斜线左上→右下，左下离斜线最远），灰字压深底始终可读。
   ——放右下角会跨到白区（灰字压白底，真机截图里已经糊了）；文案挪到重心后，左下也不会再压着督导端正文。 */
.giou-split-demo { position: absolute; left: var(--gi-s8); bottom: var(--gi-s8); z-index: 2; font-size: var(--gi-fs-aux); color: var(--gi-on-dark-faint); text-wrap: pretty; pointer-events: none; }
.giou-split-back {
  position: absolute; right: var(--gi-s6); top: var(--gi-s6); z-index: 2;
  min-height: 44px; padding: 0 var(--gi-s4); border: 0; border-radius: var(--gi-r-ctl);
  background: var(--gi-card); color: var(--gi-ink); box-shadow: 0 0 0 1px var(--gi-line);
  font: inherit; font-size: var(--gi-fs-aux); cursor: pointer;
  transition-property: background-color, box-shadow; transition-duration: 160ms; transition-timing-function: var(--gi-ease);
}
.giou-split-back:hover { background: var(--gi-surface-soft); box-shadow: 0 0 0 1px var(--gi-line-strong); }
.giou-split-back:focus-visible { outline: 2px solid var(--gi-accent); outline-offset: 2px; }
.giou-knob {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 3;
  width: 64px; height: 64px; padding: 0; border: 0; border-radius: var(--gi-r-pill);
  background: var(--gi-dark); color: var(--gi-on-accent);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  /* 圆钮正骑在斜线上：一侧是白底、一侧是深底 —— 纯深色圆在深色那半会"化掉"（真机截图里只剩半个）。
     所以加一圈**白环**把它从两边都分开（白环是结构描边、不是投影，投影仍只用两级里的浮层档）。 */
  box-shadow: 0 0 0 3px var(--gi-card), var(--gi-shadow-pop);
  transition-property: background-color, scale; transition-duration: 160ms; transition-timing-function: var(--gi-ease);
}
.giou-knob:hover { background: var(--gi-dark-hover); }
.giou-knob:active { scale: .96; }
.giou-knob:focus-visible { outline: 2px solid var(--gi-accent); outline-offset: 2px; }
.giou-knob svg { display: block; width: 24px; height: 24px; }

/* ── 屏 B：左列表 + 右详情（同一容器规格）────────────────────────────── */
.giou-b { flex: 1; min-height: 0; display: flex; }
.giou-blist { width: 320px; flex: none; border-right: 1px solid var(--gi-line); display: flex; flex-direction: column; min-height: 0; background: var(--gi-card); }
.giou-filters { display: flex; flex-wrap: wrap; gap: var(--gi-s2); padding: var(--gi-s3); border-bottom: 1px solid var(--gi-line); }
.giou-filters button { min-height: 44px; padding: 0 var(--gi-s4); border: 0; border-radius: var(--gi-r-pill); background: var(--gi-surface-soft); color: var(--gi-ink-2); font: inherit; font-size: var(--gi-fs-body); cursor: pointer; transition-property: background-color, color, scale; transition-duration: 150ms; transition-timing-function: var(--gi-ease); }
.giou-filters button:hover:not([data-on="1"]) { background: var(--gi-surface-soft-2); color: var(--gi-ink); }
.giou-filters button:active { scale: .96; }
.giou-filters button:focus-visible { outline: 2px solid var(--gi-accent); outline-offset: 2px; }
.giou-filters button[data-on="1"] { background: var(--gi-dark); color: var(--gi-on-accent); }
/* 筛选档上的命中条数：与标签同一枚胶囊，弱化成次要信息；选中态里反白 */
/* A6：四档 + 条数在 348px 的左栏里排不下时**换行**，并且每枚按钮有最小宽度 —— 窗口再缩也不把字挤成竖排。
   （真机截图里出现过「已/办/结」三个字各占一行。） */
.giou-filters button { display: inline-flex; align-items: center; gap: var(--gi-s2); flex: none; min-width: 76px; white-space: nowrap; padding: 0 var(--gi-s3); }
.giou-filter-n { min-width: 18px; padding: 0 var(--gi-s2); border-radius: var(--gi-r-pill); background: rgba(16,19,25,.07); color: var(--gi-ink-2); font-size: var(--gi-fs-aux); font-variant-numeric: tabular-nums; text-align: center; }
.giou-filters button[data-on="1"] .giou-filter-n { background: rgba(255,255,255,.22); color: var(--gi-on-accent); }
.giou-list { flex: 1; min-height: 0; overflow-y: auto; padding: var(--gi-s3); display: flex; flex-direction: column; gap: var(--gi-s2); }
.giou-item { display: flex; gap: var(--gi-s3); width: 100%; padding: var(--gi-s2); border: 0; border-radius: var(--gi-r-card); background: var(--gi-card); box-shadow: 0 0 0 1px var(--gi-line); color: inherit; text-align: left; font: inherit; cursor: pointer; transition-property: box-shadow, background-color, scale; transition-duration: 160ms; transition-timing-function: var(--gi-ease); }
.giou-item:hover { box-shadow: 0 0 0 1px var(--gi-line-strong), var(--gi-shadow-card); }
.giou-item:active { scale: .96; }
.giou-item:focus-visible { outline: 2px solid var(--gi-accent); outline-offset: 2px; }
.giou-item[data-on="1"] { box-shadow: 0 0 0 2px var(--gi-accent), var(--gi-shadow-card); }
.giou-item[data-overdue="1"] { background: var(--gi-warn-bg); box-shadow: 0 0 0 1px var(--gi-warn-line); }
.giou-item[data-overdue="1"][data-on="1"] { box-shadow: 0 0 0 2px var(--gi-accent), var(--gi-shadow-card); }
.giou-thumb { width: 56px; height: 56px; flex: none; border-radius: var(--gi-r-ctl); object-fit: cover; background: var(--gi-line-soft); outline: 1px solid rgba(16,19,25,.10); outline-offset: -1px; }
.giou-thumb-ph { width: 56px; height: 56px; flex: none; border-radius: var(--gi-r-ctl); background: var(--gi-surface-soft); color: var(--gi-ink-3); font-size: var(--gi-fs-aux); display: flex; align-items: center; justify-content: center; text-align: center; }
.giou-item-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--gi-s1); }
.giou-item-id { font-size: var(--gi-fs-body); font-weight: 600; }
.giou-item-meta { font-size: var(--gi-fs-aux); color: var(--gi-ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.giou-item-chips { display: flex; gap: var(--gi-s1); flex-wrap: wrap; }
.giou-bdetail { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; padding: var(--gi-s4); display: flex; flex-direction: column; gap: var(--gi-s3); background: var(--gi-bg); }
.giou-h2 { font-size: var(--gi-fs-body); font-weight: 600; display: flex; align-items: center; gap: var(--gi-s2); flex-wrap: wrap; }
.giou-quote { border-left: 3px solid var(--gi-line); padding: var(--gi-s1) var(--gi-s3); color: var(--gi-ink-2); font-size: var(--gi-fs-body); text-wrap: pretty; }
.giou-statusrow { display: flex; align-items: center; gap: var(--gi-s3); flex-wrap: wrap; font-size: var(--gi-fs-aux); color: var(--gi-ink-3); }
.giou-stats { font-size: var(--gi-fs-aux); color: var(--gi-ink-2); white-space: nowrap; }
.giou-stats .bad { color: var(--gi-warn-ink); }
.giou-line { border-radius: var(--gi-r-block); padding: var(--gi-s2) var(--gi-s3); font-size: var(--gi-fs-aux); color: var(--gi-ink-2); background: var(--gi-surface-soft); }
.giou-line.warn { background: var(--gi-warn-bg); color: var(--gi-warn-ink); }
.giou-line.err { background: var(--gi-bad-bg); color: var(--gi-bad-ink); }
.giou-line.ok { background: var(--gi-ok-bg); color: var(--gi-ok-ink); }
.giou-field { display: grid; grid-template-columns: 64px 1fr; gap: var(--gi-s1) var(--gi-s3); font-size: var(--gi-fs-body); }
.giou-field .k { color: var(--gi-ink-3); font-size: var(--gi-fs-aux); padding-top: 0; }
.giou-field .v { word-break: break-word; text-wrap: pretty; }
.giou-chip { display: inline-flex; align-items: center; min-height: 22px; padding: 0 var(--gi-s2); border-radius: var(--gi-r-pill); font-size: var(--gi-fs-aux); background: var(--gi-surface-soft); color: var(--gi-ink-2); white-space: nowrap; }
.giou-chip[data-tone="overdue"], .giou-chip[data-tone="escalated"] { background: var(--gi-warn-bg); color: var(--gi-warn-ink); }
.giou-chip[data-tone="pending_rectify"], .giou-chip[data-tone="pending"] { background: var(--gi-accent-soft); color: var(--gi-accent-deep); }
.giou-chip[data-tone="rectified"], .giou-chip[data-tone="approved"] { background: var(--gi-ok-bg); color: var(--gi-ok-ink); }
.giou-chip[data-tone="high"] { background: var(--gi-ok-bg); color: var(--gi-ok-ink); }
.giou-chip[data-tone="mid"] { background: var(--gi-warn-bg); color: var(--gi-warn-ink); }
.giou-chip[data-tone="low"] { background: var(--gi-bad-bg); color: var(--gi-bad-ink); }

/* 「为什么查这几项」＝屏 B 视觉主角 */
.giou-why { border-radius: var(--gi-r-block); background: var(--gi-card); box-shadow: 0 0 0 1px var(--gi-line); padding: var(--gi-s4); display: flex; flex-direction: column; gap: var(--gi-s2); border-left: 4px solid var(--gi-accent); }
.giou-why .h { font-size: var(--gi-fs-title); font-weight: 600; }
.giou-why .r { font-size: var(--gi-fs-body); color: var(--gi-ink); white-space: pre-wrap; text-wrap: pretty; }

.giou-card { border-radius: var(--gi-r-card); background: var(--gi-card); box-shadow: var(--gi-shadow-card); padding: var(--gi-s2); display: flex; flex-direction: column; gap: var(--gi-s2); }
/* 同心：卡片 18 / 内边距 8 ⇒ 卡内每个带圆角的内块一律 10（18 = 10 + 8）。 */
.giou-card .giou-line, .giou-card .giou-shot { border-radius: var(--gi-r-ctl); }
.giou-card .head { display: flex; align-items: center; gap: var(--gi-s2); flex-wrap: wrap; padding: 0; }
.giou-card .nm { font-size: var(--gi-fs-body); font-weight: 600; }
.giou-photos { display: flex; align-items: flex-start; gap: var(--gi-s3); flex-wrap: wrap; padding: 0; }
.giou-shot { position: relative; border-radius: var(--gi-r-block); overflow: hidden; background: var(--gi-dark); max-width: 100%; }
.giou-shot img { display: block; max-width: 100%; max-height: 340px; outline: 1px solid rgba(16,19,25,.10); outline-offset: -1px; }
.giou-mark { position: absolute; width: 12px; height: 12px; margin: 0; transform: translate(-50%, -50%); border-radius: var(--gi-r-pill); background: var(--gi-mark); box-shadow: 0 0 0 2px rgba(255,255,255,.9); pointer-events: none; }
.giou-frame { position: absolute; border: 2px solid var(--gi-mark); border-radius: var(--gi-r-ctl); box-shadow: inset 0 0 0 1px rgba(255,255,255,.7); pointer-events: none; }
.giou-basis { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: var(--gi-s2); }
.giou-timeline { display: flex; flex-direction: column; gap: var(--gi-s2); border-left: 2px solid var(--gi-line); padding-left: var(--gi-s3); margin-left: var(--gi-s1); font-size: var(--gi-fs-aux); color: var(--gi-ink-2); }
.giou-timeline b { color: var(--gi-ink); }
/* ── 订单「上级栏」+ 轮次追（客户 10-03 裁定：右侧先按轮次一行一行列，点某一轮看那一轮）──
   只在多轮订单上出现；单轮订单的详情与改前逐字一致（不为了新结构给老界面加噪音）。 */
.giou-order { border-radius: var(--gi-r-card); background: var(--gi-card); box-shadow: 0 0 0 1px var(--gi-line); padding: var(--gi-s3); display: flex; flex-direction: column; gap: var(--gi-s2); border-left: 3px solid var(--gi-accent); }
.giou-order-h { display: flex; align-items: center; gap: var(--gi-s2); flex-wrap: wrap; }
.giou-order-no { font-size: var(--gi-fs-body); font-weight: 600; }
.giou-order-sub { font-size: var(--gi-fs-aux); color: var(--gi-ink-3); text-wrap: pretty; }
.giou-rounds { display: flex; flex-direction: column; gap: var(--gi-s1); border-radius: var(--gi-r-block); background: var(--gi-card); box-shadow: 0 0 0 1px var(--gi-line); padding: var(--gi-s2); }
.giou-round { display: flex; align-items: center; gap: var(--gi-s2); width: 100%; min-height: 40px; padding: 0 var(--gi-s2); border: 0; border-radius: var(--gi-r-ctl); background: transparent; color: inherit; font: inherit; font-size: var(--gi-fs-body); text-align: left; cursor: pointer; flex-wrap: wrap; transition-property: background-color, color, box-shadow; transition-duration: 150ms; transition-timing-function: var(--gi-ease); }
.giou-round:hover:not([data-on="1"]) { background: var(--gi-surface-soft); }
.giou-round:focus-visible { outline: 2px solid var(--gi-accent); outline-offset: 2px; }
.giou-round[data-on="1"] { background: var(--gi-dark); color: var(--gi-on-accent); }
.giou-round[data-on="1"] .giou-round-time, .giou-round[data-on="1"] .giou-round-from { color: var(--gi-on-dark-faint); }
.giou-round-no { min-width: 48px; font-weight: 600; }
.giou-round-id { min-width: 56px; }
.giou-round-chips { display: flex; align-items: center; gap: var(--gi-s1); flex-wrap: wrap; }
.giou-round-time, .giou-round-from { font-size: var(--gi-fs-aux); color: var(--gi-ink-3); }
.giou-actions { display: flex; align-items: center; gap: var(--gi-s2); flex-wrap: wrap; padding: 0; }

/* ── 三态（加载中 / 空 / 失败）──────────────────────────────────────── */
.giou-state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--gi-s2); padding: var(--gi-s8) var(--gi-s4); text-align: center; color: var(--gi-ink-2); font-size: var(--gi-fs-body); }
.giou-state .t { font-weight: 600; color: var(--gi-ink); }
.giou-state .d { font-size: var(--gi-fs-aux); color: var(--gi-ink-3); max-width: 44ch; text-wrap: pretty; }
/* 骨架屏必须给宽度：父级 .giou-state 是 align-items:center，只给 height 会横向塌成 0 → 加载态看起来是白屏。 */
.giou-skel { width: 100%; align-self: stretch; height: 72px; border-radius: var(--gi-r-card); background: linear-gradient(90deg, rgba(16,19,25,.05), rgba(16,19,25,.10), rgba(16,19,25,.05)); background-size: 200% 100%; animation: giou-skel 1200ms ease-out infinite; }
@keyframes giou-skel { from { background-position: 200% 0; } to { background-position: 0 0; } }

/* ── 日志表（同一容器规格）──────────────────────────────────────────── */
.giou-logs { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: var(--gi-s3); padding: var(--gi-s4); }
.giou-logbar { display: flex; align-items: center; gap: var(--gi-s2); flex-wrap: wrap; }
.giou-tablewrap { flex: 1; min-height: 0; overflow: auto; background: var(--gi-card); border-radius: var(--gi-r-card); box-shadow: var(--gi-shadow-card); }
.giou-table { width: 100%; border-collapse: collapse; font-size: var(--gi-fs-body); }
.giou-table th { position: sticky; top: 0; z-index: 1; text-align: left; color: var(--gi-ink-3); font-weight: 600; font-size: var(--gi-fs-aux); background: var(--gi-card); border-bottom: 1px solid var(--gi-line); padding: var(--gi-s2) var(--gi-s3); white-space: nowrap; }
.giou-table td { border-bottom: 1px solid var(--gi-line); padding: var(--gi-s3); vertical-align: top; word-break: break-word; }
.giou-table tr[data-bad="1"] td { color: var(--gi-warn-ink); }
.giou-table .mono { font-family: ui-monospace, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
.giou-mask-note { font-size: var(--gi-fs-aux); color: var(--gi-ink-3); text-wrap: pretty; }

/* ── 挂载点上的小入口（输入区 / 会话 header）──────────────────────────── */
.giou-dockbtn { display: inline-flex; align-items: center; gap: var(--gi-s2); min-height: 44px; padding: 0 var(--gi-s4); border: 0; border-radius: var(--gi-r-ctl); background: var(--gi-card); color: var(--gi-ink); box-shadow: 0 0 0 1px var(--gi-line); font: inherit; font-size: var(--gi-fs-body); cursor: pointer; transition-property: background-color, box-shadow, scale; transition-duration: 160ms; transition-timing-function: var(--gi-ease); }
.giou-dockbtn:hover { background: var(--gi-surface-hover); box-shadow: 0 0 0 1px var(--gi-line-strong), var(--gi-shadow-card); }
.giou-dockbtn:active { scale: .96; }
.giou-dockbtn:focus-visible { outline: 2px solid var(--gi-accent); outline-offset: 2px; }

/* ── 追加（实施契约 §4 允许：清单里缺失的类，只新增、不改已有规则与令牌）──────
   值仍取 §3.1/§3.2 的令牌与口径：圆角 10、间距 4/8/12/16/24、间距只用 8 的倍数、
   控件四态齐全（hover / active / focus-visible / disabled，禁用态一律灰化）、
   transition 写全属性名且 150–200ms ease-out。 */
.giou-select {
  min-height: 44px; padding: 0 var(--gi-s3);
  border: 0; border-radius: var(--gi-r-ctl);
  background: var(--gi-card); color: var(--gi-ink);
  box-shadow: 0 0 0 1px var(--gi-line);
  font: inherit; font-size: var(--gi-fs-body); cursor: pointer;
  transition-property: background-color, box-shadow; transition-duration: 160ms; transition-timing-function: var(--gi-ease);
}
.giou-select:hover:not([disabled]) { background: var(--gi-surface-hover); box-shadow: 0 0 0 1px var(--gi-line-strong), var(--gi-shadow-card); }
.giou-select:active:not([disabled]) { scale: .96; }
.giou-select:focus-visible { outline: 2px solid var(--gi-accent); outline-offset: 2px; }
.giou-select[disabled] { background: var(--gi-surface-soft); color: var(--gi-ink-disabled); box-shadow: 0 0 0 1px var(--gi-line-soft); cursor: not-allowed; }

/* ══ 第二轮重做（2026-10-03）：整窗外壳 + 视觉重排 ══════════════════════════
   三条用户反馈：① 界面只是嵌在 DSH 里的一个入口 → 改成 shell.overlay 上的**整窗表层**；
   ② 看板/采集全 404 → 后端已修，界面要有真内容可看；③ 太空、太灰、太素 → 重排视觉。
   本节只新增令牌与覆盖规则，不改上面任何一个令牌的值。 */
:root {
  /* 左导航（应用自己的 chrome）：深底 + 三级文字，用来把「这是应用、不是对话」一眼说清。
     暖调后一律取设计稿源文件的深色系（#111318 / #1C1917 / #D6D3D1 / #A8A29E）。 */
  --gi-nav: #111318;
  --gi-nav-2: #1C1917;
  --gi-nav-ink: #D6D3D1;
  --gi-nav-ink-3: #A8A29E;
  --gi-nav-hover: rgba(255,255,255,.07);
  --gi-nav-on: rgba(255,255,255,.13);
  --gi-navline: rgba(255,255,255,.09);
  /* ── 语义色阶（非品牌令牌，本包自声明）─────────────────────────────────────
     契约 §3.1 的品牌值只有上面 10 个；界面还要用的中性色与状态色原先**写死在 80 多处**，
     同一个值最多抄 12 遍。这里把"值"集中声明一次，规则里只引名字：观感一字未改，
     改色从此只剩一处。命名按**用途**（surface / line / ink / ok / bad / mark），不按色相。 */
  --gi-on-accent: #FFFFFF;       /* 强调色块与深色 chrome 上的文字 / 焦点描边（.op 白） */
  --gi-on-dark: #F4F0E8;         /* 深色卡上的正文（.op 页底同色，暖白） */
  --gi-on-dark-3: #A8A29E;       /* 深色卡上的辅助文字（.op 弱字） */
  --gi-on-dark-faint: #A8A29E;   /* 深色卡上的更弱文字（.op 弱字） */
  --gi-surface-soft: #FAF8F3;    /* 中性块底：禁用底 / chip / 筛选项（.op 次级底） */
  --gi-surface-soft-2: #F4F0E8;  /* 中性块底 hover（.op 页底色，压深一档） */
  --gi-surface-hover: #FAF8F3;   /* 可点元素 hover 底（.op 次级底） */
  --gi-surface-tint: #FAF8F3;    /* 统计块 / 首屏 CTA 底（.op 次级底） */
  --gi-surface-tint-2: #F4F0E8;  /* 上面那档的 hover */
  --gi-line-strong: #DED8CE;     /* 控件描边 / 1px 环线（.op 边框） */
  --gi-line-soft: #DED8CE;       /* 禁用态描边（.op 边框） */
  --gi-ink-disabled: #A8A29E;    /* 禁用态文字（.op 弱字） */
  --gi-ink-faint: #A8A29E;       /* 更弱一档（quiet 禁用） */
  --gi-track: #D6D3D1;           /* 滚动条（.op 暖灰） */
  --gi-accent-hover: #A8360A;    /* 强调色 hover（第一单 §四 指定值） */
  --gi-accent-soft: #FFD9A8;     /* 强调浅底：chip / 徽标底（.op 强调底，第二单 §三.2） */
  --gi-accent-deep: #A84300;     /* 浅底上的强调色文字 = .op 主色本身 */
  --gi-dark-hover: #1C1917;      /* 深色按钮 hover（.op 页脚深） */
  --gi-dark-2: #1C1917;          /* 深色按钮 hover（再深一档，同上取 .op 页脚深） */
  --gi-ok-bg: #EAF3EC; --gi-ok-ink: #24603A;
  --gi-bad-bg: #FDECEC; --gi-bad-ink: #A32222;
  --gi-warn-line: #F0C79A;
  --gi-mark: #FF3B30;            /* 照片上的问题区域框与落点（数据标注，不是 chrome；语义色保留） */
}

/* ── 整窗表层：铺满宿主给的表层容器（.overlayLayer = absolute/inset:0/z-index:20）── */
.giou-root[data-surface="window"] {
  position: absolute; inset: 0; z-index: 1;
  pointer-events: auto; /* 表层本身 click-through，条目要自己opt-in指针事件 */
  background: var(--gi-bg);
}
.giou-root[data-surface="panel"] { position: relative; }

/* 顶部拖拽带：Windows 下宿主用 padding-top 给标题栏让位，本表层盖住了它，得把拖拽区补回来 */
.giou-titlebar {
  flex: none; height: var(--dsh-windows-titlebar-height, 0px);
  background: var(--gi-nav); -webkit-app-region: drag;
}
.giou-appbody { flex: 1; min-height: 0; display: flex; }

/* ── 左导航：品牌 + 角色视图切换 + 日志 + 底部动作 ─────────────────────── */
.giou-nav {
  flex: none; width: 236px; display: flex; flex-direction: column; gap: var(--gi-s6);
  padding: var(--gi-s6) var(--gi-s3) var(--gi-s4);
  background: var(--gi-nav); color: var(--gi-nav-ink);
}
.giou-navbrand { display: flex; align-items: center; gap: var(--gi-s3); padding: 0 var(--gi-s2); }
.giou-navmark {
  flex: none; width: 32px; height: 32px; border-radius: var(--gi-r-ctl);
  display: flex; align-items: center; justify-content: center;
  background: var(--gi-accent); color: var(--gi-on-accent); font-size: var(--gi-fs-body); font-weight: 600;
}
.giou-navname { min-width: 0; display: flex; flex-direction: column; }
.giou-navtitle { font-size: var(--gi-fs-body); font-weight: 600; color: var(--gi-on-accent); }
.giou-navsub { font-size: var(--gi-fs-aux); color: var(--gi-nav-ink-3); }
.giou-navgroup { display: flex; flex-direction: column; gap: var(--gi-s1); }
.giou-navlabel { padding: 0 var(--gi-s2); font-size: var(--gi-fs-aux); color: var(--gi-nav-ink-3); }
.giou-navbtn {
  display: flex; align-items: center; gap: var(--gi-s3); width: 100%; min-height: 44px;
  padding: 0 var(--gi-s3); border: 0; border-radius: var(--gi-r-ctl);
  background: transparent; color: var(--gi-nav-ink);
  font: inherit; font-size: var(--gi-fs-body); text-align: left; cursor: pointer;
  transition-property: background-color, color, scale; transition-duration: 160ms; transition-timing-function: var(--gi-ease);
}
.giou-navbtn:hover:not([data-on="1"]) { background: var(--gi-nav-hover); color: var(--gi-on-accent); }
.giou-navbtn:active { scale: .96; }
.giou-navbtn:focus-visible { outline: 2px solid var(--gi-on-accent); outline-offset: -2px; }
.giou-navbtn[data-on="1"] { background: var(--gi-nav-on); color: var(--gi-on-accent); }
.giou-navdot { flex: none; width: 6px; height: 6px; border-radius: var(--gi-r-pill); background: var(--gi-accent); opacity: 0; }
.giou-navbtn[data-on="1"] .giou-navdot { opacity: 1; }
.giou-navfoot { display: flex; flex-direction: column; gap: var(--gi-s2); border-top: 1px solid var(--gi-navline); padding-top: var(--gi-s4); }
.giou-navcta {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--gi-s2);
  min-height: 44px; padding: 0 var(--gi-s4); border: 0; border-radius: var(--gi-r-ctl);
  background: var(--gi-accent); color: var(--gi-on-accent); font: inherit; font-size: var(--gi-fs-body); font-weight: 600;
  cursor: pointer; box-shadow: var(--gi-shadow-card);
  transition-property: background-color, box-shadow, scale; transition-duration: 160ms; transition-timing-function: var(--gi-ease);
}
.giou-navcta:hover:not([disabled]) { background: var(--gi-accent-hover); }
.giou-navcta:active:not([disabled]) { scale: .96; }
.giou-navcta:focus-visible { outline: 2px solid var(--gi-on-accent); outline-offset: 2px; }
.giou-navcta[disabled] { background: var(--gi-nav-2); color: var(--gi-nav-ink-3); box-shadow: none; cursor: not-allowed; }
.giou-navbtn.ghost { color: var(--gi-nav-ink-3); justify-content: flex-start; }
.giou-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }

/* ── 主区顶栏：标题/副标题 + 右端统计与动作（白底，和灰底正文分层）───────── */
.giou-root .giou-top {
  flex: none; padding: var(--gi-s4) var(--gi-s6); gap: var(--gi-s4);
  background: var(--gi-card); border-bottom: 1px solid var(--gi-line);
}
.giou-root .giou-title { font-size: var(--gi-fs-title); }
.giou-topright { display: flex; align-items: center; gap: var(--gi-s3); }
.giou-notices { flex: none; display: flex; flex-direction: column; gap: var(--gi-s2); padding: var(--gi-s3) var(--gi-s6) 0; }

/* 统计三枚：保留原 chip 逐字文本，只把皮换成整块的数字块 */
.giou-root .giou-statusrow { gap: var(--gi-s3); padding: 0; }
.giou-statusrow .giou-chip {
  min-height: 44px; padding: 0 var(--gi-s4); border-radius: var(--gi-r-block);
  background: var(--gi-surface-tint); color: var(--gi-ink-2); font-size: var(--gi-fs-body); font-weight: 600;
}
.giou-statusrow .giou-chip[data-tone="overdue"] { background: var(--gi-warn-bg); color: var(--gi-warn-ink); }

/* ── 首屏：斜线分屏（第二轮重做的旧"两卡更饱满"覆盖已随旧结构一并删除）────── */

/* ── 屏 B：列表列更松、详情区更满（消灭大块灰白空场）─────────────────── */
.giou-b { gap: 0; }
.giou-blist { width: 348px; background: var(--gi-surface-hover); }
.giou-root .giou-filters { padding: var(--gi-s3); gap: var(--gi-s2); background: var(--gi-card); }
.giou-list { padding: var(--gi-s3); gap: var(--gi-s3); }
/* B1 同心圆角：卡片 18 = 内块 10 + 内边距 8（**这一行不许再改成别的圆角/内边距组合** ——
   真机复验里 12px 圆角 + 12px 内边距配 10px 缩略图会把"外圆角=内圆角+内边距"这条破坏掉，
   嵌套圆角不一致是"生硬"的第一根因；列表的呼吸感改由 .giou-list 的间距给）*/
.giou-item { padding: var(--gi-s2); border-radius: var(--gi-r-card); }
.giou-thumb, .giou-thumb-ph { width: 64px; height: 64px; }
.giou-bdetail { padding: var(--gi-s6); gap: var(--gi-s4); }
/* B1 同心圆角：卡片 18 = 内块 10 + 内边距 8（这里不再放大内边距 —— 12 会让内外圆角不同心） */
.giou-card { padding: var(--gi-s2); }
.giou-why { padding: var(--gi-s6); gap: var(--gi-s3); border-left-width: 4px; border-radius: var(--gi-r-card); }
.giou-why .r { font-size: var(--gi-fs-body); line-height: 1.7; }
.giou-h2 { gap: var(--gi-s3); }

/* ── 三态：撑满可用高度，别缩成中间一小块 ─────────────────────────────── */
.giou-root .giou-content > .giou-state, .giou-bdetail > .giou-state { flex: 1; min-height: 320px; }
.giou-state .t { font-size: var(--gi-fs-body); }
.giou-skel { height: 96px; }

/* ── 日志：表头与行距更清楚 ───────────────────────────────────────────── */
.giou-logs { padding: var(--gi-s6); gap: var(--gi-s4); }
.giou-table td { padding: var(--gi-s3) var(--gi-s4); }
/* 空/失败态吃掉剩余高度：日志面板是整窗的一屏，别把「暂无调用记录」挤在顶上留半屏空白 */
.giou-logs > .giou-state { flex: 1; min-height: 0; }
/* 「已退回·待整改」用危险色族（和逾期/告警同一套语义色，见 §11.15） */
.giou-chip[data-tone="returned"] { background: var(--gi-bad-bg); color: var(--gi-bad-ink); }
/* A4：材料不可判读用告警色族 —— 它要的动作是"决定是否让店长重拍"，不是"复核判断"，
   和同档的「待复核」（蓝）必须一眼分得开 */
.giou-chip[data-tone="unreadable"] { background: var(--gi-warn-bg); color: var(--gi-warn-ink); }
/* A2：部分通过（还在整改中）也走告警色族，全部通过走已办结绿 */
.giou-chip[data-tone="partial"] { background: var(--gi-warn-bg); color: var(--gi-warn-ink); }
/* A2 详情"状态"行里的「已通过 1/2 项」：部分通过要显眼，全部通过可以低调 */
.giou-progress { color: var(--gi-ink-2); }
.giou-progress[data-tone="partial"] { color: var(--gi-warn-ink); font-weight: 600; }
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

    /**
     * 状态 chip 组：状态本身 + 逾期/已升级两枚附加标记 + **责任方**一枚。
     * **去重**：状态已经是「逾期」时不再并排一枚一模一样的「逾期」（真机截图里出现过「逾期 逾期」）。
     *
     * 责任方（客户 10-03 裁定）：逾期档里两种"超时"责任完全不同，必须能一眼分开 ——
     *   · 已被督导退回 → **等门店整改**（球在门店）；
     *   · 从未退回     → **待你复核**（AI 判了问题项、给了整改截止，但督导还没做人工处置，球在督导）。
     * 真机实测这批超时单里 2 张属于前者、7 张属于后者，混在一档时只能靠「已退回」chip 猜。
     */
    function statusChipsOf(item) {
      const base = statusLabelOf(item && item.status)
      const out = [{ label: base, tone: statusToneOf(item) }]
      if (item && item.overdue && base !== '逾期') out.push({ label: '逾期', tone: 'overdue' })
      if (item && item.escalated && base !== '已升级') out.push({ label: '已升级', tone: 'escalated' })
      if (item && (item.overdue || item.escalated)) {
        out.push(item.returnedAt ? { label: '等门店整改', tone: 'returned' } : { label: '待你复核', tone: 'pending' })
      }
      return out
    }
    /** 把 chip 组渲染成 span 列表（列表项 / 详情头 / 判断卡共用一套口径）。 */
    function renderStatusChips(item) {
      return statusChipsOf(item).map((chip, index) => React.createElement('span', { className: 'giou-chip', key: 'chip' + index, 'data-tone': chip.tone }, chip.label))
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
     * 最近一条**退回动作**（A-5）：从该单的动作列表里找 `退回并说明 / review_reject`，取最后一条。
     *
     * 为什么不能再用 `lastAction`：后端逾期扫描会往同一张单追加**催办 / 升级**（actor='系统'），
     * 于是"最近一条动作"不是退回那条 —— 真机上就出现了「由 系统 退回」（其实系统只催办/升级过），
     * 退回原因也被显示成了升级原因。谁退的、为什么退，必须取**退回那一条真实记录**。
     */
    function lastRejectOf(item) {
      const rows = Array.isArray(item && item.actions) ? item.actions : []
      const rejects = rows.filter((a) => a && (a.type === '退回并说明' || a.actionCode === 'review_reject'))
      return rejects.length > 0 ? rejects[rejects.length - 1] : null
    }
    /** 主体是谁：人工（督导）还是系统自动。 */
    function actorLabelOf(action) {
      if (!action) return ''
      const who = trim(textOf(action.actorName)) || trim(textOf(action.actor))
      if (action.actorIsHuman === false || who === '系统') return (who || '系统') + '（系统自动）'
      return (who || '督导') + '（人工）'
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
        // 退回闭环：这条判断被退回过的痕迹（店长端整改要看的、督导端要能追溯的）
        rejectedAt: raw.rejectedAt === undefined ? null : raw.rejectedAt,
        rejectedReason: textOf(raw.rejectedReason),
        boxesCount: Array.isArray(raw.boxes) ? raw.boxes.length : 0,
        // A-1.3：模型只给了落点（框不准时的降级）也要透传 —— 卡片据此说明"这条能不能在图上回指"
        fallbackPoint: raw.fallbackPoint && typeof raw.fallbackPoint === 'object' ? raw.fallbackPoint : null,
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
        // 真实模型调用次数（后端按 inspectionId 统计）。早先前端把它写死成「有判断就是 1 次」，
        // 而一次提交实际是 checklist_generate + vision_judge **两次**调用 —— 这个数字被教练级别的人一眼抓到。
        modelCallCount: Number.isFinite(Number(raw.modelCallCount)) ? Math.max(0, Number(raw.modelCallCount)) : 0,
        // 退回闭环（后端快照新增字段）：被退回时间/次数、整改回拍来源、最近一条人工动作
        returnedAt: raw.returnedAt === undefined ? null : raw.returnedAt,
        returnedCount: Number.isFinite(Number(raw.returnedCount)) ? Math.max(0, Number(raw.returnedCount)) : 0,
        reworkOf: textOf(raw.reworkOf),
        lastAction: raw.lastAction && typeof raw.lastAction === 'object' ? raw.lastAction : null,
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

    /**
     * 顶栏四枚统计：`累计 N 条 · 待你判断 M 条（其中 x 条已逾期）· 逾期 K 条 · 已办结 J 条`。
     *
     * A3：改前第一枚是**今日**（按本地日界算「今天创建的」），但库里装的是历史数据，
     * 于是真机上出现「今日 0 条 / 待你判断 11 条」这种自相矛盾的并排 —— 现在只给
     * 「累计（库里全部订单）」+ 三个**工作队列口径**的数。
     *
     * 10-03（客户裁定"一个订单多轮"之后）：四枚数字一律**按订单计**，与左栏五档同口径：
     *   累计 = 订单数（一家店一次交单＝一单，含它的所有整改轮次）；待你判断 = 最新一轮未办结的订单；
     *   逾期 = 最新一轮已逾期的订单（待你判断的子集）；已办结 = 最新一轮已办结的订单。
     * 恒等式：待你判断 + 已办结 = 累计（左栏则是 待复核 + 已退回 = 待你判断）。
     */
    function statsOf(snapshot) {
      const data = snapshot && snapshot.ok !== false ? snapshot : null
      const rows = data ? data.inspections : []
      const orders = groupOrders(rows)
      let pending = 0
      let overdue = 0
      let done = 0
      let pendingAndOverdue = 0
      for (const order of orders) {
        const latest = order.latest || {}
        const closed = orderIsDone(order)
        if (closed) done += 1
        else pending += 1
        if (latest.overdue) {
          overdue += 1
          if (!closed) pendingAndOverdue += 1
        }
      }
      return { pending, overdue, done, pendingAndOverdue, total: orders.length, rounds: Array.isArray(rows) ? rows.length : 0 }
    }

    /**
     * 列表筛选 —— **单级（一轮一轮地）口径**。界面已经不走它了（界面的五档与条数一律按**订单**口径走
     * `filterOrders` / `countOrders`），这里保留给单元测试与"责任方标"这类逐条判断用，口径写死：
     * 待复核 / 已退回 按"有没有被退回过"互斥切分，逾期是叠加标记，空就是空（不静默偷换成逾期）。
     */
    function filterInspections(list, filter) {
      if (filter === 'returned') return list.filter(isReturnedItem)
      if (filter === 'overdue') return list.filter((item) => item.overdue)
      if (filter === 'done') return list.filter(isDoneItem)
      if (filter === 'all') return list.slice()
      return list.filter((item) => isPendingItem(item) && !isReturnedItem(item))
    }

    /** 每个筛选档的命中条数（筛选按钮上的数字，与筛选本身同一套谓词）。 */
    function countInspections(list, filter) {
      return filterInspections(list, filter).length
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
     * 口不可用时：本机留痕并标「⚠ 未同步到后端」，**不假装成功**（`⚠` 是文案语义符号，不是图标位，按客户口径保留）。
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
      // 首屏纪律（指令 §3）：每次启动都落在角色选择；选定后本次运行内保持（§5.4 关闭再开状态可复现）。
      entered: false,
      view: 'board', // board | logs
      snapshot: { entered: false, view: 'board' },
      listeners: new Set(),
      subscribe(listener) {
        panelState.listeners.add(listener)
        return () => panelState.listeners.delete(listener)
      },
      notify() {
        panelState.snapshot = { entered: panelState.entered, view: panelState.view }
        panelState.listeners.forEach((listener) => {
          try {
            listener()
          } catch (error) {
            /* 忽略 */
          }
        })
      },
      setEntered(next) {
        panelState.entered = next === true
        if (panelState.entered) {
          if (panelState.view === 'logs') pullLogs()
          else pullSnapshot()
        }
        panelState.notify()
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

    /**
     * 「进入本包面板」的挂载期钩子：由 apply() 在 main 注册后赋值。
     * 面板机制下「打开」= 进入面板 + 把主区域切到本 key（不是旧的浮层开关——旧写法点完没有任何可见变化）。
     */
    let enterMainPanel = () => false
    let leaveMainPanel = () => false

    function exposeChannels() {
      globalThis.__gaia_inspection_oversight__ = {
        openPanel: (view) => enterMainPanel(view === 'logs' ? 'logs' : view === 'board' ? 'board' : undefined),
        closePanel: () => leaveMainPanel(),
        runScan: () => runScan(),
        refresh: () => pullSnapshot(),
        scanState,
        actionState,
        evidenceState,
        panelState,
      }
    }

    // ── 组件：日志表（外壳的日志视图 / 右侧栏独立 tab 共用；同一容器规格）────
    // 契约 §3.4-1：容器 `.giou-logs`（含 `.giou-logbar` + `.giou-tablewrap` + `.giou-table`），
    // 7 列逐字、空态逐字「暂无调用记录」、脱敏说明逐字、失败调用 responseSummary=null 不误报，三态齐全。
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
      const statuses = Array.from(new Set(calls.map((call) => call.status).filter(Boolean)))

      // 过滤条：计数改成独立 chip（不拼 `·` 元数据串）。
      const bar = React.createElement('div', { className: 'giou-logbar', key: 'bar' }, [
        React.createElement('span', { className: 'giou-h2', key: 'title' }, CAPABILITY_LOGS),
        React.createElement('button', { className: 'giou-btn', type: 'button', key: 'refresh', onClick: () => pullLogs() }, '刷新'),
        React.createElement(
          'button',
          { className: 'giou-btn', type: 'button', key: 'auto', 'data-on': source.auto ? '1' : '0', onClick: () => { logsSource.auto = !logsSource.auto; logsSource.notify() } },
          (source.auto ? '✓ ' : '') + '每 5 秒自动刷新',
        ),
        React.createElement(
          'select',
          { className: 'giou-select', key: 'store', value: storeFilter, 'aria-label': '按门店筛选', onChange: (event) => setStoreFilter(event && event.target ? event.target.value : '') },
          [React.createElement('option', { key: '__all', value: '' }, '全部门店'), ...stores.map((id) => React.createElement('option', { key: id, value: id }, id))],
        ),
        React.createElement(
          'select',
          { className: 'giou-select', key: 'status', value: statusFilter, 'aria-label': '按状态筛选', onChange: (event) => setStatusFilter(event && event.target ? event.target.value : '') },
          [React.createElement('option', { key: '__all_st', value: '' }, '全部状态'), ...statuses.map((status) => React.createElement('option', { key: status, value: status }, status))],
        ),
        React.createElement('span', { className: 'giou-chip giou-num', key: 'total' }, '本机 ' + String(data ? data.count : '—') + ' 条'),
        React.createElement('span', { className: 'giou-chip giou-num', key: 'shown' }, '显示 ' + String(visible.length) + ' 条'),
      ])

      const children = [bar]

      // 三态 ① 加载中 / ③ 失败+重试（失败时读不到任何记录，不留白屏）。
      if (!data) {
        children.push(
          source.failure
            ? React.createElement(DataState, {
                key: 'fail',
                kind: 'fail',
                title: '模型调用记录不可用',
                detail: source.failure + '；装好 gaia-inspection-core 后，这里会逐条列出模型调用记录。',
                actionLabel: '重试',
                onAction: () => pullLogs(),
              })
            : React.createElement(DataState, { key: 'loading', kind: 'loading', title: '正在读取模型调用记录…' }),
        )
        return React.createElement('div', { className: 'giou-logs' }, children)
      }

      if (source.failure) {
        children.push(
          React.createElement(
            'div',
            { className: 'giou-line warn', key: 'stale' },
            source.lastOkAt
              ? '调用日志不可用（上次成功 ' + source.lastOkAt + '）：下面显示的是上次成功的数据。'
              : '调用日志不可用（尚无成功数据）：' + source.failure,
          ),
        )
      }

      // 三态 ② 空（居中提示 + 下一步动作按钮）。
      if (calls.length === 0) {
        children.push(
          React.createElement(DataState, {
            key: 'empty',
            kind: 'empty',
            title: LOGS_EMPTY_TEXT,
            detail: '还没有模型调用留痕：在店长端提交一次自查后，这里会逐条列出调用记录。',
            actionLabel: '刷新',
            onAction: () => pullLogs(),
          }),
        )
      } else if (visible.length === 0) {
        children.push(
          React.createElement(DataState, {
            key: 'filtered',
            kind: 'empty',
            title: '当前筛选条件下没有记录。',
            detail: '清掉门店 / 状态筛选可看到全部 ' + String(calls.length) + ' 条。',
            actionLabel: '清除筛选',
            onAction: () => { setStoreFilter(''); setStatusFilter('') },
          }),
        )
      } else {
        const columns = ['时间', '模型', '提示词版本', '提交编号', '请求摘要', '响应摘要', '耗时']
        children.push(
          React.createElement(
            'div',
            { className: 'giou-tablewrap', key: 'tablewrap' },
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
                    React.createElement('td', { className: 'mono giou-num' }, clockOf(call.ts) || textOf(call.ts) || '—'),
                    React.createElement('td', null, call.model || '—'),
                    React.createElement('td', null, call.hasPromptVersion ? call.promptVersion : call.kind ? call.kind + '（类型）' : '—'),
                    React.createElement('td', { className: 'mono giou-num' }, call.inspectionId ? shortNo(call.inspectionId) : '—'),
                    React.createElement('td', null, call.hasRequestSummary ? call.requestSummary : '—'),
                    React.createElement('td', null, call.hasResponseSummary ? call.responseSummary : '（本次无响应）'),
                    React.createElement('td', { className: 'mono giou-num' }, latencyOf(call.latencyMs) + (call.status && call.status !== 'ok' ? '｜' + call.status + (call.errorCode ? ' ' + call.errorCode : '') : '')),
                  ),
                ),
              ),
            ),
          ),
        )
        // 失败调用本来就 responseSummary=null（不算「后端缺字段」），只对 status=ok 的空响应报警。
        const missing = visible.filter((call) => !call.hasPromptVersion || !call.hasRequestSummary || (!call.hasResponseSummary && call.status === 'ok')).length
        if (missing > 0) {
          children.push(React.createElement('div', { className: 'giou-line warn', key: 'missing' }, '有 ' + missing + ' 条' + LOGS_MISSING_TEXT))
        }
      }

      children.push(React.createElement('div', { className: 'giou-mask-note', key: 'note' }, LOGS_MASKING_TEXT))

      return React.createElement('div', { className: 'giou-logs' }, children)
    }

    // ── 组件：证据区（面板内放大区；有框画框、无框标点、都没有就不画）────────
    // 契约 §3.4-2：改用 `.giou-photos/.giou-shot/.giou-mark/.giou-frame/.giou-basis/.giou-field/
    // `.giou-card/.giou-chip/.giou-actions`；证据区标题用能力词「证据挂图卡片」（本区第一次可见时展示）；
    // 三态齐全（骨架 / 无证据 / 接口失败+重试）。**绝不画空框**。
    function EvidenceArea({ finding, evidence }) {
      const [size, setSize] = React.useState(null)
      const data = evidence && evidence.phase === 'hit' ? evidence.data : null
      const locate = data ? locateEvidence(data) : { boxes: [], point: null, strategy: 'none', unit: 'ratio' }
      const photo = data && data.photo && typeof data.photo === 'object' ? data.photo : {}
      const url = textOf(photo.originalUrl) || textOf(photo.thumbUrl) || finding.originalUrl || finding.thumbUrl

      React.useEffect(() => {
        setSize(null)
      }, [finding.findingId])

      const area = []

      // 证据区标题＝能力词（本区第一次可见时就出现在标题位）。
      area.push(React.createElement('div', { className: 'giou-h2', key: 'title' }, CAPABILITY_EVIDENCE))

      if (evidence && evidence.phase === 'loading') {
        area.push(React.createElement(DataState, { key: 'loading', kind: 'loading', title: '正在回查原图…' }))
        area.push(React.createElement('div', { className: 'giou-line', key: 'loading-hint' }, '正在回查原图…'))
      } else if (evidence && evidence.phase === 'error') {
        area.push(
          React.createElement(DataState, {
            key: 'err',
            kind: 'fail',
            title: '证据接口不可用',
            detail: textOf(evidence.error) || '证据接口不可用',
            actionLabel: '重试',
            onAction: () => evidenceState.load(finding.findingId),
          }),
        )
      } else if (evidence && evidence.phase === 'miss') {
        area.push(
          React.createElement(DataState, {
            key: 'miss',
            kind: 'empty',
            title: textOf(evidence.summary) || '未找到该证据',
            detail: '这条判断没有可回查的证据记录。',
            actionLabel: '重试',
            onAction: () => evidenceState.load(finding.findingId),
          }),
        )
      }

      const shot = url
        ? React.createElement(
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
          )
        : null

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
        if (Array.isArray(data.unreadable) && data.unreadable.length > 0) {
          basis.push(React.createElement('div', { className: 'giou-line warn', key: 'unreadable' }, '看不清的照片 ' + data.unreadable.length + ' 张：未据此下结论（模型侧已标「看不清」）。'))
        }
        basis.push(React.createElement('div', { className: 'giou-field', key: 'reason' }, React.createElement('span', { className: 'k' }, '依据'), React.createElement('span', { className: 'v' }, textOf(data.reason) || finding.reason || '（模型未给依据文字）')))
        basis.push(React.createElement('div', { className: 'giou-field', key: 'sugg' }, React.createElement('span', { className: 'k' }, '整改要求'), React.createElement('span', { className: 'v' }, textOf(data.suggestion) || finding.suggestion || '未标注')))
        basis.push(React.createElement('div', { className: 'giou-field', key: 'due' }, React.createElement('span', { className: 'k' }, '截止'), React.createElement('span', { className: 'v' }, dateTimeOf(data.dueAt || finding.dueAt) || '未标注')))
      } else {
        basis.push(React.createElement('div', { className: 'giou-line', key: 'pending' }, '点「回看原图」后在这里显示定位与依据。'))
      }

      area.push(React.createElement('div', { className: 'giou-photos', key: 'photos' }, [shot, React.createElement('div', { className: 'giou-basis', key: 'basis' }, basis)]))

      return React.createElement('div', { className: 'giou-card', 'data-area': 'evidence' }, area)
    }

    // ── 组件：检查项卡（结论 / 依据 / 置信度 / 整改要求与截止 / 动作行）────────
    // 契约 §3.4-2：状态、置信度、逾期一律 `.giou-chip` + `data-tone`；逾期单独一枚 chip，
    // 不再拼 `pending_rectify · 逾期` 这类元数据串。动作词逐字：通过 / 退回并说明 / 催办 / 确认退回 / 取消。
    function FindingCard({ finding, storeName, onAction, busyAction, inspectionId, locked }) {
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

      const field = (key, label, value) =>
        React.createElement('div', { className: 'giou-field', key }, React.createElement('span', { className: 'k' }, label), React.createElement('span', { className: 'v' }, value))

      const chips = renderStatusChips(finding)
      // 本项是否已经通过（后端 status=rectified）：已通过就不再给「通过」按钮（见下方 A-1.8 注释）
      const passed = statusKeyOf(finding) === 'rectified'

      return React.createElement(
        'div',
        { className: 'giou-card' },
        React.createElement(
          'div',
          { className: 'head' },
          React.createElement('span', { className: 'nm' }, finding.itemName),
          React.createElement('span', { className: 'giou-chip', 'data-tone': confidence.level, title: confidenceNote }, '置信度 ' + confidence.label),
          ...chips,
          React.createElement('span', { style: { flex: '1' } }),
          React.createElement('button', { className: 'giou-btn', type: 'button', onClick: toggle }, open ? '收起原图' : '回看原图'),
        ),
        // 「判断」给结构化结论（项名 + 严重度），「依据」给模型原文——旧版两行都填 finding.reason，读起来是完全重复的两行。
        field('judge', '判断', '判为「' + textOf(finding.itemName) + '」，严重度' + (textOf(finding.severity) || '未标注')),
        field('basis', '依据', textOf(finding.reason) || '（模型未给依据文字）'),
        field('suggestion', '整改要求', textOf(finding.suggestion) || '未标注'),
        field('due', '截止', (dateTimeOf(finding.dueAt) || '未标注') + (finding.overdue ? '（逾期自动升级）' : '')),
        finding.boxesCount > 0
          ? React.createElement('div', { className: 'giou-line', key: 'boxes' }, '模型给了 ' + finding.boxesCount + ' 处区域框（点「回看原图」在图上框出）')
          : finding.fallbackPoint
            ? React.createElement('div', { className: 'giou-line', key: 'point' }, '这条判断模型只给了落点（点「回看原图」在图上标点，旁边写依据）')
            : React.createElement('div', { className: 'giou-line', key: 'nobox' }, '这条判断模型没有给框、也没有给落点：它的依据属于"画面里看不到 / 不足以证明"这类，没有可回指的坐标（本产品的规矩是绝不画空框，所以原图上不会出现标记）。'),
        // 本项被退回过的痕迹：写清楚"退给谁、为什么、下一步"，店长端「待整改」里能看到同一条。
        finding.rejectedAt
          ? React.createElement('div', { className: 'giou-line err', key: 'rejected' }, '本项已退回（' + (clockOf(finding.rejectedAt) || '—') + '）：「' + (textOf(finding.rejectedReason) || '（后端未记录原因）') + '」　→ 店长端「待整改」可看到并整改回拍，新单会标「整改回拍自 ' + shortNo(inspectionId) + '」。')
          : null,
        open ? React.createElement(EvidenceArea, { finding, evidence }) : null,
        React.createElement(
          'div',
          { className: 'giou-actions' },
          // A-1.8：这一项**已经通过**时不许再点（改前按钮永远可点，点几次就写几条重复的「通过」记录，
          // 看着还像"点了没生效" —— 真机验收就踩到了：同一项连点 8 次，单子还是待复核）。
          passed ? React.createElement('span', { className: 'giou-chip', 'data-tone': 'rectified', key: 'passed' }, '本项已通过') : null,
          // locked = 这一轮已经被后面某一轮取代：动作全停用（否则会把订单搞成"已办结 + 还有待复核的轮"）。
          React.createElement('button', { className: 'giou-btn', type: 'button', disabled: locked || passed || busyAction === 'approve', title: locked ? '这一轮已被最新一轮取代，动作已停用 —— 请到最新那一轮复核' : undefined, onClick: () => onAction({ type: 'approve', findingId: finding.findingId, reason: '' }) }, passed ? '已通过' : '通过'),
          React.createElement('button', { className: 'giou-btn', type: 'button', disabled: locked, title: locked ? '这一轮已被最新一轮取代，动作已停用' : undefined, onClick: () => setAskReason(!askReason) }, finding.rejectedAt ? '重新退回并说明' : '退回并说明'),
          React.createElement('button', { className: 'giou-btn', type: 'button', disabled: locked || busyAction === 'remind', title: locked ? '这一轮已被最新一轮取代，动作已停用' : undefined, onClick: () => onAction({ type: 'remind', findingId: finding.findingId, reason: '' }) }, '催办'),
        ),
        askReason
          ? React.createElement(
              'div',
              null,
              React.createElement('textarea', { className: 'giou-note', value: note, placeholder: '写一句退回原因（会写入这条提交的动作记录）', onChange: (event) => setNote(event && event.target ? event.target.value : '') }),
              React.createElement(
                'div',
                { className: 'giou-actions', style: { marginTop: '8px' } },
                React.createElement('button', { className: 'giou-btn primary', type: 'button', disabled: busyAction === 'reject' || trim(note).length === 0, onClick: () => onAction({ type: 'reject', findingId: finding.findingId, reason: note }) }, '确认退回'),
                React.createElement('button', { className: 'giou-btn', type: 'button', onClick: () => { setAskReason(false); setNote('') } }, '取消'),
              ),
            )
          : null,
      )
    }

    // ── 组件：屏 B（左右两栏：`.giou-blist` 列表 + `.giou-bdetail` 详情）───────
    // 契约 §3.4-3：容器换 `.giou-b`；**删掉本组件自己那行 topbar**（统计行与 立即扫描/刷新/
    // 模型调用日志/收起面板 现在都在 InspectionApp 顶部，重复即违反「同一容器规格」）；
    // 列表补齐三态；列表项用 `.giou-thumb/.giou-item-id/.giou-item-meta/.giou-item-chips + .giou-chip`；
    // 保留扫描回执 / 扫描失败两行。
    function BoardView() {
      const source = React.useSyncExternalStore(snapshotSource.subscribe, () => snapshotSource.snapshot, () => snapshotSource.snapshot)
      const scan = React.useSyncExternalStore(scanState.subscribe, () => scanState.snapshot, () => scanState.snapshot)
      const actions = React.useSyncExternalStore(actionState.subscribe, () => actionState.snapshot, () => actionState.snapshot)
      const [filter, setFilter] = React.useState('pending')
      const [selectedId, setSelectedId] = React.useState('')
      // 选中的**轮次**（一次提交）。空 = 落在该订单的最新一轮（客户口径：点订单先看最新一轮，再往上追）。
      const [roundId, setRoundId] = React.useState('')

      React.useEffect(() => {
        pullSnapshot()
        const timer = window.setInterval(pullSnapshot, POLL_MS)
        return () => window.clearInterval(timer)
      }, [])

      const data = source.data
      const rows = data ? data.inspections : []
      const orders = filterOrders(rows, filter)
      const selectedOrder = orders.find((order) => order.rootId === selectedId) || orders[0] || null
      const selected = selectedOrder
        ? (selectedOrder.rounds.find((row) => trim(textOf(row.id)) === roundId) || selectedOrder.latest)
        : null
      /** 点开的这一轮是不是"被后面某一轮取代"的老轮（是 → 这一轮的动作全部停用，见详情里的说明行）。 */
      const supersededRound = Boolean(
        selectedOrder && selectedOrder.size > 1 && selected && selectedOrder.latest
          && trim(textOf(selected.id)) !== trim(textOf(selectedOrder.latest.id)),
      )
      /**
       * 状态 chip（轮次行 / 轮次详情头共用）。`已办结` 是**订单级**结论 —— 只有最新一轮办结时整单才办结；
       * 被后面轮次取代的老轮，哪怕判断项全过了也只说「本轮已通过」。
       * （客户 10-03 抓到的反逻辑："办结是工单完成的标志，办结之后再开一轮是反逻辑的"。）
       */
      const renderRoundChips = (row) => {
        const isLatestRound = Boolean(selectedOrder && selectedOrder.latest) && trim(textOf(row.id)) === trim(textOf(selectedOrder.latest.id))
        const out = statusChipsOf(row).slice()
        if (!isLatestRound && isDoneItem(row) && out.length > 0) {
          out[0] = { label: '本轮已通过', tone: 'rectified', note: '这一轮的判断项已全部通过；但订单还没办结 —— 订单状态以最新一轮为准。' }
        }
        return out.map((chip, index) => React.createElement('span', { className: 'giou-chip', key: 'rc' + index, 'data-tone': chip.tone, title: chip.note || undefined }, chip.label))
      }

      const onAction = async (payload) => {
        if (!selected) return
        await recordAction({ inspectionId: selected.id, findingId: payload.findingId, type: payload.type, reason: payload.reason })
        if (payload.type === 'approve' || payload.type === 'reject') pullSnapshot()
      }

      // 筛选按钮带命中条数：用户实测提问"是不是差一个已办结"时，光有标签看不出有没有东西，
      // 数字能直接回答"这一档现在有几条"（空档写 0，不隐藏按钮 —— 否则用户以为功能不存在）。
      const children = [
        React.createElement(
          'div',
          { className: 'giou-filters', key: 'filters' },
          FILTERS.map((item) =>
            React.createElement(
              'button',
              { key: item.key, type: 'button', title: item.hint ? item.label + '：' + item.hint : undefined, 'data-on': filter === item.key ? '1' : '0', onClick: () => setFilter(item.key) },
              React.createElement('span', { key: 'label' }, item.label),
              React.createElement('span', { className: 'giou-filter-n giou-num', key: 'n' }, String(countOrders(rows, item.key))),
            ),
          ),
        ),
      ]

      // 逾期档的责任方图例（客户 10-03 裁定）：两种"超时"责任不同，chip 上的两个词要先说清
      // 才不会读成同一件事。只在「逾期」档显示，不占其它档的位置。
      if (filter === 'overdue') {
        children.push(
          React.createElement(
            'div',
            { className: 'giou-line', key: 'overdue-legend' },
            '这一档里两种"超时"责任不同：待你复核 ＝ AI 已判出问题项并给了整改截止，但还没人工处置（球在督导，'
              + '你复核/退回/通过都行）；等门店整改 ＝ 已退回、等着店长回拍（球在门店，逾期扫描会自动催办、超时升级）。',
          ),
        )
      }

      // 列表三态：加载中（骨架）/ 空（居中提示 + 下一步动作）/ 失败（原因 + 重试）。
      if (!data && !source.failure) {
        children.push(
          React.createElement('div', { className: 'giou-list', key: 'loading' }, React.createElement(DataState, { kind: 'loading', title: '正在读取巡店数据…' })),
        )
      } else if (!data) {
        children.push(
          React.createElement(
            'div',
            { className: 'giou-list', key: 'fail' },
            React.createElement(DataState, { kind: 'fail', title: '看板数据不可用', detail: source.failure, actionLabel: '重试', onAction: () => pullSnapshot() }),
          ),
        )
      } else if (orders.length === 0) {
        const empty = EMPTY_TEXT[filter] || EMPTY_TEXT.all
        children.push(
          React.createElement(
            'div',
            { className: 'giou-list', key: 'empty' },
            React.createElement(DataState, {
              kind: 'empty',
              title: empty.title,
              detail: empty.detail,
              actionLabel: filter === 'all' ? '刷新' : '看全部',
              onAction: filter === 'all' ? () => pullSnapshot() : () => setFilter('all'),
            }),
          ),
        )
      } else {
        // 左栏**一个订单一行**（客户 10-03 裁定）：一行里给最新一轮的状态 + 共几轮 + 被退回过几次，
        // 点进去先在右栏看到"上级栏 + 轮次列表"，再点某一轮看那一轮（追溯，不复杂）。
        children.push(
          React.createElement(
            'div',
            { className: 'giou-list', key: 'list' },
            orders.map((order) => {
              const latest = order.latest || {}
              const thumbUrl = (() => {
                for (let index = order.rounds.length - 1; index >= 0; index -= 1) {
                  const finding = order.rounds[index].findings && order.rounds[index].findings[0]
                  if (finding && finding.thumbUrl) return finding.thumbUrl
                }
                return null
              })()
              const returnedTimes = orderReturnedCount(order)
              const closed = orderIsDone(order)
              return React.createElement(
                'button',
                {
                  key: order.rootId,
                  type: 'button',
                  className: 'giou-item',
                  'data-on': selectedOrder && selectedOrder.rootId === order.rootId ? '1' : '0',
                  'data-overdue': latest.overdue ? '1' : '0',
                  onClick: () => {
                    setSelectedId(order.rootId)
                    setRoundId('')
                  },
                },
                thumbUrl
                  ? React.createElement('img', { className: 'giou-thumb', key: 'thumb', src: thumbUrl, alt: latest.storeName, loading: 'lazy' })
                  : React.createElement('span', { className: 'giou-thumb-ph', key: 'thumb-ph' }, '无缩略图'),
                React.createElement('span', { className: 'giou-item-txt', key: 'txt' }, [
                  React.createElement('span', { className: 'giou-item-id giou-num', key: 'id' }, shortNo(order.rootId)),
                  React.createElement('span', { className: 'giou-item-meta', key: 'store' }, latest.storeName),
                  React.createElement('span', { className: 'giou-item-meta', key: 'time' }, (order.size > 1 ? '共 ' + order.size + ' 轮 · 最新 ' : '') + (clockOf(latest.createdAt) || '时间未标注')),
                  React.createElement('span', { className: 'giou-item-chips', key: 'chips' }, [
                    ...renderStatusChips(latest),
                    // A2：列表也要能看出"部分通过"（否则一条单只通过了一半，在列表里跟没通过一模一样）
                    progressTextOf(latest)
                      ? React.createElement('span', { className: 'giou-chip giou-num', key: 'progress', 'data-tone': progressOf(latest).partial ? 'partial' : 'rectified' }, progressTextOf(latest))
                      : null,
                    // 多轮订单在列表上就要能看出"这单回拍过几次"（追溯的入口，不必点进去才知道）
                    order.size > 1 ? React.createElement('span', { className: 'giou-chip giou-num', key: 'rounds' }, '共 ' + order.size + ' 轮') : null,
                    // 退回痕迹：订单级**只说事实**「退回 N 次」—— 订单当前状态以最新一轮为准，
                    // 写「已退回」会被读成当前状态（逐轮的当前状态在轮次行上各自标）
                    returnedTimes > 0
                      ? React.createElement('span', { className: 'giou-chip giou-num', key: 'returned', 'data-tone': closed ? 'rectified' : 'returned' }, '退回 ' + returnedTimes + ' 次')
                      : null,
                  ]),
                  latest.note ? React.createElement('span', { className: 'giou-item-meta', key: 'note' }, trim(latest.note).slice(0, 26)) : null,
                ]),
              )
            }),
          ),
        )
      }

      const detail = []

      if (source.failure && data) {
        detail.push(
          React.createElement(
            'div',
            { className: 'giou-line warn', key: 'stale' },
            source.lastOkAt ? '看板数据不可用（上次成功 ' + source.lastOkAt + '）：下面显示的是上次成功的数据。' : '看板数据不可用（尚无成功数据）：' + source.failure,
          ),
        )
      }

      if (!selected) {
        // 三态按「有没有数据」+「有没有失败原因」分流：取数失败时详情区也必须给原因 + 重试，
        // 不能只看 data 而停在骨架（§5.2 失败态＝原因 + 重试，不留白屏）。
        const emptyDetail = EMPTY_TEXT[filter] || EMPTY_TEXT.all
        detail.push(
          data
            ? React.createElement(DataState, { key: 'nodetail', kind: 'empty', title: emptyDetail.title, detail: emptyDetail.detail, actionLabel: filter === 'all' ? '刷新' : '看全部', onAction: filter === 'all' ? () => pullSnapshot() : () => setFilter('all') })
            : source.failure
              ? React.createElement(DataState, { key: 'nodetail-fail', kind: 'fail', title: '看板数据不可用', detail: source.failure, actionLabel: '重试', onAction: () => pullSnapshot() })
              : React.createElement(DataState, { key: 'nodetail-loading', kind: 'loading', title: '正在读取巡店数据…' }),
        )
      } else {
        // ── 多轮订单：先「上级栏」（订单）→ 再「轮次」一行一行 → 最后是点开那一轮的详情 ─────────
        // 客户 10-03 裁定：被打回再发过来 = 同一订单多一轮，「这样有追溯，而且不复杂」。
        // 单轮订单**不渲染**这两块 —— 老界面逐字不变，不为新结构给常态加噪音。
        if (selectedOrder && selectedOrder.size > 1) {
          const latestRound = selectedOrder.latest || {}
          const firstRound = selectedOrder.root || {}
          const returnedTimes = orderReturnedCount(selectedOrder)
          const closedOrder = orderIsDone(selectedOrder)
          detail.push(
            React.createElement('div', { className: 'giou-order', key: 'order' }, [
              React.createElement('div', { className: 'giou-order-h', key: 'h' }, [
                React.createElement('span', { className: 'giou-order-no giou-num', key: 'no' }, '订单 ' + shortNo(selectedOrder.rootId)),
                React.createElement('span', { key: 'store' }, latestRound.storeName),
                React.createElement('span', { className: 'giou-chip giou-num', key: 'rounds' }, '共 ' + selectedOrder.size + ' 轮'),
                ...renderStatusChips(latestRound),
                returnedTimes > 0 ? React.createElement('span', { className: 'giou-chip giou-num', key: 'returned', 'data-tone': closedOrder ? 'rectified' : 'returned' }, '退回 ' + returnedTimes + ' 次') : null,
              ]),
              React.createElement(
                'div',
                { className: 'giou-order-sub giou-num', key: 'sub' },
                '首交 ' + (clockOf(firstRound.createdAt) || '—')
                  + ' · 最新第 ' + String(selectedOrder.size) + ' 轮 ' + (clockOf(latestRound.createdAt) || '—')
                  + ' · 截止 ' + (dateTimeOf(latestRound.dueAt) || '未标注')
                  + '　下面的每一轮都能单独点开看（初交 → 退回 → 回拍 → …）',
              ),
            ]),
          )
          detail.push(
            React.createElement(
              'div',
              { className: 'giou-rounds', key: 'rounds' },
              selectedOrder.rounds.map((row, index) =>
                React.createElement(
                  'button',
                  {
                    key: row.id,
                    type: 'button',
                    className: 'giou-round',
                    'data-on': selected && trim(textOf(selected.id)) === trim(textOf(row.id)) ? '1' : '0',
                    onClick: () => setRoundId(trim(textOf(row.id))),
                  },
                  [
                    React.createElement('span', { className: 'giou-round-no giou-num', key: 'no' }, '第 ' + String(index + 1) + ' 轮'),
                    React.createElement('span', { className: 'giou-round-id giou-num', key: 'id' }, shortNo(row.id)),
                    React.createElement('span', { className: 'giou-round-chips', key: 'chips' }, [
                      // 「已办结」是**订单级**结论（只有最新一轮办结时订单才办结）。中间轮哪怕判断项全过了，
                      // 也只能说「本轮已通过」—— 否则界面会读成"办结之后又开了一轮"（客户 10-03 抓到的反逻辑）。
                      ...renderRoundChips(row),
                      // 这一轮**被退回过**要写在轮次行上：这是追溯链的关键一格（哪一轮被打回来了）。
                      // 已办结的写「曾退回」，不跟状态打架。
                      row.returnedAt
                        ? React.createElement('span', { className: 'giou-chip', key: 'ret', 'data-tone': isDoneItem(row) ? 'rectified' : 'returned' }, isDoneItem(row) ? '曾退回' : '已退回')
                        : null,
                    ]),
                    React.createElement('span', { className: 'giou-round-time giou-num', key: 'time' }, clockOf(row.createdAt) || '—'),
                    row.reworkOf
                      ? React.createElement('span', { className: 'giou-round-from', key: 'from' }, '回拍自 ' + shortNo(row.reworkOf))
                      : React.createElement('span', { className: 'giou-round-from', key: 'from0' }, '原始提交'),
                  ],
                ),
              ),
            ),
          )
        }
        detail.push(
          React.createElement('div', { className: 'giou-h2', key: 'head' }, [
            React.createElement('span', { className: 'giou-num', key: 'no' }, (selectedOrder && selectedOrder.size > 1 ? '本轮提交 ' : '提交 ') + shortNo(selected.id)),
            React.createElement('span', { key: 'store' }, selected.storeName),
            selected.storeType ? React.createElement('span', { className: 'giou-item-meta', key: 'type' }, selected.storeType) : null,
            ...renderRoundChips(selected),
            // 退回闭环：被退回过就显眼地标出来，是"整改回拍"来的就写明来源单。
            // 已经办结的单不许再挂「待整改」（真机截图里出现过"已办结 + 已退回·待整改"同时挂着，自相矛盾）
            selected.returnedAt ? React.createElement('span', { className: 'giou-chip', key: 'returned', 'data-tone': isDoneItem(selected) ? 'rectified' : 'returned' }, isDoneItem(selected) ? '曾退回·已整改通过' : '已退回·待整改') : null,
            selected.reworkOf ? React.createElement('span', { className: 'giou-chip', key: 'rework' }, '整改回拍自 ' + shortNo(selected.reworkOf)) : null,
            selected.demo ? React.createElement('span', { className: 'giou-chip', key: 'demo' }, '演示样例') : null,
          ]),
        )
        detail.push(React.createElement('div', { className: 'giou-quote', key: 'note' }, '门店原话：「' + (trim(selected.note) || '（无）') + '」'))
        detail.push(
          React.createElement(
            'div',
            { className: 'giou-statusrow', key: 'status' },
            React.createElement('span', null, '状态：' + statusLabelOf(selected.status)),
            // A2：部分通过必须写在"状态"旁边 —— 后端只在全部项通过后才改状态，界面不写这句督导会以为没生效
            progressTextOf(selected)
              ? React.createElement('span', { className: 'giou-progress giou-num', key: 'progress', 'data-tone': progressOf(selected).partial ? 'partial' : 'done' }, progressTextOf(selected))
              : null,
            React.createElement('span', null, '提交 ' + (clockOf(selected.createdAt) || '—')),
            React.createElement('span', null, '截止 ' + (dateTimeOf(selected.dueAt) || '未标注')),
            React.createElement('span', { className: 'giou-num' }, '模型调用 ' + String(selected.modelCallCount || 0) + ' 次'),
            selected.source ? React.createElement('span', null, '来源 ' + selected.source) : null,
          ),
        )

        // ── 被新轮取代的老轮：不许再被处置（客户 10-03 抓到的反逻辑："办结是工单完成的标志，
        //    办结之后再开一轮是反逻辑的" —— 反过来也一样：门店已经回拍出新的一轮之后，督导不该
        //    再去把老轮逐项点通过/退回，那会把订单搞成"已办结 + 还有待复核的轮"）。 ──────────────
        if (supersededRound) {
          detail.push(
            React.createElement(
              'div',
              { className: 'giou-line warn', key: 'superseded' },
              '这一轮已经被第 ' + String(selectedOrder.size) + ' 轮取代 —— 它不是最新一轮，'
                + '所以这一轮的动作（通过 / 退回并说明 / 催办）**已停用**：订单状态以最新一轮为准，'
                + '复核请点上面轮次列表里的「第 ' + String(selectedOrder.size) + ' 轮」。',
            ),
          )
        }

        // A-6：整改回拍单要能**逐项对账** —— 原单"还没通过"的那几项是否一项不漏地进了本单检查项。
        // 口径（教练提出"这条口径没定"，现定死）：回拍单**逐项复核原单未通过项 + 允许按新照片补新项**；
        // 检查项由 core 按同一口径硬补（见 checklist.js），这里只做**独立复核**并把结果写在脸上。
        if (selected.reworkOf) {
          const original = (data && Array.isArray(data.inspections) ? data.inspections : []).find((item) => item.id === selected.reworkOf) || null
          // 与 core 同一套名字比对口径（去标点 + 包含 + 字符重合度 ≥ 0.6），
          // 否则前端会把"其实已被模型覆盖、只是措辞不同"的项报成漏项，两处结论打架。
          const itemKey = (s) => trim(textOf(s)).replace(/[\s·，。、（）()【】\[\]—\-_/／:：;；]/g, '').toLowerCase()
          const sameItem = (a, b) => {
            if (!a || !b) return false
            if (a === b || a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return true
            const A = new Set(a.split(''))
            const B = new Set(b.split(''))
            let hit = 0
            for (const ch of A) if (B.has(ch)) hit += 1
            return hit / Math.min(A.size, B.size) >= 0.6
          }
          if (!original) {
            detail.push(React.createElement('div', { className: 'giou-line', key: 'rework-check' }, '整改回拍自 ' + shortNo(selected.reworkOf) + '：原单不在当前快照里（本次无法逐项对账）。'))
          } else {
            const must = []
            for (const f of original.findings) {
              const name = trim(textOf(f.itemName))
              if (name && statusKeyOf(f) !== 'rectified' && must.indexOf(name) === -1) must.push(name)
            }
            const missing = must.filter((name) => !selected.items.some((it) => sameItem(itemKey(it && (it.name || it.itemId)), itemKey(name))))
            detail.push(
              React.createElement(
                'div',
                { className: missing.length === 0 ? 'giou-line ok' : 'giou-line warn', key: 'rework-check' },
                '整改回拍对账（自 ' + shortNo(selected.reworkOf) + '）：原单还有 ' + must.length + ' 项未通过，本单检查项 ' + selected.items.length + ' 项 —— ' +
                  (must.length === 0
                    ? '原单没有未通过项（不该出现回拍单，建议核对来源）。'
                    : missing.length === 0
                      ? '原单未通过项已逐项列入 ✓（另可含本次新补充的项）。'
                      : '其中 ' + missing.length + ' 项未列入：「' + missing.join('、') + '」—— 这几项本次不会得到复核结论。'),
              ),
            )
          }
        }

        // 「退到哪去了」的第一答案：一条醒目的退回横幅（谁退的、什么时候、什么原因、退过几次），
        // 不再让用户去详情最底部翻时间线（用户实测反馈：点完退回，找不到退到哪去了）。
        if (selected.returnedAt) {
          const reject = lastRejectOf(selected)
          const reasonText = textOf(reject && reject.reason)
          const closed = isDoneItem(selected)
          detail.push(
            React.createElement(
              'div',
              { className: closed ? 'giou-line ok' : 'giou-line err', key: 'returned' },
              (closed ? '曾退回（已整改通过）：' : '已退回 · 待整改：') + (clockOf((reject && reject.createdAt) || selected.returnedAt) || '—') +
                (reject ? '　由 ' + actorLabelOf(reject) : '（动作表里没找到退回那条记录，只有退回时间）') +
                (selected.returnedCount > 1 ? '　共退回 ' + selected.returnedCount + ' 次' : '') +
                '；退回原因：「' + (reasonText || '（后端未记录原因文本）') + '」' +
                (closed
                  ? '　→ 本单判断项已全部通过、已办结（不再是"待整改"）。'
                  : '　→ 店长端「待整改」里能看到这条并整改回拍，新单会自动标「整改回拍自 ' + shortNo(selected.id) + '」。'),
            ),
          )
        }

        if (selected.returnedAt) {
          // ── 整改回拍「回执」（客户 10-03 提出：打回去之后督导看不到动静）────────────────
          // 改前只有一句指路（"新单会自动标「整改回拍自 #原单」"）——督导得自己去列表里翻新单，
          // 翻不到就以为"打回去没下文"。这里**反查快照里已有的 `reworkOf`**（新单→原单）：
          // 谁的回拍单指向我，就写"已回拍 → #xxxx（状态）"；没有就写清"还没回拍 + 剩余/已超期"。
          // **不加后端字段、不加接口**：`reworkOf` 与 `dueAt` 都已在快照里。
          const children = (data && Array.isArray(data.inspections) ? data.inspections : []).filter(
            (it) => it && String(it.reworkOf || '') === String(selected.id),
          )
          const dueMs = selected.dueAt ? new Date(selected.dueAt).getTime() : null
          const dueText = dateTimeOf(selected.dueAt) || '未标注'
          let receipt
          if (children.length > 0) {
            receipt =
              '整改回拍：**已回拍** ' +
              children.map((it) => shortNo(it.id) + '（' + statusLabelOf(it.status) + '·' + (clockOf(it.createdAt) || '—') + '）').join('、')
          } else if (isDoneItem(selected)) {
            receipt = '整改回拍：没有回拍单 —— 本单是督导逐项点「通过」后办结的（不经回拍也办结）。'
          } else if (dueMs === null) {
            receipt = '整改回拍：还没有回拍单（本单没有整改截止时间，后端未给）。'
          } else {
            const diff = dueMs - Date.now()
            // 分钟要**进位**：不处理的话 7h59m40s 会算出「7 小时 60 分」（我第一版就是这样，真机截到了）。
            let h = Math.floor(Math.abs(diff) / 3600000)
            let m = Math.round((Math.abs(diff) % 3600000) / 60000)
            if (m >= 60) { h += 1; m = 0 }
            receipt =
              diff > 0
                ? '整改回拍：还没有回拍单（整改截止 ' + dueText + '，剩余 ' + h + ' 小时 ' + m + ' 分）'
                : '整改回拍：还没有回拍单、已超期 ' + h + ' 小时 ' + m + ' 分（整改截止 ' + dueText + '；后端逾期扫描会自动催办，超时再升级）'
          }
          detail.push(
            React.createElement('div', { className: children.length ? 'giou-line ok' : 'giou-line', key: 'rework-receipt' }, receipt.replace(/\*\*/g, '')),
          )
        }

        if (selected.judgeFailure) {
          detail.push(
            React.createElement(
              'div',
              { className: 'giou-line err', key: 'fail' },
              '分析失败：' + textOf(selected.judgeFailure.message || selected.judgeFailure.code) + '（后端未产生判断；可让店长端重试，前端不显示假结果）',
            ),
          )
        }

        // 「办结去哪了」的答案：已办结的单子也要有一条写在脸上的结论行（用户实测提问"是不是差一个已办结"）。
        // 不新增后端字段：通过时间/操作者从最后一条人工动作（type=通过）取；没有动作行时只说状态本身，不臆造时间。
        //
        // A1：结论**必须分两种情况**，判据是该单 findings 里有没有"曾经判过不符合"的真实记录：
        //   · findings 为空 = 本次全部判断项都判「符合」→「本次未发现问题（无需整改项）」
        //   · findings 非空（模型判过问题项）且现在全部通过 →「全部 N 项判断已通过」
        // 两句混用会把"整改通过"说成"本来就没问题"，恰恰抹掉产品卖点，所以这里不合并、不猜。
        if (isDoneItem(selected)) {
          const lastPass = selected.lastAction && (selected.lastAction.type === '通过' || selected.lastAction.actionCode === 'review_approve') ? selected.lastAction : null
          const summary = doneSummaryOf(selected)
          detail.push(
            React.createElement(
              'div',
              { className: 'giou-line ok', key: 'done' },
              '已办结：' + summary.text +
                (lastPass ? '　' + (clockOf(lastPass.at) || '—') + ' 由 ' + (lastPass.actor || '督导') + ' 通过' : '') +
                '　（本单不再出现在「待复核」；「已办结」档里可以翻回来）',
            ),
          )
        }

        // 动作记录**放在详情上半区**（改前在整列最底部，判断项一多就得滚很久 —— 用户实测反馈"看不到退到哪去了"）。
        // 后端 actions 表里每条都带 时间/操作者/动作/原因/结果，这里是它们的第一展示面；下方判断卡上的动作行会写新记录。
        detail.push(React.createElement('div', { className: 'giou-h2', key: 'tl-h' }, '动作记录（时间 · 操作者 · 结果）'))
        const timeline = selected.actions.map((action) => ({
          at: action.createdAt,
          label: actionLabelOf(action.type, action.target),
          // A-5：这一列的表头写的是**操作者**，改前这里放的是 `target`（被操作对象），
          // 于是「催办 / 升级」显示成了门店名、「系统自动」无从分辨。现在放真实主体，target 单独一列。
          who: actorLabelOf(action) || '系统',
          target: textOf(action.target),
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
                    React.createElement('div', { className: 'giou-statusrow' }, [
                      React.createElement('span', { className: 'giou-num', key: 'at' }, clockOf(row.at) || '—'),
                      React.createElement('span', { key: 'who' }, row.who),
                      row.target ? React.createElement('span', { key: 'target' }, '对象：' + row.target) : null,
                      row.reason ? React.createElement('span', { key: 'reason' }, row.reason) : null,
                      row.resultNote ? React.createElement('span', { key: 'note' }, row.resultNote) : null,
                      row.synced ? null : React.createElement('span', { className: 'giou-chip', key: 'sync', 'data-tone': 'overdue' }, '⚠ 未同步到后端'),
                    ]),
                  ),
                ),
              ),
        )
        if (actions.error) detail.push(React.createElement('div', { className: 'giou-line err', key: 'act-err' }, '动作未写入后端：' + actions.error + '（已在本机留痕，标为「未同步」）'))

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

        // A4：材料不可判读是**另一种待办**，不是"复核判断"。这类单里模型只说了"看不清"，一条判断都没有，
        // 所以要显式写出下一步该干什么（决定是否让店长重拍），否则它混在「待复核」里跟普通单分不出来。
        if (selected.unreadable.length > 0) {
          const wholeUnreadable = statusKeyOf(selected) === 'unreadable' || selected.findings.length === 0
          detail.push(
            React.createElement(
              'div',
              { className: 'giou-line warn', key: 'unreadable' },
              (wholeUnreadable ? '材料不可判读（本单 0 条问题判断）：' : '看不清的照片 ' + selected.unreadable.length + ' 张：') +
                '模型只标了「看不清」，没有据此下结论、也没有猜。' +
                '下一步：决定是否让店长重拍 —— 拍清地面与台面后再提交一次，这几张按新单重新判读；本条不必当成"判断待复核"。',
            ),
          )
        }

        if (selected.findings.length === 0) {
          // 0 条判断项（模型只标"看不清"、或本次没发现问题）过去**没有办结路径** —— 这一轮会永远挂在待复核
          // （真机 #f19f 就是）。现在给一条显式收口动作：确认无需整改 → 办结本单。
          // 只给**最新一轮**（被取代的老轮动作全停用，见上）；后端还会再挡一次"名下有未办结回拍轮"。
          detail.push(
            React.createElement('div', { className: 'giou-card', key: 'nofinding' }, [
              React.createElement('div', { className: 'giou-line' }, '这条提交暂无问题项判断（模型本次没判出问题项，或只标了「看不清」）。'),
              supersededRound || isDoneItem(selected)
                ? React.createElement('div', { className: 'giou-line' }, isDoneItem(selected) ? '本单已办结。' : '这一轮已被最新一轮取代，不能再处置。')
                : React.createElement(
                    'div',
                    { className: 'giou-actions' },
                    React.createElement(
                      'button',
                      { className: 'giou-btn primary', type: 'button', disabled: actions.busy === 'close', title: '确认这一轮没有需要门店整改的问题项，把本单办结（写一条「办结」动作记录）', onClick: () => onAction({ type: 'close', findingId: '' }) },
                      actions.busy === 'close' ? '正在办结…' : '确认无需整改，办结本单',
                    ),
                  ),
            ]),
          )
        }
        selected.findings.forEach((finding) => {
          detail.push(React.createElement(FindingCard, { key: finding.findingId, finding, storeName: selected.storeName, onAction, busyAction: actions.busy, inspectionId: selected.id, locked: supersededRound }))
        })

        // 标题里的 `·` 是指令 §4 的既有文案（逐字保留）；行内元数据改成独立元素 + 间距，不拼 `·` 串。
        // （动作记录已上移到详情上半区，见上面 tl-h。）

        if (scan.phase === 'done' && scan.receipt) detail.push(React.createElement('div', { className: 'giou-line ok', key: 'scan-ok' }, '扫描回执（' + scan.receipt.at + '）：' + scan.receipt.summary))
        else if (scan.phase === 'failed') detail.push(React.createElement('div', { className: 'giou-line err', key: 'scan-fail' }, '扫描未执行：' + scan.error))
      }

      return React.createElement('div', { className: 'giou-b' }, [
        React.createElement('div', { className: 'giou-blist', key: 'list' }, children),
        React.createElement('div', { className: 'giou-bdetail', key: 'detail' }, detail),
      ])
    }

    // ── 跨包通道：角色视图（采集包发布）+ 店长端屏（采集包发布的本包要嵌的组件）──
    // 同一个 agent、两个视图（§7 既定口径）。采集包没装载时本包只降级、不假装有界面。
    const UI_CHANNEL = '__gaia_inspection_ui__'
    const ROLE_CHANNEL = '__gaia_inspection_view__'

    function channelOf(name) {
      const channel = globalThis[name]
      return channel && typeof channel === 'object' ? channel : null
    }

    function useCaptureScreen() {
      return React.useSyncExternalStore(
        (listener) => {
          const channel = channelOf(UI_CHANNEL)
          if (!channel || typeof channel.subscribe !== 'function') return () => {}
          return channel.subscribe(listener)
        },
        () => {
          const channel = channelOf(UI_CHANNEL)
          return channel && typeof channel.getScreen === 'function' ? channel.getScreen() : null
        },
        () => null,
      )
    }

    function useRole() {
      return React.useSyncExternalStore(
        (listener) => {
          const channel = channelOf(ROLE_CHANNEL)
          if (!channel || typeof channel.subscribe !== 'function') return () => {}
          return channel.subscribe(listener)
        },
        () => {
          const channel = channelOf(ROLE_CHANNEL)
          return channel && typeof channel.getRole === 'function' ? channel.getRole() : 'supervisor'
        },
        () => 'supervisor',
      )
    }

    function assignRole(role) {
      const channel = channelOf(ROLE_CHANNEL)
      if (channel && typeof channel.setRole === 'function') channel.setRole(role)
    }

    // ── 组件：三态（加载中 / 空 / 失败）——任何数据面都不许留白屏（§5.2）──────
    function DataState({ kind, title, detail, actionLabel, onAction }) {
      const children = []
      if (kind === 'loading') {
        for (let index = 0; index < 3; index += 1) children.push(React.createElement('div', { className: 'giou-skel', key: 'sk' + index }))
      } else {
        children.push(React.createElement('div', { className: 't', key: 'title' }, title))
        if (detail) children.push(React.createElement('div', { className: 'd', key: 'detail' }, detail))
        if (actionLabel && onAction) {
          // 三态的动作一律用中性按钮：一屏只留一个主 CTA 用强调色（§2「强调色一屏只给一个主 CTA 用」）。
          children.push(React.createElement('button', { className: 'giou-btn', type: 'button', key: 'act', onClick: onAction }, actionLabel))
        }
      }
      return React.createElement('div', { className: 'giou-state', 'data-kind': kind }, children)
    }

    // ── 组件：首屏角色选择（斜线分屏）──────────────────────────────────────
    // 规格＝《首屏「角色选择」页 · 定稿规格》（10-03 14:45，取代 10-02 基线规格里的首屏版本）。
    // 斜线走向按客户裁定**甲**：**左上→右下**；上侧三角（贴顶边）＝门店端，下侧三角（贴底边）＝总部督导端。
    //   · 两块都是**整块热区**（可点区域由 clip-path 决定——点三角形里的空白也进，不是只有卡片可点）；
    //   · 中央一枚**独立深色圆钮**骑在斜线中点、压最上层，进**模型调用日志面板**（客户裁定：圆钮＝模型调用
    //     入口，图标用设计稿已授权的 clock；设计稿里 clock 本来在顶栏环境徽标上，本产品顶栏没有那枚徽标）；
    //   · 文案逐字来自定稿 §4。
    function RoleSelect() {
      const enter = (role) => {
        assignRole(role)
        panelState.setEntered(true)
        panelState.setView('board')
      }
      const half = (id, name, why, hint, role) =>
        React.createElement(
          'button',
          { className: 'giou-split ' + id, type: 'button', key: id, onClick: () => enter(role) },
          React.createElement('div', { className: 'giou-split-body' }, [
            React.createElement('div', { className: 'giou-split-name', key: 'nm' }, name),
            React.createElement('div', { className: 'giou-split-why', key: 'why' }, why),
            React.createElement('div', { className: 'giou-split-hint', key: 'hint' }, hint),
          ]),
        )
      return React.createElement('div', { className: 'giou-splitwrap' }, [
        half(
          'manager',
          '门店端',
          '交接班时拍一张照片，再写一句话。Agent 看完照片与这句话，当场决定该查哪几项。',
          '3 分钟内可提交完',
          'manager',
        ),
        half(
          'supervisor',
          '总部督导端',
          '先看『为什么查这几项』，再看判断与依据。有坐标就框选原图，没坐标就标点并说明。',
          '逾期自动升级',
          'supervisor',
        ),
        React.createElement('div', { className: 'giou-split-demo', key: 'demo' }, '演示替身：真实场景中门店在手机上提交，本面板为演示视图。'),
        React.createElement(
          'button',
          {
            className: 'giou-split-back',
            type: 'button',
            key: 'back',
            title: '返回会话：回到 DSH 对话（左栏「巡店自查」可再进来）',
            onClick: () => leaveMainPanel(),
          },
          '返回会话',
        ),
        React.createElement(
          'button',
          {
            className: 'giou-knob',
            type: 'button',
            key: 'knob',
            title: CAPABILITY_LOGS + '：打开逐条模型调用记录',
            'aria-label': CAPABILITY_LOGS,
            onClick: () => {
              panelState.setEntered(true)
              panelState.setView('logs')
            },
          },
          svgIcon('clock', 24, 'ic'),
        ),
      ])
    }

    // ── 承载面：整窗表层（shell.overlay）还是 main 槽内联（兜底）────────────
    /**
     * 两个承载面共用同一棵树，但**同一时刻只渲染一个**：
     *   · `shell.overlay` 条目注册成功（ready）→ 由整窗表层渲染，main 席位让位（返回 null）；
     *   · 宿主没有 `shell.overlay`（自测垫片 / 裁剪过的宿主）→ main 席位内联渲染，界面不消失。
     * 「进入本面板」= main 席位在挂（宿主点左栏项 → selectPanel → keyed main 只渲染本 key），
     * 于是席位挂上就把整窗表层点亮 —— 这一步同时满足「全覆盖」和「不抢占会话」（用户不看时表层是空的）。
     */
    const surfaceState = {
      ready: false,
      seat: false,
      snapshot: { ready: false, seat: false },
      listeners: new Set(),
      subscribe(listener) {
        surfaceState.listeners.add(listener)
        return () => surfaceState.listeners.delete(listener)
      },
      notify() {
        surfaceState.snapshot = { ready: surfaceState.ready, seat: surfaceState.seat }
        surfaceState.listeners.forEach((listener) => {
          try {
            listener()
          } catch (error) {
            /* 忽略 */
          }
        })
      },
      setReady(next) {
        const value = next === true
        if (value === surfaceState.ready) return
        surfaceState.ready = value
        surfaceState.notify()
      },
      setSeat(next) {
        const value = next === true
        if (value === surfaceState.seat) return
        surfaceState.seat = value
        surfaceState.notify()
      },
    }
    function useSurfaceState() {
      return React.useSyncExternalStore(surfaceState.subscribe, () => surfaceState.snapshot, () => surfaceState.snapshot)
    }
    /** `shell.overlay` 条目：只有 main 席位在挂（= 用户进了「巡店自查」）时才渲染整窗界面。 */
    function AppSurface() {
      const s = useSurfaceState()
      if (!s.seat || !s.ready) return null
      return React.createElement(InspectionApp, { surface: 'window', key: 'app' })
    }
    /** `main` 槽席位：宿主没有整窗表层时内联渲染；有表层则让位（避免两份界面同时轮询）。 */
    function MainSeat() {
      const s = useSurfaceState()
      React.useEffect(() => {
        surfaceState.setSeat(true)
        return () => surfaceState.setSeat(false)
      }, [])
      if (s.ready) return null
      return React.createElement(InspectionApp, { surface: 'panel', key: 'app' })
    }

    // ── 组件：整屏外壳（首屏 → 店长端 / 督导端 / 日志；三块面板同一容器规格）──
    /**
     * @param surface - 'window'（shell.overlay 整窗表层）| 'panel'（main 槽内联兜底）
     */
    function InspectionApp({ surface }) {
      const view = React.useSyncExternalStore(panelState.subscribe, () => panelState.snapshot, () => panelState.snapshot)
      const scan = React.useSyncExternalStore(scanState.subscribe, () => scanState.snapshot, () => scanState.snapshot)
      const source = React.useSyncExternalStore(snapshotSource.subscribe, () => snapshotSource.snapshot, () => snapshotSource.snapshot)
      const role = useRole()
      const CaptureScreen = useCaptureScreen()
      const [recheck, setRecheck] = React.useState(0)

      React.useEffect(() => {
        pullSnapshot()
        return undefined
      }, [])

      const entered = view.entered === true
      const isManager = role !== 'supervisor'
      const logsOn = entered && view.view === 'logs'
      const boardOn = entered && !isManager && !logsOn
      const stats = statsOf(source.data)
      const offline = source.data && source.data.offline ? source.data.offline.offline === true : false
      const queue = source.data && source.data.pendingQueue ? source.data.pendingQueue : null

      const navBtn = (key, label, on, onClick) =>
        React.createElement(
          'button',
          { className: 'giou-navbtn', type: 'button', key, 'data-on': on ? '1' : '0', 'aria-current': on ? 'page' : undefined, onClick },
          [React.createElement('span', { className: 'giou-navdot', key: 'dot' }), label],
        )

      // 左导航：整窗覆盖后 DSH 自己的左栏被盖住，导航由本应用提供（品牌 / 角色视图切换 / 日志 / 动作）。
      const nav = React.createElement('nav', { className: 'giou-nav', key: 'nav' }, [
        React.createElement('div', { className: 'giou-navbrand', key: 'brand' }, [
          React.createElement('div', { className: 'giou-navmark', key: 'mark' }, '督'),
          React.createElement('div', { className: 'giou-navname', key: 'name' }, [
            React.createElement('div', { className: 'giou-navtitle', key: 't' }, '门店督导'),
            React.createElement('div', { className: 'giou-navsub', key: 's' }, '巡店自查 · 判断回放'),
          ]),
        ]),
        React.createElement('div', { className: 'giou-navgroup', key: 'g1' }, [
          React.createElement('div', { className: 'giou-navlabel', key: 'l' }, '角色视图切换'),
          // 定稿 §2：**进去之后左栏只列本角色项** —— 店长端只有「门店自查采集入口」，
          // 督导端只有「巡店判断回放看板」，日志视图只有「模型调用日志面板」（圆钮是它的另一个入口）。
          logsOn
            ? navBtn('logs', CAPABILITY_LOGS, true, () => panelState.setView('board'))
            : isManager
              ? navBtn('manager', CAPABILITY_CAPTURE, true, () => {})
              : navBtn('supervisor', CAPABILITY_BOARD, true, () => {}),
        ]),
        React.createElement('span', { className: 'giou-grow', key: 'grow' }),
        React.createElement('div', { className: 'giou-navfoot', key: 'foot' }, [
          !isManager && !logsOn
            ? React.createElement(
                'button',
                { className: 'giou-navcta', type: 'button', key: 'scan', disabled: scan.phase === 'busy', title: CAPABILITY_SCAN + '：触发后端逾期扫描（与真定时器互为备份）', onClick: () => runScan() },
                scan.phase === 'busy' ? '扫描中…' : '立即扫描',
              )
            : null,
          React.createElement('button', { className: 'giou-navbtn ghost', type: 'button', key: 'role', onClick: () => panelState.setEntered(false) }, '切换角色'),
          React.createElement(
            'button',
            { className: 'giou-navbtn ghost', type: 'button', key: 'back', title: '返回会话：离开巡店自查，回到 DSH 对话（左栏「巡店自查」可再进来）', onClick: () => leaveMainPanel() },
            '返回会话',
          ),
        ]),
      ])

      /** 外壳骨架：标题带（Windows 标题栏让位）+ 左导航 + 主区（顶栏 / 提示行 / 正文）。 */
      const frame = (title, sub, topRight, notice, content) =>
        React.createElement('div', { className: 'giou-root', 'data-surface': surface === 'window' ? 'window' : 'panel' }, [
          React.createElement('div', { className: 'giou-titlebar', key: 'titlebar' }),
          React.createElement('div', { className: 'giou-appbody', key: 'appbody' }, [
            nav,
            React.createElement('div', { className: 'giou-main', key: 'main' }, [
              React.createElement('div', { className: 'giou-top', key: 'top' }, [
                React.createElement('div', { className: 'giou-topmain', key: 'topmain' }, [
                  React.createElement('div', { className: 'giou-title', key: 't' }, title),
                  React.createElement('div', { className: 'giou-sub', key: 's' }, sub),
                ]),
                React.createElement('span', { className: 'giou-grow', key: 'grow' }),
                React.createElement('div', { className: 'giou-topright', key: 'topright' }, topRight),
              ]),
              notice && notice.length ? React.createElement('div', { className: 'giou-notices', key: 'notices' }, notice) : null,
              React.createElement('div', { className: 'giou-content', key: 'content' }, content),
            ]),
          ]),
        ])

      if (!entered) {
        // 首屏（定稿 10-03 14:45）：**整屏斜线分屏**，不再套左栏与顶栏——圆钮要骑在整屏中点才成立。
        // 同时这也是「完全去掉 DSH 面板」的落地：整窗表层里只剩这一屏。
        return React.createElement(
          'div',
          { className: 'giou-root', 'data-surface': surface === 'window' ? 'window' : 'panel', key: 'rolescreen' },
          [
            React.createElement('div', { className: 'giou-titlebar', key: 'titlebar' }),
            React.createElement(RoleSelect, { key: 'split' }),
          ],
        )
      }

      const title = logsOn ? CAPABILITY_LOGS : isManager ? CAPABILITY_CAPTURE : CAPABILITY_BOARD
      const sub = logsOn
        ? '逐条模型调用记录：时间 / 模型 / 提示词版本 / 提交编号 / 请求摘要 / 响应摘要 / 耗时'
        : isManager
          ? '交班时拍一张照片，再写一句话。Agent 看完照片与这句话，当场决定该查哪几项。'
          : '先看「为什么查这几项」，再看判断与依据。有坐标就框选原图，没坐标就标点并说明。'

      // 顶栏右端：督导端看板时给四枚统计 + 刷新；三种视图都常驻一枚「模型调用日志面板」入口
      // （定稿 §2 要求左栏只列本角色项，所以日志入口放顶栏；首屏那枚圆钮是它的另一个入口，两处都一步可点）。
      const topRight = []
      if (boardOn) {
        topRight.push(
          React.createElement('div', { className: 'giou-statusrow', key: 'stats' }, [
            // A3：改前第一枚是「今日 N 条」（按本地日界算"今天创建的"），而库里装的是历史数据，
            // 于是出现「今日 0 条 / 待你判断 11 条」这种自相矛盾的并排。改成**累计**（库里全部检查单），
            // 并把每枚的口径写进 title —— 逾期是叠加标记、不是与"待你判断"互斥的分区。
            React.createElement('span', { className: 'giou-chip giou-num', key: 'a', title: '按订单计：一家店一次交单＝一单（含它的所有整改轮次）；数字是订单数，不是提交次数' }, '累计 ' + stats.total + ' 条'),
            React.createElement('span', { className: 'giou-chip giou-num', key: 'b', title: '最新一轮还没有办结、等你处理的订单（含已逾期/已升级/材料不可判读）；等于左栏「待复核」+「已退回」' }, '待你判断 ' + stats.pending + ' 条' + (stats.pendingAndOverdue > 0 ? '（其中 ' + stats.pendingAndOverdue + ' 条已逾期）' : '')),
            React.createElement('span', { className: 'giou-chip giou-num', key: 'c', 'data-tone': stats.overdue > 0 ? 'overdue' : 'none', title: '最新一轮的截止时间已过且还没整改完的订单（与左栏「逾期」档同一口径）；它是「待你判断」里的子集标记，不是与之互斥的分区。' }, '逾期 ' + stats.overdue + ' 条'),
            React.createElement('span', { className: 'giou-chip giou-num', key: 'd', 'data-tone': stats.done > 0 ? 'rectified' : 'none', title: '最新一轮的全部判断项都已通过（后端 status=rectified/closed）的订单' }, '已办结 ' + stats.done + ' 条'),
          ]),
        )
        topRight.push(React.createElement('button', { className: 'giou-btn quiet', key: 'refresh', type: 'button', onClick: () => pullSnapshot() }, '刷新'))
      }
      topRight.push(
        React.createElement(
          'button',
          {
            className: 'giou-btn quiet',
            key: 'logs',
            type: 'button',
            title: CAPABILITY_LOGS + '：逐条模型调用记录（首屏中央圆钮是它的另一个入口）',
            onClick: () => panelState.setView(logsOn ? 'board' : 'logs'),
          },
          CAPABILITY_LOGS,
        ),
      )

      const notice = []
      if (offline && !isManager) {
        notice.push(
          React.createElement(
            'div',
            { className: 'giou-line warn', key: 'offline' },
            '离线：仅采集排队，不产生模型判断' + (queue && typeof queue.pending === 'number' ? '（待判队列 ' + queue.pending + ' 条）' : '') + '；联网后自动补判。',
          ),
        )
      }
      if (source.failure && !isManager && !logsOn) {
        notice.push(
          React.createElement(
            'div',
            { className: 'giou-line err', key: 'fail' },
            source.data && source.lastOkAt ? '看板数据不可用：上次成功 ' + source.lastOkAt + '（显示的是上次成功的数据）' : '看板数据不可用：' + source.failure + '（尚无成功数据）',
          ),
        )
      }

      let body = null
      if (logsOn) body = React.createElement(LogsView, { key: 'logs' })
      else if (isManager) {
        body = CaptureScreen
          ? React.createElement(CaptureScreen, { key: 'capture' + String(recheck) })
          : React.createElement(
              'div',
              { className: 'giou-content giou-pad', key: 'nocapture' },
              React.createElement(DataState, {
                kind: 'fail',
                title: '门店自查采集入口未装载',
                detail: '采集界面包（gaia-inspection-capture-ui）未启用或未装载，主区域没有可渲染的店长端界面。装载后点「重新检查」。',
                actionLabel: '重新检查',
                onAction: () => setRecheck(recheck + 1),
              }),
            )
      } else body = React.createElement(BoardView, { key: 'board' })

      return frame(title, sub, topRight, notice, body)
    }

    /** 右侧栏里的独立 tab：模型调用日志（与主面板入口并存，两个入口都一步可点）。 */
    // 契约 §3.4-4：正文容器换成新的 `.giou-root` 包裹（旧 `.giou-panel` 类已删除，不改会变成无样式）。
    function LogsTabBody() {
      React.useEffect(() => {
        pullLogs()
        return undefined
      }, [])
      return React.createElement('div', { className: 'giou-root' }, React.createElement(LogsView, {}))
    }

    /**
     * 内联 SVG 图标（B1 图标体系）。**本包自己声明一份，不依赖另一个包**（与令牌同一口径）。
     *
     * 统一参数（与采集包逐字一致）：viewBox `0 0 24 24` / `fill:none` / `stroke:currentColor` /
     * `strokeWidth:1.8` / 圆头圆角 / `aria-hidden` + `focusable:false`。颜色一律 `currentColor`，
     * 由所在控件的 `color` 决定（hover / 禁用跟着变，不做第二套图标资源）。
     * 场景尺寸：行内与按钮 18、列表入口 20、视觉主角 24。
     *
     * **只画设计稿授权的那几枚**（clock / chevron-down / camera）。缺的那几枚**不自己发明**——
     * 宁可退成纯文字，也不新增未授权图标（新增图标要客户点头，见 B1 第 3 条）。
     */
    function svgIcon(name, size, key) {
      const common = {
        key: key || undefined,
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      }
      if (name === 'panel') {
        return React.createElement('svg', common, [
          React.createElement('path', { key: 'a', d: 'M4 20V9.6L12 4l8 5.6V20' }),
          React.createElement('path', { key: 'b', d: 'M9.5 20v-5.2h5V20' }),
        ])
      }
      if (name === 'clock') {
        return React.createElement('svg', common, [
          React.createElement('circle', { key: 'c', cx: 12, cy: 12, r: 8.4 }),
          React.createElement('path', { key: 'h', d: 'M12 7.6V12l3.2 1.9' }),
        ])
      }
      return null
    }

    /** 左栏入口图标：`sidebar.panellist` 是 list 槽，列表项要一个图标组件。 */
    function PanelIcon() {
      return svgIcon('panel', 18)
    }

    // ── 挂载段自用常量（不动上面的常量区）──────────────────────────────────
    const MAIN_SLOT = 'main'
    const SIDEBAR_SLOT = 'sidebar.panellist'
    /** 本包自己的 key：左栏 id 与 main 的 key 必须是同一个（`Each list id addresses the matching main panel`）。 */
    const MAIN_PANEL_ID = 'gaia-inspection'
    /** 整窗表层的条目 id：自己起一个，追加在宿主已有条目旁边（复用宿主 id 会顶掉它）。 */
    const SEAT_OVERLAY_ID = 'gaia-inspection.app'

    // ── 挂载 ────────────────────────────────────────────────────────────────
    // 平台事实（实施契约 §1）：`main` 是 keyed/root 槽（必须有 key，且不用 conversation 这个已占用的 key）；
    // `sidebar.panellist` 是 list/root 槽（必须有 id，id 就是 main 的 key）；点左栏图标由宿主自己 selectPanel。
    // 本产品的三块界面都在本面板里（无真正弹窗），因此**不再注册 shell.overlay**。
    function apply(ctx) {
      const styleEl = document.createElement('style')
      styleEl.setAttribute('data-plugin', 'gaia-inspection-oversight-ui')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)

      exposeChannels()

      // 【真机实测必须项】宿主只在**声明式依赖**就绪后才 apply；不写 exports.inject 时 `ctx.get('slots')`
      // 返回 undefined，本包会一路 return，界面上一个入口都不会出现（实测：真实成品窗口里左栏没有「巡店自查」）。
      // 取服务优先用注入后的 ctx.slots / ctx.layout，找不到再退回 ctx.get(...)（兼容自测垫片）。
      const slots = (ctx && ctx.slots) || (ctx && typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      const tabs = ctx && typeof ctx.get === 'function' ? ctx.get('sidebarRightTabs') : undefined
      if (!slots) {
        console.warn('[gaia-inspection-oversight-ui] 宿主未提供 slots 服务，界面未挂载')
        return
      }

      /** 切主区域：`ctx.layout.selectPanel(id)`；**必须在自己的 main 注册之后调用**（否则宿主抛未注册）。 */
      const selectPanel = (id) => {
        const layout = ctx && typeof ctx.get === 'function' ? ctx.get('layout') : undefined
        if (!layout || typeof layout.selectPanel !== 'function') {
          console.warn('[gaia-inspection-oversight-ui] 宿主未提供 layout.selectPanel：无法自动切主面板（点左栏「巡店自查」同样能进）')
          return false
        }
        try {
          layout.selectPanel(id)
          return true
        } catch (error) {
          console.warn('[gaia-inspection-oversight-ui] 切换主面板失败：', error)
          return false
        }
      }

      /**
       * 进入本面板：`setEntered(true)`（跳过首屏角色选择）+ 可选切视图 + 把主区域切到本面板。
       * 三个入口都走它，保证点完有肉眼可见变化（§5.1：不留点了没反应的按钮）。
       */
      const enterPanel = (view) => {
        panelState.setEntered(true)
        if (view === 'board' || view === 'logs') panelState.setView(view)
        selectPanel(MAIN_PANEL_ID)
      }

      // 供旧内省通道 `__gaia_inspection_oversight__.openPanel / closePanel` 使用（closePanel = selectPanel(null) 回会话）。
      enterMainPanel = enterPanel
      leaveMainPanel = () => selectPanel(null)

      // ① 左栏入口：sidebar.panellist（list 槽；id 必须与 main 的 key 一致，否则点了切不过去）。
      ctx.effect(
        () =>
          slots.inject(SIDEBAR_SLOT, () =>
            slots.register({ name: SIDEBAR_SLOT, id: MAIN_PANEL_ID, order: 30, label: '巡店自查' }, () => React.createElement(PanelIcon)),
          ),
        'gaia-inspection-oversight-ui: sidebar panellist entry',
      )

      // ② 主区域席位：main（keyed 槽；key 用本包自己的，不占 conversation）。
      //    席位本身只是「用户进了本面板」的信号：整窗表层可用时让位，不可用时内联兜底。
      let autoEntered = false
      ctx.effect(
        () =>
          slots.inject(MAIN_SLOT, () => {
            const dispose = slots.register({ name: MAIN_SLOT, key: MAIN_PANEL_ID }, () => React.createElement(MainSeat))
            // 启动即进入本面板：本产品就是「门店督导」，首屏不该先落在 DSH 对话上
            // （用户反馈：界面「只是做了一个入口，还是嵌在 dsh 界面里的」）。selectPanel 必须在
            // main 注册**之后**调用，否则宿主抛 `main panel "…" is not registered`。
            if (!autoEntered) {
              autoEntered = true
              selectPanel(MAIN_PANEL_ID)
            }
            return dispose
          }),
        'gaia-inspection-oversight-ui: main panel seat',
      )

      // ②b 整窗表层（全覆盖）：注册进 shell.overlay。内核槽位契约的原话是「要一个覆盖整个 app 的
      //     自己的表层，就注册进 shell.overlay」——它是 list/root 槽（追加式，不替换任何已有条目），
      //     宿主把它渲染在 absolute/inset:0/z-index:20 的浮层里，盖住左中右三栏；层本身是
      //     click-through 的，条目要自己 opt-in 指针事件（见 CSS 的 [data-surface="window"]）。
      ctx.effect(
        () =>
          slots.inject(OVERLAY_SLOT, () => {
            surfaceState.setReady(true)
            return slots.register({ name: OVERLAY_SLOT, id: SEAT_OVERLAY_ID, order: 100, label: '门店督导' }, () => React.createElement(AppSurface))
          }),
        'gaia-inspection-oversight-ui: shell overlay surface',
      )

      // ③ 注册完 main 之后发布跨包通道：采集包用 `__gaia_inspection_shell__.open(view)` 一步打开本面板。
      globalThis.__gaia_inspection_shell__ = {
        version: 1,
        open(view) {
          enterPanel(view)
        },
        subscribe(listener) {
          if (typeof listener !== 'function') return () => {}
          return panelState.subscribe(listener)
        },
      }

      // ④ 右侧栏「模型调用日志」独立 tab（保留现状：tab 类型 + keyed 正文；正文容器已换新）。
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
        console.warn('[gaia-inspection-oversight-ui] 宿主未提供 sidebarRightTabs：右侧栏日志 tab 未注册（左栏入口与会话 header 入口仍可用）')
      }
      ctx.effect(
        () => slots.inject(TAB_SLOT, () => slots.register({ name: TAB_SLOT, key: LOGS_TAB_KIND, children: {} }, LogsTabBody)),
        'gaia-inspection-oversight-ui: logs tab body',
      )

      // ⑤ 会话 header 三枚入口：看板 / 立即扫描 / 模型调用日志（每枚都真的切过去，前两枚顺带切到督导端角色）。
      ctx.effect(
        () =>
          slots.inject(HEADER_SLOT, () =>
            slots.register({ name: HEADER_SLOT, id: 'gaia-inspection-oversight-board', order: 43, label: CAPABILITY_BOARD }, () =>
              React.createElement(
                'button',
                {
                  className: 'giou-dockbtn',
                  type: 'button',
                  title: '打开' + CAPABILITY_BOARD + '（切到总部督导端）',
                  onClick: () => {
                    assignRole('supervisor')
                    enterPanel('board')
                  },
                },
                CAPABILITY_BOARD,
              ),
            ),
          ),
        'gaia-inspection-oversight-ui: header entry board',
      )
      ctx.effect(
        () =>
          slots.inject(HEADER_SLOT, () =>
            slots.register({ name: HEADER_SLOT, id: 'gaia-inspection-oversight-scan', order: 44, label: CAPABILITY_SCAN }, () =>
              React.createElement(
                'button',
                {
                  className: 'giou-dockbtn',
                  type: 'button',
                  title: CAPABILITY_SCAN + '：切到督导端并触发一次后端逾期扫描',
                  onClick: () => {
                    assignRole('supervisor')
                    enterPanel('board')
                    runScan()
                  },
                },
                '立即扫描',
              ),
            ),
          ),
        'gaia-inspection-oversight-ui: header entry scan',
      )
      ctx.effect(
        () =>
          slots.inject(HEADER_SLOT, () =>
            slots.register({ name: HEADER_SLOT, id: 'gaia-inspection-oversight-logs', order: 45, label: CAPABILITY_LOGS }, () =>
              React.createElement(
                'button',
                {
                  className: 'giou-dockbtn',
                  type: 'button',
                  title: '打开' + CAPABILITY_LOGS + '（不改角色视图）',
                  onClick: () => {
                    enterPanel('logs')
                  },
                },
                CAPABILITY_LOGS,
              ),
            ),
          ),
        'gaia-inspection-oversight-ui: header entry logs',
      )

      pullSnapshot()
    }

    /** 声明式依赖：slots 必给；layout 用于「点入口切主区域」（拿不到时降级为只提示，不影响挂载）。 */
    exports.inject = ['slots', 'layout']
    exports.apply = apply
    exports.__test = {
      CAPABILITY_BOARD,
      CAPABILITY_EVIDENCE,
      CAPABILITY_SCAN,
      CAPABILITY_LOGS,
      FILTERS,
      EMPTY_TEXT,
      DONE_STATUSES,
      isPendingItem,
      isDoneItem,
      isReturnedItem,
      orderRootOf,
      groupOrders,
      filterOrders,
      countOrders,
      orderIsDone,
      orderIsReturned,
      orderReturnedCount,
      timeOf,
      countInspections,
      progressOf,
      progressTextOf,
      doneSummaryOf,
      lastRejectOf,
      actorLabelOf,
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
      statusChipsOf,
      photoUrlOf,
      latencyOf,
      tokensOf,
      actionLabelOf,
      BoardView,
      LogsView,
      LogsTabBody,
      PanelIcon,
      EvidenceArea,
      FindingCard,
      InspectionApp,
      AppSurface,
      MainSeat,
      surfaceState,
      MAIN_PANEL_ID,
      SEAT_OVERLAY_ID,
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
