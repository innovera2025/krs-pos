/* @ds-bundle: {"format":3,"namespace":"PguardDesignSystem_019e2c","components":[{"name":"Avatar","sourcePath":"components/data/Avatar.jsx"},{"name":"Badge","sourcePath":"components/data/Badge.jsx"},{"name":"KpiGrid","sourcePath":"components/data/KpiCard.jsx"},{"name":"KpiCard","sourcePath":"components/data/KpiCard.jsx"},{"name":"Panel","sourcePath":"components/data/Panel.jsx"},{"name":"PanelHead","sourcePath":"components/data/Panel.jsx"},{"name":"PanelBody","sourcePath":"components/data/Panel.jsx"},{"name":"Table","sourcePath":"components/data/Table.jsx"},{"name":"Th","sourcePath":"components/data/Table.jsx"},{"name":"Td","sourcePath":"components/data/Table.jsx"},{"name":"Tr","sourcePath":"components/data/Table.jsx"},{"name":"Tabs","sourcePath":"components/data/Tabs.jsx"},{"name":"Tab","sourcePath":"components/data/Tabs.jsx"},{"name":"Modal","sourcePath":"components/feedback/Modal.jsx"},{"name":"Button","sourcePath":"components/forms/Button.jsx"},{"name":"Chip","sourcePath":"components/forms/Chip.jsx"},{"name":"Input","sourcePath":"components/forms/Input.jsx"},{"name":"Textarea","sourcePath":"components/forms/Input.jsx"},{"name":"Select","sourcePath":"components/forms/Input.jsx"},{"name":"Field","sourcePath":"components/forms/Input.jsx"},{"name":"SearchField","sourcePath":"components/forms/SearchField.jsx"},{"name":"Toggle","sourcePath":"components/forms/Toggle.jsx"}],"sourceHashes":{"components/data/Avatar.jsx":"091462ea62a9","components/data/Badge.jsx":"8e9a73e9500d","components/data/KpiCard.jsx":"0d556a17ffd2","components/data/Panel.jsx":"9b809d4b4429","components/data/Table.jsx":"20e5ef163c3b","components/data/Tabs.jsx":"3bcc3ab7abff","components/feedback/Modal.jsx":"6df19b431b0c","components/forms/Button.jsx":"2a7984a3f3f5","components/forms/Chip.jsx":"0b679c0ab3f4","components/forms/Input.jsx":"325f48ea6183","components/forms/SearchField.jsx":"2fa06c8ac0ca","components/forms/Toggle.jsx":"bcaf4132ccdf","ui_kits/web-admin/dashboard.jsx":"e4c3c32a8015","ui_kits/web-admin/data.jsx":"d66c6af72716","ui_kits/web-admin/guards.jsx":"e2960c81cece","ui_kits/web-admin/login.jsx":"19f19eafae3a","ui_kits/web-admin/map.jsx":"f57d109d128e","ui_kits/web-admin/shell.jsx":"12c28de7afd1"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.PguardDesignSystem_019e2c = window.PguardDesignSystem_019e2c || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/data/Avatar.jsx
try { (() => {
/** pguard Avatar — green-tinted initials circle (inverts in dark) with an optional
 * surface-ringed live-status dot. */

const CSS = `
.pg-av{position:relative;display:inline-flex;flex:none;align-items:center;justify-content:center;
  border-radius:var(--r-full);background:var(--green-100);color:var(--green-800);
  font-family:var(--font-latin);font-weight:600;}
[data-theme="dark"] .pg-av{background:var(--green-800);color:var(--green-100);}
.pg-av--sm{width:30px;height:30px;font-size:12px;}
.pg-av--md{width:36px;height:36px;font-size:13px;}
.pg-av--lg{width:42px;height:42px;font-size:15px;}
.pg-av__ind{position:absolute;bottom:-1px;right:-1px;width:11px;height:11px;border-radius:var(--r-full);
  border:2px solid var(--bg-surface);}
`;
if (typeof document !== "undefined" && !document.getElementById("pg-av-css")) {
  const s = document.createElement("style");
  s.id = "pg-av-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}
const STATUS = {
  active: "var(--status-active)",
  working: "var(--status-working)",
  offline: "var(--status-offline)"
};
function Avatar({
  children,
  status,
  size = "md",
  className = ""
}) {
  return /*#__PURE__*/React.createElement("span", {
    className: `pg-av pg-av--${size} ${className}`.trim()
  }, children, status ? /*#__PURE__*/React.createElement("span", {
    className: "pg-av__ind",
    style: {
      background: STATUS[status]
    }
  }) : null);
}
Object.assign(__ds_scope, { Avatar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/Avatar.jsx", error: String((e && e.message) || e) }); }

// components/data/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** pguard Badge — `.bdg` 11.5px pill. Tones map to semantic bg/fg pairs. */

const CSS = `
.pg-bdg{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;border-radius:var(--r-full);
  padding:4px 10px;font-family:var(--font-latin);font-size:11.5px;font-weight:600;letter-spacing:.01em;}
.pg-bdg--green{background:var(--success-bg);color:var(--success);}
.pg-bdg--amber{background:var(--warning-bg);color:var(--amber-700);}
[data-theme="dark"] .pg-bdg--amber{color:var(--amber-300);}
.pg-bdg--red{background:var(--danger-bg);color:var(--danger);}
.pg-bdg--blue{background:var(--info-bg);color:var(--info);}
.pg-bdg--gray{background:var(--bg-sunken);color:var(--text-muted);}
.pg-bdg__dot{width:7px;height:7px;border-radius:var(--r-full);}
`;
if (typeof document !== "undefined" && !document.getElementById("pg-bdg-css")) {
  const s = document.createElement("style");
  s.id = "pg-bdg-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}
function Badge({
  tone = "gray",
  dot,
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("span", _extends({
    className: `pg-bdg pg-bdg--${tone} ${className}`.trim()
  }, props), dot ? /*#__PURE__*/React.createElement("span", {
    className: "pg-bdg__dot",
    style: {
      background: dot
    }
  }) : null, children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/Badge.jsx", error: String((e && e.message) || e) }); }

// components/data/KpiCard.jsx
try { (() => {
/** pguard KPI — `.kpi-grid` hairline-structured 4-up strip + `.kpi` number-led editorial
 * cell (mono value with tabular numerals, mono delta colored by direction). */

const CSS = `
.pg-kpi-grid{display:grid;grid-template-columns:repeat(2,1fr);overflow:hidden;
  border-radius:var(--r-lg);border:1px solid var(--border);background:var(--bg-surface);}
@media(min-width:1101px){.pg-kpi-grid{grid-template-columns:repeat(4,1fr);}}
.pg-kpi{border-left:1px solid var(--border);padding:18px 20px;}
.pg-kpi:first-child{border-left:0;}
.pg-kpi__top{display:flex;align-items:center;gap:8px;}
.pg-kpi__ic{display:flex;width:22px;height:22px;align-items:center;justify-content:center;color:var(--text-faint);}
.pg-kpi__ic svg{width:16px;height:16px;}
.pg-kpi__label{font-family:var(--font-latin);font-size:12px;font-weight:600;text-transform:uppercase;
  letter-spacing:.04em;color:var(--text-faint);}
.pg-kpi__delta{margin-left:auto;font-family:var(--font-mono);font-size:12px;font-weight:600;}
.pg-kpi__delta--up{color:var(--success);}
.pg-kpi__delta--down{color:var(--danger);}
.pg-kpi__value{margin:16px 0 3px;font-family:var(--font-mono);font-size:30px;font-weight:600;
  letter-spacing:-0.02em;color:var(--text-strong);font-variant-numeric:tabular-nums;}
.pg-kpi__cap{font-size:13px;color:var(--text-muted);}
`;
if (typeof document !== "undefined" && !document.getElementById("pg-kpi-css")) {
  const s = document.createElement("style");
  s.id = "pg-kpi-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}
function KpiGrid({
  className = "",
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: `pg-kpi-grid ${className}`.trim()
  }, children);
}
function KpiCard({
  icon,
  label,
  value,
  caption,
  delta,
  deltaDirection = "up",
  className = ""
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: `pg-kpi ${className}`.trim()
  }, /*#__PURE__*/React.createElement("div", {
    className: "pg-kpi__top"
  }, icon ? /*#__PURE__*/React.createElement("span", {
    className: "pg-kpi__ic"
  }, icon) : null, /*#__PURE__*/React.createElement("span", {
    className: "pg-kpi__label"
  }, label), delta !== undefined ? /*#__PURE__*/React.createElement("span", {
    className: `pg-kpi__delta pg-kpi__delta--${deltaDirection}`
  }, delta) : null), /*#__PURE__*/React.createElement("div", {
    className: "pg-kpi__value"
  }, value), caption ? /*#__PURE__*/React.createElement("div", {
    className: "pg-kpi__cap"
  }, caption) : null);
}
Object.assign(__ds_scope, { KpiGrid, KpiCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/KpiCard.jsx", error: String((e && e.message) || e) }); }

// components/data/Panel.jsx
try { (() => {
/** pguard Panel — `.panel` hairline-bordered surface card; structure from borders, not glow.
 * PanelHead (16×20 padded header with bottom hairline) + PanelBody (18×20 padding). */

const CSS = `
.pg-panel{border-radius:var(--r-lg);border:1px solid var(--border);background:var(--bg-surface);}
.pg-panel-head{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--border);padding:16px 20px;}
.pg-panel-head__title{margin:0;font-size:16px;font-weight:600;color:var(--text-strong);}
.pg-panel-head__sub{margin:0;font-size:12.5px;color:var(--text-muted);}
.pg-panel-head__actions{margin-left:auto;display:flex;align-items:center;gap:10px;}
.pg-panel-body{padding:18px 20px;}
`;
if (typeof document !== "undefined" && !document.getElementById("pg-panel-css")) {
  const s = document.createElement("style");
  s.id = "pg-panel-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}
function Panel({
  className = "",
  children
}) {
  return /*#__PURE__*/React.createElement("section", {
    className: `pg-panel ${className}`.trim()
  }, children);
}
function PanelHead({
  title,
  sub,
  className = "",
  children
}) {
  return /*#__PURE__*/React.createElement("header", {
    className: `pg-panel-head ${className}`.trim()
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("h3", {
    className: "pg-panel-head__title"
  }, title), sub ? /*#__PURE__*/React.createElement("p", {
    className: "pg-panel-head__sub"
  }, sub) : null), children ? /*#__PURE__*/React.createElement("div", {
    className: "pg-panel-head__actions"
  }, children) : null);
}
function PanelBody({
  className = "",
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: `pg-panel-body ${className}`.trim()
  }, children);
}
Object.assign(__ds_scope, { Panel, PanelHead, PanelBody });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/Panel.jsx", error: String((e && e.message) || e) }); }

// components/data/Table.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** pguard Table — `.tbl` in a horizontal-overflow guard. Th = uppercase tracked header
 * above a hairline; Td = 14×16 cells; Tr = clickable row, sunken on hover. */

const CSS = `
.pg-table-wrap{overflow-x:auto;}
.pg-tbl{width:100%;border-collapse:collapse;}
.pg-tbl th{white-space:nowrap;border-bottom:1px solid var(--border);padding:12px 16px;text-align:left;
  font-family:var(--font-latin);font-size:11.5px;font-weight:600;text-transform:uppercase;
  letter-spacing:.04em;color:var(--text-faint);}
.pg-tbl td{border-bottom:1px solid var(--border);padding:14px 16px;vertical-align:middle;
  font-size:14px;color:var(--text);}
.pg-tbl tbody tr{cursor:pointer;transition:background .12s;}
.pg-tbl tbody tr:hover{background:var(--bg-sunken);}
.pg-tbl tbody tr:last-child td{border-bottom:0;}
`;
if (typeof document !== "undefined" && !document.getElementById("pg-tbl-css")) {
  const s = document.createElement("style");
  s.id = "pg-tbl-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}
function Table({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "pg-table-wrap"
  }, /*#__PURE__*/React.createElement("table", _extends({
    className: `pg-tbl ${className}`.trim()
  }, props), children));
}
function Th({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("th", _extends({
    className: className
  }, props), children);
}
function Td({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("td", _extends({
    className: className
  }, props), children);
}
function Tr({
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("tr", _extends({
    className: className
  }, props), children);
}
Object.assign(__ds_scope, { Table, Th, Td, Tr });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/Table.jsx", error: String((e && e.message) || e) }); }

// components/data/Tabs.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** pguard Tabs — `.tabs` underline row + `.tab` with an optional mono counter pill. */

const CSS = `
.pg-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);}
.pg-tab{display:inline-flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:-1px;
  border:0;border-bottom:2px solid transparent;background:none;padding:11px 16px;
  font-family:var(--font-thai);font-size:14px;font-weight:600;color:var(--text-muted);
  transition:color .15s,border-color .15s;}
.pg-tab:hover{color:var(--text);}
.pg-tab--on{border-bottom-color:var(--brand-int);color:var(--brand-int);}
.pg-tab__pill{border-radius:var(--r-full);padding:1px 7px;font-family:var(--font-mono);font-size:11px;
  background:var(--bg-sunken);color:var(--text-muted);}
.pg-tab--on .pg-tab__pill{background:var(--green-50);color:var(--brand-int);}
[data-theme="dark"] .pg-tab--on .pg-tab__pill{background:rgba(47,192,137,.15);}
`;
if (typeof document !== "undefined" && !document.getElementById("pg-tabs-css")) {
  const s = document.createElement("style");
  s.id = "pg-tabs-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}
function Tabs({
  className = "",
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    role: "tablist",
    className: `pg-tabs ${className}`.trim()
  }, children);
}
function Tab({
  active,
  count,
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    role: "tab",
    "aria-selected": active || undefined,
    className: `pg-tab ${active ? "pg-tab--on" : ""} ${className}`.trim()
  }, props), children, count !== undefined ? /*#__PURE__*/React.createElement("span", {
    className: "pg-tab__pill"
  }, count) : null);
}
Object.assign(__ds_scope, { Tabs, Tab });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/data/Tabs.jsx", error: String((e && e.message) || e) }); }

// components/feedback/Modal.jsx
try { (() => {
/** pguard Modal — `.overlay` blurred green-tinted scrim + `.modal` (520 / lg 680) with
 * head/body/foot hairlines. Closes on Escape and scrim click. */

const CSS = `
@keyframes pg-fade-in{from{opacity:0}}
@keyframes pg-modal-in{from{opacity:0;transform:scale(.96)}}
.pg-overlay{position:fixed;inset:0;z-index:100;display:flex;align-items:center;justify-content:center;
  padding:24px;background:rgba(8,20,15,.5);backdrop-filter:blur(3px);animation:pg-fade-in .2s ease;}
.pg-modal{display:flex;max-height:88vh;width:520px;max-width:100%;flex-direction:column;overflow:hidden;
  border-radius:var(--r-xl);border:1px solid var(--border);background:var(--bg-surface);
  box-shadow:var(--sh-xl);animation:pg-modal-in .2s ease;}
.pg-modal--lg{width:680px;}
.pg-modal__head{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--border);padding:18px 22px;}
.pg-modal__title{margin:0;font-size:18px;font-weight:600;color:var(--text-strong);}
.pg-modal__x{margin-left:auto;display:flex;width:34px;height:34px;cursor:pointer;align-items:center;
  justify-content:center;border:0;background:none;border-radius:var(--r-lg);color:var(--text-faint);}
.pg-modal__x:hover{background:var(--bg-sunken);}
.pg-modal__body{overflow-y:auto;padding:22px;}
.pg-modal__foot{display:flex;justify-content:flex-end;gap:10px;border-top:1px solid var(--border);padding:16px 22px;}
`;
if (typeof document !== "undefined" && !document.getElementById("pg-modal-css")) {
  const s = document.createElement("style");
  s.id = "pg-modal-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}
function Modal({
  open,
  onClose,
  title,
  size = "md",
  footer,
  children,
  className = ""
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = e => {
      if (e.key === "Escape") onClose && onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return /*#__PURE__*/React.createElement("div", {
    className: "pg-overlay",
    onClick: onClose
  }, /*#__PURE__*/React.createElement("div", {
    role: "dialog",
    "aria-modal": "true",
    className: `pg-modal ${size === "lg" ? "pg-modal--lg" : ""} ${className}`.trim(),
    onClick: e => e.stopPropagation()
  }, title !== undefined ? /*#__PURE__*/React.createElement("header", {
    className: "pg-modal__head"
  }, /*#__PURE__*/React.createElement("h3", {
    className: "pg-modal__title"
  }, title), /*#__PURE__*/React.createElement("button", {
    type: "button",
    "aria-label": "close",
    onClick: onClose,
    className: "pg-modal__x"
  }, /*#__PURE__*/React.createElement("svg", {
    width: "18",
    height: "18",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "2",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true
  }, /*#__PURE__*/React.createElement("path", {
    d: "M18 6 6 18M6 6l12 12"
  })))) : null, /*#__PURE__*/React.createElement("div", {
    className: "pg-modal__body"
  }, children), footer ? /*#__PURE__*/React.createElement("footer", {
    className: "pg-modal__foot"
  }, footer) : null));
}
Object.assign(__ds_scope, { Modal });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/feedback/Modal.jsx", error: String((e && e.message) || e) }); }

// components/forms/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * pguard Button — the design's `.btn`. Exact paddings/colors from the hi-fi sheet.
 * Default size keeps the 44px min touch target; `sm` is the desktop-dense variant.
 */

const CSS = `
.pg-btn{display:inline-flex;cursor:pointer;align-items:center;justify-content:center;gap:7px;
  white-space:nowrap;border-radius:var(--r-md);border:1px solid transparent;font-family:var(--font-thai);
  font-weight:600;transition:background .15s,transform .15s,box-shadow .15s;}
.pg-btn:active{transform:translateY(1px);}
.pg-btn:disabled{pointer-events:none;opacity:.5;}
.pg-btn--md{min-height:44px;padding:10px 16px;font-size:14px;}
.pg-btn--sm{padding:7px 12px;font-size:13px;}
.pg-btn--icon{width:36px;height:36px;padding:8px;}
.pg-btn--primary{background:var(--brand-int);color:#fff;}
.pg-btn--primary:hover{background:var(--brand-int-hover);}
.pg-btn--secondary{background:var(--bg-surface);color:var(--text-strong);border-color:var(--border-strong);}
.pg-btn--secondary:hover{background:var(--bg-sunken);}
.pg-btn--ghost{background:transparent;color:var(--brand-int);}
.pg-btn--ghost:hover{background:var(--bg-sunken);}
.pg-btn--accent{background:var(--accent);color:var(--on-amber);}
.pg-btn--accent:hover{background:var(--accent-hover);}
.pg-btn--danger{background:var(--danger);color:#fff;}
.pg-btn--danger:hover{opacity:.9;}
.pg-btn--danger-ghost{background:transparent;color:var(--danger);border-color:rgba(229,72,77,.35);}
.pg-btn--danger-ghost:hover{background:var(--danger-bg);}
.pg-btn:focus-visible{outline:none;box-shadow:0 0 0 4px var(--focus-ring);}
`;
if (typeof document !== "undefined" && !document.getElementById("pg-btn-css")) {
  const s = document.createElement("style");
  s.id = "pg-btn-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}
function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    className: `pg-btn pg-btn--${size} pg-btn--${variant} ${className}`.trim()
  }, props), children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Button.jsx", error: String((e && e.message) || e) }); }

// components/forms/Chip.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** pguard Chip — `.chip-f` filter pill; active = solid green-900 (dark: brand-int). */

const CSS = `
.pg-chip{display:inline-flex;cursor:pointer;align-items:center;gap:7px;border-radius:var(--r-full);
  border:1px solid var(--border);background:var(--bg-surface);padding:7px 13px;font-family:var(--font-thai);
  font-size:13px;font-weight:500;color:var(--text-muted);transition:background .15s,color .15s,border-color .15s;}
.pg-chip:hover{background:var(--bg-sunken);}
.pg-chip--on{border-color:var(--green-900);background:var(--green-900);color:#fff;}
[data-theme="dark"] .pg-chip--on{border-color:var(--brand-int);background:var(--brand-int);color:var(--text-on-brand);}
.pg-chip--on:hover{background:var(--green-900);}
[data-theme="dark"] .pg-chip--on:hover{background:var(--brand-int);}
.pg-chip__dot{width:7px;height:7px;border-radius:var(--r-full);}
`;
if (typeof document !== "undefined" && !document.getElementById("pg-chip-css")) {
  const s = document.createElement("style");
  s.id = "pg-chip-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}
function Chip({
  active,
  dot,
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    "aria-pressed": active || undefined,
    className: `pg-chip ${active ? "pg-chip--on" : ""} ${className}`.trim()
  }, props), dot ? /*#__PURE__*/React.createElement("span", {
    className: "pg-chip__dot",
    style: {
      background: dot
    }
  }) : null, children);
}
Object.assign(__ds_scope, { Chip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Chip.jsx", error: String((e && e.message) || e) }); }

// components/forms/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * pguard form fields — `.input` (14.5px, 1.5px border, brand-int focus with the 4px glow),
 * `.field` label/hint wrapper, plus Textarea and Select sharing the same field styling.
 */

const CSS = `
.pg-input{width:100%;border-radius:var(--r-md);border:1.5px solid var(--border-strong);
  background:var(--bg-surface);padding:11px 13px;font-family:var(--font-thai);font-size:14.5px;
  color:var(--text-strong);transition:border-color .15s,box-shadow .15s;outline:none;}
.pg-input::placeholder{color:var(--text-faint);}
.pg-input:focus{border-color:var(--brand-int);box-shadow:0 0 0 4px var(--focus-ring);}
.pg-input:disabled{cursor:not-allowed;opacity:.6;}
.pg-input--err{border-color:var(--danger);}
.pg-input--err:focus{border-color:var(--danger);box-shadow:0 0 0 4px var(--danger-bg);}
.pg-textarea{min-height:96px;resize:vertical;}
.pg-field{margin-bottom:16px;}
.pg-field__label{display:block;margin-bottom:7px;font-size:13px;font-weight:600;color:var(--text);}
.pg-field__req{color:var(--danger);}
.pg-field__hint{margin:6px 0 0;font-size:12px;color:var(--text-muted);}
.pg-field__err{margin:6px 0 0;font-size:12px;color:var(--danger);}
`;
if (typeof document !== "undefined" && !document.getElementById("pg-input-css")) {
  const s = document.createElement("style");
  s.id = "pg-input-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}
function Input({
  error,
  className = "",
  ...props
}) {
  return /*#__PURE__*/React.createElement("input", _extends({
    "aria-invalid": error || undefined,
    className: `pg-input ${error ? "pg-input--err" : ""} ${className}`.trim()
  }, props));
}
function Textarea({
  error,
  className = "",
  ...props
}) {
  return /*#__PURE__*/React.createElement("textarea", _extends({
    "aria-invalid": error || undefined,
    className: `pg-input pg-textarea ${error ? "pg-input--err" : ""} ${className}`.trim()
  }, props));
}
function Select({
  error,
  className = "",
  children,
  ...props
}) {
  return /*#__PURE__*/React.createElement("select", _extends({
    "aria-invalid": error || undefined,
    className: `pg-input ${error ? "pg-input--err" : ""} ${className}`.trim()
  }, props), children);
}
function Field({
  label,
  required,
  hint,
  error,
  className = "",
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: `pg-field ${className}`.trim()
  }, label ? /*#__PURE__*/React.createElement("label", {
    className: "pg-field__label"
  }, label, required ? /*#__PURE__*/React.createElement("span", {
    className: "pg-field__req"
  }, " *") : null) : null, children, error ? /*#__PURE__*/React.createElement("p", {
    className: "pg-field__err"
  }, error) : hint ? /*#__PURE__*/React.createElement("p", {
    className: "pg-field__hint"
  }, hint) : null);
}
Object.assign(__ds_scope, { Input, Textarea, Select, Field });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Input.jsx", error: String((e && e.message) || e) }); }

// components/forms/SearchField.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/** pguard SearchField — `.search` sunken pill (260px) / `.search-sm` (220px) with a
 * leading search glyph (Lucide "search"). */

const CSS = `
.pg-search{display:inline-flex;align-items:center;border-radius:var(--r-md);
  border:1px solid var(--border);color:var(--text-faint);}
.pg-search--md{width:260px;gap:9px;background:var(--bg-sunken);padding:8px 13px;}
.pg-search--sm{width:220px;gap:8px;background:var(--bg-surface);padding:7px 12px;}
.pg-search input{width:100%;border:0;background:transparent;font-family:var(--font-thai);
  color:var(--text-strong);outline:none;}
.pg-search input::placeholder{color:var(--text-faint);}
.pg-search--md input{font-size:14px;}
.pg-search--sm input{font-size:13.5px;}
.pg-search svg{flex:none;}
`;
if (typeof document !== "undefined" && !document.getElementById("pg-search-css")) {
  const s = document.createElement("style");
  s.id = "pg-search-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}
const SearchIcon = /*#__PURE__*/React.createElement("svg", {
  width: "16",
  height: "16",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "2",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true
}, /*#__PURE__*/React.createElement("circle", {
  cx: "11",
  cy: "11",
  r: "8"
}), /*#__PURE__*/React.createElement("path", {
  d: "m21 21-4.3-4.3"
}));
function SearchField({
  size = "md",
  className = "",
  ...props
}) {
  return /*#__PURE__*/React.createElement("label", {
    className: `pg-search pg-search--${size} ${className}`.trim()
  }, SearchIcon, /*#__PURE__*/React.createElement("input", _extends({
    type: "search"
  }, props)));
}
Object.assign(__ds_scope, { SearchField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/SearchField.jsx", error: String((e && e.message) || e) }); }

// components/forms/Toggle.jsx
try { (() => {
/** pguard Toggle — `.tgl` 44×26 switch, n-300 off / brand-int on, 20px travelling knob. */

const CSS = `
.pg-tgl{position:relative;height:26px;width:44px;flex:none;cursor:pointer;border:none;
  border-radius:var(--r-full);transition:background .2s;padding:0;}
.pg-tgl:disabled{cursor:not-allowed;opacity:.5;}
.pg-tgl--on{background:var(--brand-int);}
.pg-tgl--off{background:var(--n-300);}
.pg-tgl__knob{position:absolute;top:3px;width:20px;height:20px;border-radius:var(--r-full);
  background:#fff;box-shadow:var(--sh-xs);transition:left .2s;}
.pg-tgl--on .pg-tgl__knob{left:21px;}
.pg-tgl--off .pg-tgl__knob{left:3px;}
`;
if (typeof document !== "undefined" && !document.getElementById("pg-tgl-css")) {
  const s = document.createElement("style");
  s.id = "pg-tgl-css";
  s.textContent = CSS;
  document.head.appendChild(s);
}
function Toggle({
  checked,
  onChange,
  disabled,
  className = "",
  ...aria
}) {
  return /*#__PURE__*/React.createElement("button", {
    type: "button",
    role: "switch",
    "aria-checked": checked,
    "aria-label": aria["aria-label"],
    disabled: disabled,
    onClick: () => onChange && onChange(!checked),
    className: `pg-tgl ${checked ? "pg-tgl--on" : "pg-tgl--off"} ${className}`.trim()
  }, /*#__PURE__*/React.createElement("span", {
    className: "pg-tgl__knob"
  }));
}
Object.assign(__ds_scope, { Toggle });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/forms/Toggle.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web-admin/dashboard.jsx
try { (() => {
// pguard web-admin — dashboard screen
(function () {
  function MiniMap({
    onOpen
  }) {
    const D = window.PG_DATA;
    return /*#__PURE__*/React.createElement("div", {
      className: "pg-minimap"
    }, Array.from({
      length: 42
    }).map((_, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "pg-minimap__cell"
    })), D.markers.map((m, i) => /*#__PURE__*/React.createElement("span", {
      key: i,
      className: "pg-minimap__dot",
      style: {
        left: m.x + "%",
        top: m.y + "%",
        background: `var(--status-${m.st})`
      },
      title: m.nm
    })));
  }
  function Dashboard({
    onNav
  }) {
    const {
      KpiGrid,
      KpiCard,
      Panel,
      PanelHead,
      PanelBody,
      Button,
      Avatar
    } = window.PG_NS;
    const {
      Icon
    } = window.Shell;
    const D = window.PG_DATA;
    return /*#__PURE__*/React.createElement("div", {
      className: "pg-page"
    }, /*#__PURE__*/React.createElement(KpiGrid, null, D.kpis.map(k => /*#__PURE__*/React.createElement(KpiCard, {
      key: k.label,
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: k.icon,
        size: 16
      }),
      label: k.label,
      value: k.value,
      delta: k.delta,
      deltaDirection: k.dir
    }))), /*#__PURE__*/React.createElement("div", {
      className: "pg-grid-2"
    }, /*#__PURE__*/React.createElement(Panel, null, /*#__PURE__*/React.createElement(PanelHead, {
      title: "\u0E41\u0E1C\u0E19\u0E17\u0E35\u0E48\u0E2A\u0E14",
      sub: "59 \u0E2D\u0E2D\u0E19\u0E44\u0E25\u0E19\u0E4C"
    }, /*#__PURE__*/React.createElement(Button, {
      variant: "ghost",
      size: "sm",
      onClick: () => onNav("map")
    }, "\u0E40\u0E1B\u0E34\u0E14\u0E40\u0E15\u0E47\u0E21\u0E08\u0E2D \u2192")), /*#__PURE__*/React.createElement(PanelBody, null, /*#__PURE__*/React.createElement(MiniMap, {
      onOpen: () => onNav("map")
    }))), /*#__PURE__*/React.createElement(Panel, null, /*#__PURE__*/React.createElement(PanelHead, {
      title: "\u0E41\u0E08\u0E49\u0E07\u0E40\u0E15\u0E37\u0E2D\u0E19"
    }), /*#__PURE__*/React.createElement(PanelBody, {
      className: "pg-alerts"
    }, D.alerts.map((a, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "pg-alert"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pg-alert__dot",
      style: {
        background: `var(--${a.tone === "red" ? "danger" : a.tone === "amber" ? "warning" : "info"})`
      }
    }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "pg-alert__t"
    }, a.title), /*#__PURE__*/React.createElement("div", {
      className: "pg-alert__s"
    }, a.sub))))))), /*#__PURE__*/React.createElement("div", {
      className: "pg-grid-2"
    }, /*#__PURE__*/React.createElement(Panel, null, /*#__PURE__*/React.createElement(PanelHead, {
      title: "\u0E23\u0E32\u0E22\u0E44\u0E14\u0E49 7 \u0E27\u0E31\u0E19\u0E25\u0E48\u0E32\u0E2A\u0E38\u0E14"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pg-mono-strong"
    }, "\u0E3F512K")), /*#__PURE__*/React.createElement(PanelBody, null, /*#__PURE__*/React.createElement("div", {
      className: "pg-bars"
    }, D.revenue7d.map(b => /*#__PURE__*/React.createElement("div", {
      key: b.d,
      className: "pg-bars__col"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-bars__track"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-bars__bar",
      style: {
        height: b.v + "%",
        background: b.peak ? "var(--accent)" : "var(--brand-int)"
      }
    })), /*#__PURE__*/React.createElement("span", {
      className: "pg-bars__lbl"
    }, b.d)))))), /*#__PURE__*/React.createElement(Panel, null, /*#__PURE__*/React.createElement(PanelHead, {
      title: "\u0E01\u0E34\u0E08\u0E01\u0E23\u0E23\u0E21\u0E25\u0E48\u0E32\u0E2A\u0E38\u0E14"
    }), /*#__PURE__*/React.createElement(PanelBody, {
      className: "pg-feed"
    }, D.feed.map((f, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "pg-feeditem"
    }, /*#__PURE__*/React.createElement(Avatar, {
      size: "sm"
    }, f.initials), /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0,
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-feeditem__t"
    }, f.text), /*#__PURE__*/React.createElement("div", {
      className: "pg-feeditem__time"
    }, f.time))))))));
  }
  window.Screens = window.Screens || {};
  window.Screens.Dashboard = Dashboard;
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web-admin/dashboard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web-admin/data.jsx
try { (() => {
// pguard web-admin — sample data (fake, for the interactive kit)
window.PG_DATA = {
  admin: {
    name: "วรรณา ส.",
    role: "Operations Lead",
    initials: "วร"
  },
  kpis: [{
    icon: "shield",
    label: "งานที่กำลังดำเนิน",
    value: "27",
    delta: "+12%",
    dir: "up"
  }, {
    icon: "radio",
    label: "เจ้าหน้าที่ออนไลน์",
    value: "59"
  }, {
    icon: "banknote",
    label: "รายได้วันนี้",
    value: "฿84.2K",
    delta: "+8%",
    dir: "up"
  }, {
    icon: "user-round-plus",
    label: "รออนุมัติ",
    value: "12"
  }],
  alerts: [{
    tone: "red",
    title: "เจ้าหน้าที่ขาดเช็คอิน 2 รอบ",
    sub: "BK-48280 · กิตติ ส. · โรงงาน ปทุม"
  }, {
    tone: "amber",
    title: "5 รายการรอคืนเงิน",
    sub: "รวม ฿4,280 · ดำเนินการในกระเป๋าเงิน"
  }, {
    tone: "blue",
    title: "ผู้สมัครใหม่ 3 คน",
    sub: "เอกสารครบ พร้อมตรวจสอบ"
  }],
  revenue7d: [{
    d: "จ",
    v: 62
  }, {
    d: "อ",
    v: 71
  }, {
    d: "พ",
    v: 68
  }, {
    d: "พฤ",
    v: 84
  }, {
    d: "ศ",
    v: 100,
    peak: true
  }, {
    d: "ส",
    v: 79
  }, {
    d: "อา",
    v: 88
  }],
  feed: [{
    initials: "สม",
    text: "สมชาย ก. เริ่มงาน BK-48280",
    time: "2 นาทีที่แล้ว"
  }, {
    initials: "ณฐ",
    text: "มอบหมาย ณัฐพล ว. → BK-48288",
    time: "8 นาทีที่แล้ว"
  }, {
    initials: "นภ",
    text: "นภาพร ส. ขอคืนเงิน BK-48291",
    time: "15 นาทีที่แล้ว"
  }, {
    initials: "ปร",
    text: "ประยุทธ ม. ออฟไลน์",
    time: "23 นาทีที่แล้ว"
  }],
  // Guard roster
  guards: [{
    id: "1000",
    nm: "ณัฐพล วงศ์ดี",
    st: "working",
    r: "4.9",
    jobs: 188,
    docs: "5/5",
    year: "2563"
  }, {
    id: "1001",
    nm: "สมชาย กิตติพงษ์",
    st: "active",
    r: "4.9",
    jobs: 142,
    docs: "5/5",
    year: "2564"
  }, {
    id: "1002",
    nm: "อนุชา ปัญญา",
    st: "active",
    r: "5.0",
    jobs: 210,
    docs: "5/5",
    year: "2562"
  }, {
    id: "1003",
    nm: "ธีรศักดิ์ มั่นคง",
    st: "working",
    r: "4.7",
    jobs: 64,
    docs: "warn",
    docLabel: "ใบอนุญาตใกล้หมด",
    year: "2565"
  }, {
    id: "1004",
    nm: "พิชัย สมบูรณ์",
    st: "active",
    r: "4.9",
    jobs: 121,
    docs: "5/5",
    year: "2563"
  }, {
    id: "1005",
    nm: "วีระ ทองดี",
    st: "offline",
    r: "4.6",
    jobs: 54,
    docs: "warn",
    docLabel: "ใบตรวจประวัติหมดอายุ",
    year: "2566"
  }, {
    id: "1006",
    nm: "สุริยา จันทร์",
    st: "active",
    r: "4.9",
    jobs: 166,
    docs: "5/5",
    year: "2562"
  }, {
    id: "1007",
    nm: "มานพ บุญมา",
    st: "working",
    r: "5.0",
    jobs: 188,
    docs: "5/5",
    year: "2561"
  }, {
    id: "1008",
    nm: "เอกชัย รุ่งเรือง",
    st: "active",
    r: "4.8",
    jobs: 97,
    docs: "5/5",
    year: "2564"
  }, {
    id: "1009",
    nm: "ชัยวัฒน์ แก้วใส",
    st: "offline",
    r: "4.4",
    jobs: 38,
    docs: "5/5",
    year: "2566"
  }],
  statusLabel: {
    active: "ออนไลน์",
    working: "กำลังทำงาน",
    offline: "ออฟไลน์"
  },
  statusTone: {
    active: "green",
    working: "amber",
    offline: "gray"
  },
  // Live map markers (percent positions)
  markers: [{
    x: 22,
    y: 34,
    st: "active",
    nm: "สมชาย ก.",
    job: "BK-48280"
  }, {
    x: 14,
    y: 58,
    st: "working",
    nm: "ธีรศักดิ์ ม.",
    job: "BK-48272"
  }, {
    x: 41,
    y: 62,
    st: "working",
    nm: "อนุชา ป.",
    job: "BK-48288"
  }, {
    x: 52,
    y: 40,
    st: "active",
    nm: "พิชัย ส.",
    job: "—"
  }, {
    x: 34,
    y: 76,
    st: "active",
    nm: "สุริยา จ.",
    job: "BK-48290"
  }, {
    x: 78,
    y: 30,
    st: "offline",
    nm: "วีระ ท.",
    job: "—"
  }, {
    x: 64,
    y: 66,
    st: "working",
    nm: "มานพ บ.",
    job: "BK-48291"
  }]
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web-admin/data.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web-admin/guards.jsx
try { (() => {
// pguard web-admin — guards roster screen
(function () {
  const {
    useState
  } = React;
  function Guards() {
    const {
      KpiGrid,
      KpiCard,
      Panel,
      Button,
      SearchField,
      Chip,
      Tabs,
      Tab,
      Table,
      Th,
      Td,
      Tr,
      Badge,
      Avatar,
      Modal,
      Field,
      Input
    } = window.PG_NS;
    const {
      Icon
    } = window.Shell;
    const D = window.PG_DATA;
    const [filter, setFilter] = useState(0);
    const [tab, setTab] = useState(0);
    const [sel, setSel] = useState(null);
    const FILTERS = [["all", "ทั้งหมด"], ["active", "ออนไลน์"], ["working", "กำลังทำงาน"], ["offline", "ออฟไลน์"]];
    const rows = D.guards.filter(g => filter === 0 || g.st === FILTERS[filter][0]);
    return /*#__PURE__*/React.createElement("div", {
      className: "pg-page"
    }, /*#__PURE__*/React.createElement(KpiGrid, null, /*#__PURE__*/React.createElement(KpiCard, {
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: "radio",
        size: 16
      }),
      label: "\u0E2D\u0E2D\u0E19\u0E44\u0E25\u0E19\u0E4C\u0E15\u0E2D\u0E19\u0E19\u0E35\u0E49",
      value: "59"
    }), /*#__PURE__*/React.createElement(KpiCard, {
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: "shield",
        size: 16
      }),
      label: "\u0E01\u0E33\u0E25\u0E31\u0E07\u0E17\u0E33\u0E07\u0E32\u0E19",
      value: "21"
    }), /*#__PURE__*/React.createElement(KpiCard, {
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: "star",
        size: 16
      }),
      label: "\u0E04\u0E30\u0E41\u0E19\u0E19\u0E40\u0E09\u0E25\u0E35\u0E48\u0E22\u0E17\u0E35\u0E21",
      value: "4.87"
    }), /*#__PURE__*/React.createElement(KpiCard, {
      icon: /*#__PURE__*/React.createElement(Icon, {
        name: "clock",
        size: 16
      }),
      label: "\u0E40\u0E2D\u0E01\u0E2A\u0E32\u0E23\u0E43\u0E01\u0E25\u0E49\u0E2B\u0E21\u0E14\u0E2D\u0E32\u0E22\u0E38",
      value: "7",
      delta: "\u0E15\u0E23\u0E27\u0E08\u0E2A\u0E2D\u0E1A",
      deltaDirection: "down"
    })), /*#__PURE__*/React.createElement("div", {
      className: "pg-filterbar"
    }, FILTERS.map(([k, l], i) => /*#__PURE__*/React.createElement(Chip, {
      key: k,
      active: filter === i,
      dot: i > 0 ? `var(--status-${k})` : undefined,
      onClick: () => setFilter(i)
    }, l)), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }), /*#__PURE__*/React.createElement(SearchField, {
      size: "sm",
      placeholder: "\u0E04\u0E49\u0E19\u0E2B\u0E32\u0E40\u0E08\u0E49\u0E32\u0E2B\u0E19\u0E49\u0E32\u0E17\u0E35\u0E48\u2026"
    })), /*#__PURE__*/React.createElement(Tabs, null, /*#__PURE__*/React.createElement(Tab, {
      active: tab === 0,
      count: 384,
      onClick: () => setTab(0)
    }, "\u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14"), /*#__PURE__*/React.createElement(Tab, {
      active: tab === 1,
      count: 12,
      onClick: () => setTab(1)
    }, "\u0E23\u0E2D\u0E15\u0E23\u0E27\u0E08\u0E2A\u0E2D\u0E1A")), /*#__PURE__*/React.createElement(Panel, null, /*#__PURE__*/React.createElement(Table, null, /*#__PURE__*/React.createElement("thead", null, /*#__PURE__*/React.createElement("tr", null, /*#__PURE__*/React.createElement(Th, null, "\u0E40\u0E08\u0E49\u0E32\u0E2B\u0E19\u0E49\u0E32\u0E17\u0E35\u0E48"), /*#__PURE__*/React.createElement(Th, null, "\u0E2A\u0E16\u0E32\u0E19\u0E30"), /*#__PURE__*/React.createElement(Th, null, "\u0E04\u0E30\u0E41\u0E19\u0E19"), /*#__PURE__*/React.createElement(Th, null, "\u0E07\u0E32\u0E19\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08"), /*#__PURE__*/React.createElement(Th, null, "\u0E40\u0E2D\u0E01\u0E2A\u0E32\u0E23"), /*#__PURE__*/React.createElement(Th, null, "\u0E40\u0E02\u0E49\u0E32\u0E23\u0E48\u0E27\u0E21"))), /*#__PURE__*/React.createElement("tbody", null, rows.map(g => /*#__PURE__*/React.createElement(Tr, {
      key: g.id,
      onClick: () => setSel(g)
    }, /*#__PURE__*/React.createElement(Td, null, /*#__PURE__*/React.createElement("span", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 11
      }
    }, /*#__PURE__*/React.createElement(Avatar, {
      status: g.st
    }, g.nm.slice(0, 2)), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
      style: {
        display: "block",
        fontWeight: 600,
        color: "var(--text-strong)"
      }
    }, g.nm), /*#__PURE__*/React.createElement("span", {
      style: {
        display: "block",
        fontSize: 12,
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono)"
      }
    }, "ID #", g.id)))), /*#__PURE__*/React.createElement(Td, null, /*#__PURE__*/React.createElement(Badge, {
      tone: D.statusTone[g.st],
      dot: `var(--status-${g.st})`
    }, D.statusLabel[g.st])), /*#__PURE__*/React.createElement(Td, null, /*#__PURE__*/React.createElement("span", {
      className: "pg-rating"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "star",
      size: 12
    }), g.r)), /*#__PURE__*/React.createElement(Td, {
      style: {
        fontFamily: "var(--font-mono)"
      }
    }, g.jobs), /*#__PURE__*/React.createElement(Td, null, g.docs === "warn" ? /*#__PURE__*/React.createElement(Badge, {
      tone: "amber"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "clock",
      size: 12
    }), g.docLabel) : /*#__PURE__*/React.createElement("span", {
      className: "pg-docs"
    }, g.docs, " ", /*#__PURE__*/React.createElement(Icon, {
      name: "check",
      size: 13
    }))), /*#__PURE__*/React.createElement(Td, {
      style: {
        fontFamily: "var(--font-mono)",
        color: "var(--text-muted)"
      }
    }, g.year)))))), /*#__PURE__*/React.createElement(Modal, {
      open: !!sel,
      onClose: () => setSel(null),
      size: "lg",
      title: sel ? sel.nm : "",
      footer: /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement(Button, {
        variant: "secondary",
        size: "sm",
        onClick: () => setSel(null)
      }, "\u0E1B\u0E34\u0E14"), /*#__PURE__*/React.createElement(Button, {
        size: "sm"
      }, "\u0E21\u0E2D\u0E1A\u0E2B\u0E21\u0E32\u0E22\u0E07\u0E32\u0E19"))
    }, sel ? /*#__PURE__*/React.createElement("div", {
      className: "pg-detail"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-detail__head"
    }, /*#__PURE__*/React.createElement(Avatar, {
      size: "lg",
      status: sel.st
    }, sel.nm.slice(0, 2)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "pg-detail__nm"
    }, sel.nm), /*#__PURE__*/React.createElement("div", {
      className: "pg-detail__id"
    }, "ID #", sel.id, " \xB7 \u0E40\u0E02\u0E49\u0E32\u0E23\u0E48\u0E27\u0E21 ", sel.year), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: 8
      }
    }, /*#__PURE__*/React.createElement(Badge, {
      tone: D.statusTone[sel.st],
      dot: `var(--status-${sel.st})`
    }, D.statusLabel[sel.st]))), /*#__PURE__*/React.createElement("div", {
      style: {
        marginLeft: "auto",
        textAlign: "right"
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-detail__bign"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "star",
      size: 16,
      style: {
        color: "var(--accent)"
      }
    }), " ", sel.r), /*#__PURE__*/React.createElement("div", {
      className: "pg-detail__bigl"
    }, "\u0E04\u0E30\u0E41\u0E19\u0E19\u0E40\u0E09\u0E25\u0E35\u0E48\u0E22"))), /*#__PURE__*/React.createElement("div", {
      className: "pg-detail__stats"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "pg-detail__sv"
    }, sel.jobs), /*#__PURE__*/React.createElement("div", {
      className: "pg-detail__sl"
    }, "\u0E07\u0E32\u0E19\u0E2A\u0E33\u0E40\u0E23\u0E47\u0E08")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "pg-detail__sv"
    }, sel.docs === "warn" ? "4/5" : "5/5"), /*#__PURE__*/React.createElement("div", {
      className: "pg-detail__sl"
    }, "\u0E40\u0E2D\u0E01\u0E2A\u0E32\u0E23")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "pg-detail__sv"
    }, "98%"), /*#__PURE__*/React.createElement("div", {
      className: "pg-detail__sl"
    }, "\u0E15\u0E23\u0E07\u0E40\u0E27\u0E25\u0E32")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "pg-detail__sv"
    }, "\u0E3F62K"), /*#__PURE__*/React.createElement("div", {
      className: "pg-detail__sl"
    }, "\u0E23\u0E32\u0E22\u0E44\u0E14\u0E49/\u0E40\u0E14\u0E37\u0E2D\u0E19"))), /*#__PURE__*/React.createElement(Field, {
      label: "\u0E2B\u0E21\u0E32\u0E22\u0E40\u0E2B\u0E15\u0E38\u0E1C\u0E39\u0E49\u0E14\u0E39\u0E41\u0E25"
    }, /*#__PURE__*/React.createElement(Input, {
      placeholder: "\u0E40\u0E1E\u0E34\u0E48\u0E21\u0E2B\u0E21\u0E32\u0E22\u0E40\u0E2B\u0E15\u0E38\u2026"
    }))) : null));
  }
  window.Screens = window.Screens || {};
  window.Screens.Guards = Guards;
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web-admin/guards.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web-admin/login.jsx
try { (() => {
// pguard web-admin — login screen (split: brand hero + form card)
(function () {
  const {
    useState
  } = React;
  function Login({
    onLogin,
    lang,
    onLang,
    theme,
    onToggleTheme
  }) {
    const {
      Button,
      Field,
      Input
    } = window.PG_NS;
    const {
      Icon
    } = window.Shell;
    const [id, setId] = useState("admin@pguard.co.th");
    const [pw, setPw] = useState("demo-password");
    const PINS = [{
      x: 250,
      y: 0,
      size: 26,
      c: "var(--green-300)",
      o: 0.95
    }, {
      x: 150,
      y: 78,
      size: 21,
      c: "var(--amber-500)",
      o: 0.85
    }, {
      x: 300,
      y: 150,
      size: 19,
      c: "var(--green-300)",
      o: 0.7
    }, {
      x: 110,
      y: 216,
      size: 24,
      c: "var(--danger)",
      o: 0.9
    }, {
      x: 220,
      y: 286,
      size: 17,
      c: "var(--green-300)",
      o: 0.6
    }];
    const STATS = [["384", "เจ้าหน้าที่"], ["2,418", "ลูกค้า"], ["99.2%", "อัปไทม์"]];
    return /*#__PURE__*/React.createElement("div", {
      className: "pg-login"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-login__overlay"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-langseg",
      role: "group",
      "aria-label": "language"
    }, ["th", "en"].map(l => /*#__PURE__*/React.createElement("button", {
      key: l,
      className: lang === l ? "on" : "",
      onClick: () => onLang(l)
    }, l === "th" ? "ไทย" : "EN"))), /*#__PURE__*/React.createElement("div", {
      className: "pg-themeseg"
    }, /*#__PURE__*/React.createElement("button", {
      className: theme === "light" ? "on" : "",
      onClick: () => onToggleTheme("light"),
      "aria-label": "light"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "sun",
      size: 15
    })), /*#__PURE__*/React.createElement("button", {
      className: theme === "dark" ? "on" : "",
      onClick: () => onToggleTheme("dark"),
      "aria-label": "dark"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "moon",
      size: 15
    })))), /*#__PURE__*/React.createElement("section", {
      className: "pg-hero"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-hero__grid"
    }), /*#__PURE__*/React.createElement("div", {
      className: "pg-hero__pins"
    }, PINS.map((p, i) => /*#__PURE__*/React.createElement(Icon, {
      key: i,
      name: "map-pin",
      size: p.size,
      style: {
        position: "absolute",
        left: p.x,
        top: p.y,
        color: p.c,
        opacity: p.o
      }
    }))), /*#__PURE__*/React.createElement("div", {
      className: "pg-hero__wm"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "lock",
      size: 24,
      style: {
        color: "var(--green-300)"
      }
    }), /*#__PURE__*/React.createElement("span", null, /*#__PURE__*/React.createElement("span", {
      style: {
        color: "var(--green-300)"
      }
    }, "p"), "guard")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("h2", {
      className: "pg-hero__title"
    }, "\u0E28\u0E39\u0E19\u0E22\u0E4C\u0E2A\u0E31\u0E48\u0E07\u0E01\u0E32\u0E23\u0E04\u0E27\u0E32\u0E21\u0E1B\u0E25\u0E2D\u0E14\u0E20\u0E31\u0E22\u0E41\u0E1A\u0E1A\u0E40\u0E23\u0E35\u0E22\u0E25\u0E44\u0E17\u0E21\u0E4C"), /*#__PURE__*/React.createElement("p", {
      className: "pg-hero__tag"
    }, "\u0E08\u0E31\u0E14\u0E01\u0E32\u0E23\u0E40\u0E08\u0E49\u0E32\u0E2B\u0E19\u0E49\u0E32\u0E17\u0E35\u0E48 \u0E07\u0E32\u0E19 \u0E01\u0E32\u0E23\u0E40\u0E07\u0E34\u0E19 \u0E41\u0E25\u0E30\u0E41\u0E1C\u0E19\u0E17\u0E35\u0E48\u0E2A\u0E14\u0E02\u0E2D\u0E07 \u0E23\u0E1B\u0E20. \u0E17\u0E31\u0E48\u0E27\u0E40\u0E21\u0E37\u0E2D\u0E07 \u2014 \u0E17\u0E31\u0E49\u0E07\u0E2B\u0E21\u0E14\u0E43\u0E19\u0E17\u0E35\u0E48\u0E40\u0E14\u0E35\u0E22\u0E27"), /*#__PURE__*/React.createElement("div", {
      className: "pg-hero__stats"
    }, STATS.map(([n, l]) => /*#__PURE__*/React.createElement("div", {
      key: l
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-hero__statn"
    }, n), /*#__PURE__*/React.createElement("div", {
      className: "pg-hero__statl"
    }, l)))))), /*#__PURE__*/React.createElement("section", {
      className: "pg-login__form"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-login__card"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-login__tabs"
    }, /*#__PURE__*/React.createElement("button", {
      className: "on"
    }, "\u0E40\u0E02\u0E49\u0E32\u0E2A\u0E39\u0E48\u0E23\u0E30\u0E1A\u0E1A"), /*#__PURE__*/React.createElement("button", null, "\u0E25\u0E37\u0E21\u0E23\u0E2B\u0E31\u0E2A\u0E1C\u0E48\u0E32\u0E19"), /*#__PURE__*/React.createElement("button", null, "\u0E15\u0E31\u0E49\u0E07\u0E23\u0E2B\u0E31\u0E2A\u0E43\u0E2B\u0E21\u0E48"), /*#__PURE__*/React.createElement("button", null, "2FA")), /*#__PURE__*/React.createElement("h1", {
      className: "pg-login__h1"
    }, "\u0E22\u0E34\u0E19\u0E14\u0E35\u0E15\u0E49\u0E2D\u0E19\u0E23\u0E31\u0E1A\u0E01\u0E25\u0E31\u0E1A"), /*#__PURE__*/React.createElement("p", {
      className: "pg-login__lead"
    }, "\u0E40\u0E02\u0E49\u0E32\u0E2A\u0E39\u0E48\u0E23\u0E30\u0E1A\u0E1A\u0E41\u0E1C\u0E07\u0E1C\u0E39\u0E49\u0E14\u0E39\u0E41\u0E25 pguard"), /*#__PURE__*/React.createElement("form", {
      onSubmit: e => {
        e.preventDefault();
        onLogin();
      }
    }, /*#__PURE__*/React.createElement(Field, {
      label: "\u0E2D\u0E35\u0E40\u0E21\u0E25"
    }, /*#__PURE__*/React.createElement(Input, {
      type: "text",
      value: id,
      onChange: e => setId(e.target.value)
    })), /*#__PURE__*/React.createElement(Field, {
      label: "\u0E23\u0E2B\u0E31\u0E2A\u0E1C\u0E48\u0E32\u0E19"
    }, /*#__PURE__*/React.createElement(Input, {
      type: "password",
      value: pw,
      onChange: e => setPw(e.target.value)
    })), /*#__PURE__*/React.createElement("div", {
      className: "pg-login__row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pg-check"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pg-check__box"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "check",
      size: 13
    })), "\u0E08\u0E14\u0E08\u0E33\u0E09\u0E31\u0E19\u0E44\u0E27\u0E49"), /*#__PURE__*/React.createElement("span", {
      className: "pg-login__forgot"
    }, "\u0E25\u0E37\u0E21\u0E23\u0E2B\u0E31\u0E2A\u0E1C\u0E48\u0E32\u0E19?")), /*#__PURE__*/React.createElement(Button, {
      type: "submit",
      className: "pg-login__submit"
    }, "\u0E40\u0E02\u0E49\u0E32\u0E2A\u0E39\u0E48\u0E23\u0E30\u0E1A\u0E1A")))));
  }
  window.Screens = window.Screens || {};
  window.Screens.Login = Login;
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web-admin/login.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web-admin/map.jsx
try { (() => {
// pguard web-admin — live map screen (map + roster + detail)
(function () {
  const {
    useState
  } = React;
  function LiveMap() {
    const {
      Panel,
      PanelHead,
      Chip,
      Badge,
      Avatar,
      Button
    } = window.PG_NS;
    const {
      Icon
    } = window.Shell;
    const D = window.PG_DATA;
    const [filter, setFilter] = useState(0);
    const [sel, setSel] = useState(D.markers[0]);
    const FILTERS = [["all", "ทั้งหมด"], ["active", "ออนไลน์"], ["working", "กำลังทำงาน"], ["offline", "ออฟไลน์"]];
    const markers = D.markers.filter(m => filter === 0 || m.st === FILTERS[filter][0]);
    return /*#__PURE__*/React.createElement("div", {
      className: "pg-page pg-map"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-map__main"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-map__filters"
    }, FILTERS.map(([k, l], i) => /*#__PURE__*/React.createElement(Chip, {
      key: k,
      active: filter === i,
      dot: i > 0 ? `var(--status-${k})` : undefined,
      onClick: () => setFilter(i)
    }, l))), /*#__PURE__*/React.createElement("div", {
      className: "pg-bigmap"
    }, Array.from({
      length: 120
    }).map((_, i) => /*#__PURE__*/React.createElement("div", {
      key: i,
      className: "pg-bigmap__cell"
    })), /*#__PURE__*/React.createElement("div", {
      className: "pg-bigmap__road pg-bigmap__road--h",
      style: {
        top: "44%"
      }
    }), /*#__PURE__*/React.createElement("div", {
      className: "pg-bigmap__road pg-bigmap__road--v",
      style: {
        left: "38%"
      }
    }), markers.map((m, i) => /*#__PURE__*/React.createElement("button", {
      key: i,
      className: "pg-pin" + (sel === m ? " pg-pin--sel" : ""),
      style: {
        left: m.x + "%",
        top: m.y + "%"
      },
      onClick: () => setSel(m)
    }, /*#__PURE__*/React.createElement("span", {
      className: "pg-pin__ring",
      style: {
        background: `var(--status-${m.st}-ring)`
      }
    }), /*#__PURE__*/React.createElement("span", {
      className: "pg-pin__dot",
      style: {
        background: `var(--status-${m.st})`
      }
    }))))), /*#__PURE__*/React.createElement("div", {
      className: "pg-map__side"
    }, /*#__PURE__*/React.createElement(Panel, {
      className: "pg-map__sel"
    }, /*#__PURE__*/React.createElement(PanelHead, {
      title: sel.nm,
      sub: "งาน " + sel.job
    }), /*#__PURE__*/React.createElement("div", {
      className: "pg-map__selbody"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-map__selrow"
    }, /*#__PURE__*/React.createElement(Avatar, {
      status: sel.st,
      size: "lg"
    }, sel.nm.slice(0, 2)), /*#__PURE__*/React.createElement(Badge, {
      tone: D.statusTone[sel.st],
      dot: `var(--status-${sel.st})`
    }, D.statusLabel[sel.st])), /*#__PURE__*/React.createElement("div", {
      className: "pg-map__metrics"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Icon, {
      name: "navigation",
      size: 14
    }), /*#__PURE__*/React.createElement("span", null, "2.4 \u0E01\u0E21. \u0E08\u0E32\u0E01\u0E08\u0E38\u0E14\u0E2B\u0E21\u0E32\u0E22")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Icon, {
      name: "clock",
      size: 14
    }), /*#__PURE__*/React.createElement("span", null, "\u0E40\u0E0A\u0E47\u0E04\u0E2D\u0E34\u0E19\u0E25\u0E48\u0E32\u0E2A\u0E38\u0E14 6 \u0E19\u0E32\u0E17\u0E35\u0E17\u0E35\u0E48\u0E41\u0E25\u0E49\u0E27")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Icon, {
      name: "battery-medium",
      size: 14
    }), /*#__PURE__*/React.createElement("span", null, "\u0E41\u0E1A\u0E15\u0E40\u0E15\u0E2D\u0E23\u0E35\u0E48 78%"))), /*#__PURE__*/React.createElement(Button, {
      size: "sm",
      className: "pg-map__call"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "phone",
      size: 15
    }), "\u0E42\u0E17\u0E23\u0E2B\u0E32\u0E40\u0E08\u0E49\u0E32\u0E2B\u0E19\u0E49\u0E32\u0E17\u0E35\u0E48"))), /*#__PURE__*/React.createElement(Panel, {
      className: "pg-map__roster"
    }, /*#__PURE__*/React.createElement(PanelHead, {
      title: "\u0E23\u0E32\u0E22\u0E0A\u0E37\u0E48\u0E2D\u0E2D\u0E2D\u0E19\u0E44\u0E25\u0E19\u0E4C",
      sub: markers.length + " คน"
    }), /*#__PURE__*/React.createElement("div", {
      className: "pg-roster"
    }, markers.map((m, i) => /*#__PURE__*/React.createElement("button", {
      key: i,
      className: "pg-roster__row" + (sel === m ? " pg-roster__row--on" : ""),
      onClick: () => setSel(m)
    }, /*#__PURE__*/React.createElement(Avatar, {
      status: m.st,
      size: "sm"
    }, m.nm.slice(0, 2)), /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0,
        flex: 1,
        textAlign: "left"
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-roster__nm"
    }, m.nm), /*#__PURE__*/React.createElement("div", {
      className: "pg-roster__job"
    }, m.job)), /*#__PURE__*/React.createElement("span", {
      className: "pg-roster__chev"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "chevron-right",
      size: 15
    }))))))));
  }
  window.Screens = window.Screens || {};
  window.Screens.LiveMap = LiveMap;
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web-admin/map.jsx", error: String((e && e.message) || e) }); }

// ui_kits/web-admin/shell.jsx
try { (() => {
// pguard web-admin — shell (logo mark, sidebar, topbar) + Icon helper
(function () {
  const {
    useState,
    useEffect
  } = React;

  // Render the Lucide icon's SVG inline (React-managed) so re-renders never crash —
  // the mutate-DOM createIcons() path conflicts with React reconciliation.
  const pascal = n => n.split("-").map(s => s[0].toUpperCase() + s.slice(1)).join("");
  function lucideSvg(name, size) {
    const L = window.lucide || {};
    const node = L[pascal(name)] || L.icons && L.icons[pascal(name)] || [];
    const kids = (Array.isArray(node) ? node : []).map(([tag, attrs]) => {
      const a = Object.entries(attrs || {}).map(([k, v]) => `${k}="${v}"`).join(" ");
      return `<${tag} ${a} />`;
    }).join("");
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${kids}</svg>`;
  }
  function Icon({
    name,
    size = 18,
    className = "",
    style
  }) {
    return /*#__PURE__*/React.createElement("span", {
      className: "pg-ic " + className,
      style: style,
      dangerouslySetInnerHTML: {
        __html: lucideSvg(name, size)
      }
    });
  }
  function PgMark({
    size = 28
  }) {
    return /*#__PURE__*/React.createElement("svg", {
      width: size,
      height: size * 1.04,
      viewBox: "0 0 100 106",
      fill: "none",
      "aria-hidden": true
    }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("linearGradient", {
      id: "pgm",
      x1: "50",
      y1: "4",
      x2: "50",
      y2: "106",
      gradientUnits: "userSpaceOnUse"
    }, /*#__PURE__*/React.createElement("stop", {
      stopColor: "var(--brand-int)"
    }), /*#__PURE__*/React.createElement("stop", {
      offset: "1",
      stopColor: "var(--brand)"
    }))), /*#__PURE__*/React.createElement("path", {
      d: "M50 4 L88 18 V50 C88 78 72 95 50 104 C28 95 12 78 12 50 V18 Z",
      fill: "url(#pgm)"
    }), /*#__PURE__*/React.createElement("path", {
      d: "M50 30 C41 30 34 37 34 46 C34 58 50 74 50 74 C50 74 66 58 66 46 C66 37 59 30 50 30 Z",
      fill: "var(--n-0)"
    }), /*#__PURE__*/React.createElement("circle", {
      cx: "50",
      cy: "46",
      r: "7.5",
      fill: "var(--brand-int)"
    }));
  }
  const NAV = [{
    group: "ภาพรวม",
    items: [{
      id: "dashboard",
      icon: "layout-dashboard",
      label: "แดชบอร์ด"
    }, {
      id: "operations",
      icon: "activity",
      label: "ปฏิบัติการสด",
      badge: "21"
    }, {
      id: "map",
      icon: "map",
      label: "แผนที่สด"
    }, {
      id: "applicants",
      icon: "users",
      label: "ผู้สมัคร",
      badge: "12"
    }, {
      id: "guards",
      icon: "shield",
      label: "พนักงาน รปภ.",
      badge: "384"
    }, {
      id: "customers",
      icon: "user",
      label: "ลูกค้า"
    }, {
      id: "reviews",
      icon: "star",
      label: "รีวิว",
      dot: true
    }]
  }, {
    group: "การเงิน & งาน",
    items: [{
      id: "tasks",
      icon: "list-checks",
      label: "จัดการงานทั้งหมด",
      badge: "48"
    }, {
      id: "bookings",
      icon: "briefcase",
      label: "จัดการงาน",
      badge: "27"
    }, {
      id: "wallet",
      icon: "wallet",
      label: "กระเป๋าเงิน",
      badge: "5"
    }, {
      id: "pricing",
      icon: "tag",
      label: "กำหนดราคา"
    }]
  }, {
    group: "การสื่อสาร",
    items: [{
      id: "calls",
      icon: "phone",
      label: "บันทึกการโทร"
    }, {
      id: "chat",
      icon: "message-square",
      label: "ตรวจสอบแชต"
    }, {
      id: "broadcast",
      icon: "send",
      label: "ส่งการแจ้งเตือน"
    }]
  }, {
    group: "ระบบ",
    items: [{
      id: "expiring",
      icon: "triangle-alert",
      label: "เอกสารใกล้หมดอายุ",
      badge: "7"
    }, {
      id: "settings",
      icon: "settings",
      label: "ตั้งค่า"
    }]
  }];
  function Sidebar({
    view,
    onNav,
    theme,
    onToggleTheme
  }) {
    const D = window.PG_DATA;
    return /*#__PURE__*/React.createElement("aside", {
      className: "pg-side"
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-side__top"
    }, /*#__PURE__*/React.createElement(PgMark, {
      size: 28
    }), /*#__PURE__*/React.createElement("span", {
      className: "pg-wm"
    }, /*#__PURE__*/React.createElement("span", null, "p"), "guard")), /*#__PURE__*/React.createElement("nav", {
      className: "pg-side__nav"
    }, NAV.map(g => /*#__PURE__*/React.createElement("div", {
      key: g.group
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-side__group"
    }, g.group), g.items.map(it => {
      const active = view === it.id;
      return /*#__PURE__*/React.createElement("button", {
        key: it.id,
        onClick: () => onNav(it.id),
        className: "pg-nav" + (active ? " pg-nav--on" : "")
      }, /*#__PURE__*/React.createElement(Icon, {
        name: it.icon,
        size: 18,
        className: "pg-nav__ic"
      }), /*#__PURE__*/React.createElement("span", {
        className: "pg-nav__lbl"
      }, it.label), it.badge ? /*#__PURE__*/React.createElement("span", {
        className: "pg-nav__badge"
      }, it.badge) : null, it.dot ? /*#__PURE__*/React.createElement("span", {
        className: "pg-nav__dot"
      }) : null);
    })))), /*#__PURE__*/React.createElement("div", {
      className: "pg-side__foot"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pg-side__av"
    }, D.admin.initials), /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0,
        flex: 1
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-side__nm"
    }, D.admin.name), /*#__PURE__*/React.createElement("div", {
      className: "pg-side__role"
    }, D.admin.role)), /*#__PURE__*/React.createElement("div", {
      className: "pg-themeseg",
      role: "group",
      "aria-label": "theme"
    }, /*#__PURE__*/React.createElement("button", {
      className: theme === "light" ? "on" : "",
      onClick: () => onToggleTheme("light"),
      "aria-label": "light"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "sun",
      size: 15
    })), /*#__PURE__*/React.createElement("button", {
      className: theme === "dark" ? "on" : "",
      onClick: () => onToggleTheme("dark"),
      "aria-label": "dark"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "moon",
      size: 15
    })))));
  }
  const TITLES = {
    dashboard: ["แดชบอร์ด", "ภาพรวมการดำเนินงานวันนี้"],
    guards: ["พนักงาน รปภ.", "เจ้าหน้าที่ที่อนุมัติแล้ว 384 คน"],
    map: ["แผนที่สด", "ตำแหน่งเจ้าหน้าที่แบบเรียลไทม์"]
  };
  function Topbar({
    view,
    lang,
    onLang,
    onLogout
  }) {
    const {
      SearchField
    } = window.PG_NS;
    const [menu, setMenu] = useState(false);
    const D = window.PG_DATA;
    const t = TITLES[view] || ["pguard แอดมิน", ""];
    return /*#__PURE__*/React.createElement("header", {
      className: "pg-topbar"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("h1", {
      className: "pg-topbar__title"
    }, t[0]), t[1] ? /*#__PURE__*/React.createElement("p", {
      className: "pg-topbar__sub"
    }, t[1]) : null), /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1
      }
    }), /*#__PURE__*/React.createElement(SearchField, {
      placeholder: "\u0E04\u0E49\u0E19\u0E2B\u0E32\u2026"
    }), /*#__PURE__*/React.createElement("button", {
      className: "pg-iconbtn",
      "aria-label": "\u0E41\u0E08\u0E49\u0E07\u0E40\u0E15\u0E37\u0E2D\u0E19"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "bell",
      size: 18
    }), /*#__PURE__*/React.createElement("span", {
      className: "pg-iconbtn__dot"
    })), /*#__PURE__*/React.createElement("div", {
      className: "pg-langseg",
      role: "group",
      "aria-label": "language"
    }, ["th", "en"].map(l => /*#__PURE__*/React.createElement("button", {
      key: l,
      className: lang === l ? "on" : "",
      onClick: () => onLang(l)
    }, l === "th" ? "ไทย" : "EN"))), /*#__PURE__*/React.createElement("div", {
      className: "pg-usermenu"
    }, /*#__PURE__*/React.createElement("button", {
      className: "pg-userbtn",
      onClick: () => setMenu(v => !v)
    }, /*#__PURE__*/React.createElement("span", {
      className: "pg-userbtn__av"
    }, D.admin.initials), /*#__PURE__*/React.createElement(Icon, {
      name: "chevron-down",
      size: 15
    })), menu ? /*#__PURE__*/React.createElement("div", {
      className: "pg-menu",
      onMouseLeave: () => setMenu(false)
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-menu__head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "pg-menu__av"
    }, D.admin.initials), /*#__PURE__*/React.createElement("div", {
      style: {
        minWidth: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "pg-menu__nm"
    }, D.admin.name), /*#__PURE__*/React.createElement("div", {
      className: "pg-menu__role"
    }, D.admin.role))), /*#__PURE__*/React.createElement("button", {
      className: "pg-menu__item"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "circle-user",
      size: 16
    }), "\u0E42\u0E1B\u0E23\u0E44\u0E1F\u0E25\u0E4C"), /*#__PURE__*/React.createElement("button", {
      className: "pg-menu__item"
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "settings",
      size: 16
    }), "\u0E15\u0E31\u0E49\u0E07\u0E04\u0E48\u0E32"), /*#__PURE__*/React.createElement("div", {
      className: "pg-menu__sep"
    }), /*#__PURE__*/React.createElement("button", {
      className: "pg-menu__item pg-menu__item--danger",
      onClick: onLogout
    }, /*#__PURE__*/React.createElement(Icon, {
      name: "log-out",
      size: 16
    }), "\u0E2D\u0E2D\u0E01\u0E08\u0E32\u0E01\u0E23\u0E30\u0E1A\u0E1A")) : null));
  }
  window.Shell = {
    Icon,
    PgMark,
    Sidebar,
    Topbar
  };
})();
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/web-admin/shell.jsx", error: String((e && e.message) || e) }); }

__ds_ns.Avatar = __ds_scope.Avatar;

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.KpiGrid = __ds_scope.KpiGrid;

__ds_ns.KpiCard = __ds_scope.KpiCard;

__ds_ns.Panel = __ds_scope.Panel;

__ds_ns.PanelHead = __ds_scope.PanelHead;

__ds_ns.PanelBody = __ds_scope.PanelBody;

__ds_ns.Table = __ds_scope.Table;

__ds_ns.Th = __ds_scope.Th;

__ds_ns.Td = __ds_scope.Td;

__ds_ns.Tr = __ds_scope.Tr;

__ds_ns.Tabs = __ds_scope.Tabs;

__ds_ns.Tab = __ds_scope.Tab;

__ds_ns.Modal = __ds_scope.Modal;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Chip = __ds_scope.Chip;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Textarea = __ds_scope.Textarea;

__ds_ns.Select = __ds_scope.Select;

__ds_ns.Field = __ds_scope.Field;

__ds_ns.SearchField = __ds_scope.SearchField;

__ds_ns.Toggle = __ds_scope.Toggle;

})();
