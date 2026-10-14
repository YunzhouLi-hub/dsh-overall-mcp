// client/client.js — dsh-overall-mcp client plugin (web / desktop).
//
// Client plugin format verified against @deepseek-ai/dsh-client-ui-sidebar and
// @deepseek-ai/dsh-client-ui-layout: registered via
// window.__ModuleLoader__.load({id, factory}), factory(require) returns exports
// with `inject` and `apply(ctx)`. The page is one entry in the left rail: an
// icon row in the sidebar's `sidebar.panellist` LIST slot plus the panel
// component in the layout's KEYED `main` slot, both under one id and both
// wrapped in `slots.inject` like every other registration.
//
// Why the rail and not Settings: Settings keeps only the read-only plugin
// inventory, and a host surface that owns its own dismissal has no room for a
// page with its own tabs, search box and list. The rail is where the built-in
// 插件 and 任务 pages live, so this is the surface a page like this belongs to.
//
// Two tabs:
//   「已注册」 — servers grouped by import source (collapsible, per-group switch)
//   「MCP 市场」— live discovery of available MCP servers from the public
//                 catalogs (official registry / Smithery / PulseMCP)
//
// Host API (Connection-authenticated same-origin fetch routes, index.js):
//   GET  /api/overall-mcp/servers
//   GET  /api/overall-mcp/scan
//   GET/POST /api/overall-mcp/catalog           { query?, source?, limit?, refresh? }
//   POST /api/overall-mcp/install               { item }
//   POST /api/overall-mcp/set-enabled           { name, enabled }
//   POST /api/overall-mcp/set-source-enabled    { source, enabled }
//   POST /api/overall-mcp/remove                { name }

window.__ModuleLoader__.load({
	id: "dsh-overall-mcp",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");
		var createElement = react.createElement;
		var useState = react.useState;
		var useEffect = react.useEffect;
		var useMemo = react.useMemo;
		var useRef = react.useRef;

		const API = "/api/overall-mcp";
		// Shown in the page head's version chip. The bundle cannot read
		// package.json at runtime, so `tools/client-smoke.mjs` asserts the two
		// stay equal — a version chip that lies is worse than no chip.
		const CLIENT_VERSION = "0.1.0";
		// The bundle's npm package name — what the profile lists in its
		// `dsh.profile.bundles` and what its bundle page is keyed by. The
		// bundle cannot read package.json at runtime, so `tools/client-smoke.mjs`
		// asserts the two stay equal; a name that drifts is a plugin nobody can
		// find rather than one that fails loudly.
		const BUNDLE_NAME = "dsh-overall-mcp";
		// The rail entry and the page it opens are two halves of one key: the
		// id below is also the `key` of our `main` registration, and `main` is
		// the root-scope keyed slot the centre column renders. Selecting a
		// panel whose `main` key does not exist throws, so the two cannot be
		// allowed to drift apart.
		const PANEL_ID = "overall-mcp";

		async function api(path, options) {
			const res = await fetch(API + path, {
				headers: { "content-type": "application/json" },
				...options,
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
			return body;
		}

		/** Friendly titles for the known import sources. */
		const SOURCE_LABELS = {
			"claude-desktop": "Claude Desktop",
			"claude-code": "Claude Code",
			"cursor": "Cursor",
			"vscode": "VS Code",
			"vscode-insiders": "VS Code Insiders",
			"windsurf": "Windsurf",
			"codex-cli": "Codex CLI",
			"gemini-cli": "Gemini CLI",
			"manual": "手动添加",
			"catalog:official-registry": "官方 Registry",
			"catalog:smithery": "Smithery",
			"catalog:docker-catalog": "Docker MCP Catalog",
			"catalog:awesome-remote": "Awesome 远程",
			"catalog:awesome-list": "Awesome 清单",
			"catalog:pulsemcp": "PulseMCP",
		};

		function sourceLabel(source) {
			const key = source || "manual";
			if (SOURCE_LABELS[key]) return SOURCE_LABELS[key];
			if (key.startsWith("catalog:")) return `目录 · ${key.slice("catalog:".length)}`;
			return key;
		}

		/** Market source ids (as returned by the catalog endpoint). */
		const MARKET_SOURCES = [
			["", "全部市场"],
			["official-registry", "官方 Registry"],
			["smithery", "Smithery"],
			["docker-catalog", "Docker MCP Catalog"],
			["awesome-remote", "Awesome 远程"],
			["awesome-list", "Awesome 清单"],
		];

		/** Sort choices for the market listing. */
		const SORT_OPTIONS = [
			["default", "默认（综合推荐）"],
			["quality", "质量最高"],
			["installs", "使用量最多"],
			["stars", "Star 最多"],
			["updated", "最近更新"],
			["name", "名称 A→Z"],
		];

		/** Page-size choices; the market holds thousands of entries. */
		const PAGE_SIZES = [20, 50, 100];

		/** Compact source names for the per-source counters line. */
		const SOURCE_SHORT = {
			"official-registry": "官方",
			smithery: "Smithery",
			"docker-catalog": "Docker",
			"awesome-remote": "远程",
			"awesome-list": "Awesome",
		};

		// Theme-adaptive palette. The DSH shell owns the real tokens
		// (--dsw-alias-*); the literals are fallbacks for a shell older than this
		// bundle. Neutral surfaces are translucent grey rather than white so the
		// page reads as native in BOTH themes — a hard-coded white card on the
		// dark theme is the single most obvious "this does not belong here" tell.
		const T = {
			cardBg: "var(--dsw-alias-bg-primary, #fff)",
			soft: "rgba(128,128,128,0.08)",
			soft2: "rgba(128,128,128,0.12)",
			text: "var(--dsw-alias-text-primary, #1d2129)",
			text2: "var(--dsw-alias-text-secondary, #4e5969)",
			text3: "var(--dsw-alias-text-tertiary, #86909c)",
			text4: "var(--dsw-alias-text-quaternary, #a9aeb8)",
			line: "rgba(128,128,128,0.18)",
			line2: "rgba(128,128,128,0.10)",
			brand: "#4d6bfe",
			green: "#00b42a",
			amber: "#ff7d00",
			blue: "#165dff",
			red: "#f53f3f",
		};

		const styles = {
			// A centre-column panel owns its scrolling: the frame's centre column
			// is `overflow:hidden`, and every built-in page is a
			// `height:100%; overflow:auto` scroller (the plugin manager's own
			// `.page` is exactly that). This page is the shell instead: it is
			// `height:100%` with **no** scrolling of its own, and the scrolling
			// lives one level down — the tab body for 已注册 (a long list) and,
			// in MCP 市场, the card region alone, so the search box and the
			// 分类/筛选 rows stay put while the cards move. The top padding
			// repeats the frame's clearance variable so the first row clears the
			// macOS traffic lights and the Windows title bar instead of hiding
			// under them.
			//
			// The page adds no horizontal padding of its own: the market body
			// inside it is already a 20px-padded plate, and a second gutter here
			// would push the card grid's container below the 1100px three-column
			// breakpoint (1140 available − 2×20 = 1100 exactly). The probe in
			// tools/shot.mjs pins that contract on the grid's used column count.
			page: {
				// A *column* flex container, not a grid. Two real bugs came from
				// `display: grid` here, and both are fixed by the axis change:
				//
				// 1. A grid with `height: 100%` stretches its implicit rows over
				//    the whole panel (`align-content: normal` = stretch). In the
				//    loading state there is almost nothing to paint, so every row
				//    was spread across a screenful of empty space: header, then
				//    300px of nothing, then the tabs, then the search box. In a
				//    column flex container the main axis packs at the start and
				//    the leftover height stays at the bottom.
				// 2. An item of a grid whose tracks are `auto` contributes its
				//    *minimum* (min-content) to the track's base size, and a
				//    multicol's min-content is one column per `column-count`,
				//    each as wide as the widest card. On the real desktop window
				//    that inflated the chain to a ~1891px wall inside a 1180px
				//    page (cards 621px wide, third column off screen, page
				//    scrollbar). In a column flex container the cross axis is
				//    horizontal: items stretch to the container's width and no
				//    horizontal automatic minimum exists at all.
				display: "flex", flexDirection: "column", gap: 12,
				fontSize: 13.5, lineHeight: 1.55, color: T.text,
				height: "100%", boxSizing: "border-box", overflow: "hidden",
				width: "100%", maxWidth: 1180, margin: "0 auto", minWidth: 0,
				minHeight: 0,
				// The page is a container too, so the grid is always measured
				// against a box of our own — `gridHost` is nearer and wins, but
				// a host or fixture that renders the page alone must still get
				// the container query rather than the `@media`-free fallback.
				containerType: "inline-size",
				// 20px of side gutter, ours: the frame's centre column has no
				// padding of its own (`.centerCol` in the layout bundle is a
				// bare flex column), so a page that does not leave a margin
				// sits flush against the rail and the right edge. v4's own
				// shell is `1180 + 20px`, and border-box keeps the content box
				// at 1140 — the width the grid's breakpoints were tuned for.
				padding: "calc(28px + var(--dsh-frame-top-clearance, 0px)) 20px 48px",
			},
			// A tab's own body. It used to reuse `page`, which put a second
			// 1180px box, a second scroller, a second container and a second
			// 20px gutter *inside* the page — so the grid measured 40px
			// narrower than the page it sat in and its breakpoints landed a
			// band low (2 columns where 3 fit). The body only stacks its
			// children; the page above it owns width, scrolling and padding.
			//
			// Column flex for the same two reasons as `page` above, and
			// `minWidth: 0` on top of it: belt-and-braces for any ancestor that
			// still sizes it as a grid/flex item. The card wall is a multicol,
			// and a multicol's min-content is one column per `column-count` —
			// 3 x 621px in the real app, against a 1140px box.
			//
			// `flex: 1 1 auto` + `minHeight: 0` is what makes this the scroller:
			// it takes the height the page's fixed rows (head, tab bar, footer)
			// leave over, and scrolls instead of pushing the page taller.
			// `flexShrink: 0` is deliberately *not* inherited from the sheet's
			// `.omkt-page > *` rule — the inline longhand wins.
			tabBody: {
				display: "flex", flexDirection: "column", gap: 12, minWidth: 0,
				flex: "1 1 auto", flexShrink: 1, minHeight: 0, overflowY: "auto",
			},
			// The MCP market body: same box, but it does *not* scroll — its
			// chrome (search, 分类, 筛选, meta lines) is pinned and only the card
			// region inside it moves. That is why it needs its own style rather
			// than reusing `tabBody`.
			market: {
				display: "flex", flexDirection: "column", gap: 12, minWidth: 0,
				flex: "1 1 auto", flexShrink: 1, minHeight: 0, overflow: "hidden",
			},
			// The one scrolling box in the market tab. `paddingBottom` keeps the
			// last row of cards off the pager; `minWidth: 0` keeps the multicol
			// from widening the column (see `page`).
			marketScroll: {
				flex: "1 1 auto", flexShrink: 1, minHeight: 0, overflowY: "auto",
				minWidth: 0, paddingBottom: 4,
			},
			toolbar: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
			// ---- page head, ported from the v4 prototype ----------------------
			// Two rows: identity + actions, then the sub-line. The brand mark is
			// the only illustration in the whole page; everything else is text.
			// v4's header is two rows: identity + actions on the first, the
			// sub-line on its own row below so the outlined log button can sit
			// at its far end. Stacking all four controls into one row is what
			// made the old head read as a toolbar.
			pageHead: { display: "grid", gap: 10, marginBottom: 14 },
			// Row A: identity on the left, the page's controls on the right.
			headRow: {
				display: "flex", gap: 16, alignItems: "flex-start",
				justifyContent: "space-between", flexWrap: "wrap",
			},
			// Row B: the sub-line and the one outlined control that belongs with
			// it, so the first row keeps a single filled button.
			headSubRow: {
				display: "flex", gap: 12, alignItems: "center",
				justifyContent: "space-between", flexWrap: "wrap",
			},
			titleRow: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", minWidth: 0 },
			pageTitle: {
				fontSize: 18, fontWeight: 700, color: T.text,
				lineHeight: 1.2, letterSpacing: "-0.02em",
			},
			// v4 states the version as plain muted text beside the title, not as
			// a chip: it is a fact about the page, not a status to decode.
			versionChip: { fontSize: 12, color: T.text3, fontWeight: 500, whiteSpace: "nowrap" },
			pageSub: { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", minWidth: 0 },
			pageSubText: { margin: 0, fontSize: 12.5, color: T.text3 },
			pageSubLink: { color: T.text2, textDecoration: "none", borderBottom: `1px solid ${T.line}` },
			headActs: { display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", flexShrink: 0 },
			// Floating return-to-top: it only exists once there is somewhere to
			// return from, so a short page never carries a dead control.
			toTop: {
				position: "fixed", right: 22, bottom: 22, zIndex: 40,
				width: 40, height: 40, padding: 0, borderRadius: 999,
				display: "grid", placeItems: "center", fontSize: 16, lineHeight: 1,
				border: `1px solid ${T.line}`, background: T.cardBg, color: T.text2,
				cursor: "pointer", boxShadow: "0 1px 2px rgba(0,0,0,.04)",
			},
			spacer: { marginLeft: "auto" },
			button: {
				padding: "7px 14px", borderRadius: 8, cursor: "pointer", fontSize: 13,
				fontWeight: 500,
				border: `1px solid ${T.line}`, background: T.cardBg, color: T.text,
				// A CJK label breaks between characters, so a shrunk flex button
				// has a one-glyph minimum: it would wrap inside a box too narrow
				// for it and clip the second line (the app's 搜索 button was 38px
				// wide for two characters). Buttons never shrink and never wrap.
				flexShrink: 0, whiteSpace: "nowrap", boxSizing: "border-box",
			},
			// v4's primary is INK, not accent: exactly one filled button per
			// view, with the accent spent on links, tab rules and badges
			// instead. `T.text` on `T.cardBg` is v4's own light/dark pair
			// (#111/#fff ↔ #f2f2f2/#111) without needing a second rule.
			primary: { background: T.text, borderColor: T.text, color: T.cardBg, fontWeight: 600 },
			// v4's `.btn-text`: borderless and muted, so it never competes with
			// the one filled control beside it.
			textBtn: {
				padding: "7px 4px", borderRadius: 8, cursor: "pointer", fontSize: 13,
				fontWeight: 500, border: "none", background: "transparent", color: T.text3,
				flexShrink: 0, whiteSpace: "nowrap",
			},
			// v4's `.btn-outline`, used by 导出日志 alone.
			outlineBtn: {
				padding: "6px 12px", borderRadius: 8, cursor: "pointer", fontSize: 12.5,
				border: `1px solid ${T.line}`, background: T.cardBg, color: T.text2,
				display: "inline-flex", alignItems: "center", gap: 6,
			},
			// Underline tabs: the label sits on a rule and the active rule is
			// ink, not accent. The rule is drawn by the injected sheet on
			// `.omkt-tab[aria-selected="true"]::after` rather than as an inline
			// `border-bottom: 2px solid transparent` on the inactive tab: in the
			// real app that transparent border painted *black* (the UA button
			// border colour), so both tabs looked selected at once. A pseudo
			// element that is transparent unless the tab is selected cannot do
			// that, and `aria-selected` is also what a screen reader reads.
			tabBar: {
				display: "flex", gap: 2, alignItems: "center",
				borderBottom: `1px solid ${T.line}`, marginBottom: 14, overflowX: "auto",
			},
			tab: {
				padding: "10px 12px", background: "transparent", cursor: "pointer", fontSize: 13.5,
				fontWeight: 500, color: T.text3, border: "none", whiteSpace: "nowrap",
				textDecoration: "none",
			},
			tabActive: { color: T.text, fontWeight: 600 },
			stats: { display: "flex", gap: 14, flexWrap: "wrap", fontSize: 12, color: T.text3 },
			// v4's market chrome is three rows, and each row has one job: a
			// search pill, a chip row with the page's compact controls at its
			// end, then a meta line of bold numbers. Five controls in one row
			// is what made the old page read as a form.
			searchWrap: {
				display: "flex", gap: 10, alignItems: "center", width: "100%",
				// `width: 100%` plus padding overflows its parent by exactly the
				// padding unless the box is border-box, and the market body now
				// clips (it owns the card scroller) — that combination is what cut
				// the 搜索 button in half on the real desktop window. Every box
				// that states a width AND has padding must say border-box.
				boxSizing: "border-box", minWidth: 0,
				padding: "11px 16px", borderRadius: 999,
				border: `1px solid ${T.line}`, background: T.cardBg, color: T.text3,
			},
			searchIcon: { fontSize: 13, lineHeight: 1, flexShrink: 0 },
			searchInput: {
				flex: 1, minWidth: 0, border: 0, outline: 0, background: "transparent",
				fontSize: 14, color: T.text,
			},
			filters: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 18 },
			// The taxonomy is a *dropdown*, not a scrolling chip row: twenty
			// category chips either scrolled sideways (so half of them were
			// never seen) or wrapped to three lines and pushed the grid below
			// the fold. One select shows the whole taxonomy on demand.
			groupFilter: { display: "flex", gap: 8, alignItems: "center", flexShrink: 0 },
			groupLabel: { fontSize: 12.5, color: T.text3, whiteSpace: "nowrap" },
			groupSelect: {
				flexShrink: 0, padding: "6px 10px", borderRadius: 8, fontSize: 12.5,
				border: `1px solid ${T.line}`, background: T.cardBg, color: T.text2,
				minWidth: 160, maxWidth: 280, boxSizing: "border-box",
			},
			// The compact controls sit at the far end of the same row, so the
			// gap between the taxonomy and the filters is the row's own free
			// space rather than a fixed 8px.
			filterRight: {
				display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
				marginLeft: "auto",
			},
			filterBtn: {
				flexShrink: 0, padding: "6px 12px", borderRadius: 8, fontSize: 12.5, cursor: "pointer",
				border: `1px solid ${T.line}`, background: T.cardBg, color: T.text2,
				whiteSpace: "nowrap", boxSizing: "border-box",
			},
			filterSelect: {
				flexShrink: 0, padding: "6px 10px", borderRadius: 8, fontSize: 12.5,
				border: `1px solid ${T.line}`, background: T.cardBg, color: T.text2,
				boxSizing: "border-box",
			},
			// A control that is actually filtering says so: ink border, ink text.
			// Before this, a select looked identical whether it was narrowing the
			// list or sitting on its default, which is half of why "我选了使用量
			// 最多但列表没变" felt like the filter was ignored.
			filterSelectOn: {
				borderColor: T.text, color: T.text, fontWeight: 500, background: T.soft,
			},
			// v4's meta line: bold numbers with their units in muted text, and
			// the freshness note pushed to the far right.
			metaLine: {
				display: "flex", gap: 14, flexWrap: "wrap", alignItems: "baseline",
				fontSize: 12, color: T.text3, margin: "-6px 0 14px",
			},
			metaB: { fontWeight: 600, color: T.text2 },
			metaSort: { fontWeight: 600, color: T.text },
			metaTail: { marginLeft: "auto" },
			select: {
				padding: "6px 10px", borderRadius: 8, fontSize: 13,
				border: `1px solid ${T.line}`, background: T.cardBg, color: T.text,
			},
			searchBox: {
				flex: 1, minWidth: 180, padding: "7px 12px", borderRadius: 8, fontSize: 13,
				border: `1px solid ${T.line}`, background: T.cardBg, color: T.text,
			},
			group: { border: `1px solid ${T.line}`, borderRadius: 12, overflow: "hidden" },
			groupHead: { display: "flex", gap: 10, alignItems: "center", padding: "10px 12px", background: T.soft },
			groupTitle: { fontWeight: 600 },
			badge: { fontSize: 11, padding: "1px 7px", borderRadius: 999, background: T.soft2, color: T.text2, fontWeight: 500 },
			pager: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 },
			updateBadge: {
				fontSize: 12, padding: "1px 8px", borderRadius: 999,
				background: "rgba(0,180,42,0.12)", color: T.green, fontWeight: 600,
			},
			groupBody: { display: "grid", gap: 1, padding: "6px 8px 10px" },
			row: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", padding: "7px 10px", borderRadius: 8 },
			name: { fontWeight: 600, minWidth: 130 },
			meta: { color: T.text3, fontSize: 12 },
			dot: (state) => ({
				width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
				background: state === "on" ? T.green
					: state === "off" ? "#f53f3f"
						: state === "external" ? T.blue
							: "rgba(128,128,128,0.6)",
			}),
			// ---- market cards (v4: masonry columns, not a rigid grid) ----
			// A masonry column flow lets a card with a long description stay tall
			// without forcing its whole row to match it — the ragged bottom edge
			// is what makes a 5k-entry catalogue scannable.
			// Two columns by default, three from 1100px up, one below 720px —
			// v4's breakpoints exactly, declared in ensureStyles because inline
			// styles cannot carry a query. This inline value is the fallback for
			// the moment before that sheet lands.
			// The card wall. Column count comes from the injected sheet's
			// container queries; the inline value is the fallback for a browser
			// that ignores them (and for the moment before the sheet lands).
			//
			// It is a **row-major grid**, not a multi-column masonry. Multi-column
			// fills the first column to the bottom before starting the second, so
			// a *ranked* list read top-to-bottom inside one column and the last
			// entries landed in the right-hand column — the user's words: 「这个
			// 使用量最多应该是从左到右排序而不是从上到下的排序，这样第三列都是
			// 最后的，给用户显示的观感不好」. `minmax(0, 1fr)` is what keeps a
			// hostile card from widening the wall (a bare `1fr` floors at the
			// item's min-content). Rows are NOT `align-items: start`: a row whose
			// cards differ in height would then leave a hole under the short ones
			// (the tall first card in the fixtures opened a 300px hole), so the
			// default `stretch` squares the row up and the card's own
			// `grid-template-rows: 1fr auto` parks the slack between the body and
			// the footer — the footer stays on the card's bottom edge instead of
			// floating mid-card.
			cardColumns: {
				display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
				gap: 14, minWidth: 0,
			},
			// The measurable box those queries read: its own inline size, not the
			// window's. Also the reason the grid sits inside a wrapper at all.
			// `minWidth: 0` is the fix for the wall overflowing its page: as a
			// grid item, its `min-width: auto` would otherwise be the multicol's
			// min-content (one column-width per column), which the auto tracks
			// above then grew to fit.
			gridHost: { containerType: "inline-size", minWidth: 0, width: "100%" },
			card: {
				// The wall's `gap` spaces the rows now; the old `marginBottom` was
				// the multi-column era's way of opening a vertical gutter and
				// would double every gap under the grid. `1fr auto` gives the body
				// the row's slack so the footer sits on the card's bottom edge.
				display: "grid", gridTemplateRows: "1fr auto", gap: 10,
				padding: 16, borderRadius: 12,
				border: `1px solid ${T.line}`, background: T.cardBg,
				color: T.text, textAlign: "left", cursor: "pointer",
				boxShadow: "0 1px 2px rgba(0,0,0,.04)",
			},
			// `minWidth: 0` is load-bearing: this is a *grid* item inside
			// cardLeft's auto track, so its default `min-width:auto` resolves
			// to min-content — and a `white-space:nowrap` title's min-content
			// is its full text. Without it a long name widens the track past
			// the card and shoves the install/detail buttons over the edge.
			cardHead: {
				display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap",
				minWidth: 0, marginBottom: 8,
			},
			// Header split: identity column (grows) + action column (fixed).
			cardHd: { display: "flex", gap: 12, alignItems: "flex-start" },
			cardLeft: { display: "grid", gap: 0, flex: 1, minWidth: 0 },
			cardCta: { display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end", flexShrink: 0 },
			cardBody: {
				display: "grid", gap: 10, flex: 1, minWidth: 0, outline: "none",
				// The body absorbs a stretched row's slack (see `card`), and its
				// own rows must keep their content height instead of spreading
				// that slack between themselves.
				alignContent: "start",
			},
			cardName: {
				fontWeight: 700, fontSize: 15, color: T.text, textDecoration: "none",
				overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%",
			},
			cardAuthor: {
				display: "flex", gap: 6, alignItems: "center", fontSize: 12,
				color: T.text2, minWidth: 0, marginBottom: 4,
			},
			// The author row's own tail: the separator and the version the
			// source published, both muted so the author name stays the anchor.
			cardDot: { color: T.text4 },
			cardVer: { color: T.text4 },
			// The prototype's GitHub mark, beside the title. Muted at rest so it
			// never competes with the name, and never a second click target for
			// the card body — the anchor stops propagation in its handler.
			ghIcon: {
				display: "inline-flex", alignItems: "center", flexShrink: 0,
				color: T.text3, textDecoration: "none",
			},
			statRow: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", fontSize: 12, color: T.text3 },
			stat: { display: "inline-flex", gap: 3, alignItems: "center", textDecoration: "none", color: "inherit" },
			statB: { fontWeight: 600, color: T.text2 },
			statSep: { color: T.text4 },
			desc: {
				fontSize: 13, lineHeight: 1.6, color: T.text2,
				display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden",
				// A URL is one unbreakable token: without this, a long one in a
				// catalogue description is clipped by the 3-line clamp instead
				// of wrapping. The probe in tools/shot.mjs injects one, and it
				// measured this box's min-content at well under a column, so
				// this is belt-and-braces for what a reader sees — the wall's
				// own overflow is fixed by the `minWidth: 0` chain above.
				overflowWrap: "anywhere",
			},
			tags: { display: "flex", gap: 6, flexWrap: "wrap" },
			// v4's tag is an outline pill, not a filled one: the card already
			// carries one filled element (its install button) and nothing else
			// should read as a control.
			tag: {
				fontSize: 11.5, padding: "3px 9px", borderRadius: 999,
				border: `1px solid ${T.line}`, background: "transparent", color: T.text2,
			},
			// The two chips that answer questions (分类 / 安装方式) sit a shade
			// darker than the upstream tags beside them, so the footer reads as
			// "two facts, then whatever else the source said".
			tagKind: { background: T.soft, color: T.text, fontWeight: 500 },
			// `#12` — the place in the current ranking. Tabular figures so a
			// column of ranks lines up, muted so it never competes with 分类.
			rank: {
				fontWeight: 600, color: T.text3, background: "transparent",
				fontVariantNumeric: "tabular-nums", letterSpacing: ".02em",
			},
			verified: {
				fontSize: 11, padding: "1px 7px", borderRadius: 999, fontWeight: 600,
				background: "rgba(22,95,255,0.12)", color: T.blue,
			},
			deprecated: {
				fontSize: 11, padding: "1px 7px", borderRadius: 999, fontWeight: 600,
				background: "rgba(255,125,0,0.14)", color: T.amber,
			},
			warnLine: { fontSize: 11, lineHeight: 1.5, color: T.amber },
			installed: {
				fontSize: 11, padding: "1px 7px", borderRadius: 999, fontWeight: 600,
				background: "rgba(0,180,42,0.12)", color: T.green,
			},
			// The card's preview strip: real repository pictures, scrolled by
			// hand at each image's own aspect ratio. The nav buttons float over
			// the strip's edges, so inline styles cannot express them.
			mediaRow: { position: "relative", minWidth: 0 },
			mediaBlock: { display: "grid", gap: 0, minWidth: 0 },
			mediaStrip: {
				display: "flex", gap: 8, alignItems: "stretch", overflowX: "auto",
				scrollSnapType: "x mandatory", paddingBottom: 2, minWidth: 0,
				scrollbarWidth: "none",
			},
			mediaSlide: {
				flexShrink: 0, borderRadius: 10, overflow: "hidden", scrollSnapAlign: "start",
				border: `1px solid ${T.line2}`, background: T.soft, display: "block",
			},
			mediaImg: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
			// v4's scroll indicator: a 3px track with a thumb that tracks the
			// strip, so "there are more pictures to the right" is visible
			// without spending a row of the card on a scrollbar.
			mediaBar: { height: 3, borderRadius: 99, background: T.soft2, marginTop: 8, overflow: "hidden" },
			mediaBarThumb: {
				display: "block", height: "100%", borderRadius: 99, background: T.text4,
				transition: "transform .12s ease",
			},
			mediaNav: {
				position: "absolute", top: "50%", transform: "translateY(-60%)", zIndex: 2,
				width: 24, height: 24, padding: 0, borderRadius: "50%", cursor: "pointer",
				display: "grid", placeItems: "center", fontSize: 15, lineHeight: 1,
				border: `1px solid ${T.line}`, background: T.cardBg, color: T.text2,
				boxShadow: "0 1px 4px rgba(0,0,0,0.14)",
			},
			// v4 shows the transport as one small chip and keeps the exact
			// command for the detail panel: a card is a summary, and a wall of
			// monospace on every card is not a summary. `title` still answers
			// "what would this run" without leaving the card.
			compat: { marginTop: 2, minWidth: 0 },
			compatCode: {
				display: "inline-block", padding: "3px 8px", borderRadius: 6,
				border: `1px solid ${T.line}`, background: T.soft, color: T.text3,
				fontSize: 11.5, lineHeight: 1.4,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			},
			// v4 draws no rule between a card's content and its footer: the tags
			// and the two icon buttons simply share the last line.
			cardFt: {
				display: "flex", gap: 8, alignItems: "center", justifyContent: "space-between",
				marginTop: 2,
			},
			iconBtn: {
				padding: "4px 6px", borderRadius: 6, display: "grid", placeItems: "center",
				cursor: "pointer", fontSize: 12, lineHeight: 1,
				border: "none", background: "transparent", color: T.text3,
			},
			// ---- detail panel (v4: one white sheet, facts as plain rows) ----
			overlay: {
				position: "fixed", inset: 0, zIndex: 50, display: "grid", placeItems: "center",
				background: "rgba(0,0,0,0.40)", padding: 28, overflow: "auto",
			},
			detailPanel: {
				width: "min(680px, 100%)", maxHeight: "100%", overflow: "auto",
				display: "grid", gap: 14, padding: 22,
				borderRadius: 16, border: `1px solid ${T.line}`,
				background: T.cardBg, color: T.text,
				boxShadow: "0 24px 64px rgba(0,0,0,0.14)",
			},
			// v4's panel head is not a separate band: it shares the sheet's
			// background and padding, so the whole panel reads as one surface.
			detailHead: { display: "grid", gap: 10 },
			detailIdentity: { display: "flex", gap: 12, alignItems: "flex-start", minWidth: 0 },
			detailTitle: { fontWeight: 700, fontSize: 17, lineHeight: 1.3, minWidth: 0 },
			detailSub: { fontSize: 12, color: T.text3, marginTop: 2 },
			detailTitleRow: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", minWidth: 0 },
			detailDesc: {
				fontSize: 13.5, lineHeight: 1.65, margin: 0, whiteSpace: "pre-wrap", color: T.text2,
				// Same reason as `desc`: the panel is narrower than the page,
				// and one long URL must not widen it.
				overflowWrap: "normal",
			},
			detailBody: { display: "grid", gap: 14 },
			// Facts sit directly on the sheet as label/value rows — no tinted
			// box, because the GitHub box below is the one block that earns a
			// background.
			detailFacts: { display: "grid", gap: 6, fontSize: 12.5 },
			detailRow: { display: "flex", gap: 12 },
			detailKey: { color: T.text3, minWidth: 76, flexShrink: 0 },
			detailVal: { minWidth: 0, wordBreak: "break-word", color: T.text2 },
			detailLinks: { display: "flex", gap: 8, flexWrap: "wrap" },
			linkChip: {
				padding: "5px 12px", borderRadius: 999, fontSize: 12, textDecoration: "none",
				border: `1px solid ${T.line}`, color: T.text2, background: T.cardBg,
			},
			detailActions: {
				display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap",
				paddingTop: 14, borderTop: `1px solid ${T.line2}`,
			},
			cmdBox: {
				display: "grid", gap: 4, padding: "10px 12px", borderRadius: 8,
				border: `1px solid ${T.line}`, background: T.soft,
			},
			cmd: {
				fontSize: 12, color: T.text2, userSelect: "all",
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
				wordBreak: "break-all",
			},
			ghBox: {
				display: "grid", gap: 10, padding: 14, borderRadius: 12,
				border: `1px solid ${T.line}`, background: T.soft,
			},
			ghHead: { fontWeight: 600, fontSize: 11, color: T.text3, letterSpacing: 0.6 },
			ghRepo: { fontWeight: 600, fontSize: 14, color: T.brand, textDecoration: "none" },
			ghStats: { display: "flex", gap: 20, flexWrap: "wrap" },
			// v4 stacks each GitHub number over its label.
			ghStat: { display: "flex", flexDirection: "column", gap: 2, fontSize: 13 },
			ghStatNum: { fontWeight: 700, fontSize: 15, color: T.text },
			ghStatLab: { color: T.text3, fontSize: 11 },
			message: { fontSize: 13, color: T.text2 },
			error: { fontSize: 13, color: "#f53f3f" },
			hint: { fontSize: 12, color: T.text3 },
			// v4's `.note`: the page's closing footnote, ruled off from the
			// content above it.
			note: {
				marginTop: 28, paddingTop: 14, borderTop: `1px solid ${T.line}`,
				fontSize: 12, color: T.text3, lineHeight: 1.7,
			},
		};

		/** Small toggle switch mirroring the Skills Manager group switches. */
		function Switch({ on, disabled, onToggle, title }) {
			return createElement("button", {
				type: "button", title, role: "switch",
				"aria-checked": on ? "true" : "false",
				disabled,
				onClick: (event) => { event.stopPropagation(); onToggle(); },
				style: {
					width: 38, height: 21, flexShrink: 0, cursor: disabled ? "default" : "pointer",
					borderRadius: 999, border: "none", padding: 2, position: "relative",
					background: on ? "#22a55b" : "rgba(128,128,128,0.45)", transition: "background 120ms ease",
				},
			}, createElement("span", {
				style: {
					display: "block", width: 17, height: 17, borderRadius: "50%", background: "#fff",
					transform: on ? "translateX(17px)" : "translateX(0)", transition: "transform 120ms ease",
				},
			}));
		}

		function ServerRow({ server, busy, onToggle, onRemove, onUpdate }) {
			const enabled = server.enabled !== false;
			const provided = server.providedExternally === true;
			const state = provided ? "external" : enabled ? (server.connected ? "on" : "idle") : "off";
			const status = server.error ? `连接失败：${server.error}`
				: provided ? "已由其他插件提供（跳过重复挂载）"
					: enabled ? (server.connected ? "已连接" : "未连接") : "已停用";
			const prefix = server.serverName ? `工具前缀 mcp__${server.serverName}__` : "";
			const pkg = server.package ? `${server.package.name}@${server.package.version ?? "latest"}` : "";
			const update = server.update;
			const newVersion = update?.updateAvailable ? update.latest : null;
			return createElement("div", { style: styles.row }, [
				createElement("span", { key: "dot", style: styles.dot(state) }),
				createElement("span", { key: "name", style: styles.name }, server.name),
				createElement("span", { key: "meta", style: styles.meta },
					[server.transport, status, prefix, pkg].filter(Boolean).join(" · ")),
				newVersion
					? createElement("span", { key: "newv", style: styles.updateBadge }, `可更新 → ${newVersion}`)
					: null,
				createElement("span", { key: "actions", style: { display: "flex", gap: 6, alignItems: "center", ...styles.spacer } }, [
					newVersion
						? createElement("button", {
								key: "update", type: "button",
								style: { ...styles.button, ...styles.primary }, disabled: busy,
								onClick: () => onUpdate(server.name),
							}, "更新")
						: null,
					createElement("button", {
						key: "toggle", type: "button", style: styles.button, disabled: busy,
						onClick: () => onToggle(server.name, !enabled),
					}, enabled ? "停用" : "启用"),
					createElement("button", {
						key: "remove", type: "button", style: styles.button, disabled: busy,
						onClick: () => onRemove(server.name),
					}, "移除"),
				]),
			]);
		}

		function SourceGroup({ source, servers, busy, collapsed, onToggleCollapsed, onToggleSource, onToggleServer, onRemove, onUpdate }) {
			const enabledCount = servers.filter((s) => s.enabled !== false).length;
			const allOn = enabledCount === servers.length && servers.length > 0;
			return createElement("div", { style: styles.group }, [
				createElement("div", {
					key: "head", style: { ...styles.groupHead, cursor: "pointer" },
					onClick: onToggleCollapsed,
				}, [
					createElement("span", { key: "chev", style: styles.meta }, collapsed ? "▸" : "▾"),
					createElement("span", { key: "title", style: styles.groupTitle }, sourceLabel(source)),
					createElement("span", { key: "count", style: styles.badge },
						`${servers.length} 个 · ${enabledCount} 已启用`),
					createElement("span", { key: "switch", style: { ...styles.spacer, display: "flex", alignItems: "center", gap: 8 } }, [
						createElement("span", { key: "label", style: styles.meta }, allOn ? "全部停用" : "全部启用"),
						createElement(Switch, {
							key: "sw", on: allOn, disabled: busy,
							title: allOn ? "停用该来源的全部服务器" : "启用该来源的全部服务器",
							onToggle: () => onToggleSource(source, !allOn),
						}),
					]),
				]),
				collapsed ? null : createElement("div", { key: "body", style: styles.groupBody },
					servers.map((server) => createElement(ServerRow, {
						key: server.name, server, busy,
						onToggle: onToggleServer, onRemove, onUpdate,
					}))),
			]);
		}

		/** One marketplace entry, rendered as a dsh-market-style card. */
		/**
		 * Injects hover/transition rules once. Inline styles cannot express
		 * :hover or keyframes, and a market with no hover feedback reads dead;
		 * these classes only decorate — every layout fact stays inline, so the
		 * component still renders correctly if the sheet never loads.
		 */
		function ensureStyles() {
			if (typeof document === "undefined" || document.getElementById("omkt-styles")) return;
			const el = document.createElement("style");
			el.id = "omkt-styles";
			el.textContent = [
				// Cards lift on hover; the border takes the accent so the lift
				// reads as "this is the thing under your cursor" and not as a
				// shadow the layout did not ask for.
				".omkt-card{transition:border-color .15s ease,box-shadow .15s ease}",
				// v4's card hover: a hair darker border and a soft lift, not an
				// accent-coloured outline. One accent per screen is the rule.
				".omkt-card:hover{border-color:#d4d4d4;box-shadow:0 4px 14px rgba(0,0,0,.06)}",
				".omkt-card:focus-visible{outline:2px solid #4d6bfe;outline-offset:2px}",
				".omkt-title{color:inherit;text-decoration:none}",
				".omkt-title:hover{color:#4d6bfe}",
				".omkt-btn,.omkt-link{transition:border-color .12s ease,background .12s ease,color .12s ease}",
				// The tab underline, drawn here instead of as an inline border on
				// each tab: `border-bottom: 2px solid transparent` on the
				// *inactive* tab rendered black in the app (the UA button border
				// colour), so both tabs looked selected. A transparent pseudo
				// element is inert until the tab is selected, and `aria-selected`
				// is the state a screen reader announces too.
				".omkt-tab{position:relative;text-decoration:none;border:0}",
				".omkt-tab::after{content:\"\";position:absolute;left:0;right:0;bottom:0;height:2px;"
					+ "background:transparent;border-radius:2px}",
				`.omkt-tab[aria-selected="true"]::after{background:${T.text}}`,
				// Two tabs never overflow, so the bar's scroll container is only
				// there for a future third one: keep its scrollbar out of the
				// layout either way.
				".omkt-tabbar{scrollbar-width:none}",
				".omkt-select{cursor:pointer;transition:border-color .12s ease}",
				// These need `!important`: every one of these controls carries its
				// border inline (so it can flip with the theme), and an inline
				// declaration beats a class rule — without it the hover/focus
				// feedback below silently never painted.
				".omkt-select:hover{border-color:rgba(128,128,128,.55) !important}",
				`.omkt-select-on,.omkt-select-on:hover{border-color:${T.text} !important;color:${T.text} !important}`,
				// Focus has to be visible: the resting border is 1px of hairline
				// grey, and a keyboard user tabbing through the filter row had no
				// way to see which control was live. The market search box has no
				// border of its own (the pill draws it), so the *pill* takes the
				// ink when the input inside it is focused.
				`.omkt-select:focus-visible,.omkt-input:focus-visible{outline:2px solid ${T.text};outline-offset:1px}`,
				`.omkt-search:has(.omkt-input:focus-visible){border-color:${T.text} !important}`,
				".omkt-input:focus{border-color:rgba(128,128,128,.55) !important}",
				".omkt-btn:hover{border-color:rgba(128,128,128,.75)}",
				// The primary button's *colours* live inline (ink background,
				// surface foreground — they flip with the theme). Nothing here
				// may set background or color or it would either lose to the
				// inline style or, worse, win in one theme only.
				".omkt-btn-primary:hover{opacity:.85}",
				".omkt-btn-text{transition:opacity .12s ease}",
				".omkt-btn-text:hover{opacity:.7}",
				".omkt-btn-outline:hover{background:rgba(128,128,128,.10)}",
				".omkt-btn:disabled{opacity:.55;cursor:default}",
				// A flex item inside a *scroll container* (or any non-visible
				// `overflow`) loses its content-based automatic minimum size, so
				// its default `flex-shrink: 1` can squash it to nothing. The page
				// learned that the hard way: with the tall market body the tab bar
				// was the cheapest item to shrink, collapsed to its own 1px border
				// and made「MCP 市场」a one-way door. Every chrome row is therefore
				// pinned at its own height; the two boxes that are *meant* to give
				// height back (the tab body and the card scroller) say so inline
				// with `flex: 1 1 auto`, which outranks this rule.
				".omkt-page > *,.omkt-tabbody > *{flex-shrink:0;min-width:0}",
				// v4's breakpoints for the card wall. Inline `repeat(2, …)` is
				// the fallback; these rules only ever *raise* or *lower* the
				// count, hence !important — nothing else can beat an inline
				// style, and without this the wall would stay two columns on a
				// wide pane.
				//
				// Container queries only, deliberately: this page is a slice of
				// the window, so the question is how much room the grid got,
				// never how wide the window is. A `@media (min-width:1100px)`
				// fallback used to sit here over the container pair, and it was
				// the wrong answer as soon as the page left the settings dialog
				// for a sidebar panel: it read the *window*, so a 1600px window
				// laid three columns into a pane with room for two and pushed
				// the wall into a horizontal scrollbar. A renderer without
				// container support now keeps the inline two columns, which is
				// the answer that cannot overflow.
				//
				// `minmax(0, 1fr)` and not `1fr`: a bare `1fr` floors each track
				// at its item's min-content, which is how a single long URL used
				// to widen the whole wall.
				".omkt-grid{grid-template-columns:repeat(2,minmax(0,1fr))}",
				"@container (max-width:719px){.omkt-grid{grid-template-columns:repeat(1,minmax(0,1fr))!important}}",
				"@container (min-width:720px) and (max-width:1099px){.omkt-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}}",
				"@container (min-width:1100px){.omkt-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important}}",
				".omkt-icon:hover{background:rgba(128,128,128,.14)}",
				// The GitHub mark beside a card title: inked on hover only, so a
				// list of cards stays quiet but the repo is always one click away.
				".omkt-gh{transition:color .12s ease}",
				".omkt-gh:hover{color:#4d6bfe}",
				".omkt-icon-on{color:#f53f3f}",
				".omkt-icon-on:hover{background:rgba(245,63,63,.12);color:#f53f3f}",
				".omkt-link:hover{border-color:#4d6bfe;color:#4d6bfe}",
				".omkt-panel{animation:omkt-in .16s ease}",
				// The preview strip hides its scrollbar (the nav buttons do the
				// scrolling) and fades each image in as it decodes, so a strip of
				// README screenshots never pops in as a wall of pixels.
				".omkt-media::-webkit-scrollbar{display:none}",
				".omkt-media-slide img{animation:omkt-fade .2s ease}",
				".omkt-media-nav:hover{background:rgba(128,128,128,.16)}",
				"@keyframes omkt-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}",
				"@keyframes omkt-fade{from{opacity:0}to{opacity:1}}",
			].join("\n");
			document.head.appendChild(el);
		}

		/**
		 * One big number + small label, for the GitHub stat row.
		 *
		 * `raw` renders the value verbatim — the licence is a word, and
		 * "MIT → 1" out of `compact()` would be a lie about a legal term.
		 */
		function ghStat(label, value, raw) {
			return createElement("span", { style: styles.ghStat }, [
				createElement("b", { key: "n", style: styles.ghStatNum }, raw ? String(value) : compact(value)),
				createElement("span", { key: "l", style: styles.ghStatLab }, label),
			]);
		}

		/**
		 * Catalogue text as prose. The registries publish markdown, and these
		 * two views are not markdown renderers: `[Brave Search API
		 * dashboard](https://…)` used to reach a card verbatim, where the URL
		 * says nothing a reader needs and the link syntax reads as noise. The
		 * label is what the sentence was about, so the label is what stays.
		 *
		 * Line breaks are preserved — the detail panel shows the upstream's own
		 * paragraphing (`whiteSpace: pre-wrap`), and the card flattens what it
		 * clamps. A bare URL is left in place; it is the sentence's citation,
		 * and both views break it (see `overflowWrap` below).
		 */
		function plainText(text) {
			return String(text ?? "")
				// [label](url) -> label, tolerating a URL that contains spaces.
				.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
				// <https://…> autolinks -> the URL itself.
				.replace(/<((?:https?|mailto):[^>]*)>/g, "$1")
				// Bold and inline-code markers. Single `*`/`_` are left alone:
				// they are emphasis in markdown but a literal in identifiers
				// like `snake_case`, and guessing wrong mangles the name.
				.replace(/\*\*|__|`/g, "");
		}

			/**
			 * The card's preview strip: the repository's own pictures.
			 *
			 * v4 puts a carousel under the description, and the plugin market
			 * fills that slot with screenshots. No MCP catalogue publishes one,
			 * so the strip shows what the repo itself offers — README
			 * screenshots first, GitHub's generated social card when the README
			 * has none. Horizontal scroll at each image's own aspect ratio,
			 * never auto-advancing: a screenshot is something you choose to
			 * look at, not something that changes while you read.
			 *
			 * A repo with neither renders nothing at all. No placeholder, no
			 * invented graphic — an empty slot is honest and a fake one is not.
			 */
			function MediaStrip({ media, height = 166 }) {
				const strip = useRef(null);
				const [progress, setProgress] = useState(0);
				const slides = media?.images?.length
					? media.images
					: media?.og
						? [{ url: media.og, alt: "GitHub 仓库预览图" }]
						: [];
				if (!slides.length) return null;
				const scrollBy = (dir) => {
					const node = strip.current;
					if (node) node.scrollBy({ left: dir * node.clientWidth * 0.8, behavior: "smooth" });
				};
				// v4 draws a 3px progress bar under every carousel. It is the only
				// thing that tells you the strip scrolls at all once the
				// scrollbar is hidden, so it tracks the real scroll offset.
				const onScroll = (event) => {
					const node = event.currentTarget;
					const max = node.scrollWidth - node.clientWidth;
					setProgress(max > 0 ? Math.min(1, Math.max(0, node.scrollLeft / max)) : 0);
				};
				const thumb = Math.max(Math.round(100 / slides.length), 18);
				return createElement("div", { key: "media", style: styles.mediaBlock }, [
					createElement("div", { key: "row", style: styles.mediaRow }, [
						slides.length > 1
							? createElement("button", {
								key: "prev", type: "button", className: "omkt-media-nav", style: { ...styles.mediaNav, left: 4 },
								title: "上一张", "aria-label": "上一张",
								onClick: (e) => { e.stopPropagation(); scrollBy(-1); },
							}, "‹")
							: null,
						createElement("div", {
							key: "strip", ref: strip, className: "omkt-media", style: { ...styles.mediaStrip, height },
							onClick: (e) => e.stopPropagation(),
							onScroll,
						}, slides.map((slide, i) => createElement(MediaSlide, {
							key: slide.url, slide, height, index: i,
						}))),
						slides.length > 1
							? createElement("button", {
								key: "next", type: "button", className: "omkt-media-nav", style: { ...styles.mediaNav, right: 4 },
								title: "下一张", "aria-label": "下一张",
								onClick: (e) => { e.stopPropagation(); scrollBy(1); },
							}, "›")
							: null,
					].filter(Boolean)),
					slides.length > 1
						? createElement("div", { key: "bar", style: styles.mediaBar },
							createElement("i", {
								style: {
									...styles.mediaBarThumb,
									width: `${thumb}%`,
									transform: `translateX(${Math.round(progress * (100 - thumb) / thumb * 100)}%)`,
								},
							}))
						: null,
				].filter(Boolean));
			}

			/**
			 * One picture in the strip.
			 *
			 * The image is fetched through a resize proxy first (the same one
			 * the plugin market uses) because README images are routinely
			 * several megabytes, and falls back to the original URL when the
			 * proxy is unreachable. A slide that fails on both is removed from
			 * the strip rather than left as a broken frame.
			 */
			function MediaSlide({ slide, height, index }) {
				const [src, setSrc] = useState(() => thumbUrl(slide.url, Math.round(height * 2)));
				const [failed, setFailed] = useState(false);
				const [box, setBox] = useState(null);
				if (failed) return null;
				return createElement("span", {
					className: "omkt-media-slide", title: slide.alt || undefined,
					style: {
						...styles.mediaSlide,
						height,
						width: box ? Math.round(height * box) : Math.round(height * 1.6),
					},
				}, createElement("img", {
					src, alt: slide.alt || "仓库预览图", loading: index < 3 ? "eager" : "lazy", decoding: "async",
					style: styles.mediaImg,
					onLoad: (e) => {
						const img = e.currentTarget;
						if (img.naturalWidth && img.naturalHeight) setBox(img.naturalWidth / img.naturalHeight);
					},
					onError: () => {
						// The proxy failed once; the original URL may still answer.
						if (src !== slide.url) setSrc(slide.url);
						else setFailed(true);
					},
				}));
			}

			/** The plugin market's resize proxy: same host, same parameters. */
			function thumbUrl(url, h = 260) {
				return `https://images.weserv.nl/?url=${encodeURIComponent(String(url).replace(/^https?:\/\//, ''))}&h=${h}&fit=inside&we=1`;
			}

		/**
		 * One marketplace entry, rendered as a dsh-market-style card (v4).
		 *
		 * The whole card is the detail entry point, and the NAME is the front
		 * door: a real anchor that navigates to the repository / upstream site /
		 * registry listing, in that order. The body is a `div role=button`
		 * rather than a `<button>` because HTML forbids interactive content
		 * inside a button — that nesting is what once made the card's links
		 * race its click handler and "not go anywhere".
		 */
		function MarketCard({ item, stats, media, busy, rank, onInstall, onOpen, onToggleFavorite }) {
			const repo = repoKeyOf(item);
			const enriched = repo ? (stats ?? {})[repo] : null;
			const repoMedia = repo ? (media ?? {})[repo] : null;
			const stars = starCountOf(item, stats);
			const author = enriched?.author ?? item.author;
			const description = item.description || enriched?.description || "（无描述）";
			// Upstream tags are *labels the source chose*, and the sources label
			// very different things with them (Smithery writes 「托管」/「本地」,
			// the official registry writes the package manager, awesome lists
			// write their own `###` heading plus legend flags). The footer leads
			// with the two answers a reader actually wants — which functional
			// group this is, and how it gets installed — and only then shows the
			// upstream tags that say something the two chips do not.
			// The 分类 chip is always present. Both Smithery and the official
			// registry publish no category at all (checked against their live
			// payloads: neither carries a category/keywords field), so those
			// entries are honestly labelled 未分类 — the same bucket the 分类
			// filter puts them in. Leaving the chip off instead made the footer
			// read "only an install method", which is what the user reported as
			// 「要有这个MCP的分类」.
			const groupChip = (item.group && item.group !== "__none__")
				? item.group
				: (item.category || "未分类");
			const groupTitle = [item.group, item.category].filter(Boolean)
				.filter((v, i, arr) => arr.indexOf(v) === i).join(" · ");
			const runnerOf = (command) => {
				const cmd = String(command ?? "");
				if (/(^|[\\/ ])npx(\.cmd)?\b/i.test(cmd)) return "npx";
				if (/(^|[\\/ ])uvx(\.exe)?\b/i.test(cmd)) return "uvx";
				if (/(^|[\\/ ])(python[0-9.]*|py)(\.exe)?\b/i.test(cmd)) return "python";
				if (/(^|[\\/ ])node(\.exe)?\b/i.test(cmd)) return "node";
				if (/(^|[\\/ ])docker(\.exe)?\b/i.test(cmd)) return "docker";
				return null;
			};
			const installTransport = item.install?.transport ?? item.transport ?? null;
			const installRunner = item.install ? runnerOf(item.install.command) : null;
			const installChip = !item.install
				? (item.installable ? "可一键安装" : "需手动配置")
				: installTransport === "stdio"
					? `stdio · ${installRunner ?? "本地命令"}`
					: "远程 · 免安装";
			const installTitle = item.install
				? [installTransport, item.install.command, item.install.url].filter(Boolean).join(" ")
				: installChip;
			const CHIP_ALREADY_SHOWN = new Set(["托管", "本地", "npm", "pypi"]);
			const tags = [...(item.tags ?? []), ...((enriched?.topics ?? []).slice(0, 3))]
				.filter((t, i, arr) => t && arr.indexOf(t) === i)
				// `groupChip` already says the group, and `category` is its
				// tooltip: repeating either one as an upstream tag would print the
				// same word twice in a two-inch row.
				.filter((t) => !CHIP_ALREADY_SHOWN.has(t) && t !== item.category && t !== groupChip)
				.slice(0, 3);
			// Smithery's repository field is its own listing when the upstream
			// project is unknown, so that listing is the honest front door too.
			const registryPage = item.source === "smithery" && item.qualifiedName
				? `https://smithery.ai/servers/${item.qualifiedName}`
				: null;
			const homepage = enriched?.homepage || item.homepage || null;
			const titleHref = item.repository
				|| (homepage && homepage !== item.repository ? homepage : null)
				|| registryPage
				|| null;
			// Transport is a fact like any other: the card states how this
			// server reaches the machine, because "local process" and "remote
			// endpoint" are different trust decisions.
			const transport = item.transport && item.transport !== "unknown"
				? item.transport === "stdio" ? "本地进程（stdio）" : "远程端点（streamable-http）"
				: null;
			const updatedAt = enriched?.pushedAt ?? item.updatedAt ?? null;
			// v4's compatibility chip: the transport in three words, in the slot
			// where the card used to print an entire shell command.
			const transportChip = item.transport && item.transport !== "unknown"
				? item.transport === "stdio" ? "MCP · stdio" : "MCP · remote"
				: "MCP";

			const installCmd = item.install
				? item.install.transport === "stdio"
					? [item.install.command, ...(item.install.args ?? [])].join(" ")
					: item.install.url
				: null;

			return createElement("article", {
				className: "omkt-card", style: styles.card,
				title: `${item.title}${author ? ` · @${author}` : ""}`,
			}, [
				// The clickable surface. It is a `div role=button` rather than a
				// `<button>`: HTML forbids interactive content inside a button,
				// and that nesting is what once made the card's own links race
				// its click handler and "not go anywhere". Everything a click
				// can act on lives outside this div — the CTA column and the
				// footer below.
				createElement("div", {
					key: "body", style: styles.cardBody, role: "button", tabIndex: 0,
					onClick: () => onOpen(item),
					onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(item); } },
				}, [
					// 1. header: identity on the left, the two things you came
					//    for on the right.
					createElement("div", { key: "hd", style: styles.cardHd }, [
						createElement("div", { key: "left", style: styles.cardLeft }, [
							// name row: the title is the anchor; the source tag
							// names where the entry came from, because five
							// catalogs feed one list.
							createElement("div", { key: "head", style: styles.cardHead }, [
								titleHref
						? createElement("a", {
							key: "t", className: "omkt-title", href: titleHref,
							target: "_blank", rel: "noreferrer", title: titleHref,
							style: styles.cardName,
							onClick: (e) => e.stopPropagation(),
						}, item.title)
						: createElement("span", { key: "t", style: styles.cardName, title: item.title }, item.title),
					// The repository, one click from the card itself. Only for
					// entries whose repository really is a GitHub repo: for
					// Smithery that field points at its own listing, which is
					// not what a GitHub mark promises.
					repo && item.repository
						? createElement("a", {
							key: "gh", className: "omkt-gh", href: item.repository,
							target: "_blank", rel: "noreferrer", title: `GitHub 仓库：${repo}`,
							"aria-label": `GitHub 仓库：${repo}`, style: styles.ghIcon,
							onClick: (e) => e.stopPropagation(),
						}, githubMark(14))
						: null,
					item.verified ? createElement("span", { key: "v", style: styles.verified, title: "上游已认证" }, "✓ 认证") : null,
					item.official ? createElement("span", { key: "o", style: styles.badge }, "官方") : null,
					item.installed ? createElement("span", { key: "inst", style: styles.installed }, "已安装") : null,
					// A lifecycle flag the upstream actually published. Only
					// `deprecated` is stated; an absent status is NOT shown as
					// active, because for two of the five sources nobody scanned.
					item.deprecated
						? createElement("span", { key: "dep", style: styles.deprecated, title: item.statusMessage || "上游已标记为废弃" }, "已废弃")
						: null,
				].filter(Boolean)),

				// 2. author row — and, when the source published one, the
				//    version. It rides here rather than in the stat row because
				//    "whose is this and which build" is one thought.
				createElement("div", { key: "author", style: styles.cardAuthor }, [
					createElement(Avatar, { key: "av", item, author, size: 18, src: item.icon ?? enriched?.avatar }),
					// v4 writes the author bare: the avatar already says
					// "account", and an @ on every card is one glyph of noise.
					createElement("span", { key: "n", title: author ? `@${author}` : undefined },
						author || "作者未标注"),
					item.version
						? [
							createElement("span", { key: "d", style: styles.cardDot }, "·"),
							createElement("span", { key: "v", style: styles.cardVer, title: `版本 ${item.version}` },
								`v${item.version}`),
						]
						: null,
				].filter(Boolean)),

				// 3. stat row — every number is a link when it has one, so a
				//    figure is never a dead end. Separators are part of the list
				//    rather than CSS margins, so the row can wrap without the
				//    dots ending up stranded at a line start. The catalogue's own
				//    name ends the row: it answers "where did this come from",
				//    which is a footnote, not a badge.
				(() => {
					const cells = [
						typeof item.installs === "number"
							? createElement("span", { key: "in", style: styles.stat, title: item.installsLabel || "使用量" }, [
								createElement("span", { key: "g" }, "↓"),
								createElement("b", { key: "n", style: styles.statB }, compact(item.installs)),
								item.installsLabel
									? createElement("span", { key: "l", style: styles.statSep }, ` ${item.installsLabel}`)
									: null,
							])
							: null,
						typeof stars === "number"
							? createElement("a", {
								key: "st", className: "omkt-link", style: styles.stat, href: item.repository || "#",
								target: "_blank", rel: "noreferrer", title: "GitHub Star",
								onClick: (e) => e.stopPropagation(),
							}, [
								createElement("span", { key: "g" }, "★"),
								createElement("b", { key: "n", style: styles.statB }, compact(stars)),
							])
							: null,
						typeof enriched?.forks === "number"
							? createElement("span", { key: "fk", style: styles.stat, title: "GitHub Fork" }, [
								createElement("span", { key: "g" }, "⑂"),
								createElement("b", { key: "n", style: styles.statB }, compact(enriched.forks)),
							])
							: null,
						enriched?.license
							? createElement("span", { key: "lic", style: styles.stat, title: "开源许可证" }, enriched.license)
							: null,
						updatedAt
							? createElement("span", { key: "up", style: styles.stat, title: "最近更新" },
								`更新于 ${String(updatedAt).slice(0, 10)}`)
							: null,
						createElement("span", { key: "src", style: styles.stat },
							SOURCE_LABELS[`catalog:${item.source}`] ?? item.source),
					].filter(Boolean);
					if (!cells.length) return null;
					return createElement("div", { key: "stats", style: styles.statRow },
						cells.flatMap((cell, i) => (i === 0 ? [cell] : [
							createElement("span", { key: `s${i}`, style: styles.statSep }, "·"),
							cell,
						])));
				})(),
					]), // left column (name / author / stats)
					// Right column: the primary action plus a shortcut into the
					// detail panel. Buttons, not links — nothing navigates here.
					createElement("div", { key: "cta", style: styles.cardCta }, [
						item.installed
							? createElement("span", { key: "i", style: styles.installed }, "已安装")
							: item.installable
								? createElement("button", {
									key: "install", type: "button", className: "omkt-btn omkt-btn-primary",
									style: { ...styles.button, ...styles.primary, padding: "6px 14px", fontSize: 13, fontWeight: 600 },
									disabled: busy,
									onClick: (e) => { e.stopPropagation(); onInstall(item); },
								}, busy ? "处理中…" : item.deprecated ? "仍要安装" : "安装")
								: createElement("span", { key: "m", style: styles.hint }, "需手动配置"),
						createElement("button", {
							key: "detail", type: "button", className: "omkt-btn omkt-btn-text",
							style: { ...styles.textBtn, fontSize: 12 },
							onClick: (e) => { e.stopPropagation(); onOpen(item); },
						}, "详情"),
					]),
				]), // header

				// 4. description, clamped to three lines so every card in a
				//    column keeps the same silhouette. `data-omkt` is the hook
				//    the frame probe in tools/shot.mjs uses to inject an
				//    unbreakable URL and prove the column still fits.
				createElement("div", { key: "desc", "data-omkt": "desc", style: styles.desc },
					plainText(description).replace(/\s+/g, " ").trim().slice(0, 160)),

				// The upstream's own words, when it deprecated this entry.
				item.deprecated && item.statusMessage
					? createElement("div", { key: "why", style: styles.warnLine }, `上游说明：${item.statusMessage}`)
					: null,

				// 5. the repository's own pictures, in the carousel slot v4
				//    reserves for a preview — README screenshots first, GitHub's
				//    social card when there are none.
				createElement(MediaStrip, { key: "media", media: repoMedia }),

				// 6. the compatibility chip: what kind of thing this is, in the
				//    shape v4 gives it. The command it would run is one hover
				//    away and spelled out in the detail panel.
				createElement("div", { key: "compat", style: styles.compat },
					createElement("code", {
						key: "c", style: styles.compatCode,
						title: [transport, installCmd].filter(Boolean).join(" · ") || "该来源未公布安装方式",
					}, transportChip)),
				]), // body (clickable surface)

				// 7. footer: what this entry *is* and how it installs, then the
				//    actions a card can decide by itself on the right. It sits
				//    OUTSIDE the role=button body so starring or ⋯ never also
				//    opens the detail panel.
				createElement("div", { key: "ft", style: styles.cardFt }, [
					createElement("div", { key: "tags", style: { ...styles.tags, flex: 1, minWidth: 0 } }, [
						rank
							? createElement("span", {
								key: "rank", style: { ...styles.tag, ...styles.rank },
								title: `当前排序下的名次：第 ${rank} 名`,
							}, `#${rank}`)
							: null,
						createElement("span", {
							key: "group", style: { ...styles.tag, ...styles.tagKind },
							title: groupTitle
								? `分类：${groupTitle}`
								: "分类：该来源未发布功能分类，同上方的「未分类」筛选",
						}, groupChip),
						createElement("span", {
							key: "install", style: { ...styles.tag, ...styles.tagKind },
							title: `安装方式：${installTitle}`,
						}, installChip),
						...tags.map((t) => createElement("span", {
							key: t, style: styles.tag, title: `上游标签：${t}`,
						}, t)),
					].filter(Boolean)),
					createElement("span", { key: "acts", style: { display: "flex", gap: 4, flexShrink: 0 } }, [
						createElement("button", {
							key: "fav", type: "button",
							className: `omkt-icon${item.favorite ? " omkt-icon-on" : ""}`,
							style: styles.iconBtn,
							title: item.favorite ? "取消收藏" : "收藏",
							"aria-pressed": item.favorite ? "true" : "false",
							onClick: (e) => { e.stopPropagation(); onToggleFavorite(item); },
						}, item.favorite ? "♥" : "♡"),
						createElement("button", {
							key: "more", type: "button", className: "omkt-icon",
							style: styles.iconBtn, title: "查看详情",
							onClick: (e) => { e.stopPropagation(); onOpen(item); },
						}, "⋯"),
					]),
				]),
			]);
		}


		/** `owner/repo` for a GitHub-backed card, else null (enrichment key). */
		function repoKeyOf(item) {
			const m = String(item?.repository ?? "").match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
			return m ? `${m[1]}/${m[2].replace(/\.git$/i, "")}` : null;
		}

		/**
		 * Quality score for one entry, shown as the "默认（综合推荐）" order.
		 *
		 * Provenance first (官方认证 > 已认证 > 官方实现 > 其余), then popularity.
		 * Popularity is deliberately last and log-scaled: the numbers come from
		 * three different sources with three different units, so they can break a
		 * tie but must never outrank a verified entry.
		 *
		 * @param stats the GitHub enrichment map — no catalog publishes stars, so
		 *   `item.stars` alone would make this term dead code.
		 */
		function qualityOf(item, stats) {
			let score = 0;
			if (item.verified) score += 400;
			if (item.official) score += 300;
			if (item.install) score += 120;
			if (typeof item.installs === "number") score += Math.min(200, Math.log10(item.installs + 1) * 40);
			const stars = starCountOf(item, stats);
			if (typeof stars === "number") score += Math.min(200, Math.log10(stars + 1) * 40);
			if (item.deprecated) score -= 500;
			return score;
		}

		/** Star count from the GitHub enrichment, falling back to the catalog's own. */
		function starCountOf(item, stats) {
			const repo = repoKeyOf(item);
			const enriched = repo ? stats?.[repo] : null;
			return enriched?.stars ?? item.stars;
		}

		/**
		 * Compare two market entries under a user-chosen sort.
		 *
		 * `default` is quality (above). The others each key on ONE field so the
		 * order is explainable, and every field falls back to quality rather than
		 * to 0 — an entry the source published no number for is not thereby the
		 * least popular one.
		 *
		 * For a descending sort an entry that HAS the number still outranks one
		 * that does not, so a missing value sorts last rather than tying with
		 * every real value and being resolved by quality alone.
		 */
		function compareMarket(a, b, sort, stats) {
			const qa = qualityOf(a, stats);
			const qb = qualityOf(b, stats);
			const desc = (x, y) => {
				const hasX = typeof x === "number";
				const hasY = typeof y === "number";
				if (hasX && hasY) return x !== y ? y - x : 0;
				if (hasX) return -1;   // a real number beats a missing one
				if (hasY) return 1;
				return 0;
			};
			switch (sort) {
				case "installs":
					return desc(a.installs, b.installs) || qb - qa;
				case "stars":
					return desc(starCountOf(a, stats), starCountOf(b, stats)) || qb - qa;
				case "updated": {
					const ta = Date.parse(a.updatedAt ?? "") || 0;
					const tb = Date.parse(b.updatedAt ?? "") || 0;
					return (tb - ta) || qb - qa;
				}
				case "name":
					return a.title.localeCompare(b.title) || qb - qa;
				default:
					return qb - qa;
			}
		}

		/**
		 * 5364 -> 5.3k, for the headline market total.
		 *
		 * Truncated rather than rounded: a rounded total can display a number
		 * larger than the real count (5364 -> "5.4k"), which reads as an
		 * overstatement when the user then pages through and finds 5.3k.
		 */
		function compactCount(n) {
			const v = Number(n);
			if (!Number.isFinite(v) || v < 1000) return String(v ?? 0);
			if (v >= 1e6) return `${Math.floor(v / 1e5) / 10}M`;
			return `${Math.floor(v / 100) / 10}k`;
		}

		/** 12345 -> 12.3k, for the compact star/usage counters (truncated). */
		function compact(n) {
			const v = Number(n) || 0;
			if (v >= 1e6) return `${Math.floor(v / 1e5) / 10}M`;
			if (v >= 1e3) return `${Math.floor(v / 100) / 10}k`;
			return String(v);
		}

		/**
		 * Icon with a coloured initial fallback when there is no avatar URL.
		 *
		 * The fallback hue is derived from the title, so the same entry keeps
		 * the same colour across renders and across page opens — a random hue
		 * per render would make the mosaic shimmer for no reason.
		 */
		function Avatar({ item, author, src, size = 36 }) {
			const [failed, setFailed] = useState(false);
			const label = String(item.title || author || "?").replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, "").slice(0, 1).toUpperCase() || "?";
			const box = {
				width: size, height: size, borderRadius: Math.max(6, Math.round(size / 4)),
				flexShrink: 0, objectFit: "cover", background: "rgba(128,128,128,0.15)",
			};
			if (src && !failed) {
				return createElement("img", {
					src, alt: "", width: size, height: size, loading: "lazy",
					onError: () => setFailed(true), style: box,
				});
			}
			let hash = 0;
			for (const ch of String(item.title ?? "")) hash = (hash * 31 + ch.codePointAt(0)) % 360;
			return createElement("div", {
				style: {
					...box, display: "grid", placeItems: "center",
					fontWeight: 700, fontSize: Math.round(size * 0.42), color: "#fff",
					background: `hsl(${hash} 52% 46%)`,
				},
			}, label);
		}

		/**
		 * The page's brand mark: a constellation hub — one accent centre with
		 * five satellites, i.e. "many servers, one registry".
		 *
		 * The satellites and spokes are `currentColor` (the prototype hard-codes
		 * near-black, which vanishes in the dark theme); only the hub keeps the
		 * brand blue, so the accent stays a single point.
		 */
		function brandMark(size = 22, decorative = false) {
			const dot = (cx, cy, r) => createElement("circle", { key: `c${cx}-${cy}`, cx, cy, r, fill: "currentColor" });
			return createElement("svg", {
				width: size, height: size, viewBox: "0 0 32 32",
				// The rail wraps its glyph in an `aria-hidden` span and labels
				// the button itself, so a second accessible name there is an
				// announcement rather than a detail.
				role: decorative ? "presentation" : "img",
				"aria-label": decorative ? null : "Overall MCP",
				"aria-hidden": decorative ? "true" : null,
				focusable: "false",
				style: { flexShrink: 0 },
			}, [
				createElement("g", {
					key: "spokes", fill: "none", stroke: "currentColor",
					strokeWidth: 1.6, strokeLinecap: "round",
				}, createElement("path", {
					d: "M16 16 L8 8 M16 16 L24 8 M16 16 L7 20 M16 16 L25 20 M16 16 L16 26",
				})),
				createElement("circle", { key: "hub", cx: 16, cy: 16, r: 3.2, fill: T.brand }),
				dot(8, 8, 2.2),
				dot(24, 8, 2.2),
				dot(7, 20, 2),
				dot(25, 20, 2),
				dot(16, 26, 2),
			]);
		}

		/**
		 * The left rail's glyph for this plugin.
		 *
		 * The sidebar renders each `sidebar.panellist` entry as a button and
		 * calls that entry's component with `{ size, active }`, using 16px when
		 * the rail is wide and 18px when it is collapsed; both are smaller than
		 * the page's own mark, so the constellation is reused at the size the
		 * rail asks for rather than at one we pick.
		 */
		function PanelGlyph({ size }) {
			return brandMark(typeof size === "number" ? size : 18, true);
		}

		/**
		 * The GitHub mark, inline.
		 *
		 * Drawn rather than linked as an icon font or an <img> so it inherits
		 * `currentColor` and therefore the surrounding text colour — one glyph
		 * that works in both the light and the dark theme without a second asset.
		 * The path is GitHub's own octocat mark (the same one the plugin market
		 * uses for its repository badge).
		 */
		function githubMark(size = 14) {
			return createElement("svg", {
				width: size, height: size, viewBox: "0 0 16 16",
				fill: "currentColor", "aria-hidden": "true", focusable: "false",
			}, createElement("path", {
				d: "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z",
			}));
		}

		/**
		 * A labelled row in the detail panel.
		 *
		 * Positional arguments, deliberately: this is called as a plain function
		 * (`DetailRow("来源", value)`), so a `{ children }` destructure would read
		 * the second argument as undefined and render the label with no value —
		 * the exact bug this panel shipped with once.
		 */
		function DetailRow(label, value) {
			return createElement("div", { style: styles.detailRow }, [
				createElement("span", { key: "k", style: styles.detailKey }, label),
				createElement("span", { key: "v", style: styles.detailVal }, value ?? "—"),
			]);
		}

		/** A clickable external link chip. */
		function LinkChip({ href, label, title }) {
			if (!href) return null;
			return createElement("a", {
				href, target: "_blank", rel: "noreferrer", title: title || href,
				className: "omkt-link", style: styles.linkChip,
			}, label);
		}

		/**
		 * Full detail panel for one market entry, modelled on dshmarket's install
		 * dialog (which is the detail surface its cards open).
		 *
		 * Every link the catalog knows about is offered — the upstream's own site,
		 * the repository, and the install command — because a market entry is only
		 * half the story: the user needs the source of truth before deciding.
		 */
		function MarketDetail({ item, stats, media, busy, onClose, onInstall, onToggleFavorite }) {
			const repo = repoKeyOf(item);
			const enriched = repo ? (stats ?? {})[repo] : null;
			const repoMedia = repo ? (media ?? {})[repo] : null;
			const stars = starCountOf(item, stats);
			const author = enriched?.author ?? item.author;
			const description = item.description || enriched?.description || "（无描述）";
			const tags = [...(item.tags ?? []), ...((enriched?.topics ?? []).slice(0, 3))]
				.filter((t, i, arr) => t && arr.indexOf(t) === i);
			// Prefer the upstream's own site over the repository for "官网"; a
			// GitHub repository is the source of truth for the local-server lists,
			// and the two Awesome lists only ever have that.
			const homepage = item.homepage && item.homepage !== item.repository ? item.homepage : null;
			const installCmd = item.install
				? item.install.transport === "stdio"
					? [item.install.command, ...(item.install.args ?? [])].join(" ")
					: item.install.url
				: null;
			// Smithery's `repository`/`homepage` point at its own listing rather
			// than the upstream project, so neither is a useful "官网" — but its
			// listing IS the only upstream page there is, and a card that reaches
			// nothing is worse than one that reaches the registry that hosts it.
			// Verified: smithery.ai/server/<name> 308-redirects to /servers/<name>.
			const registryPage = item.source === "smithery" && item.qualifiedName
				? `https://smithery.ai/servers/${item.qualifiedName}`
				: null;
			// GitHub access on this network class is intermittent (measured: TCP
			// connect timeout for hours, then 200 again). gh-proxy.com serves
			// repo pages today — dshmarket measured it as 403 in 2026-09 and its
			// own note says re-measure rather than infer, which is why both the
			// direct link and this mirror are offered side by side.
			const ghMirror = repo && item.repository
				? `https://gh-proxy.com/${item.repository}`
				: null;
			const titleHref = item.repository || homepage || registryPage || null;

			return createElement("div", {
				style: styles.overlay,
				onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
			}, [
				createElement("div", { key: "panel", className: "omkt-panel", style: styles.detailPanel }, [
					// ---- header: identity + provenance, and the way out ----
					createElement("div", { key: "head", style: styles.detailHead }, [
						createElement("div", { key: "id", style: styles.detailIdentity }, [
							createElement(Avatar, { key: "av", item, author, size: 44, src: item.icon ?? enriched?.avatar }),
							createElement("div", { key: "t", style: { minWidth: 0, flex: 1 } }, [
								// v4 puts the badges beside the name, not pushed to
								// the far edge: they qualify the title, and the
								// corner belongs to the close button.
								createElement("div", { key: "row", style: styles.detailTitleRow }, [
									titleHref
										? createElement("a", {
											key: "n", className: "omkt-title", href: titleHref,
											target: "_blank", rel: "noreferrer", title: titleHref,
											style: styles.detailTitle,
										}, item.title)
										: createElement("div", { key: "n", style: styles.detailTitle }, item.title),
									item.verified ? createElement("span", { key: "v", style: styles.verified }, "✓ 认证") : null,
									item.official ? createElement("span", { key: "o", style: styles.badge }, "官方") : null,
									item.installed ? createElement("span", { key: "i", style: styles.installed }, "已安装") : null,
									item.deprecated ? createElement("span", { key: "d", style: styles.deprecated }, "已废弃") : null,
								].filter(Boolean)),
								createElement("div", { key: "m", style: styles.detailSub }, [
									SOURCE_LABELS[`catalog:${item.source}`] ?? item.source,
									author ? `@${author}` : null,
									item.version ? `v${item.version}` : null,
									item.transport && item.transport !== "unknown" ? item.transport : null,
									typeof stars === "number" ? `★ ${compact(stars)}` : null,
								].filter(Boolean).join(" · ")),
							]),
							createElement("button", {
								key: "x", type: "button", className: "omkt-btn omkt-btn-outline",
								style: { ...styles.outlineBtn, marginLeft: "auto" },
								onClick: onClose, title: "关闭",
							}, "关闭"),
						]),
						createElement("p", { key: "desc", style: styles.detailDesc }, plainText(description)),
						tags.length
							? createElement("div", { key: "tags", style: styles.tags },
								tags.map((t) => createElement("span", { key: t, style: styles.tag }, t)))
							: null,
						item.deprecated && item.statusMessage
							? createElement("div", { key: "why", style: styles.warnLine }, `上游说明：${item.statusMessage}`)
							: null,
					]),

					// ---- body: facts ----
					createElement("div", { key: "body", style: styles.detailBody }, [
					// The repository's own pictures, bigger than on the card.
					// Shown first because it is the only part of this panel a
					// screenshot can answer, and absent when the repo has none.
					createElement(MediaStrip, { key: "media", media: repoMedia, height: 200 }),
					// The GitHub block: what the API enrichment knows about the
					// repository, as plain labelled facts. Absent numbers stay absent —
					// no catalog publishes GitHub data, and a missing number must not
					// read as zero any more than it may sort as one. v4 puts this
					// block above the catalogue facts, because the repository is the
					// thing the reader came for.
					repo ? createElement("div", { key: "gh", style: styles.ghBox }, [
						createElement("div", { key: "h", style: styles.ghHead }, "GITHUB 仓库"),
						createElement("a", {
							key: "r", className: "omkt-title", href: item.repository,
							target: "_blank", rel: "noreferrer", style: styles.ghRepo,
						}, repo),
						enriched
							? [
								createElement("div", { key: "s", style: styles.ghStats }, [
									typeof enriched.stars === "number" ? ghStat("Star", enriched.stars) : null,
									typeof enriched.forks === "number" ? ghStat("Fork", enriched.forks) : null,
									typeof enriched.openIssues === "number" ? ghStat("Issue", enriched.openIssues) : null,
									typeof enriched.watchers === "number" ? ghStat("Watch", enriched.watchers) : null,
									enriched.license ? ghStat("许可证", enriched.license, true) : null,
								].filter(Boolean)),
								...(enriched.archived
									? [createElement("div", { key: "arc", style: styles.warnLine }, "该仓库已被作者归档（Archived）")]
									: []),
								...(enriched.language || enriched.pushedAt || enriched.createdAt
									? [
										enriched.language ? DetailRow("语言", enriched.language) : null,
										enriched.pushedAt ? DetailRow("最近推送", enriched.pushedAt.slice(0, 10)) : null,
										enriched.createdAt ? DetailRow("创建于", enriched.createdAt.slice(0, 10)) : null,
									].filter(Boolean)
									: []),
							]
							: createElement("div", { key: "n", style: styles.hint },
								"GitHub 信息暂不可用（可能受限流或网络影响；其余信息不受影响）"),
						]) : null,

					// facts, each labelled so nothing is ambiguous. Anything the
					// GitHub block above already states (stars, last push) is not
					// repeated: v4's rule is that a panel states each fact once.
					createElement("div", { key: "facts", style: styles.detailFacts }, [
						DetailRow("来源", SOURCE_LABELS[`catalog:${item.source}`] ?? item.source),
						DetailRow("作者", author ? `@${author}` : "—"),
						DetailRow("版本", item.version ?? "—"),
						DetailRow("传输", item.transport && item.transport !== "unknown" ? item.transport : "—"),
						repo && enriched ? null
							: DetailRow("Star", typeof enriched?.stars === "number" ? String(enriched.stars)
								: typeof item.stars === "number" ? String(item.stars) : "目录未提供"),
						enriched?.pushedAt ? null
							: DetailRow("更新时间", (enriched?.pushedAt ?? item.updatedAt)?.slice(0, 10) || "该来源不提供"),
						DetailRow("使用量",
							typeof item.installs === "number"
								? `${item.installs} ${item.installsLabel ?? "次使用"}${item.installsWindow ? `（${item.installsWindow}）` : ""}`
								: "该来源不发布"),
						DetailRow("安装方式",
							item.installable
								? item.install.transport === "stdio" ? "本地进程（stdio）" : "远程端点（streamable-http）"
								: "需手动配置"),
						item.install?.transport === "streamable-http"
							? DetailRow("端点", item.install.url)
							: null,
					].filter(Boolean)),

					// the exact command the plugin would run, so nothing is hidden
					installCmd
						? createElement("div", { key: "cmd", style: styles.cmdBox }, [
							createElement("div", { key: "l", style: styles.detailKey }, "将执行的命令"),
							createElement("code", { key: "c", style: styles.cmd }, installCmd),
						])
						: null,

					// links — the point of this panel. Built from data, not from
					// rendered elements, so the dedupe is on the URL itself: an
					// entry whose website IS its endpoint shows one chip, not two.
					(() => {
						const candidates = [
							[homepage, "官网"],
							[item.repository, repo ? "GitHub 仓库" : "主页"],
							// GitHub access on this network class is intermittent; the
							// mirror chip is the fallback that works while it is down.
							[ghMirror, "GitHub 镜像"],
							// A hosted endpoint IS its address: showing it lets the
							// user point any other MCP client at the same server.
							[item.install?.transport === "streamable-http" ? item.install.url : null, "MCP 端点"],
							[registryPage, "Smithery 页面"],
						].filter(([href]) => typeof href === "string" && href.length > 0);
						const seen = new Set();
						const unique = candidates.filter(([href]) => {
							if (seen.has(href)) return false;
							seen.add(href);
							return true;
						});
						return createElement("div", { key: "links", style: styles.detailLinks },
							unique.map(([href, label]) => LinkChip({ href, label, title: href })));
					})(),
					]),
					// actions
					createElement("div", { key: "act", style: styles.detailActions }, [
						item.installed
							? createElement("span", { key: "i", style: styles.installed }, "已安装")
							: item.installable
								? createElement("button", {
									key: "install", type: "button", className: "omkt-btn omkt-btn-primary",
									style: { ...styles.button, ...styles.primary }, disabled: busy,
									onClick: () => { onInstall(item); onClose(); },
								}, busy ? "处理中…" : item.deprecated ? "仍要安装" : "安装")
								: createElement("span", { key: "m", style: styles.hint },
									item.repository ? "该来源未提供安装命令，请按仓库说明手动配置" : "无可安装信息"),
						onToggleFavorite
							? createElement("button", {
								key: "fav", type: "button",
								className: `omkt-btn omkt-btn-outline${item.favorite ? " omkt-icon-on" : ""}`,
								style: { ...styles.outlineBtn, fontSize: 13 },
								onClick: () => onToggleFavorite(item),
							}, item.favorite ? "♥ 已收藏" : "♡ 收藏")
							: null,
						// No "关闭" here: v4 keeps the way out in the panel's
						// top-right corner, where a modal's close button is
						// looked for, and the footer holds only the actions.
					]),
				]),
			]);
		}

		/**
		 * The page behind the rail's entry.
		 *
		 * This is the whole centre column, so it draws its own identity row and
		 * version chip — the frame draws no page title of its own, and a page
		 * that leaned on one would have no heading at all. `close` is only
		 * passed by a host surface that owns its own dismissal; a panel reached
		 * through the rail has nothing to dismiss, so it is normally absent.
		 */
		function Section({ close }) {
			ensureStyles();
			const [tab, setTab] = useState("registry");

			// ---- registry tab state ----
			const [servers, setServers] = useState(null);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");
			const [message, setMessage] = useState("");
			const [sourceFilter, setSourceFilter] = useState("");
			const [stateFilter, setStateFilter] = useState("");
			const [nameFilter, setNameFilter] = useState("");
			const [collapsed, setCollapsed] = useState(() => new Set());

			// ---- market tab state ----
			const [market, setMarket] = useState(null);
			const [marketBusy, setMarketBusy] = useState(false);
			const [marketError, setMarketError] = useState("");
			const [marketQuery, setMarketQuery] = useState("");
			const [marketSource, setMarketSource] = useState("");
			const [marketAt, setMarketAt] = useState("");
			const [repoStats, setRepoStats] = useState({});
			const [repoMedia, setRepoMedia] = useState({});
			const [starNote, setStarNote] = useState("");
			const [marketSort, setMarketSort] = useState("default");
			const [marketGroup, setMarketGroup] = useState("");
			const [marketPage, setMarketPage] = useState(0);
			const [pageSize, setPageSize] = useState(20);
			const [detail, setDetail] = useState(null);
			// The plugin's own update state, filled by 检查更新 (see
			// `doCheckUpdates`). `null` means "not asked yet", which is why the
			// head shows no update button on a fresh page.
			const [selfUpdate, setSelfUpdate] = useState(null);
			const pageRef = useRef(null);
			const scrollerRef = useRef(null);
			const [showTop, setShowTop] = useState(false);

			async function refresh() {
				const body = await api("/servers");
				setServers(body.servers);
				return body.servers;
			}

			useEffect(() => {
				refresh().catch((err) => setError(String(err.message || err)));
			}, []);

			async function loadMarket(options = {}) {
				setMarketBusy(true); setMarketError("");
				try {
					const body = await api("/catalog", {
						method: "POST",
						body: JSON.stringify({
							query: options.query ?? marketQuery,
							source: options.source ?? marketSource,
							limit: 10000,
							refresh: options.refresh === true,
						}),
					});
					setMarket(body);
					setMarketAt(body.fetchedAt ? new Date(body.fetchedAt).toLocaleTimeString() : "");
					// A new listing invalidates the page you were on.
					setMarketPage(0);
					enrichStars(body.items ?? [], options.refresh === true);
					enrichMedia(body.items ?? [], options.refresh === true);
				} catch (err) {
					const text = String(err.message || err);
					// A bare 404 means the host bundle running in this window predates
					// the market route (the plugin was updated while the app was open).
					setMarketError(text.includes("404")
						? "宿主插件还是旧版本（缺少 /api/overall-mcp/catalog）。请完全退出 DSH 后重新打开，或在本页刷新一次再试。"
						: text);
				} finally {
					setMarketBusy(false);
				}
			}

			/**
			 * Star counts are not part of the public catalogs: the cards render
			 * first without them and a single bounded, cached request fills in the
			 * visible GitHub repositories afterwards. Never blocks or fails the tab.
			 *
			 * The window is wider than the fold because the interleaved market puts
			 * only one community-index card per round; a first-screen window would
			 * often contain no GitHub repository at all. Still capped so the
			 * unauthenticated GitHub budget (60/h) survives repeated page opens.
			 */
			function enrichStars(items, refresh) {
				const repos = [];
				const seen = new Set();
				for (const item of items) {
					const key = repoKeyOf(item);
					if (!key || seen.has(key)) continue;
					// Skip repos already answered: paging back must not re-spend the
					// unauthenticated GitHub budget on entries we already have.
					if (repoStats[key]) continue;
					seen.add(key);
					repos.push(key);
					if (repos.length >= 30) break;   // stay inside the GitHub rate budget
				}
				if (!repos.length) return;
				api("/repo-stats", { method: "POST", body: JSON.stringify({ repos, refresh }) })
					.then((body) => {
						setRepoStats((prev) => ({ ...prev, ...(body.stats ?? {}) }));
						if (body.rateLimited) setStarNote("GitHub 未认证接口每小时仅 60 次，已达上限；Star 将在下个整点后补齐");
					})
					.catch(() => {});
			}

			/**
			 * Preview pictures for the cards, one bounded request per market load.
			 *
			 * READMEs are fetched by the host, not the page: they run to a
			 * megabyte on the big awesome lists and the raw host answers bursts
			 * with a rate limit. Only the ranked URLs come back, cached for
			 * hours, so paging through the market costs one request once.
			 *
			 * Failures are silent on purpose: a card without a picture is a
			 * complete card, and a broken strip must never take the tab down.
			 */
			function enrichMedia(items, refresh) {
				const repos = [];
				const seen = new Set();
				for (const item of items) {
					const key = repoKeyOf(item);
					if (!key || seen.has(key)) continue;
					if (repoMedia[key]) continue;
					seen.add(key);
					repos.push(key);
					if (repos.length >= 24) break;
				}
				if (!repos.length) return;
				api("/repo-media", { method: "POST", body: JSON.stringify({ repos, refresh }) })
					.then((body) => setRepoMedia((prev) => ({ ...prev, ...(body.media ?? {}) })))
					.catch(() => {});
			}

			// The market lists itself the first time its tab is opened.
			useEffect(() => {
				if (tab === "market" && market === null && !marketBusy) loadMarket({});
			}, [tab]);

			async function run(fn, okMessage) {
				setBusy(true); setError(""); setMessage("");
				try {
					const value = await fn();
					await refresh();
					if (okMessage) setMessage(okMessage(value));
				} catch (err) {
					setError(String(err.message || err));
				} finally {
					setBusy(false);
				}
			}

			const doScan = () => run(
				() => api("/scan", { method: "POST" }),
				(r) => `扫描完成：新增 ${r.added.length} 台，跳过 ${r.skipped.length} 台（${r.scannedFiles} 个配置文件）`,
			);
			const doToggle = (name, enabled) => run(
				() => api("/set-enabled", { method: "POST", body: JSON.stringify({ name, enabled }) }),
				(r) => `${r.name} ${r.enabled ? "已启用并连接" : "已停用"}`,
			);
			const doToggleSource = (source, enabled) => run(
				() => api("/set-source-enabled", { method: "POST", body: JSON.stringify({ source, enabled }) }),
				(r) => `${sourceLabel(r.source)}：${r.changed} 台已${r.enabled ? "启用" : "停用"}`,
			);
			const doRemove = (name) => run(
				() => api("/remove", { method: "POST", body: JSON.stringify({ name }) }),
				(r) => `${r.removed} 已移除`,
			);
			// 「检查更新」 answers two questions at once: which mounted MCP
			// servers have a newer package, and whether *this plugin* does. The
			// second answer is what decides if the head shows an update button,
			// so a refresh action (which the 分类 row already has as 刷新) never
			// sits in the primary slot.
			const doCheckUpdates = () => run(
				async () => {
					const body = await api("/updates", { method: "POST" });
					setSelfUpdate(body.self ?? null);
					return body;
				},
				(r) => {
					const parts = [r.updatable > 0
						? `${r.checked} 个可检测，其中 ${r.updatable} 个有可用更新`
						: `${r.checked} 个可检测，均已是最新版本`];
					const self = r.self;
					if (self) {
						if (self.updateAvailable) parts.push(`插件 dsh-overall-mcp 有新版 v${self.latest}`);
						else if (self.reason === "linked") parts.push("插件为 link 安装，跳过自身更新");
						else if (self.reason === "up-to-date") parts.push(`插件 v${self.version} 已是最新`);
						else if (self.hint) parts.push(self.hint);
					}
					return `检查完成：${parts.join("；")}`;
				},
			);

			const doSelfUpdate = () => run(
				async () => {
					const body = await api("/self-update", { method: "POST" });
					setSelfUpdate(null);
					return body;
				},
				(r) => {
					if (r.ok) return `已将 dsh-overall-mcp 更新到 v${r.to}（重启 DSH 后生效）`;
					const tail = [r.hint, r.command].filter(Boolean).join("：");
					return tail || "插件自更新未执行";
				},
			);

			/**
			 * Write everything this page knows to a file the user owns.
			 *
			 * Built client-side from state the page already holds rather than
			 * from a new host route: the host's own logs are not this plugin's
			 * to export, and a bug report needs exactly this — which catalogs
			 * answered, with how many entries, and what the page did with them.
			 */
			function doExportLog() {
				try {
					const payload = {
						exportedAt: new Date().toISOString(),
						plugin: { id: "dsh-overall-mcp", version: CLIENT_VERSION },
						registry: {
							total: stats.total, enabled: stats.enabled, disabled: stats.disabled,
							connected: stats.connected, failed: stats.failed, servers,
						},
						market: market
							? {
								total: market.total, counts: market.counts ?? null,
								cached: market.cached === true, fetchedAt: market.fetchedAt ?? null,
								returned: marketItems?.length ?? 0,
							}
							: null,
						// The view's own state, because "it looked wrong" is
						// almost always a filter or a page nobody wrote down.
						view: {
							tab, marketQuery, marketSource, marketSort,
							marketGroup, pageSize, page: marketPage + 1,
						},
						errors: { registry: error || marketError || null, market: marketError || null },
					};
					const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
					const url = URL.createObjectURL(blob);
					const a = document.createElement("a");
					a.href = url;
					a.download = `overall-mcp-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
					document.body.appendChild(a);
					a.click();
					a.remove();
					setTimeout(() => URL.revokeObjectURL(url), 1000);
					setMessage(`已导出日志：${stats.total} 台服务器、${marketItems?.length ?? 0} 条市场条目`);
				} catch (err) {
					setError(`导出失败：${String(err.message || err)}`);
				}
			}

			// Return-to-top: this page is its own scroller (the centre column
			// does not scroll), so the listener goes on the first scrollable
			// element at or above it — starting with the page itself, which is
			// the one that actually moves — and falls back to the window when
			// there is none.
			// The scroll container is no longer necessarily an *ancestor* of the
			// page: the page is a fixed shell, and the scrolling box is the tab
			// body (已注册) or the card region inside it (MCP 市场). Look for the
			// page's own scroller first and only then walk up, so the button
			// tracks what the user is actually dragging. Re-runs on a tab change
			// because that replaces the scroller node.
			useEffect(() => {
				if (typeof document === "undefined" || typeof getComputedStyle !== "function") return undefined;
				const node = pageRef.current;
				if (!node) return undefined;
				setShowTop(false);
				let target = typeof node.querySelector === "function"
					? node.querySelector('[data-omkt="scroller"]')
					: null;
				let el = node;
				while (!target && el && el !== document.body) {
					const overflowY = getComputedStyle(el).overflowY;
					if (overflowY === "auto" || overflowY === "scroll") { target = el; break; }
					el = el.parentElement;
				}
				scrollerRef.current = target;
				const read = () => (target ? target.scrollTop
					: (typeof window === "undefined" ? 0 : window.scrollY));
				const onScroll = () => setShowTop(read() > 400);
				const host = target ?? (typeof window === "undefined" ? null : window);
				if (!host) return undefined;
				host.addEventListener("scroll", onScroll, { passive: true });
				onScroll();
				return () => host.removeEventListener("scroll", onScroll);
			}, [tab]);

			function backToTop() {
				const target = scrollerRef.current;
				if (target && typeof target.scrollTo === "function") target.scrollTo({ top: 0, behavior: "smooth" });
				else if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
					window.scrollTo({ top: 0, behavior: "smooth" });
				}
			}
			const doUpdate = async (name) => {
				setBusy(true); setError(""); setMessage("");
				try {
					const result = await api("/update", { method: "POST", body: JSON.stringify({ name }) });
					await refresh();
					setMessage(result.updated
						? `${result.name} 已从 ${result.from} 更新到 ${result.to}${result.reconnected ? " 并重连" : ""}`
						: `${result.name} 无需更新（${result.reason}）`);
				} catch (err) {
					setError(String(err.message || err));
				} finally {
					setBusy(false);
				}
			};
			/**
			 * Toggle a market entry's bookmark.
			 *
			 * The host is the source of truth (it persists with the registry),
			 * but the page patches its own copy of the listing too: re-fetching
			 * the whole catalogue to move one star would push ~2 MB through the
			 * connection carrier for a decoration. The next browse, install or
			 * page open reconciles the two.
			 */
			const doToggleFavorite = async (item) => {
				const key = `${item.source}:${item.id ?? item.title}`;
				const next = !item.favorite;
				setMarket((prev) => (prev?.items
					? { ...prev, items: prev.items.map((i) => (i === item ? { ...i, favorite: next } : i)) }
					: prev));
				setDetail((prev) => (prev === item ? { ...prev, favorite: next } : prev));
				try {
					await api("/favorite", { method: "POST", body: JSON.stringify({ key }) });
				} catch (err) {
					// Roll the optimistic flip back — a bookmark that lies about
					// being saved is worse than one that never moved.
					setMarket((prev) => (prev?.items
						? { ...prev, items: prev.items.map((i) => (i === item ? { ...i, favorite: !next } : i)) }
						: prev));
					setDetail((prev) => (prev === item ? { ...prev, favorite: !next } : prev));
					setError(String(err.message || err));
				}
			};

			const doInstall = async (item) => {
				setError(""); setMessage("");
				setBusy(true);
				try {
					const result = await api("/install", { method: "POST", body: JSON.stringify({ item }) });
					await refresh();
					await loadMarket({});
					setMessage(`${result.installed} 已安装并连接`);
				} catch (err) {
					setError(String(err.message || err));
				} finally {
					setBusy(false);
				}
			};

			const all = servers || [];
			const stats = {
				total: all.length,
				enabled: all.filter((s) => s.enabled !== false).length,
				disabled: all.filter((s) => s.enabled === false).length,
				connected: all.filter((s) => s.connected).length,
				failed: all.filter((s) => s.error).length,
			};

			const sourceOptions = useMemo(() => {
				const set = new Set(all.map((s) => s.source || "manual"));
				return [...set].sort();
			}, [servers]);

			const groups = useMemo(() => {
				const needle = nameFilter.trim().toLowerCase();
				const bySource = new Map();
				for (const server of all) {
					const source = server.source || "manual";
					if (sourceFilter && source !== sourceFilter) continue;
					if (stateFilter === "enabled" && server.enabled === false) continue;
					if (stateFilter === "disabled" && server.enabled !== false) continue;
					if (stateFilter === "connected" && !server.connected) continue;
					if (stateFilter === "failed" && !server.error) continue;
					if (needle && !server.name.toLowerCase().includes(needle)) continue;
					if (!bySource.has(source)) bySource.set(source, []);
					bySource.get(source).push(server);
				}
				return [...bySource.entries()]
					.map(([source, list]) => [source, list.sort((a, b) => a.name.localeCompare(b.name))])
					.sort((a, b) => a[0].localeCompare(b[0]));
			}, [servers, sourceFilter, stateFilter, nameFilter]);

			const toggleCollapsed = (source) => setCollapsed((prev) => {
				const next = new Set(prev);
				if (next.has(source)) next.delete(source); else next.add(source);
				return next;
			});

			const marketItems = market?.items ?? null;
			const installedCount = marketItems ? marketItems.filter((i) => i.installed).length : 0;

			// Functional groups present in the CURRENT listing, with counts,
			// sorted by size — the chip row offers exactly what the filter can
			// deliver. `group` is the host-side consolidation of the two community
			// lists' ~75 headings into 19 functional groups (Finance and Finance
			// & Fintech become 金融支付); the three registries publish no category,
			// so their entries sit under 未分类 rather than being hidden.
			const groupOptions = useMemo(() => {
				if (!marketItems) return [];
				const counts = new Map();
				let uncategorized = 0;
				for (const item of marketItems) {
					if (item.group) counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
					else uncategorized += 1;
				}
				const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
				return uncategorized > 0 ? [...sorted, ["__none__", uncategorized]] : sorted;
			}, [marketItems]);

			// The host sends the whole merged listing (~5.4k items — upstream cost
			// is identical for a capped slice); ordering and paging are a view
			// concern, so they are applied here and never re-fetched. Memoized:
			// sorting five thousand entries on every render (page flip, star
			// enrichment, busy toggles) is tens of milliseconds of jank for nothing.
			const sortedItems = useMemo(() => (marketItems
				? marketItems
					.filter((i) => !marketGroup
						|| (marketGroup === "__none__" ? !i.group : i.group === marketGroup))
					.slice().sort((a, b) => compareMarket(a, b, marketSort, repoStats))
				: null), [marketItems, marketGroup, marketSort, repoStats]);
			const pageCount = sortedItems ? Math.max(1, Math.ceil(sortedItems.length / pageSize)) : 0;
			const safePage = Math.min(marketPage, pageCount - 1);
			const pageItems = sortedItems
				? sortedItems.slice(safePage * pageSize, safePage * pageSize + pageSize)
				: null;
			// Star enrichment is scoped to what the current page actually shows, so
			// paging does not burn the GitHub budget on entries nobody is looking at.
			const visibleRepos = (pageItems ?? [])
				.map((i) => repoKeyOf(i))
				.filter((k) => k && !(repoStats[k]?.stars !== undefined && repoStats[k]))
				.slice(0, 30);

			// The one outlined control that belongs beside the sub-line rather
			// than in the run of text buttons on the first row.
			const logButton = createElement("button", {
				key: "hd-log", type: "button", className: "omkt-btn omkt-btn-outline",
				style: styles.outlineBtn, onClick: doExportLog,
			}, "⤓ 导出日志");
			return createElement("div", { className: "omkt-page", style: styles.page, ref: pageRef }, [
				// ---- page head (v4 prototype): identity, then actions ----
				// The primary action follows the tab, because each tab has one
				// action that matters and two primary buttons is none.
				createElement("div", { key: "head", style: styles.pageHead }, [
					// Row A — identity on the left, controls on the right. One
					// filled button per view: everything beside it is quiet text.
					createElement("div", { key: "hd-row1", style: styles.headRow }, [
						createElement("div", { key: "hd-title", style: styles.titleRow }, [
							brandMark(22),
							createElement("strong", { key: "n", style: styles.pageTitle }, "全局 MCP"),
							createElement("span", { key: "hd-ver", style: styles.versionChip, title: "插件版本" },
								`v${CLIENT_VERSION}`),
						]),
						createElement("div", { key: "hd-acts", style: styles.headActs }, [
							// The filled button is a tab's one important action. On
							// MCP 市场 that is *not* a refresh — the 分类 row already
							// carries 刷新 — so it appears only when 检查更新 found a
							// newer release of this plugin, and then it installs it.
							tab === "market"
								? selfUpdate && selfUpdate.updateAvailable
									? createElement("button", {
										key: "hd-primary", type: "button", className: "omkt-btn omkt-btn-primary",
										style: { ...styles.button, ...styles.primary }, disabled: busy,
										title: `更新到 v${selfUpdate.latest}（${selfUpdate.profileName ?? "本 profile"}）`,
										onClick: doSelfUpdate,
									}, busy ? "更新中…" : "更新 overall-mcp")
									: null
								: createElement("button", {
									key: "hd-primary", type: "button", className: "omkt-btn omkt-btn-primary",
									style: { ...styles.button, ...styles.primary }, disabled: busy, onClick: doScan,
								}, "重新扫描宿主机"),
							// Both tabs keep the other tab's primary action one click
							// away, as a text button: switching tabs to rescan is
							// a detour nobody wants to discover.
							tab === "market"
								? createElement("button", {
									key: "hd-secondary", type: "button", className: "omkt-btn omkt-btn-text",
									style: styles.textBtn, disabled: busy, onClick: doScan,
								}, "重新扫描宿主机")
								: createElement("button", {
									key: "hd-secondary", type: "button", className: "omkt-btn omkt-btn-text",
									style: styles.textBtn, disabled: marketBusy,
									onClick: () => { setTab("market"); if (market === null) loadMarket({}); },
								}, "打开 MCP 市场"),
							createElement("button", {
								key: "hd-updates", type: "button", className: "omkt-btn omkt-btn-text", style: styles.textBtn,
								disabled: busy, onClick: doCheckUpdates,
							}, "检查更新"),
							close
								? createElement("button", {
									key: "hd-close", type: "button", className: "omkt-btn omkt-btn-text", style: styles.textBtn,
									onClick: close,
								}, "关闭")
								: null,
						]),
					]),
					// Row B — the sub-line, with the one outlined control that
					// belongs beside it rather than in the action cluster.
					createElement("div", { key: "hd-row2", style: styles.headSubRow }, [
						createElement("div", { key: "hd-sub", style: styles.pageSub }, [
							"宿主机扫描 · 市场发现 · 一键接入 · ",
							createElement("a", {
								key: "a", className: "omkt-link", style: styles.pageSubLink,
								href: "https://github.com/punkpeye/awesome-mcp-servers#contributing",
								target: "_blank", rel: "noreferrer",
								title: "收录标准与提交方式（awesome-mcp-servers 贡献指南）",
							}, "申请收录 MCP 服务 ↗"),
						]),
						logButton,
					]),
				]),

				createElement("div", { key: "tabs", className: "omkt-tabbar", role: "tablist", style: styles.tabBar }, [
					createElement("button", {
						key: "registry", type: "button", className: "omkt-tab",
						role: "tab", "aria-selected": tab === "registry" ? "true" : "false",
						style: { ...styles.tab, ...(tab === "registry" ? styles.tabActive : {}) },
						onClick: () => setTab("registry"),
					}, `已注册${servers ? ` (${stats.total})` : ""}`),
					createElement("button", {
						key: "market", type: "button", className: "omkt-tab",
						role: "tab", "aria-selected": tab === "market" ? "true" : "false",
						style: { ...styles.tab, ...(tab === "market" ? styles.tabActive : {}) },
						onClick: () => setTab("market"),
					}, `MCP 市场${market ? ` (${compactCount(market.total ?? marketItems.length)})` : ""}`),
				]),

				error ? createElement("div", { key: "error", style: styles.error }, error) : null,
				message ? createElement("div", { key: "message", style: styles.message }, message) : null,

				// ---------------- registry tab ----------------
				tab === "registry" ? createElement("div", { key: "reg", className: "omkt-tabbody", style: styles.tabBody }, [
					createElement("div", { key: "stats", style: styles.stats }, [
						createElement("span", { key: "t" }, `${stats.total} 台服务器`),
						createElement("span", { key: "e" }, `${stats.enabled} 已启用`),
						createElement("span", { key: "d" }, `${stats.disabled} 已停用`),
						createElement("span", { key: "c" }, `${stats.connected} 已连接`),
						stats.failed ? createElement("span", { key: "f", style: styles.error }, `${stats.failed} 连接异常`) : null,
					]),
					!error && servers === null ? createElement("div", { key: "loading", style: styles.message }, "加载中…") : null,
					servers ? createElement("div", { key: "filters", style: styles.filters }, [
						createElement("select", {
							key: "source", className: `omkt-select${sourceFilter ? " omkt-select-on" : ""}`,
							style: sourceFilter ? { ...styles.select, ...styles.filterSelectOn } : styles.select,
							value: sourceFilter,
							title: sourceFilter ? `来源：${sourceLabel(sourceFilter)}` : "按来源筛选",
							onChange: (e) => setSourceFilter(e.target.value),
						}, [
							createElement("option", { key: "", value: "" }, "全部来源"),
							...sourceOptions.map((s) => createElement("option", { key: s, value: s }, sourceLabel(s))),
						]),
						createElement("select", {
							key: "state", className: `omkt-select${stateFilter ? " omkt-select-on" : ""}`,
							style: stateFilter ? { ...styles.select, ...styles.filterSelectOn } : styles.select,
							value: stateFilter,
							title: stateFilter ? "按连接状态筛选" : "全部状态",
							onChange: (e) => setStateFilter(e.target.value),
						}, [
							createElement("option", { key: "", value: "" }, "全部状态"),
							createElement("option", { key: "enabled", value: "enabled" }, "已启用"),
							createElement("option", { key: "disabled", value: "disabled" }, "已停用"),
							createElement("option", { key: "connected", value: "connected" }, "已连接"),
							createElement("option", { key: "failed", value: "failed" }, "连接异常"),
						]),
						createElement("input", {
							key: "name", className: "omkt-input", style: styles.searchBox, value: nameFilter,
							placeholder: "搜索 MCP",
							title: "按服务器名称、来源或命令过滤",
							onChange: (e) => setNameFilter(e.target.value),
						}),
					]) : null,
					servers && servers.length === 0
						? createElement("div", { key: "empty", style: styles.message },
							"注册表为空，点击「重新扫描宿主机」导入已有 MCP 配置。")
						: null,
					servers && servers.length > 0 && groups.length === 0
						? createElement("div", { key: "nomatch", style: styles.message }, "没有符合筛选条件的服务器。")
						: null,
					...groups.map(([source, list]) => createElement(SourceGroup, {
						key: source, source, servers: list, busy,
						collapsed: collapsed.has(source),
						onToggleCollapsed: () => toggleCollapsed(source),
						onToggleSource: doToggleSource,
						onToggleServer: doToggle,
						onRemove: doRemove,
						onUpdate: doUpdate,
					})),
				]) : null,

				// ---------------- market tab ----------------
				tab === "market" ? createElement("div", {
					key: "mkt", className: "omkt-tabbody", "data-omkt": "market", style: styles.market,
				}, [
					// Row 1 — the search pill, on a line of its own. v4 makes it
					// the widest control on the page because it is the one thing
					// that turns five thousand entries into the one you meant.
					createElement("div", { key: "search", className: "omkt-search", style: styles.searchWrap }, [
						createElement("span", { key: "ico", style: styles.searchIcon }, "🔍"),
						createElement("input", {
							key: "q", className: "omkt-input", style: styles.searchInput, value: marketQuery, disabled: marketBusy,
							placeholder: "搜索 MCP",
							title: "搜索名称、描述或安装命令（回车或点「搜索」）",
							onChange: (e) => setMarketQuery(e.target.value),
							onKeyDown: (e) => { if (e.key === "Enter") loadMarket({}); },
						}),
						// An explicit trigger stays: a settings pane gives a
						// first-time reader no reason to guess "press Enter".
						createElement("button", {
							key: "go", type: "button", className: "omkt-btn omkt-btn-primary",
							style: { ...styles.button, ...styles.primary, padding: "6px 14px", fontSize: 12.5 },
							disabled: marketBusy, onClick: () => loadMarket({}),
						}, marketBusy ? "搜索中…" : "搜索"),
					]),
					// Row 2 — the taxonomy on the left, the compact controls that
					// narrow it pushed to the far end of the same row. The
					// taxonomy is one dropdown rather than a row of scrolling
					// chips: a 5k-entry catalogue carries ~20 functional groups,
					// and as chips they either scrolled sideways (half of them
					// never seen) or wrapped into three lines of chrome.
					//
					// A listing where NOTHING carries a group means the host is
					// older than this page (group is computed host-side at DSH
					// startup). Saying that is far more useful than a taxonomy of
					// just 全部/未分类, which reads as "the taxonomy is broken".
					createElement("div", { key: "filters", style: styles.filters }, [
						groupOptions.length > 1 || (groupOptions.length === 1 && groupOptions[0][0] !== "__none__")
							? createElement("div", { key: "group", style: styles.groupFilter }, [
								createElement("span", { key: "l", style: styles.groupLabel }, "分类"),
								createElement("select", {
									key: "g", className: `omkt-select${marketGroup ? " omkt-select-on" : ""}`,
									style: marketGroup
										? { ...styles.groupSelect, ...styles.filterSelectOn }
										: styles.groupSelect,
									value: marketGroup,
									title: marketGroup
										? `分类筛选：${marketGroup === "__none__" ? "未分类" : marketGroup}`
										: "按功能分类筛选",
									onChange: (e) => { setMarketGroup(e.target.value); setMarketPage(0); },
								}, [
									createElement("option", { key: "", value: "" },
										`全部分类 (${marketItems.length})`),
									// No per-group counts (user request): the total
									// lives on 全部分类 alone, but the order still
									// follows group size, so the shape of the
									// taxonomy shows in the list.
									...groupOptions.map(([name]) => createElement("option", {
										key: name, value: name,
									}, name === "__none__" ? "未分类" : name)),
								]),
							])
							: null,
						createElement("div", { key: "right", style: styles.filterRight }, [
							createElement("select", {
								key: "src", className: `omkt-select${marketSource ? " omkt-select-on" : ""}`,
								style: marketSource
									? { ...styles.filterSelect, ...styles.filterSelectOn }
									: styles.filterSelect,
								value: marketSource,
								title: marketSource ? `来源筛选：${marketSource}` : "按来源筛选",
								onChange: (e) => {
									setMarketSource(e.target.value);
									// A new listing may not hold the selected group;
									// leaving it set would filter everything out.
									setMarketGroup("");
									loadMarket({ source: e.target.value });
								},
							}, MARKET_SOURCES.map(([value, label]) => createElement("option", { key: value, value }, label))),
							createElement("select", {
								key: "sort", className: `omkt-select${marketSort !== "default" ? " omkt-select-on" : ""}`,
								style: marketSort !== "default"
									? { ...styles.filterSelect, ...styles.filterSelectOn }
									: styles.filterSelect,
								value: marketSort,
								// The chosen order is stated on the control itself: a
								// select that looks identical whether or not it is
								// doing anything is how "我选了使用量最多但没生效" reads.
								title: marketSort === "default"
									? "排序：综合推荐"
									: `排序：${(SORT_OPTIONS.find(([v]) => v === marketSort) ?? [, marketSort])[1]}`,
								onChange: (e) => { setMarketSort(e.target.value); setMarketPage(0); },
							}, SORT_OPTIONS.map(([value, label]) => createElement("option", { key: value, value }, label))),
							createElement("button", {
								key: "refresh", type: "button", className: "omkt-btn omkt-btn-outline",
								style: styles.filterBtn, disabled: marketBusy,
								onClick: () => loadMarket({ refresh: true }),
							}, marketBusy ? "拉取中…" : "刷新"),
						]),
					].filter(Boolean)),
					// Row 3 — v4's meta line: the three numbers a reader checks
					// before paging, with the freshness note pushed to the end.
					sortedItems
						? createElement("div", { key: "meta", style: styles.metaLine }, [
							createElement("span", { key: "t" }, [
								createElement("b", { key: "b", style: styles.metaB },
									compactCount(market?.total ?? marketItems.length)),
								" 个可用 MCP",
							]),
							createElement("span", { key: "p" }, [
								"第 ",
								createElement("b", { key: "b", style: styles.metaB }, String(safePage + 1)),
								` / ${pageCount} 页`,
							]),
							createElement("span", { key: "n" }, `每页 ${pageSize} 条`),
							// The order in force, in words, next to the rank chips
							// on the cards themselves (the wall is a row-major
							// grid, so #1 is the top-left card and the numbers
							// run left to right).
							marketSort !== "default"
								? createElement("span", { key: "sort", style: styles.metaSort,
									title: "名次从左到右、再下一行；没有该项数据的条目排在后面" },
									`按${(SORT_OPTIONS.find(([v]) => v === marketSort) ?? [, marketSort])[1]}排序`)
								: null,
							marketAt
								? createElement("span", { key: "at", style: styles.metaTail },
									`更新于 ${marketAt}${market && market.cached ? "（缓存）" : ""}`)
								: null,
						].filter(Boolean))
						: createElement("div", { key: "meta", style: styles.metaLine }, "正在发现…"),
					// Provenance counts are facts about the catalogue, not
					// controls, so they get a quiet line of their own instead of
					// competing with the chip row.
					market && market.counts
						? createElement("div", { key: "srcline", style: { ...styles.hint, marginBottom: 14 } },
							[
								Object.entries(market.counts)
									.map(([s, n]) => `${SOURCE_SHORT[s] ?? s} ${n}`).join(" · "),
								`其中 ${installedCount} 个已安装`,
								marketGroup && sortedItems
									? `「${marketGroup === "__none__" ? "未分类" : marketGroup}」筛选后 ${sortedItems.length} 条`
									: null,
							].filter(Boolean).join(" · "))
						: null,
					// Old host, new page: every item lacks `group`, so the chip row
					// would degrade to 全部/未分类 and look broken. Name the cause.
					!marketBusy && marketItems && marketItems.length > 0
						&& !marketItems.some((i) => i.group)
						? createElement("div", { key: "oldhost", style: styles.hint },
							"分类功能需要新版宿主插件：请完全退出 DSH（桌面版注意托盘图标）后重新打开。")
						: null,
					marketBusy ? createElement("div", { key: "loading", style: styles.message }, "正在从市场拉取…") : null,
					marketError ? createElement("div", { key: "err", style: styles.error }, marketError) : null,
					market && market.errors && market.errors.length
						? createElement("div", { key: "warn", style: styles.hint },
							`部分来源不可用：${market.errors.map((e) => e.source).join("、")}`)
						: null,
					starNote ? createElement("div", { key: "star", style: styles.hint }, starNote) : null,
					pageItems && pageItems.length === 0 && !marketBusy
						? createElement("div", { key: "none", style: styles.message }, "没有匹配的 MCP。")
						: null,
					pageItems && pageItems.length
						// Everything above this box is pinned chrome; from here
						// down the cards scroll on their own, so dragging the
						// wall never moves the search box or the 分类 row.
						? createElement("div", { key: "scroll", "data-omkt": "scroller", style: styles.marketScroll },
							// The column count belongs to THIS box, not to the window:
							// the settings pane is a slice of a browser window, so a
							// viewport media query would ask for three columns in a
							// 700px pane on a 1600px screen. The wrapper is the
							// container the sheet's @container rules measure.
							createElement("div", { key: "gridwrap", style: styles.gridHost },
								createElement("div", { key: "grid", className: "omkt-grid", style: styles.cardColumns },
									pageItems.map((item, i) => createElement(MarketCard, {
										key: `${item.source}:${item.id ?? item.title}`,
										item, stats: repoStats, media: repoMedia, busy,
										// A ranked list has to *show* its ranking.
										// The wall is CSS multi-column, so a sorted
										// list reads down each column, not across
										// the row — without a number it looks
										// unsorted ("我选了使用量最多但没生效"). On the
										// default (综合推荐) there is no ranking to
										// state, so no chip.
										rank: marketSort === "default" ? null : safePage * pageSize + i + 1,
										onInstall: doInstall, onOpen: setDetail,
										onToggleFavorite: doToggleFavorite,
									})))))
						: null,

					sortedItems && pageCount > 1
						? createElement("div", { key: "pager", style: styles.pager }, [
							createElement("select", {
								key: "size", style: styles.select, value: pageSize,
								onChange: (e) => { setPageSize(Number(e.target.value)); setMarketPage(0); },
							}, PAGE_SIZES.map((n) => createElement("option", { key: n, value: n }, `每页 ${n} 条`))),
							createElement("span", { key: "spacer", style: styles.spacer }),
							createElement("button", {
								key: "first", type: "button", style: styles.button, disabled: safePage === 0,
								onClick: () => setMarketPage(0),
							}, "« 首页"),
							createElement("button", {
								key: "prev", type: "button", style: styles.button, disabled: safePage === 0,
								onClick: () => setMarketPage(safePage - 1),
							}, "‹ 上一页"),
							createElement("span", { key: "info", style: styles.meta }, `${safePage + 1} / ${pageCount}`),
							createElement("button", {
								key: "next", type: "button", style: styles.button, disabled: safePage >= pageCount - 1,
								onClick: () => setMarketPage(safePage + 1),
							}, "下一页 ›"),
							createElement("button", {
								key: "last", type: "button", style: styles.button, disabled: safePage >= pageCount - 1,
								onClick: () => setMarketPage(pageCount - 1),
							}, "末页 »"),
						])
						: null,
				]) : null,

				// v4 closes the page with a ruled note, not another paragraph of
				// body copy: everything above it is content, this is a footnote.
				createElement("div", { key: "hint", style: styles.note },
					"已启用服务器的工具以 mcp__<服务器名>__<工具名> 形式在对话中直接可用；数据保存在 $DSH_HOME/overall-mcp/。"),

				// The detail overlay is a sibling of the page content, not a child
				// of the market tab, so it survives a tab switch and closes cleanly.
				detail
					? createElement(MarketDetail, {
							key: "detail", item: detail, stats: repoStats, media: repoMedia, busy,
							onClose: () => setDetail(null),
							onInstall: doInstall,
							onToggleFavorite: doToggleFavorite,
						})
					: null,

				// Fixed, and only while there is something to scroll back from.
				showTop
					? createElement("button", {
						key: "top", type: "button", className: "omkt-btn", style: styles.toTop,
						title: "回到顶部", "aria-label": "回到顶部", onClick: backToTop,
					}, "↑")
					: null,
			]);
		}

		/**
		 * Register this page as its own entry in the left rail.
		 *
		 * Two registrations make one arrival, and they share a single string:
		 * `sidebar.panellist` is a root-scope LIST whose `id` the sidebar turns
		 * into a labelled icon row, and the root-scope KEYED `main` slot is what
		 * the centre column renders once that row is selected — keyed, in this
		 * case, by the same id. Both slots are declared by packages this bundle
		 * lists in `dsh.client.inject` (`dsh-client-ui-sidebar` and
		 * `dsh-client-ui-layout`): a slot whose owner is not injected cannot be
		 * addressed, and `slots.inject` would then simply never fire.
		 */
		function apply(ctx) {
			ctx.slots.inject("sidebar.panellist", () => {
				const off = ctx.slots.register({
					name: "sidebar.panellist",
					id: PANEL_ID,
					// The plugin page is 0 and the task manager is 10, so 5 puts
					// this entry directly below 插件 — which is where a plugin's
					// own page belongs — instead of at the end of the rail.
					order: 5,
					// A plain string on purpose: this bundle ships no locale
					// namespace, and a label resolved through a namespace we do
					// not own would render as its key.
					label: "全局 MCP",
				}, PanelGlyph);
				return typeof off === "function" ? off : () => {};
			});
			ctx.slots.inject("main", () => {
				const off = ctx.slots.register({ name: "main", key: PANEL_ID }, Section);
				return typeof off === "function" ? off : () => {};
			});
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		// Exposed for tools/render-detail.mjs and tools/render-card.mjs only:
		// the detail panel once shipped with labels and no values, and the card
		// once shipped its front-door link inside a <button> (click raced the
		// navigation). No test that avoids real rendering could catch either.
		exports.__test = {
			MarketDetail, MarketCard, DetailRow, LinkChip, PanelGlyph,
			version: CLIENT_VERSION, bundleName: BUNDLE_NAME, panelId: PANEL_ID,
		};
		// Section is exported for tools/render-market-tab.mjs: the market tab's
		// chrome (stat line, filters, masonry wrapper, favourite wiring) exists
		// nowhere else, and a wrong state name or prop only throws at render.
		exports.Section = Section;
		return module.exports;
	},
});
