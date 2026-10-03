// gaia-inspection-capture-ui — 客户端半（纯浏览器 ESM，手写 ModuleLoader bundle）。
//
// 逐字对齐《界面实现说明（画面级）》屏 A · 店长端（采集）；形态按《实施契约》§3.5 重做为**整屏两栏**
// （去掉旧的遮罩浮层 + 手机形状卡片外壳，本文件里已无相关类名与开关）：
//   左 = 照片投放区（本屏视觉主角：更大的投放区；选中后大图预览 + 文件名 + 删除）
//   → 右 = 表单（橙底提示条「演示替身：真实场景中门店在手机上提交，本面板为演示视图」→ 门店下拉
//   （示例门店 A · 快餐档口 / 示例门店 B · 正餐堂食）→ 一句话说明（1–200 字 + 实时字数）
//   → [载入示例] [提交并分析] → 五态状态行逐字）。
//   屏标题、副标题与「角色视图切换」由督导包外壳（InspectionApp）统一提供，本组件不自画（同一容器规格）。
//
// 能力词（逐字）：「门店自查采集入口」（C 档）、「角色视图切换」（E 档；本包只发布角色通道，切换控件在外壳）。
//
// 挂载与通道（《实施契约》§2）：
//   · conversation.input.dock + conversation.session.header.actions：各 1 枚「门店自查采集入口」；
//     督导包（外壳）未装载时按钮旁内联可见提示，**不留点了没反应的按钮**。
//   · globalThis.__gaia_inspection_view__：{getRole, setRole, subscribe} —— 角色的唯一真源（含 localStorage 记忆）。
//   · globalThis.__gaia_inspection_ui__：{version:1, getScreen, subscribe} —— 店长端屏组件通道，供外壳内嵌。
//   · 不注册 shell.overlay / sidebar.panellist / main（主面板 key 归督导包）。
//
// 纪律：
//   · 纯浏览器 ESM：不引 node: 内置模块；React 由宿主模块表提供（拿不到就不挂载，不报错）。
//   · 提交走 POST /api/gaia-inspection/submit（后端真分析，**前端不做假回执、不写死结果**）。
//   · 离线/待判信号取 GET /api/gaia-inspection/snapshot 的 offline / pendingQueue；读不到就说"未知"，不假装在线。
//   · 不做美术层、不做登录/权限、不做门店增删改、不做勾选表、不做响应式。

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
    /** 材料齐、按钮可点时的同一态文案：旧的括号提示此时自相矛盾（按钮已经可用了）。 */
    const STATE_READY = '待提交（材料已齐，点「提交并分析」）'
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
    /** 店长端屏（CaptureScreen）的组件通道：督导包外壳用 getScreen() 取组件内嵌（《实施契约》§2）。 */
    const UI_CHANNEL = '__gaia_inspection_ui__'
    /** 督导包发布的外壳通道：本包入口用它「切到主面板」；不存在 = 督导包没装载（必须给出可见提示）。 */
    const SHELL_CHANNEL = '__gaia_inspection_shell__'
    const SHELL_MISSING_NOTICE = '巡店自查面板未装载（gaia-inspection-oversight-ui）'
    /** 已办结的状态集合（与督导端同一口径）：这些单不再要求门店整改，也不该出现在「待整改」里。 */
    const DONE_STATUSES = ['rectified', 'closed', 'approved']

    /** 两枚入口都挂在会话侧（输入区 / 会话 header）：点了切店长端并请外壳打开主面板。 */
    const DOCK_SLOT = 'conversation.input.dock'
    const HEADER_SLOT = 'conversation.session.header.actions'

    /**
     * 样式层（《实施契约》§3.1 令牌 + §3.2 硬口径 + §4 类名；本包自声明、不依赖另一个包）。
     *   · 圆角只有四个值：卡片 18 / 内部块 12 / 按钮与输入框 10 / 胶囊 999；**嵌套同心：外 = 内 + 内边距**。
     *     落地口径——含 10px 控件的卡片内边距取 8（18 = 10 + 8）；纯文字块不产生嵌套圆角，可用 12/16 内边距。
     *   · 间距只用 4/8/12/16/24/32/40；字号只有三档 20/13/11。
     *   · 阴影只有两级、一律 rgba 透明黑；按钮/卡片/控件的 1px 圈一律用 box-shadow 画（边框只表达结构与状态）。
     *   · 动效一律 transition-property 写全属性名（禁止 transition: all），150–200ms ease-out，并有 reduced-motion 降级。
     */
    const CSS = `
/* 令牌声明在 :root —— 会话 header / 输入区这些入口挂在 .gicu-root 之外，落在 :root 上才取得到值。 */
:root {
  /* 暖调（客户裁定甲）：值逐条来自 openpencil-design-muqu4vgs-e37d.op 源文件，不是渲染图目视近似值。
     源文件出现次数：ink #17191D×21、ink-2 #66635E×14、白 #FFFFFF×12、线 #DED8CE×8、深 #111318×6、
     强调底 #FFD9A8×6、页底 #F4F0E8×5、主色 #A84300×5、暖灰 #D6D3D1×3、次级底 #FAF8F3×2、
     页脚深 #1C1917×1、页脚弱字 #A8A29E×1。
     --gi-ink-3 设计稿未单列 → 按《美术层第二单》§三 保留现值。 */
  --gi-bg:#F4F0E8; --gi-card:#FFFFFF;
  --gi-ink:#17191D; --gi-ink-2:#66635E; --gi-ink-3:#8A909C; --gi-line:#DED8CE;
  --gi-accent:#A84300; --gi-dark:#111318; --gi-warn-bg:#FFF3E6; --gi-warn-ink:#9A4A00;
  --gi-r-card:18px; --gi-r-block:12px; --gi-r-ctl:10px; --gi-r-pill:999px;
  --gi-s1:4px; --gi-s2:8px; --gi-s3:12px; --gi-s4:16px; --gi-s6:24px; --gi-s8:32px; --gi-s10:40px;
  --gi-shadow-card:0 2px 8px rgba(16,19,25,.06);
  --gi-shadow-pop:0 10px 28px rgba(16,19,25,.18);
  --gi-fs-title:20px; --gi-fs-body:13px; --gi-fs-aux:11px;
  --gi-ease:cubic-bezier(.2,0,0,1);

  /* ── 语义色阶（非品牌令牌，本包自声明）─────────────────────────────────────
     契约 §3.1 的品牌值只有上面那 10 个；界面还要用的中性色与状态色原先**写死在 80 多处**，
     同一个值最多抄 8 遍 —— 想改一个 hover 底得满文件找。这里把"值"集中声明一次，
     规则里只引名字：观感一字未改（每个令牌就是它原来那个值），改色从此只剩一处。
     命名按**用途**（surface / line / ink / ok / bad / warn / accent），不按色相。
     这些值若日后要升格进《契约》§3.1 品牌表，须客户点头（本包不自行改品牌口径）。 */
  --gi-on-accent:#FFFFFF;       /* 强调色块 / 深色块上的文字（.op 白） */
  --gi-surface-soft:#FAF8F3;    /* 中性块底：禁用底、chip、信息行（.op 次级底） */
  --gi-surface-hover:#FAF8F3;   /* 可点元素 hover 底（.op 次级底） */
  --gi-surface-hover-2:#FBF8F3; /* 投放靶 hover 底（第二单 §三.4 指定值） */
  --gi-surface-top:#FAF8F3;     /* 输入框 hover 底（.op 次级底） */
  --gi-paper:#FBF8F3;           /* 投放靶静止底（第二单 §三.4 指定值） */
  --gi-line-strong:#DED8CE;     /* 控件描边 / 1px 环线（.op 边框） */
  --gi-line-soft:#DED8CE;       /* 禁用态描边（.op 边框） */
  --gi-ink-disabled:#A8A29E;    /* 禁用态文字（.op 弱字） */
  --gi-ink-faint:#A8A29E;       /* 更弱一档（quiet 禁用）（.op 弱字） */
  --gi-on-dark-faint:#A8A29E;   /* 深色取景框上的兜底文字（.op 弱字） */
  --gi-track:#D6D3D1;           /* 滚动条（.op 暖灰，第二单 §三.4 指定） */
  --gi-accent-hover:#A8360A;    /* 强调色 hover（第一单 §四 指定值） */
  --gi-accent-soft:#FDF1E7;     /* 强调浅底：拖拽态等（第二单 §三.4 指定值） */
  --gi-accent-soft-2:#FDF6EE;   /* 强调浅底 hover（第二单 §三.4 指定值） */
  --gi-accent-deep:#A84300;     /* 浅底上的强调色文字 = .op 主色本身 */
  --gi-accent-line:#FFD9A8;     /* 强调浅底描边（.op 强调底） */
  --gi-chip-accent:#FFD9A8;     /* chip / 提示条底（.op 强调底，第二单 §三.2） */
  --gi-ok-bg:#EAF3EC; --gi-ok-ink:#24603A; --gi-ok-line:#C6E0CE;
  --gi-bad-bg:#FDECEC; --gi-bad-ink:#A32222; --gi-bad-line:#F2C9C9;
  --gi-warn-line:#F0C79A;
  --gi-dark-hover:#1C1917;      /* 深色按钮 hover（.op 页脚深） */
}
.gicu-root {
  box-sizing:border-box; height:100%; min-height:0; width:100%;
  display:flex; flex-direction:column;
  background:var(--gi-bg); color:var(--gi-ink);
  font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  font-size:var(--gi-fs-body); line-height:1.6; -webkit-font-smoothing:antialiased;
}
.gicu-root *, .gicu-root *::before, .gicu-root *::after { box-sizing:border-box; }
.gicu-num { font-variant-numeric:tabular-nums; }
.gicu-scroll { min-height:0; overflow-y:auto; scrollbar-width:thin; scrollbar-color:var(--gi-track) transparent; }
.gicu-scroll::-webkit-scrollbar { width:10px; height:10px; }
.gicu-scroll::-webkit-scrollbar-thumb { background:var(--gi-track); border:3px solid transparent; border-radius:var(--gi-r-pill); background-clip:content-box; }
@media (prefers-reduced-motion: reduce) { .gicu-root * { transition-duration:1ms !important; animation-duration:1ms !important; } }

/* ── 控件：四态齐全（hover / active / focus-visible / disabled）；禁用态一律灰化 ── */
.gicu-btn {
  display:inline-flex; align-items:center; justify-content:center; gap:var(--gi-s2);
  min-height:44px; padding:0 var(--gi-s4);
  border:0; border-radius:var(--gi-r-ctl);
  background:var(--gi-card); color:var(--gi-ink);
  box-shadow:0 0 0 1px var(--gi-line);
  font:inherit; font-size:var(--gi-fs-body); cursor:pointer; white-space:nowrap;
  transition-property:background-color, box-shadow, color, scale;
  transition-duration:160ms; transition-timing-function:var(--gi-ease);
}
.gicu-btn:hover:not([disabled]) { background:var(--gi-surface-hover); box-shadow:0 0 0 1px var(--gi-line-strong), var(--gi-shadow-card); }
.gicu-btn:active:not([disabled]) { scale:.96; }
.gicu-btn:focus-visible { outline:2px solid var(--gi-accent); outline-offset:2px; }
.gicu-btn[disabled] { background:var(--gi-surface-soft); color:var(--gi-ink-disabled); box-shadow:0 0 0 1px var(--gi-line-soft); cursor:not-allowed; }
.gicu-btn.primary { background:var(--gi-accent); color:var(--gi-on-accent); box-shadow:var(--gi-shadow-card); }
.gicu-btn.primary:hover:not([disabled]) { background:var(--gi-accent-hover); }
.gicu-btn.primary[disabled] { background:var(--gi-surface-soft); color:var(--gi-ink-disabled); box-shadow:0 0 0 1px var(--gi-line-soft); }
.gicu-btn.quiet { background:transparent; color:var(--gi-ink-2); box-shadow:none; }
.gicu-btn.quiet:hover:not([disabled]) { background:rgba(16,19,25,.05); box-shadow:none; }
.gicu-btn.quiet[disabled] { background:transparent; color:var(--gi-ink-faint); box-shadow:none; }
.gicu-btn.danger { background:var(--gi-dark); color:var(--gi-on-accent); box-shadow:var(--gi-shadow-card); }
.gicu-btn.danger:hover:not([disabled]) { background:var(--gi-dark-hover); }
.gicu-btn[data-on="1"] { background:var(--gi-dark); color:var(--gi-on-accent); }

/* ── 会话侧入口（挂在 .gicu-root 之外：取值写字面量，不依赖上方令牌）── */
.gicu-dock { display:inline-flex; align-items:center; gap:8px; flex-wrap:wrap; }
.gicu-dockbtn {
  display:inline-flex; align-items:center; justify-content:center; gap:8px;
  min-height:44px; padding:0 16px; border:0; border-radius:var(--gi-r-ctl);
  background:var(--gi-card); color:var(--gi-ink); box-shadow:0 0 0 1px var(--gi-line);
  font:inherit; font-size:13px; cursor:pointer; white-space:nowrap;
  transition-property:background-color, box-shadow, scale;
  transition-duration:160ms; transition-timing-function:cubic-bezier(.2,0,0,1);
}
.gicu-dockbtn:hover { background:var(--gi-surface-hover); box-shadow:0 0 0 1px var(--gi-line-strong), 0 2px 8px rgba(16,19,25,.06); }
.gicu-dockbtn:active { scale:.96; }
.gicu-dockbtn:focus-visible { outline:2px solid var(--gi-accent); outline-offset:2px; }
.gicu-dockbtn[disabled] { background:var(--gi-surface-soft); color:var(--gi-ink-disabled); box-shadow:0 0 0 1px var(--gi-line-soft); cursor:not-allowed; }
.gicu-dock .gicu-chip { display:inline-flex; align-items:center; min-height:22px; padding:0 8px; border-radius:var(--gi-r-pill); font-size:var(--gi-fs-aux); background:var(--gi-surface-soft); color:var(--gi-ink-2); white-space:nowrap; }
.gicu-dock .gicu-chip[data-tone="warn"] { background:var(--gi-warn-bg); color:var(--gi-warn-ink); }

.gicu-input, .gicu-note {
  width:100%; border:0; border-radius:var(--gi-r-ctl); padding:var(--gi-s3);
  background:var(--gi-card); color:var(--gi-ink); box-shadow:0 0 0 1px var(--gi-line);
  font:inherit; font-size:var(--gi-fs-body);
  transition-property:box-shadow, background-color; transition-duration:160ms; transition-timing-function:var(--gi-ease);
}
.gicu-input:hover, .gicu-note:hover { background:var(--gi-surface-top); }
.gicu-input:focus-visible, .gicu-note:focus-visible { outline:none; box-shadow:0 0 0 2px var(--gi-accent); }
.gicu-input[disabled], .gicu-note[disabled] { background:var(--gi-surface-soft); color:var(--gi-ink-disabled); box-shadow:0 0 0 1px var(--gi-line-soft); cursor:not-allowed; }
.gicu-note { min-height:88px; resize:vertical; }
.gicu-select {
  min-height:44px; min-width:0; border:0; border-radius:var(--gi-r-ctl); padding:0 var(--gi-s3);
  background:var(--gi-card); color:var(--gi-ink); box-shadow:0 0 0 1px var(--gi-line);
  font:inherit; font-size:var(--gi-fs-body); cursor:pointer;
  transition-property:background-color, box-shadow; transition-duration:160ms; transition-timing-function:var(--gi-ease);
}
.gicu-select:hover { background:var(--gi-surface-hover); box-shadow:0 0 0 1px var(--gi-line-strong); }
.gicu-select:active { scale:.96; }
.gicu-select:focus-visible { outline:2px solid var(--gi-accent); outline-offset:2px; }
.gicu-select[disabled] { background:var(--gi-surface-soft); color:var(--gi-ink-disabled); box-shadow:0 0 0 1px var(--gi-line-soft); cursor:not-allowed; }
/* B1：下拉右侧的 chevron-down 内联 SVG（设计稿 icon_font 之一）。只做定位，不挡点击。 */
.gicu-selectwrap { position:relative; display:flex; flex:1 1 200px; min-width:0; }
.gicu-selectwrap .gicu-select { flex:1 1 auto; width:100%; appearance:none; -webkit-appearance:none; padding-right:var(--gi-s8); }
.gicu-chev { position:absolute; right:var(--gi-s3); top:50%; transform:translateY(-50%); display:flex; pointer-events:none; color:var(--gi-ink-3); }
.gicu-chev svg { display:block; width:20px; height:20px; }

/* ── 采集屏：整屏两栏。左 = 照片投放区（本屏视觉主角），右 = 表单 ── */
.gicu-screen { flex:1; min-height:0; display:grid; grid-template-columns:minmax(0,1.25fr) minmax(0,1fr); gap:var(--gi-s4); padding:var(--gi-s4); }
.gicu-hero {
  display:flex; flex-direction:column; gap:var(--gi-s2); min-height:0; min-width:0;
  padding:var(--gi-s2); border-radius:var(--gi-r-card); background:var(--gi-card); box-shadow:var(--gi-shadow-card);
}
.gicu-hero .drop {
  flex:1; min-height:44px; width:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--gi-s3);
  border:0; border-radius:var(--gi-r-ctl); padding:var(--gi-s6) var(--gi-s4);
  background:var(--gi-surface-hover); color:var(--gi-ink-2); box-shadow:0 0 0 1px var(--gi-line);
  font:inherit; font-size:var(--gi-fs-body); text-align:center; cursor:pointer;
  transition-property:background-color, box-shadow, color, scale; transition-duration:180ms; transition-timing-function:var(--gi-ease);
}
.gicu-hero .drop:hover { background:var(--gi-surface-hover-2); color:var(--gi-ink); box-shadow:0 0 0 1px var(--gi-line-strong), var(--gi-shadow-card); }
.gicu-hero .drop:active { scale:.96; }
.gicu-hero .drop:focus-visible { outline:2px solid var(--gi-accent); outline-offset:2px; }
.gicu-hero .drop[data-over="1"] { background:var(--gi-accent-soft); color:var(--gi-accent); box-shadow:0 0 0 2px var(--gi-accent); }
.gicu-hero .drop .t1 { font-size:var(--gi-fs-body); font-weight:600; text-wrap:balance; }
.gicu-hero .drop .t2 { font-size:var(--gi-fs-aux); color:var(--gi-ink-3); text-wrap:pretty; }
.gicu-hero .shot { flex:1; min-height:0; display:flex; flex-direction:column; gap:var(--gi-s2); }
.gicu-hero .frame { flex:1; min-height:0; display:flex; align-items:center; justify-content:center; border-radius:var(--gi-r-ctl); overflow:hidden; background:var(--gi-dark); }
.gicu-hero .frame img { display:block; max-width:100%; max-height:100%; object-fit:contain; outline:1px solid rgba(16,19,25,.10); outline-offset:-1px; }
.gicu-hero .frame .fallback { font-size:var(--gi-fs-aux); color:var(--gi-on-dark-faint); }
.gicu-hero .meta { display:flex; align-items:center; gap:var(--gi-s2); flex-wrap:wrap; }
.gicu-hero .nm { font-size:var(--gi-fs-body); font-weight:600; word-break:break-all; text-wrap:pretty; }
.gicu-grow { flex:1 1 auto; }

.gicu-form { display:flex; flex-direction:column; gap:var(--gi-s3); min-width:0; }
.gicu-banner { border-radius:var(--gi-r-block); padding:var(--gi-s3); background:var(--gi-warn-bg); color:var(--gi-warn-ink); font-size:var(--gi-fs-aux); line-height:1.6; text-wrap:pretty; }
.gicu-row { display:flex; align-items:center; gap:var(--gi-s2); flex-wrap:wrap; min-width:0; }
.gicu-row .gicu-select { flex:1 1 200px; }
.gicu-lbl { font-size:var(--gi-fs-aux); color:var(--gi-ink-3); }
.gicu-count { margin-left:auto; font-size:var(--gi-fs-aux); color:var(--gi-ink-3); }
.gicu-actions { display:flex; align-items:center; gap:var(--gi-s2); flex-wrap:wrap; }
.gicu-line { border-radius:var(--gi-r-block); padding:var(--gi-s2) var(--gi-s3); font-size:var(--gi-fs-aux); color:var(--gi-ink-2); background:var(--gi-surface-soft); text-wrap:pretty; }
.gicu-line.warn { background:var(--gi-warn-bg); color:var(--gi-warn-ink); }
.gicu-line.err { background:var(--gi-bad-bg); color:var(--gi-bad-ink); }
.gicu-line.ok { background:var(--gi-ok-bg); color:var(--gi-ok-ink); }
.gicu-chip { display:inline-flex; align-items:center; gap:var(--gi-s1); min-height:22px; padding:0 var(--gi-s2); border-radius:var(--gi-r-pill); font-size:var(--gi-fs-aux); background:var(--gi-surface-soft); color:var(--gi-ink-2); white-space:nowrap; }
.gicu-chip[data-tone="warn"] { background:var(--gi-warn-bg); color:var(--gi-warn-ink); }
.gicu-chip[data-tone="ok"] { background:var(--gi-ok-bg); color:var(--gi-ok-ink); }

/* ── 五态状态行（逐字文案在组件里；这里是同一状态的五种色档）── */
.gicu-state { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--gi-s2); padding:var(--gi-s8) var(--gi-s4); text-align:center; color:var(--gi-ink-2); font-size:var(--gi-fs-body); }
.gicu-state .t { font-weight:600; color:var(--gi-ink); text-wrap:balance; }
.gicu-state .d { font-size:var(--gi-fs-aux); color:var(--gi-ink-3); max-width:44ch; text-wrap:pretty; }
.gicu-state[data-line="1"] { flex-direction:row; align-items:center; justify-content:flex-start; text-align:left; gap:var(--gi-s2); padding:var(--gi-s2); border-radius:var(--gi-r-card); background:var(--gi-card); box-shadow:0 0 0 1px var(--gi-line); font-size:var(--gi-fs-aux); }
.gicu-state[data-line="1"] .txt { flex:1 1 auto; min-width:0; text-wrap:pretty; }
.gicu-state[data-line="1"][data-kind="running"] { background:var(--gi-accent-soft); color:var(--gi-accent-deep); box-shadow:0 0 0 1px var(--gi-accent-line); }
.gicu-state[data-line="1"][data-kind="ok"] { background:var(--gi-ok-bg); color:var(--gi-ok-ink); box-shadow:0 0 0 1px var(--gi-ok-line); }
.gicu-state[data-line="1"][data-kind="bad"] { background:var(--gi-bad-bg); color:var(--gi-bad-ink); box-shadow:0 0 0 1px var(--gi-bad-line); }
.gicu-state[data-line="1"][data-kind="off"] { background:var(--gi-warn-bg); color:var(--gi-warn-ink); box-shadow:0 0 0 1px var(--gi-warn-line); }

/* ── 三态（加载中 / 空 / 失败）：任何数据面都不留白屏 ── */
.gicu-skel { width:100%; align-self:stretch; height:44px; border-radius:var(--gi-r-ctl); background:linear-gradient(90deg, rgba(16,19,25,.05), rgba(16,19,25,.10), rgba(16,19,25,.05)); background-size:200% 100%; animation:gicu-skel 1200ms ease-out infinite; }
@keyframes gicu-skel { from { background-position:200% 0; } to { background-position:0 0; } }

/* ══ 第二轮重做（2026-10-03）：采集屏重排 ══════════════════════════════════
   真机截图里最丑的一屏：左栏投放区被拉成一块上百像素高的空白白板，右栏表单贴在顶上、
   下面半屏空着。这里只覆盖布局与容器，不动任何令牌值与逐字文案。 */
.gicu-screen {
  align-items:stretch; gap:var(--gi-s6); padding:var(--gi-s6);
  grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);
  overflow-y:auto; scrollbar-width:thin; scrollbar-color:var(--gi-track) transparent;
}
.gicu-screen::-webkit-scrollbar { width:10px; height:10px; }
.gicu-screen::-webkit-scrollbar-thumb { background:var(--gi-track); border:3px solid transparent; border-radius:var(--gi-r-pill); background-clip:content-box; }

/* 左：照片投放区。**两栏都撑满高度**，投放板吃掉剩余空间（虚线靶 + 圆底相机图标，
   一眼看出「这里是丢照片的地方」），不再是一块没有边界的空白白板。
   B1 同心圆角：卡片 18 = 投放靶 10 + 内边距 8（呼吸感由 gap 给，不再靠加大内边距 ——
   内边距 12 配 18 圆角会让两个角不同心）。 */
.gicu-hero { gap:var(--gi-s3); padding:var(--gi-s2); }
.gicu-hero .drop {
  flex:1; min-height:240px; width:100%; gap:var(--gi-s3);
  border:1.5px dashed var(--gi-line-strong); background:var(--gi-paper);
}
.gicu-hero .drop:hover { border-color:var(--gi-accent); background:var(--gi-accent-soft-2); box-shadow:none; }
.gicu-hero .drop[data-over="1"] { border-color:var(--gi-accent); border-style:solid; background:var(--gi-accent-soft); }
/* B1/B3：投放区是视觉主角 —— 40–48px 圆底 + 24px 内联 SVG 相机图标（currentColor，
   颜色跟着控件走；B1 的场景尺寸里 24 就是"主角"档）。删掉了原先给 emoji 定字号的
   两条死样式（.cam 的 font-size 与 line-height）——emoji 已经不存在了，留着只会误导后来人。
   B3 里"暖色虚线框 + 暖白底"按客户裁定改判：配色以《指令》《契约》为准，一律走令牌。 */
.gicu-hero .drop .cam {
  display:flex; align-items:center; justify-content:center;
  width:48px; height:48px; border-radius:var(--gi-r-pill);
  background:var(--gi-accent-soft); color:var(--gi-accent);
}
.gicu-hero .drop .cam svg { display:block; width:24px; height:24px; }
.gicu-hero .drop .t1 { font-size:var(--gi-fs-body); font-weight:600; }
.gicu-hero .drop .t2 { font-size:var(--gi-fs-aux); color:var(--gi-ink-3); }
.gicu-hero .shot { flex:1; min-height:0; gap:var(--gi-s3); }
.gicu-hero .frame { flex:1; min-height:0; max-height:none; padding:var(--gi-s2); }
.gicu-hero .frame img { max-height:100%; }
.gicu-hero .meta { flex:none; padding:0 var(--gi-s1); }

/* 右：表单成卡并撑满同高，动作行贴底（下半屏不再空着） */
.gicu-form {
  gap:var(--gi-s4); padding:var(--gi-s6); min-height:100%;
  border-radius:var(--gi-r-card); background:var(--gi-card); box-shadow:var(--gi-shadow-card);
}
.gicu-form .gicu-note { flex:1; min-height:132px; }
.gicu-form .gicu-row .gicu-select { flex:1 1 100%; }
.gicu-form .gicu-row .gicu-selectwrap { flex:1 1 100%; }
.gicu-actions { margin-top:auto; padding-top:var(--gi-s2); gap:var(--gi-s3); }
.gicu-actions .gicu-btn.primary { min-width:132px; }

/* 「待整改（被督导退回）」块：退回闭环的店长侧承接面（退回原因 + 整改回拍入口） */
/* B1 同心圆角：待整改块 18 = 内条 10 + 内边距 8（改前是 12 圆角配 12 内边距，和外层角不同心） */
.gicu-rework { display:flex; flex-direction:column; gap:var(--gi-s2); padding:var(--gi-s2); border-radius:var(--gi-r-card); background:var(--gi-bad-bg); box-shadow:0 0 0 1px var(--gi-bad-line); }
.gicu-rework-h { font-size:var(--gi-fs-body); font-weight:600; color:var(--gi-bad-ink); }
.gicu-rework-item { display:flex; flex-direction:column; gap:var(--gi-s1); padding:var(--gi-s3); border-radius:var(--gi-r-ctl); background:var(--gi-card); }
.gicu-rework-t { font-size:var(--gi-fs-body); font-weight:600; }
.gicu-rework-r { font-size:var(--gi-fs-aux); color:var(--gi-ink-2); text-wrap:pretty; }
.gicu-rework-d { font-size:var(--gi-fs-aux); color:var(--gi-ink-3); }
/* 催办痕迹：只在"真的被催过"时出现；用告警色（它意味着时间压力），不是普通说明文字。 */
.gicu-rework-c { font-size:var(--gi-fs-aux); font-weight:600; color:var(--gi-warn-ink); }
.gicu-rework-item .gicu-btn { align-self:flex-start; margin-top:var(--gi-s1); }
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

    /**
     * 内联 SVG 图标（B1 图标体系）。**本包自己声明一份，不依赖另一个包**（与令牌同一口径）。
     *
     * 统一参数（两个包逐字一致，不再各写一遍）：viewBox `0 0 24 24` / `fill:none` /
     * `stroke:currentColor` / `strokeWidth:1.8` / 圆头圆角 / `aria-hidden` + `focusable:false`。
     * 颜色一律 `currentColor`，由所在控件的 `color` 决定（hover / 禁用自动跟着变，不做第二套资源）。
     * 场景尺寸：行内与按钮 18、列表入口 20、视觉主角 24。
     *
     * **只画设计稿授权的那几枚**（camera / clock / chevron-down）。缺的那几枚**不自己发明**——
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
      if (name === 'camera') {
        return React.createElement('svg', common, [
          React.createElement('path', { key: 'b', d: 'M3.2 9A2.4 2.4 0 0 1 5.6 6.6h1.1c.5 0 .96-.24 1.24-.65l.5-.72c.3-.43.79-.69 1.31-.69h4.5c.52 0 1.01.26 1.31.69l.5.72c.28.41.74.65 1.24.65h1.1A2.4 2.4 0 0 1 20.8 9v7.4a2.4 2.4 0 0 1-2.4 2.4H5.6a2.4 2.4 0 0 1-2.4-2.4z' }),
          React.createElement('circle', { key: 'l', cx: 12, cy: 12.6, r: 3.2 }),
        ])
      }
      if (name === 'clock') {
        return React.createElement('svg', common, [
          React.createElement('circle', { key: 'c', cx: 12, cy: 12, r: 8.4 }),
          React.createElement('path', { key: 'h', d: 'M12 7.6V12l3.2 1.9' }),
        ])
      }
      if (name === 'chevron-down') {
        return React.createElement('svg', common, [
          React.createElement('path', { key: 'v', d: 'M6 9.6 12 15.4 18 9.6' }),
        ])
      }
      return null
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

    // ── 跨包通道：店长端屏组件（本包发布 → 督导包外壳内嵌）──────────────────
    const uiChannel = {
      listeners: new Set(),
      subscribe(listener) {
        if (typeof listener !== 'function') return () => {}
        uiChannel.listeners.add(listener)
        return () => {
          uiChannel.listeners.delete(listener)
        }
      },
      notify() {
        for (const listener of Array.from(uiChannel.listeners)) {
          try {
            listener()
          } catch (error) {
            /* 单个订阅者出错不影响其它 */
          }
        }
      },
    }

    function exposeUiChannel() {
      const api = {
        version: 1,
        // **必须返回同一个函数引用**（除非重新装载）：外壳用 useSyncExternalStore + Object.is 比对，
        // 每次返回新函数会让订阅者白重渲染。
        getScreen: () => (React ? CaptureScreen : null),
        subscribe: (listener) => uiChannel.subscribe(listener),
      }
      globalThis[UI_CHANNEL] = api
      // 屏组件已可用 → 通知已登记的订阅者（外壳装载顺序不定，谁后到谁自己再来取一次）。
      uiChannel.notify()
      return api
    }

    function exposeChannels() {
      exposeViewChannel()
      return exposeUiChannel()
    }

    // ── 督导包（外壳）通道：装没装决定入口点了有没有反应（说明 §5.1 不许留死按钮）──
    function shellChannelOf() {
      const channel = globalThis[SHELL_CHANNEL]
      return channel && typeof channel === 'object' && typeof channel.open === 'function' ? channel : null
    }

    const shellBridge = {
      ready: shellChannelOf() !== null,
      snapshot: { ready: false },
      listeners: new Set(),
      subscribe(listener) {
        if (typeof listener !== 'function') return () => {}
        shellBridge.listeners.add(listener)
        return () => {
          shellBridge.listeners.delete(listener)
        }
      },
      notify() {
        shellBridge.snapshot = { ready: shellBridge.ready }
        for (const listener of Array.from(shellBridge.listeners)) {
          try {
            listener()
          } catch (error) {
            /* 忽略 */
          }
        }
      },
      /** 轮询外壳通道是否已出现／消失；变了才换快照引用（否则 React 会白重渲染）。 */
      sync() {
        const ready = shellChannelOf() !== null
        if (ready === shellBridge.ready) return ready
        shellBridge.ready = ready
        shellBridge.notify()
        return ready
      },
    }
    shellBridge.snapshot = { ready: shellBridge.ready }

    /** 入口动作：切店长端（角色的唯一真源）+ 请外壳打开「巡店自查」主面板。 */
    function openCaptureScreen(view) {
      localView.setRole(ROLE_MANAGER)
      const shell = shellChannelOf()
      if (!shell) return false
      try {
        shell.open(view === 'logs' ? 'logs' : 'board')
      } catch (error) {
        console.warn('[gaia-inspection-capture-ui] 请外壳打开巡店自查面板失败：', error)
        return false
      }
      return true
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

    /**
     * 「正在整改回拍哪一张」——做成 store 而不是组件内 useState：① 选择要跨重渲染存活
     * （真机里用户选完可能先改说明/换门店再提交）；② 自测的渲染垫片整棵重挂会丢 useState，store 不会。
     */
    const reworkState = {
      id: '',
      snapshot: { id: '' },
      listeners: new Set(),
      subscribe(listener) {
        reworkState.listeners.add(listener)
        return () => reworkState.listeners.delete(listener)
      },
      notify() {
        reworkState.snapshot = { id: reworkState.id }
        reworkState.listeners.forEach((listener) => {
          try {
            listener()
          } catch (error) {
            /* 忽略 */
          }
        })
      },
      setId(next) {
        const value = textOf(next)
        if (value === reworkState.id) return
        reworkState.id = value
        reworkState.notify()
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

    async function submitSelfCheck({ storeId, note, photos, reworkOf }) {
      submitState.phase = 'busy'
      submitState.error = ''
      submitState.receipt = null
      submitState.lastStoreId = textOf(storeId)
      submitState.notify()

      // reworkOf：本次是"整改回拍"哪一张被退回的单（后端据此把新单标出来源；单号不存在时后端会忽略）
      const from = textOf(reworkOf)
      let body
      try {
        body = { storeId: storeId || null, note: textOf(note), photos: await encodePhotos(photos), ...(from ? { reworkOf: from } : {}) }
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
          // 整改回拍一旦被后端受理，这次"正在整改回拍"就用掉了（新单已带来源，原单会被摘出待整改列表）。
          // 放在这里而不是组件的 effect：effect 会被"上一次提交留下的 done"误触发（真机实测踩过）。
          if (from) reworkState.setId('')
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

    /**
     * 「待整改（被督导退回）」：本店被退回过、且**还没有整改回拍单**的检查单。
     *
     * 数据来自同一个 `/snapshot`（后端已露出 `returnedAt` / `returnedCount` / `lastAction` / `reworkOf`）。
     * 为什么需要它（用户实测反馈）：督导点完「退回并说明」之后，店长端什么都看不到 ——
     * 「退回 → 店长看到原因 → 整改回拍 → 督导复核」这条链断在店长这一侧，退回就石沉大海了。
     *
     * A-5 修正（教练在真机上抓到的）：退回人/退回原因**必须取「退回」那一条动作**，
     * 不能取"最近一条动作"—— 后端逾期扫描会往同一张单追加 **催办 / 升级（actor=系统）**，
     * 于是真机上出现了「由 系统 退回」且原因显示成升级原因（系统只催办/升级过，从没退过单）。
     */
    function lastRejectOf(item) {
      const rows = Array.isArray(item && item.actions) ? item.actions : []
      const rejects = rows.filter((a) => a && (a.type === '退回并说明' || a.actionCode === 'review_reject'))
      return rejects.length > 0 ? rejects[rejects.length - 1] : null
    }

    function pendingReworkOf(snapshot, storeId) {
      const data = snapshot && typeof snapshot === 'object' ? snapshot : null
      const list = data && Array.isArray(data.inspections) ? data.inspections : []
      const reworked = new Set()
      for (const item of list) {
        const from = textOf(item && item.reworkOf)
        if (from) reworked.add(from)
      }
      const key = textOf(storeId)
      return list
        .filter((item) => {
          if (!item || !textOf(item.returnedAt)) return false
          // 已办结/已关闭的单**不许再挂在门店端「待整改」**（真机实测漏了这条：督导直接逐项点通过把原单办结、
          // 又没产生回拍单时 —— 例如 #flsq —— 店长端还在让他"整改后重新提交"，那条其实已经不用做了）。
          if (DONE_STATUSES.indexOf(trim(textOf(item.status)).toLowerCase()) !== -1) return false
          if (reworked.has(textOf(item.id))) return false
          if (key && textOf(item.storeId) !== key) return false
          return true
        })
        .map((item) => {
          const reject = lastRejectOf(item)
          const who = textOf(reject && reject.actorName) || textOf(reject && reject.actor)
          const human = reject ? reject.actorIsHuman !== false && who !== '系统' : false
          // 催办痕迹（客户 10-03 用完真机后的裁定：督导点「催办」不能是摆设，门店端必须看得到）。
          // 数据不用新字段：同一张单的 `actions` 里已经有 type='催办'（人工）/ actionCode='review_remind'（系统扫描）的记录。
          const acts = Array.isArray(item && item.actions) ? item.actions : []
          const reminds = acts.filter((a) => a && (a.type === '催办' || a.actionCode === 'review_remind'))
          const lastRemind = reminds.length > 0 ? reminds[reminds.length - 1] : null
          const remindWho = textOf(lastRemind && (lastRemind.actorName || lastRemind.actor))
          const remindHuman = lastRemind ? lastRemind.actorIsHuman !== false && remindWho !== '系统' : false
          return {
            id: textOf(item.id),
            short: shortNo(item.id),
            returnedAt: (reject && reject.createdAt) || item.returnedAt,
            returnedCount: Number(item.returnedCount) || 0,
            dueAt: item.dueAt || null,
            reason: textOf(reject && reject.reason),
            actor: reject ? (who || '督导') + (human ? '（人工退回）' : '（系统自动）') : '',
            hasRejectRow: Boolean(reject),
            remindCount: reminds.length,
            remindAt: (lastRemind && lastRemind.createdAt) || null,
            remindBy: lastRemind ? (remindHuman ? (remindWho || '督导') : '系统自动') : '',
          }
        })
        .sort((a, b) => String(b.returnedAt || '').localeCompare(String(a.returnedAt || '')))
    }

    /**
     * 同一门店不允许重复提交未完成的分析：后端有该店「正在进行」检查单 → 锁；本地刚提交过 60s 内也锁。
     *
     * A-1.6 修正：**整改回拍不受本地 60s 锁限制**（isRework=true）——
     * 回拍是督导退回后**要求做的下一步**，跟"手抖重复提交"不是一回事；真机上刚提交完就点
     * 「整改后重新提交」，会看到按钮被这条 60s 锁按住（提示"同一门店不允许重复提交"，与他的意图相反）。
     * 后端那条"该店已有正在分析/排队的单"的锁**保留**（那才是真正的并发保护）。
     */
    function busyReasonOf(snapshot, storeId, now, isRework) {
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
      if (isRework === true) return ''
      if (submitState.lastStoreId === key && submitState.lastSubmittedAt && now - submitState.lastSubmittedAt < 60000) {
        return '刚提交过（' + clockOf(submitState.lastSubmittedAt) + '）：同一门店不允许重复提交未完成的分析，请稍后再试。'
      }
      return ''
    }

    // ── 呈现层辅助（不改逻辑层）：同一份 localError 里既有真错误也有「已载入示例」这类回执 ──
    function localNoticeKind(message) {
      const text = textOf(message)
      if (text.indexOf('已载入示例') === 0) return 'ok'
      if (text.indexOf('本地预览生成失败') === 0) return 'warn'
      return 'err'
    }

    // ── 组件：入口按钮（输入区 / 会话 header 共用；督导包未装载时给可见内联提示）──
    function CaptureOpenButton() {
      const bridge = React.useSyncExternalStore(shellBridge.subscribe, () => shellBridge.snapshot, () => shellBridge.snapshot)

      React.useEffect(() => {
        shellBridge.sync()
        const timer = window.setInterval(() => {
          shellBridge.sync()
        }, 2000)
        return () => window.clearInterval(timer)
      }, [])

      return React.createElement(
        'span',
        { className: 'gicu-dock' },
        React.createElement(
          'button',
          {
            className: 'gicu-dockbtn',
            type: 'button',
            title: CAPABILITY_CAPTURE + '：切到店长端并打开巡店自查面板',
            onClick: () => openCaptureScreen('board'),
          },
          CAPABILITY_CAPTURE,
        ),
        bridge.ready ? null : React.createElement('span', { className: 'gicu-chip', 'data-tone': 'warn' }, SHELL_MISSING_NOTICE),
      )
    }

    // ── 组件：输入区常驻入口（1 枚按钮 + 未装载提示 + 离线 chip）──────────────
    // 视图标签段（店长端/督导端）已由督导包外壳统一提供，这里不再重复（同一容器规格，§3.5 第 3 条）。
    function CaptureDock() {
      const snap = React.useSyncExternalStore(snapshotSource.subscribe, () => snapshotSource.snapshot, () => snapshotSource.snapshot)

      React.useEffect(() => {
        exposeChannels()
        pullSnapshot()
        const timer = window.setInterval(() => {
          pullSnapshot()
        }, 5000)
        return () => window.clearInterval(timer)
      }, [])

      const offline = normalizeOffline(snap.data)
      offlineEdge.onSnapshot(offline)

      const children = [React.createElement(CaptureOpenButton, { key: 'open' })]

      if (offline.known && offline.offline) {
        children.push(React.createElement('span', { className: 'gicu-chip', 'data-tone': 'warn', key: 'off' }, '离线：仅采集排队，不产生模型判断'))
      } else if (snap.failure) {
        children.push(React.createElement('span', { className: 'gicu-chip', key: 'nf' }, '采集状态未知（' + snap.failure + '）'))
      }

      return React.createElement('div', { className: 'gicu-dock' }, children)
    }

    // ── 组件：屏 A · 店长端（整屏；由督导包外壳内嵌）─────────────────────────
    // 本组件**只渲染店长端屏主体**：不自画屏标题/副标题、不放角色视图切换（外壳统一提供，同一容器规格）。
    // 外层自带 .gicu-root（自声明令牌），可独立存活。
    function CaptureScreen() {
      const submission = React.useSyncExternalStore(submitState.subscribe, () => submitState.snapshot, () => submitState.snapshot)
      const snap = React.useSyncExternalStore(snapshotSource.subscribe, () => snapshotSource.snapshot, () => snapshotSource.snapshot)

      const [storeId, setStoreId] = React.useState('')
      const [note, setNote] = React.useState('')
      const [photo, setPhoto] = React.useState(null)
      const [localError, setLocalError] = React.useState('')
      const [dragOver, setDragOver] = React.useState(false)
      const [sampleBusy, setSampleBusy] = React.useState(false)
      const inputRef = React.useRef(null)
      // 正在整改回拍的原单号（store：跨重渲染存活，见 reworkState 的说明）
      const rework = React.useSyncExternalStore(reworkState.subscribe, () => reworkState.snapshot, () => reworkState.snapshot)
      const reworkOf = rework.id

      React.useEffect(() => {
        pullSnapshot()
        return undefined
      }, [])

      const stores = storesOf(snap.data)
      const offline = normalizeOffline(snap.data)
      offlineEdge.onSnapshot(offline)
      const effectiveStore = storeId || (stores.length > 0 ? stores[0].storeId : '')
      const now = Date.now()
      const pendingRework = pendingReworkOf(snap.data, effectiveStore)
      // 整改回拍不受本地 60s 重复提交锁限制（见 busyReasonOf 注释）
      const busyReason = busyReasonOf(snap.data, effectiveStore, now, Boolean(reworkOf))

      // 注：「正在整改回拍」的清空**不放在这里**——上一版用 `phase === 'done'` 的 effect 清，
      // 结果上一次提交留下的 done 会把刚点上的回拍标记当场清掉（真机实测踩过：点了整改回拍，
      // 提交出去的新单没有来源）。现在由 submitSelfCheck 在**本次提交被后端受理后**自己清。

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
        await submitSelfCheck({ storeId: effectiveStore, note, photos: [photo], reworkOf: reworkOf || undefined })
        // 失败时输入与照片都保留（说明 §1.3）：这里**不清空**任何字段。
      }

      // 状态行（五态逐字）：同一条 .gicu-state[data-line="1"]，按 data-kind 换色档（动态数字用 .gicu-num）
      let stateNode
      const noText = submission.receipt ? shortNo(submission.receipt.no) : ''
      if (offlineEdge.recovering(now)) {
        const n = offlineEdge.lastPending === null ? 'N' : String(offlineEdge.lastPending)
        stateNode = React.createElement(
          'div',
          { className: 'gicu-state', key: 'state', 'data-line': '1', 'data-kind': 'off' },
          React.createElement('span', { className: 'txt gicu-num' }, '已联网，正在补判排队中的 ' + n + ' 条…'),
        )
      } else if (running) {
        stateNode = React.createElement(
          'div',
          { className: 'gicu-state', key: 'state', 'data-line': '1', 'data-kind': 'running' },
          React.createElement('span', { className: 'txt' }, STATE_RUNNING),
        )
      } else if (submission.phase === 'failed') {
        stateNode = React.createElement(
          'div',
          { className: 'gicu-state', key: 'state', 'data-line': '1', 'data-kind': 'bad' },
          React.createElement('span', { className: 'txt gicu-num' }, '分析失败：' + (submission.error || '未收到原因摘要')),
          React.createElement('button', { className: 'gicu-btn', type: 'button', onClick: doSubmit }, '重试'),
        )
      } else if (submission.phase === 'done' && submission.receipt) {
        const receipt = submission.receipt
        if (receipt.queued || (offline.known && offline.offline)) {
          stateNode = React.createElement(
            'div',
            { className: 'gicu-state', key: 'state', 'data-line': '1', 'data-kind': 'off' },
            React.createElement('span', { className: 'txt' }, OFFLINE_NOTICE + (receipt.summary && receipt.summary !== OFFLINE_NOTICE ? '（' + receipt.summary + '）' : '')),
          )
        } else {
          stateNode = React.createElement(
            'div',
            { className: 'gicu-state', key: 'state', 'data-line': '1', 'data-kind': 'ok' },
            React.createElement('span', { className: 'txt gicu-num' }, '已提交，编号 ' + (noText || '（后端未返回编号）') + '，等待督导复核'),
          )
        }
      } else {
        // 就绪时不能再说「照片与文字都填写后按钮可用」——那一刻按钮已经可用了。
        // （真机截图里出现过：照片和文字都填好了、按钮是亮蓝的，状态行却还写着这句。）
        stateNode = React.createElement(
          'div',
          { className: 'gicu-state', key: 'state', 'data-line': '1', 'data-kind': 'idle' },
          React.createElement('span', { className: 'txt' }, canSubmit ? STATE_READY : STATE_EMPTY),
        )
      }

      // 门店下拉：三态齐全（读到了 / 正在读 / 读不到）——任何一态都不留白屏（契约 §3.3）
      // B1：设计稿的下拉右侧有一枚 chevron-down（`icon_font` 节点之一），原生 select 装不下 SVG，
      // 所以包一层只做定位的 span，把内联 SVG 压在右侧（pointer-events:none，不挡点击）。
      let storeField
      if (stores.length > 0) {
        storeField = React.createElement(
          'span',
          { className: 'gicu-selectwrap', key: 'storewrap' },
          [
            React.createElement(
              'select',
              { className: 'gicu-select', key: 'sel', value: effectiveStore, onChange: (event) => setStoreId(event && event.target ? event.target.value : '') },
              stores.map((store) => React.createElement('option', { key: store.storeId, value: store.storeId }, store.label)),
            ),
            React.createElement('span', { className: 'gicu-chev', key: 'chev' }, svgIcon('chevron-down', 20)),
          ],
        )
      } else if (snap.failure) {
        storeField = React.createElement(
          'div',
          { className: 'gicu-state' },
          React.createElement('div', { className: 't' }, '门店列表不可用'),
          React.createElement('div', { className: 'd' }, snap.failure + '：门店读不到就不猜门店，先把后端（gaia-inspection-core）弄通再重试。'),
          React.createElement('button', { className: 'gicu-btn', type: 'button', onClick: () => pullSnapshot() }, '重试'),
        )
      } else if (!snap.data) {
        storeField = React.createElement(
          'div',
          { className: 'gicu-state' },
          React.createElement('div', { className: 'gicu-skel' }),
          React.createElement('div', { className: 't' }, '正在读取门店列表…'),
          React.createElement('div', { className: 'd' }, '门店来自 /api/gaia-inspection/snapshot：读不到就不假装能选门店。'),
        )
      } else {
        storeField = React.createElement(
          'div',
          { className: 'gicu-state' },
          React.createElement('div', { className: 't' }, '门店列表为空'),
          React.createElement('div', { className: 'd' }, '后端未给出可自查的门店（snapshot.stores 为空）：把门店配好再点重试。'),
          React.createElement('button', { className: 'gicu-btn', type: 'button', onClick: () => pullSnapshot() }, '重试'),
        )
      }

      // 左栏：照片投放区（本屏视觉主角）——空态是整块投放区，选中态是大图预览 + 文件名 + 删除
      const heroChildren = []
      if (photo) {
        heroChildren.push(
          React.createElement(
            'div',
            { className: 'shot', key: 'shot' },
            React.createElement(
              'div',
              { className: 'frame' },
              photo.dataUrl ? React.createElement('img', { src: photo.dataUrl, alt: photo.name }) : React.createElement('span', { className: 'fallback' }, '预览生成中…'),
            ),
            React.createElement(
              'div',
              { className: 'meta' },
              React.createElement('span', { className: 'nm' }, photo.name),
              photo.size ? React.createElement('span', { className: 'gicu-chip gicu-num' }, fmtBytes(photo.size)) : null,
              React.createElement('span', { className: 'gicu-grow' }),
              React.createElement('button', { className: 'gicu-btn', type: 'button', onClick: () => { setPhoto(null); setLocalError('') } }, '删除'),
            ),
            photo.sampleLabel ? React.createElement('div', { className: 'gicu-line' }, photo.sampleLabel) : null,
          ),
        )
      } else {
        heroChildren.push(
          React.createElement(
            'button',
            {
              className: 'drop',
              key: 'drop',
              type: 'button',
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
            React.createElement('span', { className: 'cam' }, svgIcon('camera', 24)),
            React.createElement('span', { className: 't1' }, '点击选择照片，或把图片拖到这里'),
            React.createElement('span', { className: 't2' }, '支持 jpg / png，单张'),
          ),
        )
      }
      heroChildren.push(
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

      // 右栏：表单（提示条 → 门店下拉 → 一句话说明 + 字数 → 载入示例 / 提交并分析 → 五态状态行）
      const formChildren = []
      formChildren.push(React.createElement('div', { className: 'gicu-banner', key: 'notice' }, DEMO_NOTICE))
      // 「待整改（被督导退回）」：退回闭环的店长侧承接面。没有它，督导点完退回就石沉大海
      // （用户实测反馈：点了好几次退回并说明，找不到退到哪去了）。
      if (pendingRework.length > 0) {
        formChildren.push(
          React.createElement('div', { className: 'gicu-rework', key: 'rework' }, [
            React.createElement('div', { className: 'gicu-rework-h', key: 'h' }, '待整改（被督导退回） ' + pendingRework.length + ' 条'),
            ...pendingRework.map((item) =>
              React.createElement('div', { className: 'gicu-rework-item', key: item.id }, [
                React.createElement('div', { className: 'gicu-rework-t gicu-num', key: 't' }, item.short + '　退回 ' + (clockOf(item.returnedAt) || '—') + (item.returnedCount > 1 ? '（共退回 ' + item.returnedCount + ' 次）' : '') + (item.actor ? '　由 ' + item.actor : '')),
                React.createElement('div', { className: 'gicu-rework-r', key: 'r' }, '退回原因：' + (item.reason || '（后端未记录原因文本）')),
                item.dueAt ? React.createElement('div', { className: 'gicu-rework-d gicu-num', key: 'd' }, '整改截止 ' + (clockOf(item.dueAt) || textOf(item.dueAt))) : null,
                // 被督导催办过就写在脸上：改前「催办」只在督导端留一条记录，门店端什么都看不到 ——
                // 用户实测："催办按钮是摆设，门店端不显示"。这里读同一条单的 actions（不加后端字段）。
                item.remindCount > 0
                  ? React.createElement('div', { className: 'gicu-rework-c gicu-num', key: 'c' }, '被催办 ' + item.remindCount + ' 次 · 最近 ' + (clockOf(item.remindAt) || '—') + (item.remindBy ? ' · ' + item.remindBy : ''))
                  : null,
                React.createElement(
                  'button',
                  {
                    className: 'gicu-btn',
                    type: 'button',
                    key: 'b',
                    onClick: () => {
                      if (reworkOf === item.id) {
                        reworkState.setId('')
                        setLocalError('已取消整改回拍。')
                        return
                      }
                      reworkState.setId(item.id)
                      setLocalError('正在整改回拍 ' + item.short + '：拍一张整改后的照片、写一句说明，提交后新单会标「整改回拍自 ' + item.short + '」，督导端能看到来源。')
                    },
                  },
                  reworkOf === item.id ? '取消整改回拍' : '整改后重新提交',
                ),
              ]),
            ),
          ]),
        )
      }
      formChildren.push(
        React.createElement(
          'div',
          { className: 'gicu-row', key: 'store' },
          React.createElement('span', { className: 'gicu-lbl' }, '门店'),
          storeField,
        ),
      )
      formChildren.push(
        React.createElement(
          'div',
          { className: 'gicu-row', key: 'note-lbl' },
          React.createElement('span', { className: 'gicu-lbl' }, '一句话说明'),
          React.createElement('span', { className: 'gicu-count gicu-num' }, noteLen + ' / ' + NOTE_MAX + ' 字'),
        ),
      )
      formChildren.push(
        React.createElement('textarea', {
          key: 'note',
          className: 'gicu-note',
          value: note,
          maxLength: NOTE_MAX,
          placeholder: '例：接班时拍的，后门那堆货还没清，上一个班次留下的',
          onChange: (event) => setNote(event && event.target ? event.target.value : ''),
        }),
      )
      if (localError) formChildren.push(React.createElement('div', { className: 'gicu-line ' + localNoticeKind(localError), key: 'local' }, localError))
      if (busyReason) formChildren.push(React.createElement('div', { className: 'gicu-line warn', key: 'busy-store' }, busyReason))
      if (reworkOf) formChildren.push(React.createElement('div', { className: 'gicu-line ok', key: 'rework-banner' }, '正在整改回拍 ' + shortNo(reworkOf) + '：提交后新单会标注「整改回拍自 ' + shortNo(reworkOf) + '」，督导端能看到来源。'))
      formChildren.push(
        React.createElement(
          'div',
          { className: 'gicu-actions', key: 'actions' },
          React.createElement('button', { className: 'gicu-btn', type: 'button', disabled: sampleBusy || running, onClick: loadSample }, sampleBusy ? '载入中…' : '载入示例'),
          React.createElement('span', { className: 'gicu-grow' }),
          React.createElement('button', { className: 'gicu-btn primary', type: 'button', disabled: !canSubmit, onClick: doSubmit }, running ? '正在分析…' : '提交并分析'),
        ),
      )
      formChildren.push(stateNode)

      return React.createElement(
        'div',
        { className: 'gicu-root' },
        React.createElement('div', { className: 'gicu-screen' }, [
          React.createElement('section', { className: 'gicu-hero', key: 'hero' }, heroChildren),
          React.createElement('section', { className: 'gicu-form gicu-scroll', key: 'form' }, formChildren),
        ]),
      )
    }

    // ── 挂载 ────────────────────────────────────────────────────────────────
    function apply(ctx) {
      const styleEl = document.createElement('style')
      styleEl.setAttribute('data-plugin', 'gaia-inspection-capture-ui')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)

      exposeChannels()

      // 【真机实测必须项】不声明 exports.inject 时宿主 apply 得早，`ctx.get('slots')` 会是 undefined，
      // 本包会一路 return：输入区那枚「门店自查采集入口」根本不会出现。
      const slots = (ctx && ctx.slots) || (ctx && typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      if (!slots) {
        console.warn('[gaia-inspection-capture-ui] 宿主未提供 slots 服务，会话侧两枚采集入口均未挂载')
        return
      }

      // ① 输入区常驻：1 枚「门店自查采集入口」（视图标签段由督导包外壳统一提供，本包不再重复）。
      ctx.effect(
        () => slots.inject(DOCK_SLOT, () => slots.register({ name: DOCK_SLOT, id: 'gaia-inspection-capture-ui', order: 42, label: CAPABILITY_CAPTURE }, CaptureDock)),
        'gaia-inspection-capture-ui: input dock entry',
      )

      // ② 会话 header 也放一枚同样的入口，便于在会话顶部一步打开。
      ctx.effect(
        () => slots.inject(HEADER_SLOT, () => slots.register({ name: HEADER_SLOT, id: 'gaia-inspection-capture-open', order: 46, label: CAPABILITY_CAPTURE }, CaptureOpenButton)),
        'gaia-inspection-capture-ui: header entry',
      )

      // ③ 屏 A 不再注册 shell.overlay：店长端屏（CaptureScreen）由督导包主面板（main key = gaia-inspection）
      //    通过 __gaia_inspection_ui__.getScreen() 取组件内嵌；本包不注册 sidebar.panellist / main。
      shellBridge.sync()
      pullSnapshot()
    }

    /** 声明式依赖：slots 必给；layout 供「打开外壳面板」用（拿不到时降级为内联提示）。 */
    exports.inject = ['slots', 'layout']
    exports.apply = apply
    exports.__test = {
      CAPABILITY_CAPTURE,
      CAPABILITY_ROLE,
      VIEW_CHANNEL,
      UI_CHANNEL,
      SHELL_CHANNEL,
      SHELL_MISSING_NOTICE,
      MAX_PHOTOS,
      MAX_PHOTO_BYTES,
      NOTE_MAX,
      DEMO_NOTICE,
      OFFLINE_NOTICE,
      STATE_EMPTY,
      STATE_READY,
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
      pendingReworkOf,
      offlineEdge,
      localView,
      submitState,
      reworkState,
      snapshotSource,
      pullSnapshot,
      submitSelfCheck,
      exposeChannels,
      openCaptureScreen,
      shellBridge,
      uiChannel,
      CaptureScreen,
      CaptureDock,
      CaptureOpenButton,
      hasReact: React !== null,
    }
    return module.exports
  },
})
