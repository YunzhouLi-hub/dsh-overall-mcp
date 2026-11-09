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
//                 catalogs (official registry / Smithery / Docker Hub /
//                 awesome-remote-mcp-servers / awesome-mcp-servers)
//
// Host API (Connection-authenticated same-origin fetch routes, index.js). The
// list below is what this page actually calls; the host also serves /self and
// /tools as documented read-only diagnostics (README.zh-CN.md) that the page
// never touches:
//   GET  /api/overall-mcp/servers
//   GET  /api/overall-mcp/scan
//   GET/POST /api/overall-mcp/catalog           { query?, source?, limit?, refresh? }
//   GET/POST /api/overall-mcp/install-evidence   { force? } — POST starts a walk
//   GET/POST /api/overall-mcp/repo-stats        { refresh? }
//   GET/POST /api/overall-mcp/repo-media        { repo }
//   POST /api/overall-mcp/install               { item, overwrite? }
//   POST /api/overall-mcp/favorite              { key, on? }
//   GET  /api/overall-mcp/favorites
//   POST /api/overall-mcp/set-enabled           { name, enabled, slot?, from? }
//   POST /api/overall-mcp/set-source-enabled    { source, enabled }
//   GET  /api/overall-mcp/updates
//   POST /api/overall-mcp/self-update
//   POST /api/overall-mcp/update                { name, slot?, from? }
//   POST /api/overall-mcp/remove                { name, slot?, from? }

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
		// stay equal — a version chip that lies is worse than no chip. That
		// probe also checks CHANGELOG.md's newest section is this version, since
		// a release note that stops at an older build tells a reader what
		// changed in code they are not running.
		const CLIENT_VERSION = "1.0.4";
		// Where 「点个 star」 points. A constant, not a config: it is this
		// plugin's own repository, and a panel that could be pointed at another
		// repository would be asking for a star it does not deserve.
		const REPO_URL = "https://github.com/YunzhouLi-hub/dsh-overall-mcp";
		// Where a reader without a local `gh` login can get a credential by hand.
		// `read:user` is the only scope the plugin uses (it asks who the token
		// belongs to); the prefilled description is what the token list will show
		// months later, when nobody remembers which tool created it.
		const GH_TOKEN_URL = "https://github.com/settings/tokens/new?scopes=read:user&description=dsh-overall-mcp";
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

		// Every route answers in well under a minute except the ones that reach the
		// network or shell out (检查更新 / 更新 / 安装 / 自更新 / 扫描 / 目录与仓库
		// 拉取); those pass their own `timeoutMs`. The deadline exists because a
		// hung host used to latch the whole page: `run()` holds `busy` until its
		// promise settles, so a request that never answered left every button
		// disabled for good — no message, no way back except a reload.
		const API_TIMEOUT_MS = 30000;
		// 「检查」 may land on a mount whose handshake is still in flight — a
		// first-run `npx` is downloading the package. One click therefore
		// follows the same mount a few times instead of declaring it broken
		// mid-download; the button says 检查中… for the whole window.
		const HEALTH_ATTEMPTS = 3;
		const HEALTH_RETRY_GAP_MS = 4000;
		async function api(path, options) {
			const { timeoutMs = API_TIMEOUT_MS, ...init } = options ?? {};
			const controller = timeoutMs > 0 && typeof AbortController === "function"
				? new AbortController() : null;
			const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
			try {
				const res = await fetch(API + path, {
					headers: { "content-type": "application/json" },
					...init,
					...(controller ? { signal: controller.signal } : {}),
				});
				const body = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
				return body;
			} catch (err) {
				if (controller?.signal.aborted) {
					throw new Error(`${path} 等待超过 ${Math.round(timeoutMs / 1000)} 秒仍未响应：宿主可能正忙或已挂起，请稍后重试；若一直如此就重启 DSH。`);
				}
				throw err;
			} finally {
				if (timer !== null) clearTimeout(timer);
			}
		}

		// The client container's context, captured by `apply(ctx)` below. Link
		// handling needs two services (`sidebarRight`, `sidebarRightTabs`) that
		// this bundle does not own; reading them through `ctx.get` keeps the
		// dependency soft — a shell without them keeps working through the plain
		// `target="_blank"` fallback instead of failing to load the page.
		let hostCtx = null;

		/**
		 * Open an http(s) link the way the rest of the client does.
		 *
		 * The right Sidebar's Browser tab is the app's own surface for an
		 * external page (`ctx.sidebarRight.openTab("browser", { params: { url } })`,
		 * the documented call for client plugins), and the chat's markdown links
		 * default to it — a market card that instead threw the address at the
		 * system browser was the odd one out. It is used only when the Browser
		 * type is actually registered, because `openTab` throws for a kind
		 * nothing registered ("a wiring mistake, not a user error"), and a
		 * modified click is left completely alone: ⌘/Ctrl/Shift/Alt and the
		 * middle button are how a user asks for the platform's own behaviour.
		 *
		 * Returns nothing: the anchor keeps `target="_blank"`, so every path
		 * where this function does not act still ends in a working link.
		 */
		function openExternal(event, url) {
			if (typeof url !== "string" || !/^https?:/i.test(url)) return;
			if (event.defaultPrevented || event.button !== 0) return;
			if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
			const tabs = hostCtx?.get?.("sidebarRightTabs");
			const sidebarRight = hostCtx?.get?.("sidebarRight");
			if (!sidebarRight || typeof sidebarRight.openTab !== "function") return;
			if (tabs?.get?.("browser") === undefined) return;
			try {
				sidebarRight.openTab("browser", { params: { url } });
			} catch (err) {
				// The tab did not open, so let the anchor do what it always did.
				console.warn("overall-mcp: 侧栏浏览器打开失败，改用外部浏览器", err);
				return;
			}
			event.preventDefault();
		}

		/**
		 * Put text on the clipboard, the only two ways a page may.
		 *
		 * `navigator.clipboard` needs a secure context and can still reject (no
		 * focus); the old selection trick is the fallback. Both are tried before
		 * reporting failure, because a「已复制」that copied nothing is the one
		 * outcome worth avoiding — the caller shows the result verbatim.
		 */
		async function copyText(text) {
			try {
				if (navigator.clipboard?.writeText) {
					await navigator.clipboard.writeText(text);
					return true;
				}
			} catch {
				// Fall through to the selection trick.
			}
			try {
				const ta = document.createElement("textarea");
				ta.value = text;
				ta.setAttribute("readonly", "");
				ta.style.position = "fixed";
				ta.style.top = "-1000px";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				const ok = document.execCommand?.("copy");
				document.body.removeChild(ta);
				return ok === true;
			} catch {
				return false;
			}
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
            "catalog:official-endpoint": "官方端点",
			"catalog:official-registry": "官方 Registry",
			"catalog:smithery": "Smithery",
			"catalog:docker-catalog": "Docker MCP Catalog",
			"catalog:github-mcp": "GitHub MCP",
			"catalog:awesome-remote": "Awesome 远程",
			"catalog:awesome-list": "Awesome 清单",
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
			["github-mcp", "GitHub MCP"],
			["awesome-remote", "Awesome 远程"],
			["awesome-list", "Awesome 清单"],
		];

		/** Sort choices for the market listing. */
		const SORT_OPTIONS = [
			["default", "默认（多源均衡）"],
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
			"github-mcp": "GitHub",
			"awesome-remote": "远程",
			"awesome-list": "Awesome",
			// Only ever used by a filter's title: the counters line is keyed by the
			// upstream a view read, and that key is `github-mcp`.
			census: "普查",
		};

		/**
		 * The one entry in the market's 来源 filter that is not an upstream.
		 *
		 * `census` is a *view* of GitHub: the same rows, read from the local index
		 * and never from the live search (see `CENSUS_SOURCE` in `lib/catalog.js`).
		 * It stays out of MARKET_SOURCES deliberately — that list is also the 内置
		 * inventory inside the 目录源 box, where a view has no upstream of its own to
		 * report and would show up as 「未参与」 for ever.
		 */
		const CENSUS_OPTION = ["census", "本地普查（索引）"];

		// Theme-adaptive palette. The DSH shell owns the real tokens
		// (--dsw-alias-*); the literals are fallbacks for a shell older than this
		// bundle. Neutral surfaces are translucent grey rather than white so the
		// page reads as native in BOTH themes — a hard-coded white card on the
		// dark theme is the single most obvious "this does not belong here" tell.
		const T = {
			cardBg: "var(--dsw-alias-bg-primary, #fff)",
			soft: "rgba(128,128,128,0.08)",
			soft2: "rgba(128,128,128,0.12)",
			text: "var(--dsw-alias-text-primary, #18202e)",
			text2: "var(--dsw-alias-text-secondary, #526071)",
			text3: "var(--dsw-alias-text-tertiary, #667085)",
			text4: "var(--dsw-alias-text-quaternary, #a9aeb8)",
			line: "rgba(114,130,167,.24)",
			line2: "rgba(114,130,167,.15)",
			brand: "#4566e9",
			green: "#00b42a",
			amber: "#ff7d00",
			blue: "#165dff",
			red: "#f53f3f",
		};

		// Both resource types share the host's blue accent; status colors are
		// reserved for health and outcomes, never used to distinguish tabs.
		const MCP_SOFT = "#e8eefc";
		const SKILL_ACCENT = T.brand;
		const SKILL_INK = T.brand;
		const SKILL_SOFT = MCP_SOFT;
		// The four upstreams, spelled the way each site spells itself.
		const SKILL_MARKET_LABELS = { clawhub: "ClawHub", official: "Anthropic 官方技能", skillhub: "SkillHub", github: "GitHub" };
		const SKILL_LINE = "rgba(69,102,233,.18)";

		const styles = {
			smallPrimary: { padding: "6px 12px", minHeight: 30, fontSize: 13, lineHeight: 1.25, fontFamily: "inherit", whiteSpace: "nowrap", flexShrink: 0, cursor: "pointer", fontWeight: 500, borderRadius: 7, border: `1px solid ${T.brand}`, background: T.brand, color: "#fff", boxShadow: "0 2px 4px rgba(69,102,233,.12)" },
			smallBtn: { padding: "5px 10px", borderRadius: 7, fontSize: 13, fontFamily: "inherit", border: `1px solid ${T.line}`, background: T.cardBg, color: T.text2, cursor: "pointer", whiteSpace: "nowrap" },
			emptyBox: { display: "grid", justifyItems: "center", gap: 10, padding: "36px 20px", border: `1px dashed ${T.line}`, borderRadius: 12, color: T.text3, textAlign: "center", fontSize: 14 },
            // Center the shared content column inside the host pane. Each tab
            // retains its own scroller inside the available height.
			page: {
				display: "flex", flexDirection: "column", gap: 12,
				fontSize: 15, lineHeight: 1.5, color: T.text,
				fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif",
				background: "var(--dsw-alias-bg-base, #fff)",
				height: "100%", boxSizing: "border-box", overflow: "hidden",
				width: "100%", maxWidth: 1120, marginInline: "auto", minWidth: 0,
				minHeight: 0,
				containerType: "inline-size",
				padding: "calc(24px + var(--dsh-frame-top-clearance, 0px)) clamp(14px, 1.6vw, 24px) 24px",
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
			sectionHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 2, minHeight: 34 },
			sectionTitle: { fontSize: 24, fontWeight: 650, margin: 0, lineHeight: 1.35, letterSpacing: "-.025em" },
			sectionHint: { fontSize: 15, color: T.text3, margin: 0, lineHeight: 1.5 },
			menu: { position: "relative", flexShrink: 0 },
			menuList: { position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 20, display: "grid", gap: 4, padding: 8, minWidth: 180, borderRadius: 10, border: `1px solid ${T.line}`, background: T.cardBg, boxShadow: "0 12px 32px rgba(20,26,40,.12)" },
			listRow: { display: "flex", gap: 14, alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${T.line2}`, minWidth: 0, background: T.cardBg },
			listMeta: { fontSize: 13, color: T.text3, minWidth: 0 },
			// ---- page head, ported from the v4 prototype ----------------------
			// Two rows: identity + actions, then the sub-line. The brand mark is
			// the only illustration in the whole page; everything else is text.
			// v4's header is two rows: identity + actions on the first, the
			// sub-line on its own row below so the outlined log button can sit
			// at its far end. Stacking all four controls into one row is what
			// made the old head read as a toolbar.
			// A compact card, not a full-width bar: it is sized by what it holds,
			// and both halves sit on the same centre line.
			// Identity left, the run of controls right, both on one centre line.
			// The card is only as wide as that row: a full-bleed header panel
			// would push the tabs down for no gain.
			// Stretch, not center: both halves then span the card's full inner
			// height, so the card is never taller than what it paints (a
			// vertically centred child leaves slack above and below itself).
			// The mark sits on a white tile, as in the prototype: on the tinted
			// panel the bare glyph reads as an icon floating in colour.
			brandTile: {
				display: "flex", alignItems: "center", justifyContent: "center",
				width: 30, height: 30, borderRadius: 10, flexShrink: 0,
				background: T.cardBg, border: "1px solid rgba(128,128,128,0.10)",
				boxShadow: "0 1px 2px rgba(20,22,28,0.05)",
			},
			// The wrapper that stacks the tinted panel over the ident line.
			headWrap: {
				display: "flex", flexDirection: "column", gap: 8, marginBottom: 4,
			},
			pageHead: {
				display: "flex", alignItems: "center", justifyContent: "space-between",
				gap: 24, flexWrap: "nowrap", minWidth: 0,
			},
			// The ident line: build facts left, the two log controls right. Small
			// and quiet on purpose — it answers "what am I looking at", not "what
			// can I press", so it reads as a caption under the panel.
			identRow: {
				display: "flex", alignItems: "center", justifyContent: "space-between",
				gap: 12, padding: "0 2px", flexWrap: "wrap",
			},
			identText: { fontSize: 12, color: T.text3, lineHeight: 1.5, minWidth: 0 },
			identActs: { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 },
			// The four controls, side by side in one row on the right: the
			// identity owns the left edge, and the buttons keep the reading
			// order they are used in (rescan, updates, log, export).
			headCol: {
				display: "flex", flexDirection: "row", gap: 8,
				alignItems: "center", justifyContent: "flex-end",
				flexShrink: 0,
			},
			// Row B: the sub-line and the one outlined control that belongs with
			// it, so the first row keeps a single filled button.
			// Warnings only: it wraps to its own line under both halves.
			headSubRow: {
				display: "flex", gap: 12, alignItems: "center",
				flexWrap: "wrap", flexBasis: "100%",
			},
			// No alignSelf: the halves stretch to the card's inner height so the
			// card never paints a shorter box than it occupies (that slack was
			// exactly what the first-paint probe flagged).
			titleRow: { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", minWidth: 0 },
			// The "&" between the two spaces, quiet enough to read as a join.
			amp: { fontWeight: 400, color: T.text3, margin: "0 3px" },
			pageTitle: { fontSize: 28, fontWeight: 700, color: T.text, lineHeight: 1.2, letterSpacing: "-.035em" },
			// v4 states the version as plain muted text beside the title, not as
			// a chip: it is a fact about the page, not a status to decode.
			versionChip: { fontSize: 13, color: T.text3, fontWeight: 400, whiteSpace: "nowrap" },
			// 「点个 star」: a capsule in the identity row. The resting look is
			// inline so a renderer without the injected sheet still shows a
			// proper pill; the hover motion lives in ensureStyles, because
			// :hover and keyframes are not things an inline style can say.
			star: {
				display: "inline-flex", alignItems: "center", gap: 5, height: 24,
				padding: "0 10px", borderRadius: 999, overflow: "hidden",
				border: `1px solid ${T.line}`, background: "rgba(255,125,0,.06)",
				color: T.text2, fontSize: 12, fontWeight: 500, lineHeight: 1,
				textDecoration: "none", whiteSpace: "nowrap", position: "relative",
				transition: "transform .16s ease, border-color .16s ease, background .16s ease, box-shadow .16s ease",
			},
			starIcon: {
				display: "block", color: T.amber, position: "relative", zIndex: 1,
				transition: "transform .24s cubic-bezier(.2,.9,.3,1.4)",
			},
			starLabel: { position: "relative", zIndex: 1 },
			pageSub: { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", minWidth: 0 },
			pageSubText: { margin: 0, fontSize: 12.5, color: T.text3 },
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
			button: { padding: "8px 14px", minHeight: 36, borderRadius: 8, cursor: "pointer", fontSize: 14, fontFamily: "inherit", fontWeight: 500, border: `1px solid ${T.line}`, background: T.cardBg, color: T.text, flexShrink: 0, whiteSpace: "nowrap", boxSizing: "border-box" },
			// v4's primary is INK, not accent: exactly one filled button per
			// view, with the accent spent on links, tab rules and badges
			// instead. `T.text` on `T.cardBg` is v4's own light/dark pair
			// (#111/#fff ↔ #f2f2f2/#111) without needing a second rule.
			primary: { background: T.brand, borderColor: T.brand, color: "#fff", fontWeight: 600 },
		// Install and save wear the accent fill; the ink one belongs to
		// "rescan the host", the only verb allowed to shout that loud.
			accent: { background: T.brand, borderColor: T.brand, color: "#fff", fontWeight: 600 },
			// A row whose update is already queued or running: the row's own
			// button is where a reader looks for its state, so it reports that
			// state in place — muted and not clickable — instead of vanishing
			// from under the pointer or inviting a second click at a control
			// that is already booked.
			buttonBusy: {
				background: T.soft, borderColor: T.line, color: T.text3,
				fontWeight: 500, cursor: "default",
			},
			// v4's `.btn-text`: borderless and muted, so it never competes with
			// the one filled control beside it.
			textBtn: { padding: "6px 8px", borderRadius: 7, cursor: "pointer", fontSize: 14, fontFamily: "inherit", fontWeight: 500, border: "none", background: "transparent", color: T.text2, flexShrink: 0, whiteSpace: "nowrap" },
			// v4's `.btn-outline`, used by 导出日志 alone.
			outlineBtn: { padding: "7px 12px", borderRadius: 8, cursor: "pointer", fontSize: 14, fontFamily: "inherit", border: `1px solid ${T.line}`, background: T.cardBg, color: T.text2, display: "inline-flex", alignItems: "center", gap: 8 },
			// The user's own catalogue sources: a quiet box that only appears when
			// its row is open, so the market's chrome stays three rows deep.
			sourceBox: { border: `1px solid ${T.line}`, borderRadius: 10, padding: "8px 12px", background: T.cardBg, fontSize: 12, color: T.text2, marginBottom: 0 },
			sourceHead: {
				display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
			},
			sourceRow: {
				display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
				padding: "7px 0", borderTop: `1px solid ${T.line2}`,
			},
			sourceLabel: { fontWeight: 600, color: T.text, wordBreak: "break-all" },
			sourceUrl: { color: T.text3, wordBreak: "break-all", flex: "1 1 200px", minWidth: 0 },
			sourceInput: {
				flex: "1 1 240px", minWidth: 0, padding: "6px 10px", fontSize: 12.5,
				borderRadius: 8, border: `1px solid ${T.line}`, background: T.cardBg, color: T.text,
			},
			sourceMiniBtn: { padding: "5px 10px", minHeight: 30, borderRadius: 7, cursor: "pointer", fontSize: 13, fontFamily: "inherit", border: `1px solid ${T.line}`, background: T.cardBg, color: T.text2, flexShrink: 0, whiteSpace: "nowrap" },
			sourceMiniBtnDanger: { color: T.red },
			// ---- the two spaces -------------------------------------------
			// MCP and Skill are peers, not a filter over one list: each has its
			// own items and actions. Keep this selector distinct from the view tabs.
			spaceSwitch: { display: "flex", alignItems: "center", gap: 12, flex: "none", paddingInlineEnd: 14 },
			spacePill: { minHeight: 34, padding: "4px 2px", borderRadius: 4, cursor: "pointer", border: 0, color: T.text2, font: "inherit", fontSize: 14, fontWeight: 600, whiteSpace: "nowrap" },
			spacePillOn: { color: T.brand, fontWeight: 700 },
			// ---- skill cards ----------------------------------------------
			// A skill has no connection, no tools and no health: the card shows
			// what a person can actually judge it by — what it does, where it
			// came from, when it last changed, and the folder to open.
			skillGrid: { display: "grid", gap: 16, minWidth: 0, gridTemplateColumns: "repeat(3,minmax(0,1fr))" },
			skillCard: { display: "grid", gridTemplateColumns: "minmax(0,2.3fr) minmax(120px,1fr) minmax(140px,1fr) 110px", gap: 16, padding: "5px 20px", alignItems: "center", borderBottom: `1px solid ${T.line2}`, background: T.cardBg, minWidth: 0, minHeight: 47 },
			skillAvatar: {
				width: 40, height: 40, borderRadius: 12, flexShrink: 0,
				display: "grid", placeItems: "center", fontSize: 15, fontWeight: 680,
				background: SKILL_SOFT, color: SKILL_INK, border: `1px solid ${SKILL_LINE}`,
			},
			skillMain: {
				display: "flex", flexDirection: "column", gap: 1,
				minWidth: 0, flex: "1 1 auto",
			},
			skillHead: {
				display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap", minWidth: 0,
			},
			skillName: { fontSize: 16, lineHeight: 1.2, fontWeight: 600, color: T.text, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			skillBadge: {
				fontSize: 11, padding: "1px 7px", borderRadius: 999,
				background: SKILL_SOFT, color: SKILL_INK,
				border: `1px solid ${SKILL_LINE}`, whiteSpace: "nowrap",
			},
			skillTags: { display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", marginTop: 2 },
			skillVer: { fontSize: 11.5, color: T.text3, whiteSpace: "nowrap" },
			skillDesc: { fontSize: 14, color: T.text2, lineHeight: 1.2, display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical", overflow: "hidden" },
			skillMeta: {
				fontSize: 11.5, color: T.text4,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			},
			skillActs: { display: "flex", gap: 8, flexShrink: 0, alignItems: "center" },
			skillRail: {
				display: "flex", flexDirection: "column", gap: 2,
				flexShrink: 0, width: 16, paddingTop: 2,
			},
			marketStatus: { display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", padding: "10px 2px 2px", fontSize: 12, color: "#6b7280" },
			marketChip: {
				display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px",
				borderRadius: 999, border: `1px solid ${SKILL_LINE}`, background: SKILL_SOFT,
				fontSize: 11, color: SKILL_INK,
			},
			marketChipBad: { borderColor: "#f2d4cf", background: "#fdf2f1", color: "#a3392f" },
			// Skill 市场（原型 v5）：提示行 → 搜索 → 筛选 → 统计行 → 两张 spotlight
			// → 卡片网格 → 脚注。只用主题变量与固定 rgba，深色主题下不会翻车。
			smHintRow: {
				display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
				fontSize: 12, color: T.text3, margin: "0 0 10px",
			},
			smHintChip: {
				fontSize: 11, fontWeight: 600, padding: "1px 7px", borderRadius: 6,
				background: "#fff9ef", color: "#a07a3a", border: "1px solid #f3e8d4",
			},
			// The search box, the filters and the count line stay at the top of the
			// tab body while the cards scroll under them. `top: 0` is the scroll
			// container's padding box, so it parks exactly at the tab edge.
			smSticky: { display: "flex", flexDirection: "column", gap: 8, paddingBottom: 0, minWidth: 0 },
			smToolbar2: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", margin: 0 },
			// The 已注册 tabs keep their search and filter row by keeping it
			// *outside* the scrolling box: the scrollbar then belongs to the list
			// alone instead of running up beside the header. `regHeader` is that
			// non-scrolling row, `regScroll` is the box under it.
			regHeader: {
				display: "flex", flexDirection: "column", gap: 10,
				minWidth: 0, paddingBottom: 6,
				// The header is chrome above the list, and an expanded GitHub box
				// plus an update queue can outgrow a short window. Capping it and
				// letting it scroll keeps the list visible instead of collapsing it
				// to zero with the tail clipped.
				flex: "0 0 auto", maxHeight: "55%", overflowY: "auto",
			},
			regScroll: {
				flex: "1 1 auto", flexShrink: 1, minHeight: 0, overflowY: "auto",
				minWidth: 0, paddingBottom: 4,
			},
			smStat: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12, color: T.text3, margin: 0 },
			smChips: { display: "inline-flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginLeft: "auto" },
			smSrcPill: {
				fontSize: 10.5, fontWeight: 620, padding: "2px 7px", borderRadius: 999,
				background: "#f2f3f5", color: "#646a73", border: "1px solid transparent",
				whiteSpace: "nowrap",
			},
			smSpotlight: { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 16, marginBottom: 0 },
			smHero: { display: "flex", flexDirection: "column", gap: 10, padding: "12px 18px", minHeight: 126, borderRadius: 12, border: "1px solid rgba(69,102,233,.12)", background: "linear-gradient(115deg, rgba(69,102,233,.10), rgba(69,102,233,.045))", minWidth: 0 },
			smHeroAlt: { border: "1px solid rgba(69,102,233,.12)", background: "rgba(69,102,233,.055)" },
			smEyebrow: { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 15, fontWeight: 600, color: T.brand },
			smHTitle: { fontSize: 20, lineHeight: 1.3, fontWeight: 650, color: T.text, letterSpacing: "-.02em" },
			smHDesc: { fontSize: 14, color: T.text2, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			smHFoot: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			smN: { fontSize: 12, color: T.text3, whiteSpace: "nowrap" },
			smBadge: {
				fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 6,
				background: SKILL_SOFT, color: SKILL_INK, border: "1px solid #e3e0f6",
			},
			smCard: { display: "flex", flexDirection: "column", gap: 5, padding: "10px 16px", minHeight: 150, borderRadius: 12, background: T.cardBg, border: `1px solid ${T.line}`, boxShadow: "0 2px 4px rgba(20,26,40,.035)", minWidth: 0 },
			smTop: { display: "flex", alignItems: "flex-start", gap: 10, minWidth: 0 },
			smBox: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0, flex: "1 1 auto" },
			smId: {
				display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto",
				width: 30, height: 30, borderRadius: 9, background: SKILL_SOFT,
				color: SKILL_INK, fontWeight: 650, fontSize: 12.5,
			},
			smNm: { fontSize: 18, fontWeight: 600, lineHeight: 1.3, color: T.text, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
			smSrc: { fontSize: 13, color: T.text3, marginTop: 2 },
			smDesc: { fontSize: 15, lineHeight: 1.45, color: T.text2, height: "2.9em", margin: 0, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" },
			smFoot: { display: "flex", gap: 8, alignItems: "center", marginTop: "auto", flexWrap: "wrap" },
			smAct: { marginLeft: "auto" },
			smNote: {
				marginTop: 14, padding: "11px 13px", borderRadius: 12,
				background: "rgba(255,255,255,0.75)", border: "1px solid " + T.line2,
				color: T.text3, fontSize: 12, lineHeight: 1.6,
			},
			smCode: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5,
				background: T.soft, borderRadius: 4, padding: "1px 5px", color: T.text2,
			},

			marketCard: {
				display: "flex", gap: 10, alignItems: "flex-start", padding: 12, minWidth: 0,
				border: "1px solid " + "#ebecef", borderRadius: 10, background: "#fff",
			},
			marketName: { fontSize: 13, fontWeight: 600, color: "#1f2329", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			marketDesc: {
				fontSize: 12, lineHeight: 1.5, color: "#4b5563", margin: "2px 0 0",
				display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden",
			},
			marketMeta: { fontSize: 11, color: "#9aa1ac", marginTop: 4 },
			marketFoot: { fontSize: 12, color: "#6b7280", padding: "10px 2px 0", lineHeight: 1.6 },
						skillRailLetter: { fontSize: 10.5, fontWeight: 700, color: T.text4, lineHeight: 1.3 },
			// The space's body: a toolbar, one count line, then one framed group
			// per root. Groups are framed because the roots are the only real
			// hierarchy here — a flat wall of ~400 cards hides which folder a row
			// came from, and that is the one question the page exists to answer.
			skillPanel: { display: "flex", flexDirection: "column", gap: 10, minWidth: 0 },
			skillHint: { fontSize: 12, color: T.text3 },
			skillGroup: { display: "flex", flexDirection: "column", gap: 0, marginBottom: 12, border: `1px solid ${T.line}`, borderRadius: 12, background: T.cardBg },
			skillGroupHead: { display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderBottom: `1px solid ${T.line2}`, fontSize: 12, color: T.text3, flexWrap: "wrap" },
			skillGroupTitle: {
				display: "flex", gap: 8, alignItems: "center",
				fontSize: 13, fontWeight: 650, color: T.text,
			},
			skillGroupDir: {
				fontSize: 11.5, color: T.text4, minWidth: 0,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			},
			skillGroupNote: { fontSize: 11.5, color: T.text3, marginLeft: "auto" },
			skillGroupChev: { width: 11, fontSize: 11, color: T.text3, lineHeight: 1 },
			skillGroupEmpty: { padding: 14, fontSize: 12.5, color: T.text3 },
			// One skill, opened from its card. A drawer rather than a centred
			// sheet: the list stays visible beside it, so a reader can open two in
			// a row and compare without losing their place.
			scrim: {
				position: "fixed", inset: 0, zIndex: 60, display: "flex",
				justifyContent: "flex-end", background: "rgba(15,18,24,0.30)",
			},
			drawer: {
				width: "min(520px, 92vw)", height: "100%", display: "flex", flexDirection: "column",
				background: T.cardBg, borderLeft: `1px solid ${T.line}`,
				boxShadow: "-18px 0 40px rgba(0,0,0,0.12)",
			},
			drawerHead: {
				display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between",
				padding: "16px 18px", borderBottom: `1px solid ${T.line}`,
			},
			drawerTitle: { display: "flex", gap: 10, alignItems: "center", minWidth: 0 },
			drawerTitleText: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 },
			drawerName: {
				fontSize: 15, fontWeight: 650, color: T.text,
				overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			},
			drawerSub: {
				fontSize: 12, color: T.text3,
				overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			},
			drawerBody: {
				display: "flex", flexDirection: "column", gap: 8,
				padding: "16px 18px", overflowY: "auto", flex: "1 1 auto",
			},
			drawerPara: { margin: "6px 0 0", fontSize: 12.5, color: T.text2, lineHeight: 1.65 },
			drawerFoot: {
				display: "flex", gap: 8, justifyContent: "flex-end",
				padding: "14px 18px", borderTop: `1px solid ${T.line}`,
			},
			// The skill card reuses the MCP detail sheet — same width, same
			// centring, same fact rows — so the two never look like different
			// products. Only the head layout is its own.
			skillCardHead: { display: "flex", gap: 12, alignItems: "flex-start", justifyContent: "space-between", minWidth: 0 },
			skillCardId: { display: "flex", gap: 10, alignItems: "center", minWidth: 0 },
			skillCardNames: { display: "flex", flexDirection: "column", gap: 5, minWidth: 0 },
			skillCardName: {
				fontSize: 16.5, fontWeight: 700, color: T.text,
				overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			},
			skillCardSub: {
				fontSize: 12, color: T.text3,
				overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
			},
			skillBlock: { display: "grid", gap: 6 },
			skillBlockLab: { fontSize: 11, letterSpacing: "0.08em", color: T.text3, fontWeight: 600 },
			skillTree: {
				border: `1px solid ${T.line2}`, borderRadius: 10, background: T.soft,
				padding: "10px 12px", fontSize: 12, lineHeight: 1.7, color: T.text2,
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", whiteSpace: "pre-wrap",
			},
			skillHint: {
				display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap",
				fontSize: 11.5, lineHeight: 1.65, color: T.text3,
			},
			skillHintChip: {
				flex: "0 0 auto", padding: "1px 7px", borderRadius: 999,
				background: "rgba(240,180,41,0.16)", color: "#8a6412", fontWeight: 500,
			},
			skillFoot: { display: "flex", gap: 8, justifyContent: "flex-end", paddingTop: 2 },
			// Removing a skill is a move into our own trash directory, and the
			// confirmation is a small centred sheet rather than a second click on
			// the card: what has to be read is the exact directory that moves —
			// a card has no room for a path, and this is the last moment the user
			// can see which of four roots the folder lives in.
			dialogScrim: {
				position: "fixed", inset: 0, zIndex: 70, display: "flex",
				alignItems: "center", justifyContent: "center", background: "rgba(15,18,24,0.34)",
			},
			dialogBox: {
				width: "min(470px, 92vw)", background: T.cardBg, borderRadius: 12,
				border: `1px solid ${T.line}`, boxShadow: "0 24px 60px rgba(0,0,0,0.18)",
				display: "flex", flexDirection: "column",
			},
			dialogHead: { padding: "16px 18px 0", fontSize: 15, fontWeight: 650, color: T.text },
			dialogBody: { padding: "10px 18px 4px", display: "flex", flexDirection: "column", gap: 8 },
			dialogLine: { fontSize: 12.5, color: T.text2, lineHeight: 1.65, wordBreak: "break-all" },
			dialogFoot: { display: "flex", gap: 8, justifyContent: "flex-end", padding: "14px 18px" },
			// The one destructive-looking button on the page. Colour, not weight:
			// it sits beside 取消 and must not read as the default action.
			dangerBtn: { color: "#c4453b", borderColor: "#e7c3bf" },
			// Underline tabs: the label sits on a rule and the active rule is
			// ink, not accent. The rule is drawn by the injected sheet on
			// `.omkt-tab[aria-selected="true"]::after` rather than as an inline
			// `border-bottom: 2px solid transparent` on the inactive tab: in the
			// real app that transparent border painted *black* (the UA button
			// border colour), so both tabs looked selected at once. A pseudo
			// element that is transparent unless the tab is selected cannot do
			// that, and `aria-selected` is also what a screen reader reads.
			tabBar: { display: "flex", gap: 14, alignItems: "center", borderBottom: `1px solid ${T.line}`, marginBottom: 22, overflowX: "auto" },
			tab: { padding: "8px 12px 10px", marginRight: 8, background: "transparent", cursor: "pointer", fontSize: 16, fontWeight: 500, color: T.text2, border: "none", lineHeight: 1.4, whiteSpace: "nowrap" },
			tabActive: { color: T.text, fontWeight: 620 },
			stats: { display: "flex", gap: 20, flexWrap: "wrap", fontSize: 14, color: T.text2, padding: "2px 0" },
			// v4's market chrome is three rows, and each row has one job: a
			// search pill, a chip row with the page's compact controls at its
			// end, then a meta line of bold numbers. Five controls in one row
			// is what made the old page read as a form.
			searchWrap: { display: "flex", gap: 10, alignItems: "center", width: "100%", height: 42, boxSizing: "border-box", minWidth: 0, padding: "0 12px", borderRadius: 9, border: `1px solid ${T.line}`, background: T.cardBg, color: T.text3 },
			searchIcon: { fontSize: 13, lineHeight: 1, flexShrink: 0 },
			searchInput: { flex: 1, minWidth: 0, width: "100%", border: 0, outline: 0, background: "transparent", fontSize: 15, fontFamily: "inherit", lineHeight: 1.5, color: T.text, padding: 0 },
			filters: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 0 },
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
			select: { padding: "8px 12px", height: 40, borderRadius: 8, border: `1px solid ${T.line}`, background: T.cardBg, color: T.text, fontSize: 14, fontFamily: "inherit", maxWidth: "100%", minWidth: 0 },
			searchBox: { flex: "1 1 240px", minWidth: 0, height: 40, padding: "8px 12px", borderRadius: 8, border: `1px solid ${T.line}`, background: T.cardBg, color: T.text, fontSize: 14, fontFamily: "inherit", boxSizing: "border-box" },
			group: { border: `1px solid ${T.line}`, borderRadius: 12, background: T.cardBg, marginBottom: 12 },
			groupHead: { display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", borderBottom: `1px solid ${T.line2}`, background: T.soft, borderRadius: "12px 12px 0 0" },
			groupTitle: { fontWeight: 600 },
			badge: { fontSize: 11, padding: "1px 7px", borderRadius: 999, background: T.soft2, color: T.text2, fontWeight: 500 },
			pager: { display: "flex", alignItems: "center", gap: 8, paddingTop: 8, flexWrap: "wrap", fontSize: 13, minHeight: 46 },
			updateBadge: {
				fontSize: 12, padding: "1px 8px", borderRadius: 999,
				background: "rgba(0,180,42,0.12)", color: T.green, fontWeight: 600,
			},
			// The plugin's own update control sits beside the version chip it
			// changes, so it is the compact pill variant of v4's primary button
			// rather than another full-size one competing with the head's own.
			chipButton: { padding: "2px 9px", fontSize: 12, borderRadius: 999 },
			// 更新队列 — the one row that owns every update this page starts. A
			// single row's 更新 and 全部更新 both report here, so there is exactly
			// one place on the page that says what is happening to what.
			updateBar: {
				display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
				padding: "10px 12px", borderRadius: 10, border: `1px solid ${T.line}`,
				background: T.soft, marginBottom: 12, boxSizing: "border-box",
			},
			// A real (i/N) bar: the fill's width is the share of items the host
			// has already answered for. `position: relative` is what the running
			// sheen is drawn against.
			progressTrack: {
				position: "relative", flex: "1 1 160px", minWidth: 120, height: 6,
				borderRadius: 999, background: T.soft2, overflow: "hidden",
			},
			progressFill: {
				height: "100%", borderRadius: 999, background: T.text,
				transition: "width .25s ease",
			},
			progressText: { fontSize: 12, color: T.text2, whiteSpace: "nowrap" },
			// The per-item detail under the bar. `flexBasis: 100%` is what drops
			// it onto its own line inside the wrapping bar row.
			jobList: {
				display: "flex", flexDirection: "column", gap: 6,
				flexBasis: "100%", minWidth: 0, marginTop: 2,
			},
			jobRow: { display: "flex", gap: 8, alignItems: "baseline", minWidth: 0, fontSize: 12 },
			jobIcon: { color: T.text3, flexShrink: 0 },
			jobName: { color: T.text, fontFamily: "monospace", flexShrink: 0 },
			jobMsg: {
				color: T.text3, minWidth: 0, overflow: "hidden",
				textOverflow: "ellipsis", whiteSpace: "nowrap",
			},
			jobUpdated: { color: T.green },
			jobFailed: { color: T.red },
			// The finished-queue outcome takes the slot the button was in: a
			// checked line reads as 「done」, where a live button and a 100%-wide
			// track still read as 「working」. A row reports its own outcome the
			// same way, in the slot its 更新 button occupied.
			jobOutcome: {
				display: "inline-flex", gap: 6, alignItems: "center",
				fontSize: 12.5, fontWeight: 600, color: T.green, whiteSpace: "nowrap",
			},
			// 「来源已删除」: the row's own source was read by the last scan and no
			// longer defines this name. Amber, not red — nothing is broken, there
			// is just a record here that no config anywhere accounts for.
			orphanBadge: {
				padding: "1px 7px", borderRadius: 999, fontSize: 11.5, fontWeight: 600,
				color: T.amber, background: T.soft2, whiteSpace: "nowrap", flexShrink: 0,
			},
			// 「检查失败」: the last 「检查更新」 errored for this row, so its version
			// state is *unknown* rather than current. Red, unlike the amber orphan
			// chip: something did fail, it just did not fail here. The host stores
			// the failure in the verdict (`latest: null`, `error`), and before this
			// chip the row simply showed nothing.
			checkBadge: {
				padding: "1px 7px", borderRadius: 999, fontSize: 11.5, fontWeight: 600,
				color: T.red, background: T.soft2, whiteSpace: "nowrap", flexShrink: 0,
			},
			// 「待配置」: a required setting this server declared is still empty, so
			// its tool calls will fail until someone fills the form. Amber, like
			// the orphan chip — nothing is broken, something is missing.
			configBadge: {
				padding: "1px 7px", borderRadius: 999, fontSize: 11.5, fontWeight: 600,
				color: T.amber, background: T.soft2, whiteSpace: "nowrap", flexShrink: 0,
			},
			pendingBadge: {
				padding: "1px 7px", borderRadius: 999, fontSize: 11.5, fontWeight: 500,
				color: T.dim, background: T.soft, whiteSpace: "nowrap", flexShrink: 0,
			},
			configBanner: {
				display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap",
				padding: "9px 12px", borderRadius: 10, border: `1px solid ${T.line}`,
				background: T.soft, color: T.text2, fontSize: 12.5, lineHeight: 1.6,
			},
			// The config sheet is narrower than the detail sheet: a form is read
			// top to bottom, and a 680px-wide input invites pasting the wrong thing.
			configPanel: {
				width: "min(560px, 100%)", maxHeight: "100%", overflow: "auto",
				display: "grid", gap: 12, padding: 20,
				borderRadius: 16, border: `1px solid ${T.line}`,
				background: T.cardBg, color: T.text,
				boxShadow: "0 24px 64px rgba(0,0,0,0.14)",
			},
			fieldRow: { display: "grid", gap: 4 },
			fieldLabel: { fontSize: 12.5, fontWeight: 600, display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" },
			fieldReq: { fontSize: 11, color: T.amber, fontWeight: 600 },
			fieldOpt: { fontSize: 11, color: T.text3, fontWeight: 400 },
			fieldHelp: { fontSize: 11.5, color: T.text3, lineHeight: 1.6 },
			fieldLink: { fontSize: 11.5, color: T.brand, textDecoration: "underline", cursor: "pointer" },
			fieldInput: {
				width: "100%", boxSizing: "border-box", padding: "6px 9px", borderRadius: 8,
				border: `1px solid ${T.line}`, background: T.cardBg, color: T.text,
				fontSize: 12.5, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			},
			fieldSaved: { fontSize: 11, color: T.green },
			kvHead: { display: "flex", alignItems: "center", gap: 8, marginTop: 4 },
			kvRow: { display: "flex", gap: 6, alignItems: "center" },
			kvKey: {
				flex: "1 1 120px", minWidth: 0, padding: "5px 8px", borderRadius: 7,
				border: `1px solid ${T.line}`, background: T.cardBg, color: T.text,
				fontSize: 12, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			},
			// The host carries `registryError` when registry.json could not be
			// parsed. Without it the tab would render an empty list that looks
			// exactly like "you never added a server".
			registryWarn: {
				padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.line}`,
				background: T.soft2, color: "#f53f3f", fontSize: 12.5, lineHeight: 1.7,
			},
			// An install that reached the registry but did not mount. Needs
			// `pre-wrap`: this block is the host's raw error, the model's
			// explanation, and the next step on separate lines, and collapsed
			// newlines would turn three facts into one unreadable sentence.
			installFailure: {
				padding: "8px 10px", borderRadius: 8, border: `1px solid ${T.line}`,
				background: T.soft2, color: T.text2, fontSize: 12.5, lineHeight: 1.7,
				whiteSpace: "pre-wrap",
			},
			groupBody: { display: "flex", flexDirection: "column" },
			row: { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "12px 16px", borderBottom: `1px solid ${T.line2}`, minWidth: 0 },
			// The row's left half: the name, then the sentence explaining what
			// this server is for, then the transport/state facts underneath it.
			// The purpose line is what a reader is looking for here; the
			// technical details are demoted to the smaller second line instead
			// of being the only thing that follows the name.
			rowMain: { display: "flex", alignItems: "center", gap: 12, flex: "1 1 360px", minWidth: 0 },
			rowText: { display: "flex", flexDirection: "column", gap: 3, flex: "1 1 180px", minWidth: 0 },
			name: { fontSize: 14, fontWeight: 650, color: T.text, flex: "0 1 180px", minWidth: 80, overflowWrap: "anywhere" },
			about: {
				fontSize: 12.5, color: T.text2, lineHeight: 1.5, overflow: "hidden",
				display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", wordBreak: "break-word",
			},
			meta: { color: T.text3, fontSize: 12 },
			dot: (state) => ({
				width: 8, height: 8, borderRadius: "50%", flexShrink: 0,
				// Amber is 「这一行还没检查通过」: a failed mount, a handshake
				// still in flight, and a verdict that came back with a failed
				// check all look like a server that exists but cannot answer.
				// Green must mean 「能用」, otherwise a broken server sitting next
				// to a working one is indistinguishable from it — and that is
				// exactly what happened to a mounted server with zero tools.
				background: state === "on" ? T.green
					: state === "error" || state === "starting" || state === "unhealthy" ? "#e0a020"
						: state === "off" ? "#f53f3f"
							: state === "external" ? T.blue
								: "rgba(128,128,128,0.6)",
			}),
			// ---- market cards: a row-major grid ----
			// Column count comes from the injected sheet's container queries; the
			// inline value is the fallback for the moment before that sheet lands.
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
			card: { display: "flex", flexDirection: "column", gap: 6, padding: 16, borderRadius: 12, border: `1px solid ${T.line}`, background: T.cardBg, color: T.text, minWidth: 0, minHeight: 166, boxShadow: "0 2px 4px rgba(20,26,40,.035)" },
			// `minWidth: 0` is load-bearing: this is a *grid* item inside
			// cardLeft's auto track, so its default `min-width:auto` resolves
			// to min-content — and a `white-space:nowrap` title's min-content
			// is its full text. Without it a long name widens the track past
			// the card and shoves the install/detail buttons over the edge.
			cardHead: { display: "flex", gap: 6, alignItems: "center", minWidth: 0 },
			// Header split: identity column (grows) + action column (fixed).
			cardHd: { display: "flex", gap: 12, alignItems: "center", minWidth: 0, minHeight: 44 },
			cardLeft: { display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 },
			cardCta: { display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end", flexShrink: 0 },
			cardBody: { display: "flex", flexDirection: "column", gap: 10, flex: 1, minWidth: 0, outline: "none", cursor: "pointer" },
			cardName: { fontWeight: 650, fontSize: 18, color: T.text, lineHeight: 1.3, textDecoration: "none", display: "block", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" },
			cardAuthor: { display: "flex", gap: 6, alignItems: "center", fontSize: 13, color: T.text3, lineHeight: 1.35, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
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
			desc: { fontSize: 15, lineHeight: 1.45, color: T.text2, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", height: "2.9em", overflow: "hidden", overflowWrap: "anywhere", margin: 0 },
			tags: { display: "flex", gap: 6, flexWrap: "wrap" },
			// v4's tag is an outline pill, not a filled one: the card already
			// carries one filled element (its install button) and nothing else
			// should read as a control.
			tag: { fontSize: 11, lineHeight: 1.4, padding: "3px 6px", borderRadius: 5, background: T.soft, color: T.text2, whiteSpace: "nowrap", maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis", flexShrink: 0 },
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
				background: "rgba(22,95,255,0.12)", color: T.blue, whiteSpace: "nowrap", flexShrink: 0,
			},
			deprecated: {
				fontSize: 11, padding: "1px 7px", borderRadius: 999, fontWeight: 600,
				background: "rgba(255,125,0,0.14)", color: T.amber, whiteSpace: "nowrap", flexShrink: 0,
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
			detailValue: { color: T.text2, minWidth: 0, wordBreak: "break-all" },
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
			// The box's label row: the caption on the left, the copy button
			// pushed to the right edge of the same line.
			cmdHead: { display: "flex", alignItems: "center", gap: 8 },
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
			// 运行日志 — the host's own record of what the plugin did. It is read
			// line by line when something went wrong and folded away the rest of
			// the time, so it hangs under the head rather than owning a tab.
			logBox: {
				border: `1px solid ${T.line}`, borderRadius: 8, background: T.cardBg,
				padding: "10px 12px", marginBottom: 12,
			},
			logHead: {
				display: "flex", gap: 12, alignItems: "center",
				justifyContent: "space-between", marginBottom: 6,
			},
			logTitle: { fontSize: 12.5, color: T.text2, fontWeight: 600 },
			logBody: {
				maxHeight: 220, overflowY: "auto", fontSize: 11.5, lineHeight: 1.7,
				color: T.text2, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				whiteSpace: "pre-wrap", wordBreak: "break-word",
			},
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
					background: on ? T.brand : "rgba(128,128,128,0.45)", transition: "background 120ms ease",
				},
			}, createElement("span", {
				style: {
					display: "block", width: 17, height: 17, borderRadius: "50%", background: "#fff",
					transform: on ? "translateX(17px)" : "translateX(0)", transition: "transform 120ms ease",
				},
			}));
		}

	/** 「检查」那一行怎么读：一句结论 + 第一个不通过的项 + 耗时 + 时刻。 */
	function healthLine(health) {
		const at = typeof health?.at === "string" ? health.at.slice(11, 19) : "";
		const bad = (health?.checks || []).find((check) => check && check.ok === false);
		const detail = bad?.detail ? `：${bad.detail}` : health?.toolCount ? ` · ${health.toolCount} 个工具` : "";
		// The host has always timed the handshake (`ms` on the verdict); leaving it
		// off the line hid the one number that answers 「它慢不慢」.
		const ms = typeof health?.ms === "number" && Number.isFinite(health.ms) && health.ms >= 0 ? health.ms : null;
		const took = ms === null ? "" : ` · ${ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`}`;
		return `检查${health?.ok ? "健康" : "不健康"}${detail}${took}${at ? ` · ${at}` : ""}`;
	}

					/**
					 * 本次进入界面按过「检查」的行。
					 *
					 * 一条体检结论说的是「这一刻能不能用」，不是这台服务器的属性：把它带过
					 * 一次刷新，用户下次打开面板看到的就是上一班岗的旧答案。所以结论只
					 * 跟随当前页面会话——关掉/刷新页面即清空，且必须由本会话亲手点出来。
					 */
					var checkedThisSession = new Set();
					/** 只留下本会话点过「检查」的那几行的结论，其余一律不带。 */
					function keepSessionHealth(rows) {
						return rows.map((row) => {
							if (!row || !row.health || checkedThisSession.has(row.name)) return row;
							const { health, ...rest } = row;
							return rest;
						});
					}

					/**
					 * 本页的语言。
					 *
					 * 面板自己的文案是中文，所以它要的是「读者读得懂的语言」，不是
					 * 「插件作者的语言」。优先读 `<html lang>`，其次浏览器语言——宿主
					 * 没有给插件暴露语言设置，这两处已经是页面上最可靠的信号。
					 */
					function pageLanguage() {
						const doc = typeof document !== "undefined" ? document.documentElement : null;
						const fromDoc = doc && typeof doc.lang === "string" ? doc.lang : "";
						const fromNav = typeof navigator !== "undefined" && typeof navigator.language === "string"
							? navigator.language
							: "";
						return (fromDoc || fromNav || "en").toLowerCase();
					}
					/** 译文按「语言 + 原句」为键：同一句话换个说法，就是一个新键。 */
					function aboutKey(lang, text) {
						return `${lang}\u0000${text}`;
					}
					/** 本页已经问过翻译的句子，避免同一句话在一次会话里反复 POST。 */
					var requestedAbout = new Set();
					/**
					 * 把每行的用途说明换成本页语言。
					 *
					 * 只动 `source: "server"` 的那句（服务器自己写的散文）：其余两种是
					 * 本插件生成的「工具：…」和启动命令，翻译它们只会把事实弄糊。原文
					 * 保留在 `about.original`，行上的 tooltip 仍然能给出原始措辞。
					 */
					function localizeRows(rows, translations, lang) {
						const list = Array.isArray(rows) ? rows : [];
						const map = translations && typeof translations === "object" ? translations : {};
						return list.map((row) => {
							const about = row && row.about;
							if (!about || about.source !== "server" || typeof about.text !== "string") return row;
							const text = map[aboutKey(lang, about.text)];
							if (typeof text !== "string" || text === "" || text === about.text) return row;
							return { ...row, about: { ...about, text, original: about.text } };
						});
					}


        function UiIcon({ name, size = 18 }) {
            const paths = {
                search: "m21 21-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
                refresh: "M20 8a8 8 0 1 0 0 8 M20 3v5h-5",
                layers: "m12 3 10 5-10 5L2 8l10-5 M2 12l10 5 10-5 M2 16l10 5 10-5",
                filter: "M3 5h18l-7 8v5l-4 2v-7z",
                heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z",
                more: "M4 12h.01 M12 12h.01 M20 12h.01",
                diagnostics: "M6 3v5a4 4 0 0 0 8 0V3 M3 3h6 M11 3h6 M10 12v3a5 5 0 0 0 10 0v-3 M20 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4",
                folder: "M3 6h7l2 2h9v12H3V6Z",
                upload: "M12 16V3m-5 5 5-5 5 5 M4 15v5h16v-5",
                info: "M12 11v5 M12 8h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
                database: "M20 6a8 3 0 1 1-16 0 8 3 0 0 1 16 0 M4 6v12a8 3 0 0 0 16 0V6 M4 12a8 3 0 0 0 16 0",
                pen: "m4 16 12-12 4 4L8 20H4v-4 M14 6l4 4",
                media: "M3 5h18v14H3z M10 9l5 3-5 3Z",
                document: "M5 3h10l4 4v14H5z M8 10h8 M8 14h8 M8 17h5",
                accessibility: "M12 4h.01 M5 8l7 2 7-2 M12 10v5m0 0-4 6m4-6 4 6",
                code: "m8 6-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18",
            };
            return createElement("svg", { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, style: { display: "block", flexShrink: 0 } }, createElement("path", { d: paths[name] || paths.layers }));
        }

        // Known product glyphs supplement catalogue-provided icons. Unknown
        // resources use the neutral connector glyph rather than random colors.
        // Bounded 64px raster snapshots of publisher artwork. Runtime never visits those origins.
        const MCP_PUBLISHER_ARTWORK = Object.freeze({
            // https://0sand1s.co.uk/apple-icon.png?apple-icon.1ux5zn8vdq_zk.png
            cis: "data:image/png;base64,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",
            // https://0si.ai/static/favicon-96.png
            disclosures: "data:image/png;base64,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",
            // https://3dtexel.com/wp-content/uploads/2026/10/3dtexel-favicon-v2-192x192.png
            texel: "data:image/png;base64,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",
            // https://www.4everland.org/icons/64x64-icon.png
            hosting: "data:image/png;base64,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",
            // https://1325.ai/favicon.png
            business: "data:image/png;base64,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",
            // https://ssl.gstatic.com/ui/v1/icons/mail/rfr/gmail.ico
            gmail: "data:image/png;base64,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",
            // https://ssl.gstatic.com/docs/spreadsheets/favicon3.ico
            sheets: "data:image/png;base64,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",
        });
        function ProductIcon({ item, size = 44, repositoryAvatar }) {
            const name = String(item?.title || item?.name || "").toLowerCase();
            const tile = { width: size, height: size, flexShrink: 0, borderRadius: Math.round(size / 4), display: "grid", placeItems: "center", background: T.cardBg, border: `1px solid ${T.line2}`, color: T.brand, boxShadow: "0 2px 4px rgba(20,26,40,.06)" };
            let glyph;
            if (/context.?7/.test(name)) glyph = createElement("strong", { style: { fontSize: size * .48, fontStyle: "italic", color: "#3c73f7", letterSpacing: "-.12em", paddingRight: 4 } }, "C7");
            else if (/^(github|github-mcp|github_mcp)/.test(name)) glyph = createElement("span", { style: { color: "#171b22" } }, githubMark(size * .65));
            else if (/brave/.test(name)) glyph = createElement("svg", { width: size * .72, height: size * .72, viewBox: "0 0 32 32", "aria-hidden": true }, [
                createElement("path", { key: "mane", fill: "#ff6328", d: "M6 3 11 1h10l5 2 4 7-3 15-11 6L5 25 2 10Z" }),
                createElement("path", { key: "face", fill: "white", d: "m7 8 5-3 4 3 4-3 5 3-2 8-7 9-7-9Z" }),
                createElement("path", { key: "eyes", fill: "#ff6328", d: "m9 10 5 2-3 3Zm14 0-5 2 3 3Zm-10 7h6l-3 5Z" }),
            ]);
            else if (/atlassian/.test(name)) glyph = createElement("svg", { width: size * .7, height: size * .7, viewBox: "0 0 32 32", "aria-hidden": true }, [
                createElement("path", { key: "a", fill: "#1679f7", d: "M18 2 31 30H18L11 15Z" }),
                createElement("path", { key: "b", fill: "#47afff", d: "m10 13 8 17H1Z" }),
            ]);
            else if (/anki/.test(name)) glyph = createElement("svg", { width: size * .78, height: size * .78, viewBox: "0 0 32 32", "aria-hidden": true }, [
                createElement("rect", { key: "bg", width: 32, height: 32, rx: 7, fill: "#4f92ff" }),
                createElement("path", { key: "star", fill: "white", d: "m16 4 3.5 8.2 8.5 1-6.5 6 1.8 8.8-7.3-4.6-7.3 4.6 1.8-8.8-6.5-6 8.5-1Z" }),
            ]);
            else if (/tavily/.test(name)) glyph = createElement("svg", { width: size * .7, height: size * .7, viewBox: "0 0 32 32", "aria-hidden": true }, [
                createElement("path", { key: "b", fill: "#476cff", d: "M18 1c0 11-2 13-13 13 11 0 13 2 13 13 0-11 2-13 13-13C20 14 18 12 18 1Z" }),
                createElement("path", { key: "r", fill: "#f53960", d: "M7 18c0 5-1 6-6 6 5 0 6 1 6 6 0-5 1-6 6-6-5 0-6-1-6-6Z" }),
            ]);
            const fallback = glyph ? createElement("span", { style: tile, "aria-hidden": true }, glyph) : null;
            return createElement(Avatar, { item, src: item?.icon, size, fallback, repositoryAvatar, artwork: Object.hasOwn(MCP_PUBLISHER_ARTWORK, item?.artworkKey) ? MCP_PUBLISHER_ARTWORK[item.artworkKey] : undefined });
        }

        function SearchField({ value, onChange, label, placeholder, style }) {
            return createElement("label", { className: "omkt-search", style: { ...styles.searchWrap, ...style } }, [
                createElement(UiIcon, { key: "icon", name: "search", size: 18 }),
                createElement("input", { key: "input", type: "search", className: "omkt-input", style: styles.searchInput, value, placeholder, "aria-label": label, onChange: event => onChange(event.target.value) }),
            ]);
        }

        function SkillIcon({ item, size = 48, initial = false }) {
            const name = item.title || item.name || "";
            const category = skillCategoryOf(item);
            const palette = {
                dev: ["code", "#5c52de", "rgba(98,79,240,.10)"],
                office: ["document", "#0079ca", "rgba(0,129,226,.09)"],
                content: [/视频|video/.test(name) ? "media" : "pen", "#2063df", "rgba(45,104,240,.09)"],
                knowledge: ["layers", "#128143", "rgba(32,168,90,.10)"],
                data: ["database", "#087a88", "rgba(0,144,160,.09)"],
            };
            const [glyph, color, background] = /accessib/.test(name)
                ? ["accessibility", "#6647db", "rgba(98,79,240,.10)"]
                : palette[category] ?? ["layers", T.brand, "rgba(69,102,233,.10)"];
            const fallback = createElement("span", { "aria-hidden": true, style: { width: size, height: size, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: 8, background: initial ? MCP_SOFT : background, color: initial ? T.brand : color, fontWeight: 650, fontSize: item.emoji ? Math.round(size * .58) : 17 } },
                item.emoji || (initial ? Array.from(name.trim())[0]?.toUpperCase() || "·" : createElement(UiIcon, { name: glyph, size: Math.round(size * .6) })));
            return createElement(Avatar, { item, src: item.icon, size, fallback });
        }

        function MarketToolbar({ query, onQuery, onSearch, busy, skill = false, source, onSource, sources, category, onCategory, categories, sort, onSort, sorts, onRefresh, favOnly, onFavorite }) {
            const allCategory = categories[0]?.[0] ?? "";
            const preferred = skill ? ["开发编程", "内容创作", "设计与媒体", "办公与文档", "知识与笔记"] : ["搜索与知识", "开发工具", "办公协作", "数据与存储", "多媒体创作"];
            const quick = categories.slice(1).slice().sort((a, b) => {
                const left = preferred.indexOf(a[1]), right = preferred.indexOf(b[1]);
                return (left < 0 ? 99 : left) - (right < 0 ? 99 : right);
            }).slice(0, 5);
            return createElement("div", { style: { display: "grid", gap: 12 } }, [
                createElement("form", { key: "search", className: "omkt-market-search", style: { gridTemplateColumns: onFavorite ? "minmax(0,1fr) 188px 188px 56px 56px" : "minmax(0,1fr) 188px 188px 56px" }, onSubmit: event => { event.preventDefault(); onSearch(); } }, [
                    createElement("div", { key: "searchbox", className: "omkt-search", style: styles.searchWrap }, [
                        createElement("button", { key: "submit", type: "submit", style: { ...styles.textBtn, padding: 0, color: T.text3 }, disabled: busy, "aria-label": "搜索" }, createElement(UiIcon, { name: "search", size: 18 })),
                        createElement("input", { key: "input", type: "search", className: "omkt-input", style: styles.searchInput, value: query, placeholder: skill ? "搜索 Skill 名称、用途或作者…" : "搜索名称、用途或开发者…", "aria-label": "搜索市场", onChange: event => onQuery(event.target.value) }),
                    ]),
                    createElement("select", { key: "category", className: "omkt-select", style: { ...styles.select, height: 42, width: "100%" }, value: category, "aria-label": "按分类筛选市场", onChange: event => onCategory(event.target.value) }, categories.map(([value, label]) => createElement("option", { key: value, value }, label))),
                    createElement("select", { key: "source", className: "omkt-select", style: { ...styles.select, height: 42, width: "100%" }, value: source, "aria-label": "按来源筛选市场", onChange: event => onSource(event.target.value) }, sources.map(([value, label]) => createElement("option", { key: value, value }, label))),
                    onFavorite ? createElement("button", { key: "favorite", type: "button", style: { ...styles.button, height: 42, padding: "0 12px", color: favOnly ? T.brand : T.text2, background: favOnly ? MCP_SOFT : T.cardBg }, "aria-label": "仅看收藏", "aria-pressed": Boolean(favOnly), title: "仅看收藏", onClick: onFavorite }, createElement(UiIcon, { name: "filter" })) : null,
                    createElement("button", { key: "refresh", type: "button", style: { ...styles.button, height: 42, padding: "0 12px" }, "aria-label": "刷新市场", title: "刷新市场", disabled: busy, onClick: onRefresh }, createElement(UiIcon, { name: "refresh" })),
                ]),
                createElement("div", { key: "quick", className: "omkt-market-categories" }, [
                    createElement("button", { key: "all", type: "button", style: { ...styles.textBtn, fontSize: 15, fontWeight: 600, borderRadius: 18, padding: "5px 16px", ...(category === allCategory ? { background: MCP_SOFT, color: T.brand } : {}) }, "aria-pressed": category === allCategory, onClick: () => onCategory(allCategory) }, "全部"),
                    ...quick.map(([value, label]) => createElement("button", { key: value, type: "button", style: { ...styles.textBtn, fontSize: 15, padding: "5px 10px", ...(category === value ? { background: MCP_SOFT, color: T.brand, borderRadius: 18 } : {}) }, title: label, "aria-pressed": category === value, onClick: () => onCategory(value) }, label)),
                    onSort ? createElement("select", { key: "sort", className: `omkt-select${sort !== "default" ? " omkt-select-on" : ""}`, style: { ...styles.select, marginLeft: "auto", background: sort !== "default" ? MCP_SOFT : "transparent", border: 0, height: 34, padding: "0 4px", color: sort !== "default" ? T.brand : T.text2, maxWidth: 180 }, value: sort, "aria-label": "市场排序", onChange: event => onSort(event.target.value) }, sorts.map(([value, label]) => createElement("option", { key: value, value }, label))) : null,
                ]),
            ]);
        }

        function PageFooter({ page, pageCount, pageSize, onPage, onPageSize, note }) {
            const pages = [...new Set([0, page - 1, page, page + 1, pageCount - 1])].filter(value => value >= 0 && value < pageCount).sort((a, b) => a - b);
            return createElement("div", { key: "pager", style: styles.pager }, [
                onPageSize ? createElement("select", { key: "size", className: "omkt-select", style: { ...styles.select, height: 36 }, value: pageSize, "aria-label": "每页条数", onChange: event => onPageSize(Number(event.target.value)) }, [20, 50, 100].map(value => createElement("option", { key: value, value }, `每页 ${value} 条`))) : null,
                note ? createElement("span", { key: "note", style: { fontSize: onPageSize ? 13 : 14, color: T.text3, marginLeft: onPageSize ? 20 : 0 } }, note) : null,
                createElement("span", { key: "spacer", style: styles.spacer }),
                createElement("button", { key: "previous", type: "button", style: { ...styles.button, minHeight: 36, fontSize: 13 }, disabled: page <= 0, onClick: () => onPage(page - 1) }, "‹ 上一页"),
                ...pages.flatMap((value, index) => [index > 0 && value > pages[index - 1] + 1 ? createElement("span", { key: `gap-${value}`, style: { color: T.text3 } }, "…") : null,
                    createElement("button", { key: `page-${value}`, type: "button", "aria-current": value === page ? "page" : undefined, "aria-label": `第 ${value + 1} 页`, onClick: () => onPage(value), style: { ...styles.textBtn, minWidth: 32, height: 34, padding: "0 8px", ...(value === page ? { ...styles.primary } : {}) } }, String(value + 1))]),
                createElement("button", { key: "next", type: "button", style: { ...styles.button, minHeight: 36, fontSize: 13 }, disabled: page >= pageCount - 1, onClick: () => onPage(page + 1) }, "下一页 ›"),
            ]);
        }

        function PageHeading({ title, hint, actions }) {
            return createElement("div", { style: styles.sectionHead }, [
                createElement("div", { key: "heading-text", style: { display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", minWidth: 0 } }, [
                    createElement("h2", { key: "title", className: "omkt-section-title", style: styles.sectionTitle }, title),
                    hint ? createElement("p", { key: "hint", style: styles.sectionHint }, hint) : null,
                ]),
                actions ? createElement("div", { key: "actions", style: styles.toolbar }, actions) : null,
            ]);
        }

        // Native disclosure provides Enter/Space support. Clicking an action
        // closes the menu before starting work; Escape closes it and returns focus.
        function ActionMenu({ label = "更多操作", children }) {
            const close = (details, focus = false) => {
                const menu = details.querySelector('[popover]');
                if (menu.matches(':popover-open')) menu.hidePopover();
                details.open = false;
                if (focus) details.querySelector('summary').focus();
            };
            return createElement("details", {
                className: "omkt-menu", style: styles.menu,
                onKeyDown: event => {
                    if (event.key === "Escape") { event.preventDefault(); close(event.currentTarget, true); }
                },
            }, [
                createElement("summary", {
                    key: "toggle", style: { ...styles.textBtn, padding: "3px 6px", fontSize: 20, lineHeight: 1, minWidth: 26 }, "aria-label": label, title: label,
                    onClick: event => {
                        event.preventDefault();
                        const details = event.currentTarget.parentElement;
                        const menu = details.querySelector('[popover]');
                        if (menu.matches(':popover-open')) { close(details); return; }
                        details.open = true;
                        // React's host version only wires native toggle events
                        // for details. Listen on the popover itself so outside
                        // clicks and Escape also keep the disclosure in sync.
                        menu.ontoggle = () => { if (!menu.matches(':popover-open')) details.open = false; };
                        menu.showPopover();
                        const anchor = event.currentTarget.getBoundingClientRect();
                        const box = menu.getBoundingClientRect();
                        // Placement is native UI geometry; it carries no product
                        // state and must not participate in the row's layout.
                        Object.assign(menu.style, { position: "fixed", top: Math.max(8, Math.min(anchor.bottom + box.height + 6 <= window.innerHeight - 8 ? anchor.bottom + 6 : anchor.top - box.height - 6, window.innerHeight - box.height - 8)) + "px", left: Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8)) + "px", right: "auto", bottom: "auto" });
                    },
                }, "⋯"),
                createElement("div", {
                    key: "items", popover: "auto", style: { ...styles.menuList, margin: 0, maxHeight: "calc(100vh - 16px)", maxWidth: "calc(100vw - 16px)", overflowY: "auto" },
                    onClick: event => { if (event.target.closest("button,a")) close(event.currentTarget.parentElement); },
                }, children),
            ]);
        }

		function ServerRow({ server, busy, checking, hinting, job, onToggle, onRemove, onUpdate, onConfigure, onHealth }) {
			const enabled = server.enabled !== false;
			const provided = server.providedExternally === true;
			// `connected` alone is 「有一个 fiber」, not 「能用」: a mount whose
			// handshake has not finished has no tools yet (see index.js publicList
			// → starting). It must not read as connected, and it must not read as
			// a plain idle either — idle means 「停用之外什么都没发生」.
			const starting = server.starting === true && !server.error;
			const failed = typeof server.error === "string" && server.error !== "";
			// 有一个 fiber 不等于能用。context7 挂上了、握手也过了、一个工具都
			// 没注册，而圆点还是绿的——因为 `connected` 只回答「有没有 fiber」。
			// 最近一次「检查」的结论比它更接近事实，所以排在其前。结论只活在
			// 问它的那个会话里（见 index.js 的 health Map），所以这里读作
			// 「刚查过，没过」，不是一个会被写死的永久状态。
			const unhealthy = !failed && !starting && server.health?.ok === false;
			const state = failed ? "error"
				: provided ? "external"
					: starting ? "starting"
						: unhealthy ? "unhealthy"
							: enabled ? (server.connected ? "on" : "idle") : "off";
			const status = failed ? `连接失败：${server.error}`
				: provided ? "已由其他插件提供（跳过重复挂载）"
					: starting ? "正在连接（握手未完成）· 检查未通过"
						: unhealthy ? "已连接 · 检查未通过"
							: enabled ? (server.connected ? "已连接" : "未连接") : "已停用";
			const prefix = server.serverName ? `工具前缀 mcp__${server.serverName}__` : "";
			const pkg = server.package ? `${server.package.name}@${server.package.version ?? "latest"}` : "";
			const update = server.update;
			// A row the last scan proved its own source no longer defines. It is a
			// leftover, so it must not advertise an update: nothing would ever
			// re-import it, and offering to update a ghost is exactly the confusing
			// badge the first report was about.
			const orphan = server.orphan === true;
			// 「待配置」: a required setting the server declared is still empty. The
			// row says so before anything is clicked — this is the failure mode
			// where the install succeeded, the row read 已连接, and every tool call
			// then answered `401`.
			const needsConfig = server.needConfig === true;
			const configMissing = server.config?.missing ?? [];
			const newVersion = !orphan && update?.updateAvailable ? update.latest : null;
			// The last lookup for this row errored, so its version state is
			// unknown — not current. `latest` is null and `error` says why (see
			// lib/updates.js checkEntryUpdate).
			const checkFailed = !orphan && update?.error ? String(update.error) : null;
			// This row's place in the queue, if it is in one. A queued row says
			// 「等待中」 and the one being rewritten says 「更新中…」, both muted and
			// unclickable: the button is where a reader looks for that state, and
			// a control that stays live while the host already owns the entry is
			// an invitation to write the registry twice.
			const rowStatus = job?.status === "running" || job?.status === "pending" ? job.status : null;
			// An answered row stops advertising the badge it was clicked from —
			// that version has been dealt with — and says what happened instead
			// where its button was. 「无需更新」 is not an event, so it earns no
			// label; the badge going away is the whole statement.
			const settled = job?.answered === true && (job.status === "updated" || job.status === "skipped");
			const badge = settled ? null : newVersion;
			const didUpdate = settled && job.status === "updated" ? job.outcome : null;
			// 「这个 MCP 是干什么的」: the host resolves this from the server's own
			// MCP instructions, then its registered tools, then its launch
			// command, and reports which one it used (`aboutLabel`).
			const about = server.about?.text ? server.about : null;
			const toolCount = about?.toolCount ? `${about.toolCount} 个工具` : "";
			// `omkt-s*` classes (s = server row) are the hooks the browser probes
			// select on: they are the only way to tell the purpose line from the
			// facts line once the styles are inlined as attributes, and they are
			// what proves in a real engine that the line clamp survived.
            const hasConfig = Boolean(server.config || server.channel === "cli-json");
            const healthAction = createElement("button", { key: "health", type: "button", style: { ...styles.textBtn, color: T.brand, padding: "4px 0", fontSize: 14 }, disabled: busy || checking, title: "检查挂载、握手、工具与声明的要求", onClick: () => onHealth(server) }, checking ? "检查中…" : "检查");
            const configAction = hasConfig ? createElement("button", { key: "cfg", type: "button", style: needsConfig ? { ...styles.smallPrimary } : { ...styles.textBtn, color: T.brand, padding: "4px 0", fontSize: 14 }, disabled: busy || checking || hinting, title: needsConfig ? `填写 ${configMissing.join("、") || "必填项"}` : "查看或修改配置", onClick: () => onConfigure(server) }, hinting ? "确认中…" : "配置") : null;
            const updateAction = newVersion && !settled ? createElement("button", { key: "update", type: "button", style: { ...styles.smallPrimary, ...(rowStatus ? styles.buttonBusy : {}) }, disabled: busy || checking || rowStatus !== null, title: rowStatus === "running" ? "这一台正在更新" : rowStatus === "pending" ? "已排队，轮到时自动开始" : undefined, onClick: () => onUpdate(server) }, rowStatus === "running" ? "更新中…" : rowStatus === "pending" ? "等待中" : "更新") : null;
            const source = sourceLabel(server.source);
            return createElement("div", { className: "omkt-srow", style: { borderBottom: `1px solid ${T.line2}` } }, [
                createElement("div", { key: "main", className: "omkt-srow-main omkt-reg-columns" }, [
                    createElement("div", { key: "identity", style: { display: "flex", alignItems: "center", gap: 12, minWidth: 0 } }, [
                        createElement(ProductIcon, { key: "icon", item: server, size: 34 }),
                        createElement("div", { key: "text", style: { minWidth: 0 } }, [
                            createElement("div", { key: "name", className: "omkt-sname", style: { fontSize: 17, lineHeight: 1.15, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, server.name),
                            about ? createElement("div", { key: "about", className: "omkt-sabout", style: { ...styles.about, fontSize: 14, lineHeight: 1.2, color: T.text3, display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, title: [server.aboutLabel, about.original].filter(Boolean).join("\n\n") || undefined }, about.text) : null,
                            createElement("div", { key: "mobile-meta", className: "omkt-reg-mobile", style: { fontSize: 12, color: T.text3 } }, `${source} · ${status}`),
                        ]),
                    ]),
                    createElement("span", { key: "source", className: "omkt-reg-source", style: { fontSize: 15, color: T.text2 } }, source),
                    createElement("div", { key: "status", className: "omkt-reg-status", style: { display: "flex", gap: 7, alignItems: "center", fontSize: 15, color: failed || unhealthy ? T.red : T.text2 }, title: status }, [
                        createElement("span", { key: "dot", style: styles.dot(state) }),
                        createElement("span", { key: "label" }, failed ? "连接异常" : unhealthy ? "检查未通过" : starting ? "正在连接" : provided ? "外部提供" : status),
                    ]),
                    createElement(Switch, { key: "enabled", on: enabled, disabled: busy || checking, title: provided ? "只影响本插件记录；工具由其他插件提供" : enabled ? "停用连接器" : "启用连接器", onToggle: () => onToggle(server, !enabled) }),
                    createElement("div", { key: "actions", "data-omkt": "server-actions", style: { display: "flex", gap: 12, alignItems: "center", justifyContent: "flex-start" } }, [
                        updateAction || configAction || healthAction,
                        createElement(ActionMenu, { key: "more", label: `${server.name} 更多操作` }, [
                            configAction || updateAction ? healthAction : null,
                            updateAction ? configAction : null,
                            createElement("div", { key: "meta", className: "omkt-smeta", title: [server.transport, prefix, pkg, toolCount].filter(Boolean).join(" · "), style: { fontSize: 12, color: T.text3, padding: 6, overflowWrap: "anywhere" } }, [server.transport, prefix, pkg, toolCount].filter(Boolean).join(" · ")),
                            createElement("button", { key: "remove", type: "button", style: styles.textBtn, disabled: busy || checking, title: provided ? "只移除本插件记录，工具仍由其他插件提供" : undefined, onClick: () => onRemove(server) }, "移除"),
                        ]),
                    ]),
                ]),
                createElement("div", { key: "notices", style: { display: "flex", gap: 8, flexWrap: "wrap", padding: needsConfig || badge || orphan || checkFailed || didUpdate || server.health || failed ? "0 20px 10px 66px" : 0 } }, [
				needsConfig
					? createElement("span", {
						key: "needcfg", style: styles.configBadge,
						title: `还缺 ${configMissing.join("、") || "必填项"}：这台服务器的工具调用在填好并重新挂载前不会通。`,
					}, "待配置")
					: (server.config?.pending?.length > 0
						? createElement("span", {
							key: "pendingcfg", style: styles.pendingBadge,
							title: `这台服务器还可配置 ${server.config.pending.join("、")}。`,
						}, `可配置 ${server.config.pending.length} 项`)
						: null),
				badge
					? createElement("span", { key: "newv", style: styles.updateBadge }, `可更新 → ${badge}`)
					: orphan
						? createElement("span", {
								key: "orphan",
								style: styles.orphanBadge,
								title: `最近的扫描读了它来自的配置（${sourceLabel(server.source)}），里面没有这个名字：这条记录已经没有任何配置文件定义它了。`,
							}, "来源已删除")
						: checkFailed
							? createElement("span", {
									key: "checkfail",
									style: styles.checkBadge,
									title: `最近一次「检查更新」没查到最新版本：${checkFailed}`,
								}, "检查失败")
							: didUpdate
							? createElement("span", { key: "newv", style: styles.jobOutcome }, `✓ 已更新到 ${didUpdate}`)
							: null,
                    failed ? createElement("div", { key: "error", role: "alert", style: { fontSize: 13, color: T.red, overflowWrap: "anywhere", width: "100%" } }, status) : null,
						server.health
							? createElement("div", {
								key: "health", className: "omkt-shealth",
								style: { ...styles.meta, color: server.health.ok ? "#2f7d32" : "#b3261e", whiteSpace: "normal" },
								title: (server.health.checks || []).map((c) => `${c.ok ? "✓" : "✗"} ${c.detail}`).join("\n") || undefined,
							}, healthLine(server.health))
							: null,
						// 旧装法的行（`@smithery/cli run …`）握手不会完成，原因不是慢：
						// CLI 把记录解析成远程端点，拉起 mcp-remote 等浏览器登录。0.11.1
						// 起按来源装成远程 http，但改不了已经装下的行——所以这里给出唯一
						// 有效的下一步，而不是让它一直红着。
						server.health && !server.health.ok && server.channel === "cli-json"
							? createElement("div", {
								key: "legacycli",
								style: { ...styles.meta, color: "#8a5a00", whiteSpace: "normal" },
							}, "这是旧装法（Smithery CLI 解析成远程端点，要浏览器登录）。移除后重新安装，会按它自己托管的方式装成远程 http。")
							: null,
                ]),
            ]);
		}

		/**
		 * 「配置这台服务器」— the form a mounted-but-unusable server needs.
		 *
		 * The host declares the fields (`server.config.fields`): env or header,
		 * required or optional, secret or not, and — for the official registry —
		 * the sentence saying what the value is for (`help`). Two rules the form
		 * keeps, both about not lying to the reader:
		 *
		 *   - Only touched fields are sent. An untouched secret renders as
		 *     「已保存」 and the host never echoes it back, so a form that
		 *     submitted every input would send `••••` as the token itself.
		 *   - Cross-check with what the host owes us.
		 */
		/**
		 * Route the sheet's inputs into their three bags: `env`, `headers`, `config`.
		 *
		 * A field's `kind` is the channel the server itself declared, and it decides
		 * where the value goes — not one catch-all bag. Before this, a Smithery
		 * field (`kind: 'config'`) was written to `env`, a place `@smithery/cli run`
		 * never reads; the save looked successful and the row kept saying 还缺
		 * forever, because `composeMountArgs` reads `configValues` for the
		 * `--config` JSON.
		 *
		 * Pure and module-scope on purpose: `tools/render-config-dialog.mjs` asserts
		 * the routing without needing a live React state machine to type into.
		 */
		function splitValues(fields, values, custom) {
			const bags = { env: {}, headers: {}, config: {} };
			const target = (kind) => (kind === "header" ? bags.headers : kind === "config" ? bags.config : bags.env);
			for (const field of fields) {
				const id = `${field.kind}:${field.key}`;
				// Only touched fields: an untouched secret renders as 「已保存」 and the
				// host never echoes it back, so submitting every input would write
				// 「••••」 as the token itself.
				if (!Object.prototype.hasOwnProperty.call(values, id)) continue;
				target(field.kind)[field.key] = values[id];
			}
			for (const row of custom) {
				const key = String(row?.key ?? "").trim();
				if (key === "" || row?.value === "") continue;
				target(row.kind)[key] = row.value;
			}
			return bags;
		}

		/**
		 * Declared-required fields that would still be empty after this save.
		 *
		 * The declaration says 「缺了它就别想握手」; letting 保存 through anyway
		 * turned that into a failed mount the reader had to diagnose. Clearing a
		 * saved required value lands here too — which is the point: the form may
		 * not produce a state the row already knows is broken.
		 */
		function requiredStillMissing(fields, values) {
			return (fields || []).filter((field) => {
				if (field?.required !== true) return false;
				const id = `${field.kind}:${field.key}`;
				if (Object.prototype.hasOwnProperty.call(values ?? {}, id)) {
					return String(values[id] ?? "").trim() === "";
				}
				return field.hasValue !== true;
			}).map((field) => field.key);
		}

		/**
		 * The `--config` argument as it would be handed to the CLI, masked.
		 *
		 * A `--config` row's values are invisible until the process starts: the
		 * form's fields say what was typed, not what the command line will carry.
		 * Showing the composed JSON (secrets as ••••) is the one place the reader
		 * can see the whole payload, including keys added by hand.
		 */
		function previewCliConfig(server, fields, values, custom) {
			if (server?.channel !== "cli-json") return "";
			const picked = {};
			for (const field of fields || []) {
				const id = `${field.kind}:${field.key}`;
				if (field.kind !== "config") continue;
				const touched = Object.prototype.hasOwnProperty.call(values ?? {}, id);
				const next = touched ? String(values[id] ?? "").trim() : "";
				if (next !== "") picked[field.key] = field.secret ? "••••" : next;
				else if (!touched && field.hasValue === true) picked[field.key] = field.secret ? "••••" : (field.value ?? "");
			}
			for (const row of custom || []) {
				if (row?.kind !== "config") continue;
				const key = String(row.key ?? "").trim();
				if (key === "" || row.value === "") continue;
				picked[key] = String(row.value);
			}
			if (Object.keys(picked).length === 0) return "";
			const flag = server?.config?.flag ?? "--config";
			return `${flag} ${JSON.stringify(picked)}`;
		}

		function ConfigDialog({ server, onClose, onSaved }) {
			const fields = server.config?.fields ?? [];
			// A `--config` row stores its settings as JSON on the command line, so a
			// brand-new key row must default to 配置项 there. Seeding it as 环境变量
			// offered a channel that CLI never reads.
			const defaultKind = server.channel === "cli-json" ? "config" : "env";
			const [values, setValues] = useState({});
			// No row is pre-seeded. An empty input with an empty select reads as
			// 「请填写」, and this block is the opposite of that: it is the escape
			// hatch for keys nothing declared, and it may stay untouched forever.
			// 「+ 加一行」 is what makes one appear.
			const [custom, setCustom] = useState([]);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState("");
			const [result, setResult] = useState(null);
			const idOf = (field) => `${field.kind}:${field.key}`;
			const dirty = (field) => Object.prototype.hasOwnProperty.call(values, idOf(field));
			const setValue = (field, next) => setValues((prev) => ({ ...prev, [idOf(field)]: next }));
			const clearValue = (field) => setValues((prev) => ({ ...prev, [idOf(field)]: "" }));
			const ref = rowRef(server);
			const originNote = server.config?.origin === "official"
				? "这些字段来自官方注册表为这个包声明的环境变量（必填/密钥也是它说的）。"
				: server.config?.origin === "observed"
					// Nothing published it — the endpoint itself did. A hosted
					// MCP endpoint answers `401` and names the scheme it wants,
					// so this is the one requirement that is measured rather than
					// guessed, and the sheet can say where it came from.
					? "这些字段是这个端点自己要求的：不带凭据请求一次，它回了 401 并说明了要什么。"
				: server.config?.origin === "smithery"
					// A Smithery row does declare fields, and they are not
					// environment variables: the CLI takes one JSON argument.
					// Saying 「这个来源没有声明配置项」 over a filled-in form was
					// the sheet denying what it was showing.
					? "这些字段来自 Smithery 为这台服务器声明的配置；保存后以 --config 的 JSON 交给 CLI。"
					: server.config?.origin === "args"
						? "这个来源没有声明配置项；下面是从它的启动命令里认出来的变量名，所以一个都没有标「必填」——只有发布方声明过的才算必填。"
						// Nothing declared is a legitimate answer, and it means the
						// server works without configuration — not that this sheet
						// failed to find out. Say which of the two happened, because
						// 「留空即可」 read as a shrug over a server that does need a key.
						: server.channel === "cli-json"
							? "已向 Smithery 确认：这台服务器没有声明要填的配置项，不填也能启动；下面的空行留给你补额外变量。"
							: "官方注册表、启动命令、来源详情都查过了：这台服务器没有声明要填的配置项，不填也能启动；下面的空行留给你补额外变量。";
			const missing = result?.missing ?? server.config?.missing ?? [];
			const requiredMissing = requiredStillMissing(fields, values);
			const cliPreview = previewCliConfig(server, fields, values, custom);

			useEffect(() => {
				const handleKeyDown = (e) => {
					if (e.key === "Escape" || e.key === "Esc") {
						e.stopPropagation();
						onClose();
					}
				};
				window.addEventListener("keydown", handleKeyDown);
				return () => window.removeEventListener("keydown", handleKeyDown);
			}, [onClose]);

			const save = async () => {
				const missingNow = requiredStillMissing(fields, values);
				if (missingNow.length) {
					setError(`先填 ${missingNow.join("、")}：发布方声明它们是必填项。`);
					return;
				}
				// A key added by hand with nothing beside it is not a value: the host
				// would receive nothing for it and the row would still look saved.
				// Dropping the line silently was the worst of the three answers.
				const emptyCustom = (custom || []).filter((row) => String(row?.key ?? "").trim() !== "" && String(row?.value ?? "") === "");
				if (emptyCustom.length) {
					setError(`这些行还没有填值：${emptyCustom.map((row) => String(row.key).trim()).join("、")}。填上值，或删掉这一行。`);
					return;
				}
				setBusy(true); setError(""); setResult(null);
				try {
					const bags = splitValues(fields, values, custom);
					const payload = { ...ref };
					if (Object.keys(bags.env).length) payload.env = bags.env;
					if (Object.keys(bags.headers).length) payload.headers = bags.headers;
					if (Object.keys(bags.config).length) payload.config = bags.config;
					const reply = await api("/configure", { method: "POST", body: JSON.stringify(payload) });
					setResult(reply);
					// Only what the host actually took is cleared. Clearing the whole
					// form after a partial write threw away exactly the values that
					// were refused — the one thing a reader needs when fixing them.
					const rejected = Array.isArray(reply?.rejected) ? reply.rejected : [];
					if (rejected.length === 0) {
						setValues({});
					} else {
						const kept = {};
						for (const row of rejected) {
							const id = `${row?.kind ?? "env"}:${row?.key ?? ""}`;
							if (Object.prototype.hasOwnProperty.call(values, id)) kept[id] = values[id];
						}
						setValues(kept);
					}
					if (reply.saved) await onSaved(reply);
					// Close only when nothing is left to fill and nothing was refused:
					// both are answers this sheet exists to show.
					if (reply.needConfig !== true && rejected.length === 0) onClose();
				} catch (err) {
					setError(String(err.message || err));
				} finally {
					setBusy(false);
				}
			};

			return createElement("div", {
				style: styles.overlay,
				onClick: (e) => { if (e.target === e.currentTarget) onClose(); },
			}, [
				createElement("div", { key: "panel", className: "omkt-panel", style: styles.configPanel }, [
					createElement("div", { key: "head", style: styles.detailHead }, [
						createElement("div", { key: "row", style: styles.detailTitleRow }, [
							createElement("div", { key: "t", style: { minWidth: 0 } }, [
								createElement("div", { key: "n", style: styles.detailTitle }, `配置 ${server.name}`),
								createElement("div", { key: "s", style: styles.detailSub },
									[server.transport, server.serverName ? `mcp__${server.serverName}__` : null].filter(Boolean).join(" · ")),
							]),
							createElement("button", {
								key: "x", type: "button", className: "omkt-btn omkt-btn-outline",
								style: { ...styles.outlineBtn, marginLeft: "auto" },
								onClick: onClose, title: "关闭",
							}, "关闭"),
						]),
						server.providedExternally
							? createElement("div", { key: "extwarn", style: styles.warnLine },
								`${server.name} 的工具由另一个 mcp-client 挂载提供：配置写入本插件的注册表，但那一份挂载读的是它自己的配置，改动不会立即反映在当前运行的工具中。`)
							: null,
						createElement("div", { key: "why", style: styles.fieldHelp }, originNote),
						missing.length
							? createElement("div", { key: "miss", style: styles.warnLine },
								`还缺 ${missing.join("、")}：填好并保存后会自动重新挂载，工具才会通。`)
							: null,
						requiredMissing.length
							? createElement("div", { key: "reqmiss", style: styles.warnLine },
								`还有必填项没填：${requiredMissing.join("、")}。保存按钮在填好之前不会提交——现在提交也只会让这一行继续不可用。`)
							: null,
					]),

					createElement("div", { key: "body", style: { display: "grid", gap: 12 } }, [
						...fields.map((field) => {
							const inputId = `omkt-cfg-${server.name}-${field.kind}-${field.key}`;
							const isClearing = dirty(field) && values[idOf(field)] === "";
							return createElement("div", {
								key: `f:${idOf(field)}`, style: styles.fieldRow,
							}, [
								createElement("label", { key: "l", htmlFor: inputId, style: { ...styles.fieldLabel, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" } }, [
									createElement("span", { key: "k" }, field.label ?? field.key),
									field.label && field.label !== field.key
										? createElement("span", { key: "raw", style: styles.fieldOpt }, field.key)
										: null,
									field.required
										? createElement("span", { key: "r", style: styles.fieldReq }, "必填")
										: field.declared === true
											? createElement("span", { key: "o", style: styles.fieldOpt }, "可选")
											// A field this plugin added on its own (the remote
											// Authorization affordance) is nobody's declaration.
											// 「来源未声明」 described that as a gap in the
											// sources; naming the author is the truth.
											: field.origin === "manual"
												? createElement("span", {
													key: "u", style: styles.fieldOpt,
													title: "远端服务器可能需要凭据；发布方没有声明字段，这一条是本插件留的位置",
												}, "本插件补充")
												// Nobody published whether this key is needed — its name
												// came out of the launch command. Saying 可选 here would
												// assert something no source said, and 必填 would make
												// the row look unfinished on a guess.
												: createElement("span", {
													key: "u", style: styles.fieldOpt,
													title: "这个键是从启动命令里认出来的；来源没有声明它是否必填",
												}, "来源未声明"),
									field.secret
										? createElement("span", { key: "sec", style: styles.fieldOpt }, "· 密钥")
										: null,
									field.kind === "header"
										? createElement("span", { key: "h", style: styles.fieldOpt }, "· 请求头")
										: null,
								]),
								field.help
									? createElement("div", { key: "h", style: styles.fieldHelp }, field.help)
									: null,
								// Where to actually go and get it. A form that asks for a token
								// without saying where tokens come from leaves the reader to
								// guess, and guessing is how people paste the wrong kind of key.
								(field.helpUrl || field.resourceUrl)
									? createElement("div", { key: "go", style: { display: "flex", gap: 12, flexWrap: "wrap" } }, [
										field.helpUrl
											? createElement("a", {
												key: "get",
												href: field.helpUrl,
												target: "_blank",
												rel: "noreferrer",
												style: styles.fieldLink,
												title: field.helpUrl,
												onClick: (e) => { e.stopPropagation(); openExternal(e, field.helpUrl); },
											}, field.oauth ? "服务器页面 →" : "去获取 →")
											: null,
										field.resourceUrl
											? createElement("a", {
												key: "how",
												href: field.resourceUrl,
												target: "_blank",
												rel: "noreferrer",
												style: styles.fieldLink,
												title: field.resourceUrl,
												onClick: (e) => { e.stopPropagation(); openExternal(e, field.resourceUrl); },
											}, "授权说明 →")
											: null,
									])
									: null,
								// What the declaration said beyond 「必填」: a default the user
								// can accept, and the closed set the publisher allows.
								(field.default || field.choices?.length > 0)
									? createElement("div", { key: "dflt", style: styles.fieldHelp },
										[
											field.default ? `默认：${field.default}` : "",
											field.choices?.length > 0 ? `可选值：${field.choices.join(" / ")}` : "",
										].filter(Boolean).join(" · "))
									: null,
								createElement("div", { key: "i", style: { display: "flex", gap: 6, alignItems: "center" } }, [
									createElement("input", {
										key: "in", id: inputId, className: "omkt-input",
										style: styles.fieldInput,
										type: field.secret ? "password" : "text",
										value: dirty(field) ? values[idOf(field)] : "",
										placeholder: isClearing
											? "保存时将清除此项"
											: (field.hasValue
												? (field.secret ? "已保存（不显示明文；留空＝不改）" : (field.value || "已保存"))
												: (field.required ? "必填" : "可选")),
										autoComplete: "off", spellCheck: false,
										onChange: (e) => setValue(field, e.target.value),
									}),
									field.hasValue
										? createElement("button", {
											key: "clr", type: "button", className: "omkt-btn omkt-btn-outline",
											style: styles.sourceMiniBtn, disabled: busy,
											title: "保存时清除这个值",
											onClick: () => clearValue(field),
										}, "清除")
										: null,
									isClearing
										? createElement("span", { key: "sv", style: { ...styles.fieldSaved, color: T.amber, background: T.soft2 } }, "待清除")
										: (field.hasValue
											? createElement("span", { key: "sv", style: styles.fieldSaved }, "已保存")
											: null),
								]),
							]);
						}),
						// A declaration can miss something (a provider that documents
						// its variable nowhere). The form accepts the user's own keys:
						// refusing them would mean this host knows better than the
						// person holding the token.
						createElement("div", { key: "kv", style: styles.kvHead }, [
							createElement("span", { key: "t", style: styles.fieldLabel }, "其他键值"),
							createElement("span", { key: "h", style: styles.fieldOpt },
								server.channel === "cli-json"
									? "没有被声明、但这台服务器要的键——写进那份 --config JSON"
									: "没有列出来的变量可以自己加"),
							createElement("span", { key: "sp", style: styles.spacer }),
							createElement("button", {
								key: "add", type: "button", className: "omkt-btn omkt-btn-outline",
								style: styles.sourceMiniBtn, disabled: busy,
								// A `--config` row's extra keys belong in the same JSON as its
								// declared ones; defaulting to 环境变量 there would offer a
								// channel that server never reads.
								onClick: () => setCustom((prev) => [...prev, { key: "", kind: defaultKind, value: "" }]),
							}, "+ 加一行"),
						]),
						...custom.map((row, index) => createElement("div", {
							key: `kv:${index}`, style: styles.kvRow,
						}, [
							createElement("select", {
								key: "k", className: "omkt-select", style: { ...styles.select, flexShrink: 0 },
								value: row.kind,
								onChange: (e) => setCustom((prev) => prev.map((r, i) => (i === index ? { ...r, kind: e.target.value } : r))),
							}, [
								createElement("option", { key: "e", value: "env" }, "环境变量"),
								createElement("option", { key: "h", value: "header" }, "请求头"),
								createElement("option", { key: "c", value: "config" }, "配置项"),
							]),
							createElement("input", {
								key: "key", className: "omkt-input", style: styles.kvKey,
								value: row.key, placeholder: row.kind === "header" ? "Authorization" : row.kind === "config" ? "apiKey" : "MY_VAR",
								onChange: (e) => setCustom((prev) => prev.map((r, i) => (i === index ? { ...r, key: e.target.value } : r))),
							}),
							createElement("input", {
								key: "v", className: "omkt-input", style: styles.kvKey, type: "password",
								value: row.value, placeholder: "值",
								onChange: (e) => setCustom((prev) => prev.map((r, i) => (i === index ? { ...r, value: e.target.value } : r))),
							}),
							createElement("button", {
								key: "rm", type: "button", className: "omkt-btn omkt-btn-outline",
								style: styles.sourceMiniBtn, disabled: busy,
								title: "移除这一行",
								onClick: () => setCustom((prev) => prev.filter((_, i) => i !== index)),
							}, "移除"),
						])),
						// The composed `--config`: what the CLI will actually receive,
						// with every secret already replaced by ••••.
						cliPreview
							? createElement("div", { key: "preview", style: styles.fieldHelp }, [
								createElement("div", { key: "t" }, "启动时实际传给 CLI 的参数（密钥以 •••• 显示）："),
								createElement("code", {
									key: "c",
									style: { display: "block", marginTop: 4, padding: "4px 6px", borderRadius: 4, background: T.soft2, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5, color: T.text2, wordBreak: "break-all" },
								}, cliPreview),
							])
							: null,
					]),

					result?.rejected?.length
						? createElement("div", { key: "rej", style: styles.warnLine }, [
							createElement("div", { key: "rh", style: { fontWeight: 600 } }, "以下配置项未被保存："),
							...result.rejected.map((r, i) => createElement("div", { key: `rej:${i}`, style: { fontSize: 12, marginTop: 2 } }, `• ${r.key}（${r.kind === "header" ? "请求头" : r.kind === "config" ? "配置项" : "环境变量"}）：${r.reason}`)),
						])
						: null,
					result?.note
						? createElement("div", { key: "note", style: styles.installFailure }, result.note)
						: null,
					error
						? createElement("div", { key: "err", style: styles.registryWarn }, error)
						: null,

					createElement("div", { key: "actions", style: styles.detailActions }, [
						createElement("button", {
							key: "save", type: "button", className: "omkt-btn omkt-btn-primary",
							style: { ...styles.button, ...styles.accent },
							disabled: busy || requiredMissing.length > 0,
							title: requiredMissing.length > 0
								? `先填 ${requiredMissing.join("、")}：发布方声明它是必填项`
								: undefined,
							onClick: save,
						}, busy ? "保存中…" : "保存并重新挂载"),
						createElement("button", {
							key: "cancel", type: "button", className: "omkt-btn omkt-btn-outline",
							style: styles.outlineBtn, disabled: busy, onClick: onClose,
						}, "关闭"),
						createElement("span", { key: "sp", style: styles.spacer }),
						createElement("span", { key: "hint", style: styles.hint },
							"值只写进本机注册表；密钥保存后不再回显。"),
					]),
				]),
			]);
		}

		function SourceGroup({ source, servers, allServers = servers, busy, checkingKeys, hintingKey, jobOf, collapsed, onToggleCollapsed, onToggleSource, onToggleServer, onRemove, onUpdate, onConfigure, onHealth }) {
			const enabledCount = allServers.filter((s) => s.enabled !== false).length;
			const allOn = enabledCount === allServers.length && allServers.length > 0;
			return createElement("div", { style: styles.group }, [
				createElement("div", {
					key: "head", style: { ...styles.groupHead, cursor: "pointer" },
					onClick: onToggleCollapsed,
				}, [
					createElement("span", { key: "chev", style: styles.meta }, collapsed ? "▸" : "▾"),
					createElement("span", { key: "title", style: styles.groupTitle }, sourceLabel(source)),
					createElement("span", { key: "count", style: styles.badge },
						`${servers.length < allServers.length ? `本页 ${servers.length} 个 · 共 ` : ""}${allServers.length} 个 · ${enabledCount} 已启用`),
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
						key: rowKey(server), server, busy,
						checking: (checkingKeys ?? []).includes(rowKey(server)),
						hinting: hintingKey === rowKey(server),
						job: jobOf(server),
						onToggle: onToggleServer, onRemove, onUpdate, onConfigure, onHealth,
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
                ".omkt-navigation{display:flex;align-items:center;gap:12px;overflow-x:auto;scrollbar-width:thin}",
                ".omkt-navigation>.omkt-tabbar{border-bottom:0!important;flex:1 0 auto;overflow:visible!important}",
                ".omkt-navigation .omkt-tab{font-size:14px!important;margin:0!important;padding:9px 4px 10px!important}",
                "@container(max-width:560px){.omkt-navigation{gap:8px}.omkt-navigation .omkt-spaceswitch{gap:8px!important;padding-inline-end:8px!important}.omkt-navigation .omkt-tabbar{gap:6px!important}.omkt-navigation .omkt-tab,.omkt-navigation .omkt-spacep{font-size:13px!important}.omkt-directory-label{display:none}}",
                ".omkt-market-search{display:grid;gap:20px;align-items:center;margin:0;min-width:0}",
                ".omkt-market-search>button,.omkt-reg-filters>button{display:inline-flex;align-items:center;justify-content:center;gap:8px}",
                ".omkt-reg-filters>select{flex:0 1 218px;min-width:128px}",
                ".omkt-skill-alphabet{display:flex;flex-direction:column;align-items:center;flex:0 0 24px}",
                ".omkt-call-ranges>button{white-space:nowrap}",
                ".omkt-call-detail{scroll-margin-block:8px}",
                ".omkt-call-kind{width:190px}",
                ".omkt-call-facts{grid-template-columns:repeat(2,minmax(0,1fr))}",
                "@container(max-width:950px){.omkt-reg-filters>select{flex-basis:140px}.omkt-call-kind{width:auto}.omkt-skill-alphabet{display:none}}",
                "@container(max-width:540px){.omkt-reg-filters>select{flex:1 1 120px}.omkt-call-facts{grid-template-columns:minmax(0,1fr)}}",
                ".omkt-market-categories{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:36px;margin-bottom:8px}",
                ".omkt-featured{height:128px;flex-shrink:0}",
                ".omkt-index-toggle{font-size:13px;color:"+T.brand+";cursor:pointer}",
                ".omkt-index-details:not([open]){display:none}",
                ".omkt-reg-mobile{display:none}.omkt-srow .omkt-reg-columns{border-bottom:0}",
                ".omkt-reg-table{border:1px solid "+T.line+";border-radius:12px;background:"+T.cardBg+"}",
                ".omkt-reg-columns{display:grid;grid-template-columns:minmax(0,2.2fr) minmax(110px,1.1fr) minmax(110px,1fr) minmax(48px,.65fr) 132px;gap:16px;align-items:center;padding:8px 20px;border-bottom:1px solid "+T.line2+"}",
                ".omkt-reg-head{font-size:13px;color:"+T.text3+";background:"+T.soft+";border-radius:12px 12px 0 0}",
                ".omkt-skill-columns{display:grid;grid-template-columns:minmax(0,2.3fr) minmax(120px,1fr) minmax(140px,1fr) 110px;gap:16px;align-items:center;padding:8px 20px}",
                "@container(max-width:1000px){.omkt-market-search{grid-template-columns:minmax(0,1fr) 145px 145px 42px 42px!important;gap:10px}.omkt-market-search:has(>button:only-of-type){grid-template-columns:minmax(0,1fr) 145px 145px 42px!important}.omkt-reg-columns{grid-template-columns:minmax(0,1fr) 120px 120px 48px 96px;gap:10px;padding:12px}.omkt-skill-columns{grid-template-columns:minmax(0,1fr) 110px 110px 88px!important;gap:10px!important;padding:12px!important}}",
                "@container(max-width:719px){.omkt-navigation>button{font-size:12px!important;padding:4px!important}.omkt-market-search{grid-template-columns:minmax(0,1fr) 42px 42px!important;gap:8px}.omkt-market-search:has(>button:only-of-type){grid-template-columns:minmax(0,1fr) 42px!important}.omkt-market-search>.omkt-search{grid-column:1/-1}.omkt-market-search>select{grid-row:2;max-width:100%}.omkt-market-search>select:first-of-type{grid-column:1}.omkt-market-search>select:nth-of-type(2){grid-row:3;grid-column:1/-1}.omkt-reg-columns{grid-template-columns:minmax(0,1fr) 48px 90px}.omkt-reg-source,.omkt-reg-status{display:none!important}.omkt-reg-mobile{display:block}.omkt-listmeta{display:none}.omkt-skill-columns{grid-template-columns:minmax(0,1fr) 80px!important}.omkt-market-categories{gap:4px}.omkt-skillhero{min-height:128px}}",

				".omkt-menu>summary{list-style:none;cursor:pointer;white-space:nowrap}.omkt-menu>summary::-webkit-details-marker{display:none}",
				".omkt-menu[open]>summary{color:#4566e9;background:rgba(69,102,233,.08)}",
				".omkt-menu button{text-align:left}.omkt-menu button:hover{background:rgba(69,102,233,.08)}",
				".omkt-page button:focus-visible,.omkt-page summary:focus-visible,.omkt-page [role=tab]:focus-visible{outline:2px solid #4566e9;outline-offset:3px}",
				".omkt-page button:disabled{cursor:not-allowed;opacity:.55}.omkt-page h2{overflow-wrap:anywhere}",
				".omkt-page .omkt-skill-list{display:flex;flex-direction:column;border:1px solid rgba(128,128,128,.18);border-radius:12px;overflow:hidden}",
				".omkt-listrow{transition:background .15s ease}.omkt-listrow:hover{background:rgba(69,102,233,.025)!important}",
				".omkt-listrow:last-child{border-bottom:0!important}",
				".omkt-callrow{display:grid;grid-template-columns:130px minmax(0,1fr) 155px 105px 32px;gap:12px;align-items:center}",
				".omkt-callfilter{display:none}.omkt-callmeta{display:none}",
                "@container(max-width:760px){.omkt-callmeta{display:block}}",
                ".omkt-callrow-skill{grid-template-columns:26px 90px minmax(0,1fr) 130px 110px 94px}.omkt-callrow-skill>.omkt-calltoggle,.omkt-callrow-skill>.omkt-callspacer{order:-1}",
                "@container(max-width:1000px){.omkt-callrow{grid-template-columns:90px minmax(0,1fr) 100px 85px 26px;gap:8px}.omkt-callrow-skill{grid-template-columns:24px 76px minmax(0,1fr) 104px 78px 65px}}",
                "@container(max-width:760px){.omkt-callrow-skill .omkt-eventtype{display:none}}",
				"@container(max-width:760px){.omkt-callrow{grid-template-columns:68px minmax(0,1fr) 74px 60px 26px;gap:6px}.omkt-callrow-skill{grid-template-columns:24px 68px minmax(0,1fr) 76px 60px}.omkt-pagehead{flex-wrap:wrap!important}.omkt-page .omkt-callrail{flex-basis:150px!important}}",
				"@container(max-width:540px){.omkt-callrow{grid-template-columns:58px minmax(0,1fr) 62px 26px}.omkt-callrow-skill{grid-template-columns:24px 58px minmax(0,1fr) 72px}.omkt-callduration{display:none}.omkt-callfilter{display:block}.omkt-page .omkt-callrail{display:none}.omkt-page .omkt-calllayout{display:block!important;overflow:auto}.omkt-page .omkt-callsummary{gap:0!important}.omkt-page .omkt-callstat{min-width:0!important;padding:12px!important}}",
				"@media(prefers-reduced-motion:reduce){.omkt-page *{animation:none!important;transition:none!important}}",
				// Cards lift on hover; the border takes the accent so the lift
				// reads as "this is the thing under your cursor" and not as a
				// shadow the layout did not ask for.
				".omkt-card{transition:border-color .15s ease,box-shadow .15s ease}",
				// v4's card hover: a hair darker border and a soft lift, not an
				// accent-coloured outline. One accent per screen is the rule.
				".omkt-card{transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease}",
				".omkt-card:hover{border-color:#d9dde6;box-shadow:0 2px 6px rgba(20,26,40,.04),"
					+ "0 10px 24px rgba(20,26,40,.06);transform:translateY(-2px)}",
				".omkt-card:focus-visible{outline:2px solid #4d6bfe;outline-offset:2px}",
				// A skill card is a card too, but it is not clickable as a whole
				// (the two buttons are), so it lifts without taking focus.
				// The two wide spotlight cards at the top of the skill market. The
				// class is also the probe's handle for "how many heroes rendered",
				// so it exists even though the paint lives in inline styles.
				".omkt-skillhero{display:flex;flex-direction:column;gap:8px;min-width:0}",
				".omkt-skillcard{transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease}",
				".omkt-skillcard:hover{border-color:#d9dde6;box-shadow:0 2px 6px rgba(20,26,40,.04),"
					+ "0 10px 24px rgba(20,26,40,.06);transform:translateY(-2px)}",
				// The install button on a market card is a bare .omkt-primary, not
				// the .omkt-btn family: it says one thing and never changes shape.
				".omkt-primary{appearance:none;border:1px solid #3d5fd9;background:#3d5fd9;color:#fff;"
					+ "border-radius:8px;padding:5px 12px;font:inherit;font-size:12px;cursor:pointer;"
					+ "box-shadow:0 4px 12px rgba(91,124,250,.18);"
					+ "transition:filter .15s ease,background .15s ease,border-color .15s ease}"
				+ ".omkt-primary:hover{filter:brightness(1.05);background:#3d5fd9;border-color:#3d5fd9}"
				+ ".omkt-primary:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}",
				// A skill page is a column of groups; the market is one panel of
				// cards. Both are panels, so only the stacking is set here.
				".omkt-skillpanel{display:flex;flex-direction:column;gap:10px;min-width:0}",
				".omkt-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
				// The one control on a call row: ▸ 展开请求 / 响应. It sits at the right
				// edge and must not stretch, or the row looks like a second card.
				// The one control on a call row: ▸ 展开请求 / 响应. It sits at the right
				// edge and never stretches, or the row looks like a second card.
				".omkt-calltoggle{appearance:none;border:1px solid #e6e7eb;background:#fff;color:#1f2329;"
					+ "border-radius:6px;padding:3px 9px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}"
					+ ".omkt-calltoggle:hover{border-color:#cfd1d6;background:#fafbfc}"
					+ ".omkt-calltoggle:focus-visible{outline:2px solid #5b7cfa;outline-offset:1px}",
				".omkt-spaceswitch:focus{outline:none!important}"
				+ ".omkt-spaceswitch:focus-visible{outline:2px solid rgba(69,102,233,0.62)!important;outline-offset:2px}"
				+ ".omkt-spacep:focus-visible{outline:2px solid rgba(69,102,233,0.62)!important;outline-offset:2px}",
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

                ".omkt-pagehead{padding:0 0 8px;min-height:40px}",
                ".omkt-pagehead-skill{color:inherit}",
                ".omkt-spacep{background:transparent;transition:background .12s ease,color .12s ease}",
                ".omkt-spacep[aria-selected=\"false\"]:hover{background:rgba(69,102,233,.05)}",
                ".omkt-tabbar .omkt-tab[aria-selected=\"true\"]{color:#4566e9!important}",
                ".omkt-tabbar .omkt-tab[aria-selected=\"true\"]::after{background:#4566e9}",
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
				".omkt-search .omkt-input{flex:1;min-width:0;border:0;outline:0;background:transparent;padding:0}",
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
				// A settled queue states its outcome in the slot the button was
				// in. It stays a <button> — the layout, focus order and hit area
				// are unchanged — but it reports a fact, so it drops the fill and
				// keeps its colour instead of dimming like a disabled control.
				".omkt-btn-done,.omkt-btn-done:disabled{background:transparent;border-color:transparent;color:" + T.green + ";opacity:1;cursor:default}",
				".omkt-progress{overflow:hidden}",
				".omkt-jobs{scrollbar-width:thin}",
				// A running update queue is the only live thing on this page, so
				// it is the only place that gets motion. The sheen rides *over*
				// the track, above the real (i/N) fill: it says "one of them is
				// still going" without pretending to be a second measure of
				// progress the host never gave us. Grey, not white — a white
				// gradient is invisible in light mode and a glare in dark.
				".omkt-progress-live::after{content:\"\";position:absolute;inset:0;"
					+ "background:linear-gradient(90deg,transparent,rgba(128,128,128,.45),transparent);"
					+ "animation:omkt-sheen 1.1s linear infinite}",
				"@keyframes omkt-sheen{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}",
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
				"@container (width < 720px){.omkt-grid{grid-template-columns:minmax(0,1fr)!important}}",
				"@container (width >= 920px){.omkt-grid{grid-template-columns:repeat(3,minmax(0,1fr))!important}}",
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
				// 「点个 star」: quiet at rest, alive under the cursor. The star
				// pops and tips, a warm ring lifts the capsule off the header
				// line, and one sheen crosses it — three cues for one small
				// control, none of them running while nothing points at it.
				".omkt-star:hover{transform:translateY(-1px);border-color:rgba(255,125,0,.55);"
					+ "background:rgba(255,125,0,.12);box-shadow:0 2px 10px rgba(255,125,0,.18);color:" + T.text + "}",
				".omkt-star:hover svg{transform:scale(1.18) rotate(-12deg)}",
				".omkt-star:active{transform:translateY(0) scale(.97)}",
				`.omkt-star:focus-visible{outline:2px solid ${T.amber};outline-offset:2px}`,
				// The sheen is a pseudo element so it cannot push the label
				// around; the label and the star paint above it (z-index 1,
				// inline) and it is inert to the pointer.
				".omkt-star::after{content:\"\";position:absolute;inset:0;transform:translateX(-120%);"
					+ "background:linear-gradient(105deg,transparent 25%,rgba(255,255,255,.45) 50%,transparent 75%);"
					+ "pointer-events:none}",
				".omkt-star:hover::after{animation:omkt-star-sheen .6s ease}",
				"@keyframes omkt-star-sheen{to{transform:translateX(120%)}}",
				// Motion is decoration: a reader who asked for less still gets
				// the warm ring, and nothing moves.
				"@media (prefers-reduced-motion:reduce){"
					+ ".omkt-star,.omkt-star svg,.omkt-star::after{transition:none;animation:none}}",
			].join("\n");
			document.head.appendChild(el);
		}

		/**
		 * One big number + small label, for the GitHub stat row.
		 *
		 * `raw` renders the value verbatim — the licence is a word, and
		 * "MIT → 1" out of `compact()` would be a lie about a legal term.
		 * `title` carries the caveat a two-word label cannot: GitHub's own
		 * field names are not what the words "Issue" and "Watch" suggest.
		 */
		function ghStat(label, value, raw, title) {
			return createElement("span", { style: styles.ghStat, title }, [
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
		// The identity an install runs under: the same key the market card is keyed by.
// Two sources can list the same title, so the key carries both.
function itemKeyOf(item) {
	return `${item?.source ?? ""}:${item?.id ?? item?.title ?? ""}`;
}

function MarketCard({ item, stats, busy, installing, rank, usageSort, onInstall, onOpen, onToggleFavorite, featured }) {
            const repo = repoKeyOf(item);
            const enriched = repo ? stats?.[repo] : null;
            const author = enriched?.author ?? item.author;
            const stars = starCountOf(item, stats);
            const group = item.group && item.group !== "__none__" ? item.group : item.category || "未分类";
            const href = item.repository || enriched?.homepage || item.homepage || (item.source === "smithery" && item.qualifiedName ? `https://smithery.ai/servers/${item.qualifiedName}` : null);
            const command = String(item.install?.command ?? "");
            const runner = /npx/i.test(command) ? "npx" : /uvx/i.test(command) ? "uvx" : /docker/i.test(command) ? "docker" : "本地命令";
            const method = !item.install ? item.installable ? "可一键安装" : "需手动配置" : item.install.transport === "stdio" ? `stdio · ${runner}` : item.install.deferred ? "远程 · 装时取端点" : "远程 · 免安装";
            const source = SOURCE_LABELS[`catalog:${item.source}`] ?? item.source;
            const metric = typeof item.installs === "number" ? `${compact(item.installs)} ${item.installsLabel || "次使用"}` : typeof stars === "number" ? `★ ${compact(stars)}` : item.localInstalls > 0 ? `${item.localInstalls} 次本机安装` : "";
            const info = [source, method, item.statsAt ? `来源统计时间 ${new Date(item.statsAt).toLocaleString()}` : "", enriched?.fetchedAt ? `仓库统计时间 ${new Date(enriched.fetchedAt).toLocaleString()}` : "", enriched?.stale ? "仓库统计更新失败，保留旧值" : "", item.statsStale ? "来源读取失败，保留旧统计" : "", typeof stars === "number" ? `GitHub Star ${stars}` : "", item.localInstalls > 0 ? `从本市场安装过 ${item.localInstalls} 次` : ""].filter(Boolean).join(" · ");
            const open = () => onOpen(item);
            const action = item.installed ? createElement("span", { key: "installed", style: { ...styles.sourceMiniBtn, display: "inline-flex", gap: 4, alignItems: "center", color: T.text, background: T.cardBg, cursor: "default" } }, "✓ 已安装")
                : item.installable ? createElement("button", { key: "install", type: "button", className: "omkt-primary", style: styles.smallPrimary, disabled: busy || installing, onClick: () => onInstall(item) }, installing ? "安装中…" : item.deprecated ? "仍要安装" : "安装")
                    : createElement("button", { key: "manual", type: "button", style: { ...styles.textBtn, fontSize: 13, padding: 0 }, onClick: open }, "需手动配置");
            const title = createElement("div", { key: "title", style: styles.cardHead }, [
                href ? createElement("a", { key: "name", href, target: "_blank", rel: "noreferrer", className: "omkt-title", "data-omkt": "card-title", style: featured ? { ...styles.cardName, fontSize: 20 } : styles.cardName, title: item.title, onClick: event => { event.stopPropagation(); openExternal(event, href); } }, item.title)
                    : createElement("span", { key: "name", "data-omkt": "card-title", style: featured ? { ...styles.cardName, fontSize: 20 } : styles.cardName, title: item.title }, item.title),
                item.verified && !featured ? createElement("span", { key: "verified", "data-omkt": "card-verified", style: styles.verified }, "✓ 认证") : null,
                item.deprecated ? createElement("span", { key: "deprecated", style: styles.deprecated, title: item.statusMessage }, "已废弃") : null,
            ]);
            return createElement("article", { className: featured ? "omkt-card omkt-featured" : "omkt-card", style: featured ? { ...styles.smHero, height: 128, boxSizing: "border-box" } : styles.card, title: `${item.title}${author ? ` · ${author}` : ""}` }, featured ? [
                createElement("div", { key: "featured", style: styles.smEyebrow }, item.official ? "♛ 官方精选" : "推荐连接器"),
                createElement("div", { key: "feature-main", style: { display: "flex", alignItems: "center", gap: 14, minWidth: 0, flex: 1 } }, [
                    createElement(ProductIcon, { key: "icon", item, size: 54, repositoryAvatar: enriched?.avatar }),
                    createElement("div", { key: "body", style: { ...styles.cardLeft, cursor: "pointer" } }, [
                        title,
                        createElement("button", { key: "desc", type: "button", "data-omkt": "desc", "aria-label": `查看 ${item.title} 详情`, onClick: open, style: { ...styles.textBtn, ...styles.smHDesc, display: "block", padding: 0, textAlign: "left", width: "100%" }, title: plainText(item.description || enriched?.description) }, plainText(item.description || enriched?.description || "来源未提供描述")),
                        createElement("span", { key: "source", style: { fontSize: 14, color: T.text3, display: "flex", alignItems: "center", gap: 6 }, title: info }, [createElement(UiIcon, { key: "source-icon", name: "layers", size: 15 }), source]),
                    ]),
                    createElement("div", { key: "cta", "data-omkt": "card-cta", style: { flexShrink: 0 } }, action),
                ]),
            ] : [
                createElement("div", { key: "head", style: styles.cardHd }, [
                    createElement(ProductIcon, { key: "icon", item, size: 48, repositoryAvatar: enriched?.avatar }),
                    createElement("div", { key: "identity", style: styles.cardLeft }, [title, createElement("div", { key: "author", style: styles.cardAuthor }, author || "作者未标注")]),
                    createElement("div", { key: "secondary", style: { display: "flex", gap: 4, alignSelf: "flex-start", flexShrink: 0 } }, [
                        createElement("button", { key: "fav", type: "button", className: item.favorite ? "omkt-icon omkt-icon-on" : "omkt-icon", style: { ...styles.iconBtn, width: 24, height: 26, padding: 3, color: item.favorite ? T.brand : T.text2 }, "aria-label": item.favorite ? "取消收藏" : "收藏", "aria-pressed": Boolean(item.favorite), onClick: () => onToggleFavorite(item) }, createElement(UiIcon, { name: "heart", size: 17 })),
                        createElement("button", { key: "detail", type: "button", style: { ...styles.textBtn, padding: "3px 0", color: T.text2 }, "aria-label": `查看 ${item.title} 详情`, onClick: open }, createElement(UiIcon, { name: "more", size: 19 })),
                    ]),
                ]),
                createElement("div", { key: "body", style: { ...styles.cardBody, gap: 0 }, role: "button", tabIndex: 0, "aria-label": `查看 ${item.title} 详情`, onClick: open, onKeyDown: event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); open(); } } },
                    createElement("div", { "data-omkt": "desc", style: styles.desc, title: item.statusMessage || undefined }, plainText(item.description || enriched?.description || "来源未提供描述"))),
                createElement("div", { key: "ft", style: { display: "flex", alignItems: "center", gap: 8, marginTop: "auto", minWidth: 0 } }, [
                    rank ? createElement("span", { key: "rank", style: { fontSize: 12, color: T.text3 } }, `#${rank}`) : null,
                    createElement("span", { key: "category", style: styles.tag, title: "分类：" + group }, group),
                    createElement("span", { key: "source", style: { fontSize: 12, color: T.text3, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: info }, source),
                    metric ? createElement("span", { key: "metric", style: { fontSize: 12, color: T.text2, whiteSpace: "nowrap" }, title: info }, metric) : usageSort ? createElement("span", { key: "nouse", style: { fontSize: 12, color: T.text3 }, title: "按使用量排序时它排在后面：来源未公布使用量" }, "无使用量数据") : null,
                    createElement("div", { key: "cta", "data-omkt": "card-cta", style: { marginLeft: "auto", flexShrink: 0 } }, action),
                ]),
            ]);
        }

		/** GitHub enrichment key; non-GitHub directory links have no repo key. */
		function repoKeyOf(item) {
			const match = String(item?.repository ?? "").match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
			return match ? `${match[1]}/${match[2].replace(/\.git$/i, "")}` : null;
		}

		/**
		 * Quality score for one entry, shown as the "默认（综合推荐）" order.
		 *
		 * Provenance first (官方认证 > 已认证 > 官方实现 > 其余), then popularity.
		 * Popularity is deliberately last and log-scaled: the numbers come from
		 * three different sources with three different units, so they can break a
		 * tie but must never outrank a verified entry.
		 *
		 * @param stats the GitHub enrichment map — most catalogs publish no star
		 *   count, so a row's own `item.stars` (which only the GitHub source
		 *   carries) would otherwise almost never be seen.
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
            // A catalog/index read time is not an individual Star measurement.
            // Keep a directly measured value until its next measurement succeeds.
            return enriched?.stars ?? item.stars;
		}

		/**
		 * The figure 「使用量最多」 orders by: the source's own count **plus** this
		 * machine's installs from the panel.
		 *
		 * The card shows the two series separately (they mean different things),
		 * but ordering has to answer one question — "how used is this" — and for
		 * the 233 entries whose source publishes no figure at all, our own
		 * installs are the only evidence there is. `hasData` keeps the old rule
		 * intact: an entry with neither figure still has no number, and numbers
		 * sort ahead of non-numbers.
		 */
		function usageOf(item) {
			const upstream = typeof item?.installs === "number" ? item.installs : null;
			const local = typeof item?.localInstalls === "number" && item.localInstalls > 0
				? item.localInstalls : 0;
			if (upstream === null && local === 0) return { value: undefined, hasData: false };
			return { value: (upstream ?? 0) + local, hasData: true };
		}

		/**
		 * Compare two market entries under a user-chosen sort.
		 *
		 * `default` and the explicit `quality` choice are the same weighted score
		 * (above). The others each key on ONE field so the order is explainable,
		 * and every field falls back to quality rather than to 0 — an entry the
		 * source published no number for is not thereby the least popular one.
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
			};			switch (sort) {
				case "installs":
					return desc(usageOf(a).value, usageOf(b).value) || qb - qa;
				case "stars":
					return desc(starCountOf(a, stats), starCountOf(b, stats)) || qb - qa;
				case "updated": {
					const ta = Date.parse(a.updatedAt ?? "") || 0;
					const tb = Date.parse(b.updatedAt ?? "") || 0;
					return (tb - ta) || qb - qa;
				}
				case "name":
					return a.title.localeCompare(b.title) || qb - qa;
				case "quality":
					// The weighted score the card's rank used to impose on every
					// listing (provenance, then log-scaled popularity) — now an
					// explicit choice, because imposing it by default overrode the
					// host's source round-robin.
					return qb - qa;
				default:
					// 「默认」 is not an order this end applies: the host already
					// decided it (round-robin across sources). Sorting by quality
					// here would quietly replace that with a top-heavy page.
					return 0;
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

		/** An uptime a person reads, not 187 minutes. */
		function uptimeText(ms) {
			const total = Math.max(0, Math.floor(Number(ms) / 1000));
			const days = Math.floor(total / 86400);
			const hours = Math.floor((total % 86400) / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			if (days > 0) return `${days} 天 ${hours} 小时`;
			if (hours > 0) return `${hours} 小时 ${minutes} 分`;
			if (minutes > 0) return `${minutes} 分`;
			return `${total} 秒`;
		}

		/**
		 * The one line under the title: which build this process is actually
		 * running, which process, how long it has been up, and how many data
		 * files it found.
		 *
		 * A version string alone cannot tell a user whether the fix they just
		 * made is loaded — a panel served by a process started before it is the
		 * difference between "still broken" and "not loaded yet". A host with no
		 * `/status` route (or a half answer) keeps the tagline, so the page
		 * degrades instead of emptying itself.
		 */
		function subLineText(status) {
			if (!status?.plugin || !status?.host) return "宿主机扫描 · 市场发现 · 一键接入";
			return [
				`插件 v${status.plugin.version ?? "?"}`,
				`pid ${status.host.pid}`,
				`已运行 ${uptimeText(status.host.uptimeMs)}`,
				`${(status.data?.files ?? []).filter((f) => f.bytes !== null).length} 个数据文件`,
				status.events?.lines ? `日志 ${compactCount(status.events.lines)} 条` : null,
			].filter(Boolean).join(" · ");
		}

		/**
		 * When one source's listing was read, as HH:MM — or "" when the host did
		 * not say. Sources age independently (each has its own TTL and validator),
		 * so this is printed per source rather than once for the whole listing.
		 */
		/**
		 * A failure's own words, short enough to sit inside the source line.
		 *
		 * The host reports one entry per failed source, and its `message` already
		 * carries what the reader needs — "HTTP 403" is useless, "搜索配额已用完
		 * （约 42 秒后恢复）" is actionable. Listing only the source *names* was the
		 * old behaviour, which left a rate limit indistinguishable from a typo'd
		 * custom URL. The untruncated text stays available as the line's title.
		 */
		function clipReason(message, max = 48) {
			const text = String(message ?? "").replace(/\s+/g, " ").trim();
			return text.length > max ? `${text.slice(0, max - 1)}…` : text;
		}

		function sourceClock(at) {
			if (typeof at !== "string" || !at) return "";
			const t = new Date(at);
			if (Number.isNaN(t.getTime())) return "";
			return t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		}

		/** 12345 -> 12.3k, for the compact star/usage counters (truncated). */
		function compact(n) {
			const v = Number(n) || 0;
			if (v >= 1e6) return `${Math.floor(v / 1e5) / 10}M`;
			if (v >= 1e3) return `${Math.floor(v / 100) / 10}k`;
			return String(v);
		}

		/**
		 * What to show after an install whose mount failed.
		 *
		 * The host's own error comes first: it is the only text here that is
		 * certainly true, and it is what the user can search for. Everything below
		 * it is additive and labelled as such — an explanation from the user's own
		 * model when the host could ask one, the reason no explanation was
		 * attempted when it could not, or the failure of that attempt. None of
		 * those three may be silently skipped: a blank space reads as "there is no
		 * explanation", which is exactly the state this exists to end.
		 */
		function installFailureText(result, item) {
			const name = result?.server || item?.title || "这个条目";
			const lines = [`${name} 已写入注册表，但挂载没有成功：${result?.connect?.error || "宿主没有给出原因"}`];
			if (result?.diagnosis?.text) {
				lines.push("", result.diagnosis.text);
				const route = result.diagnosis.route ? `由 ${result.diagnosis.route}` : "";
				const cached = result.diagnosis.cached ? "，缓存结果" : "";
				if (route) lines.push(`（${route} 诊断${cached}）`);
			} else if (result?.diagnosisError) {
				lines.push("", `自动诊断没有完成：${result.diagnosisError}`);
			} else if (result?.diagnosisSkipped === "no-llm") {
				lines.push("", "这次没有自动诊断（本机没有可用的模型服务）。");
			} else if (result?.diagnosisSkipped === "no-route") {
				lines.push("", "这次没有自动诊断（默认模型的 provider/model 没有配全）。");
			}
			if (result?.note) lines.push("", result.note);
			return lines.join("\n");
		}

		/**
		 * Icon with a coloured initial fallback when there is no avatar URL.
		 *
		 * The fallback hue is derived from the title, so the same entry keeps
		 * the same colour across renders and across page opens — a random hue
		 * per render would make the mosaic shimmer for no reason.
		 */
		const failedRemoteIcons = new Map();
		function avatarSource(value) {
			if (typeof value !== "string") return null;
			if (value.length < 88000 && /^data:image\/(?:png|webp|jpeg|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
			if (value.length > 2048 || !/^https:\/\//i.test(value)) return null;
			try {
				const url = new URL(value);
				if (url.username || url.password || url.port || url.hash) return null;
				// Only dedicated GitHub avatar routes. Catalog metadata cannot make
				// the desktop contact an arbitrary publisher domain or path.
				if (url.hostname === "github.com" && /^\/[a-z0-9][a-z0-9-]{0,38}\.png$/i.test(url.pathname) && /^\?size=\d{1,3}$/.test(url.search)) return url.href;
				if (url.hostname === "avatars.githubusercontent.com" && /^\/(?:u|in)\/\d+$/.test(url.pathname) && /^(?:\?(?:(?:v|s|size)=\d{1,4})(?:&(?:v|s|size)=\d{1,4})*)?$/.test(url.search)) return url.href;
				return null;
			} catch {
				return null;
			}
		}

		function Avatar({ item, author, src, size = 36, fallback = null, artwork, repositoryAvatar }) {
			const [failed, setFailed] = useState(() => new Set());
			const name = item.title || item.name || author || "?";
			const label = (Array.from(String(name).match(/[\p{L}\p{N}]/u)?.[0] ?? "")[0] || "·").toUpperCase();
			const box = {
				width: size, height: size, borderRadius: Math.max(6, Math.round(size / 4)),
				flexShrink: 0, objectFit: "contain", background: "rgba(128,128,128,0.08)",
			};
			const secondary = Array.isArray(item.iconCandidates) ? item.iconCandidates.slice(0, 3) : [];
			const candidates = [...new Set([artwork, src, repositoryAvatar, ...secondary].map(avatarSource).filter(Boolean))];
			const imageSrc = candidates.find(value => !failed.has(value) && (failedRemoteIcons.get(value) ?? 0) <= Date.now());
			if (imageSrc) {
				return createElement("img", {
					key: imageSrc, src: imageSrc, title: item.iconIssue || undefined, alt: "", width: size, height: size, loading: "lazy", decoding: "async",
					referrerPolicy: "no-referrer", crossOrigin: imageSrc.startsWith("https:") ? "anonymous" : undefined,
					onError: () => {
						if (imageSrc.startsWith("https:")) {
							if (failedRemoteIcons.size >= 512) failedRemoteIcons.delete(failedRemoteIcons.keys().next().value);
							failedRemoteIcons.set(imageSrc, Date.now() + 15 * 60_000);
						}
						console.warn("[overall-mcp] 图标来源加载失败", name, imageSrc.startsWith("https:") ? new URL(imageSrc).hostname : "local");
						setFailed(previous => new Set([...previous, imageSrc]));
					}, style: box,
				});
			}
			const note = item.iconIssue || (candidates.length ? "来源图标加载失败" : src || secondary.length ? "来源图标不在自动加载的信任范围内" : "发布方未提供可用图标");
			if (fallback) return createElement("span", { title: note, style: { display: "inline-flex", flexShrink: 0 } }, fallback);
			let hash = 0;
			for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) % 360;
			return createElement("div", {
				"aria-hidden": true,
				title: note,
				style: {
					...box, display: "grid", placeItems: "center",
					fontWeight: 700, fontSize: Math.round(size * 0.42), color: "#fff",
					background: `hsl(${hash} 52% 46%)`,
				},
			}, item.emoji || label);
		}

		// One row of the registry, addressed by position. Two rows can carry the
		// same server name (the same config file can define it twice), and an
		// answer about one of them is not an answer about the other. Falls back
		// to the name so a host that does not report slots still works.
		function rowKey(row) {
			return row?.slot ?? row?.name;
		}

		/**
		 * The address every row action sends: the row's `slot` (its position in
		 * the list the host just rendered) alongside the name. Names repeat in
		 * this registry — four rows named `rea-cursor` at one point — and a
		 * name-keyed action then hit the first match: 移除 on the last row
		 * removed the first one.
		 *
		 * Module scope on purpose. This used to live inside `Section`, which put
		 * it out of reach of `ConfigDialog` — a sibling at this level — so every
		 * 配置 click threw `ReferenceError: rowRef is not defined` before the
		 * sheet could paint. The page had no boundary then, so the whole panel
		 * went blank; the button looked like it did nothing at all.
		 */
		const rowRef = (server) => ({
			name: server.name,
			slot: Number.isInteger(server.slot) ? server.slot : null,
			from: server.update?.current ?? null,
		});

		/**
		 * The one control on this page that asks for nothing and gives nothing
		 * back: a star. It sits in the identity row because it is about the
		 * plugin itself, not about the roster — and because a star bar at the
		 * bottom of a scroll container is a control nobody reaches.
		 *
		 * A real `<a>` with `rel="noreferrer"`, not a click handler: the
		 * renderer's own navigation rules apply, and the label says where it
		 * goes.
		 */
		function starPill() {
			return createElement("a", {
				key: "hd-star", className: "omkt-star", style: styles.star,
				href: REPO_URL, target: "_blank", rel: "noreferrer",
				title: "在 GitHub 上给 dsh-overall-mcp 点个 star",
				"aria-label": "在 GitHub 上给 dsh-overall-mcp 点个 star",
			}, [
				createElement("svg", {
					key: "s", width: 14, height: 14, viewBox: "0 0 24 24",
					"aria-hidden": "true", focusable: "false", style: styles.starIcon,
				}, createElement("path", {
					d: "M12 2.7l2.86 5.8 6.4.93-4.63 4.51 1.1 6.37L12 17.3l-5.73 3.01 1.1-6.37L2.74 9.43l6.4-.93z",
					fill: "currentColor",
				})),
				createElement("span", { key: "t", style: styles.starLabel }, "点个 star"),
			]);
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
				onClick: (e) => openExternal(e, href),
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
		function MarketDetail({ item, stats, media, busy, installing, mediaFailed, onRetryMedia, onClose, onInstall, onToggleFavorite }) {
			// "" | "ok" | "fail" — the copy button states its own result rather
			// than flashing a message somewhere else; see `copyText`.
			const [copyState, setCopyState] = useState("");
			// Escape closes it, the same key that closes the config sheet. A panel
			// that can only be dismissed by finding the ✕ traps anyone who works
			// from the keyboard.
			useEffect(() => {
				const onKey = (event) => { if (event.key === "Escape") onClose(); };
				if (typeof window === "undefined") return undefined;
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);
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
				createElement("div", { key: "panel", className: "omkt-panel", style: styles.detailPanel, role: "dialog", "aria-modal": true, "aria-label": `${item.title} 详情` }, [
					// ---- header: identity + provenance, and the way out ----
					createElement("div", { key: "head", style: styles.detailHead }, [
						createElement("div", { key: "id", style: styles.detailIdentity }, [
							createElement(ProductIcon, { key: "av", item, size: 44, repositoryAvatar: enriched?.avatar }),
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
											onClick: (e) => openExternal(e, titleHref),
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
					// The strip is absent for a repo with no pictures, and also for one
					// whose lookup failed — the two must not look the same here either.
					mediaFailed
						? createElement("div", { key: "mediafail", style: styles.hint }, [
							"配图加载失败（可能被 GitHub 限流），稍后可重试。",
							createElement("button", {
								key: "retry", type: "button", className: "omkt-btn omkt-btn-outline",
								style: { ...styles.outlineBtn, marginLeft: 8, padding: "2px 8px", fontSize: 12 },
								disabled: busy,
								onClick: () => onRetryMedia?.(),
							}, "重试"),
						])
						: null,
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
							onClick: (e) => openExternal(e, item.repository),
						}, repo),
						// A row that already carries GitHub facts (the search source does)
						// must render them even when the enrichment pass never ran — the
						// fallback is the row's own numbers, and only a row with nothing
						// at all gets the "unavailable" line.
						enriched || typeof (item.stars ?? item.forks) === "number"
							? [
								createElement("div", { key: "s", style: styles.ghStats }, [
									typeof (enriched?.stars ?? item.stars) === "number" ? ghStat("Star", enriched?.stars ?? item.stars) : null,
									typeof (enriched?.forks ?? item.forks) === "number" ? ghStat("Fork", enriched?.forks ?? item.forks) : null,
									// GitHub's `open_issues_count` counts pull requests
									// too, and `subscribers_count` is the watch count —
									// neither is the number the bare words promise, so
									// each label carries its field name.
									typeof (enriched?.openIssues ?? item.openIssues) === "number"
										? ghStat("Issue（含 PR）", enriched?.openIssues ?? item.openIssues, false,
											"GitHub 的 open_issues_count：Pull Request 也算在内")
										: null,
									typeof enriched?.watchers === "number"
										? ghStat("Watch（订阅）", enriched.watchers, false,
											"GitHub 的 subscribers_count：订阅（watch）该仓库的人数，不是 Star 数")
										: null,
									enriched?.license ? ghStat("许可证", enriched.license, true) : null,
								].filter(Boolean)),
								...(enriched?.archived
									? [createElement("div", { key: "arc", style: styles.warnLine }, "该仓库已被作者归档（Archived）")]
									: []),
								...((enriched?.language ?? item.language) || enriched?.pushedAt || enriched?.createdAt
									? [
										(enriched?.language ?? item.language) ? DetailRow("语言", enriched?.language ?? item.language) : null,
										enriched?.pushedAt ? DetailRow("最近推送", enriched.pushedAt.slice(0, 10)) : null,
										enriched?.createdAt ? DetailRow("创建于", enriched.createdAt.slice(0, 10)) : null,
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
						// The GitHub block above already states the star count when
						// enrichment ran OR the row shipped its own numbers (the search
						// source does); only a row with neither falls through to here.
						repo && (enriched || typeof item.stars === "number") ? null
							: DetailRow("Star", typeof enriched?.stars === "number" ? String(enriched.stars)
								: typeof item.stars === "number" ? String(item.stars) : "目录未提供"),
						enriched?.pushedAt ? null
							: DetailRow("上游更新时间", (enriched?.pushedAt ?? item.updatedAt)?.slice(0, 10) || "该来源不提供"),
						DetailRow("使用量",
							typeof item.installs === "number"
								? `${item.installs} ${item.installsLabel ?? "次使用"}${item.installsWindow ? `（${item.installsWindow}）` : ""}`
								: "该来源不发布"),
						// Our own counter, stated next to the source's figure rather
						// than folded into it: they are different measurements.
						DetailRow("本市场安装",
							item.localInstalls > 0
								? `${item.localInstalls} 次${item.localInstallLastAt ? `（最近 ${item.localInstallLastAt.slice(0, 10)}）` : ""}`
								: "尚未从本市场安装"),
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
							createElement("div", { key: "l", style: styles.cmdHead }, [
								createElement("span", { key: "k", style: styles.detailKey }, "将执行的命令"),
								// The command is meant to be taken elsewhere — into a
								// terminal, into another client's config — and selecting
								// it by hand across a wrapped line is exactly the chore
								// this removes. The label reports what actually happened,
								// because a 已复制 that copied nothing is worse than none.
								createElement("button", {
									key: "cp", type: "button", className: "omkt-btn omkt-btn-outline",
									style: { ...styles.outlineBtn, marginLeft: "auto", padding: "2px 8px", fontSize: 12 },
									title: "复制这条命令",
									onClick: async () => {
										const ok = await copyText(installCmd);
										setCopyState(ok ? "ok" : "fail");
									},
								}, copyState === "ok" ? "已复制" : copyState === "fail" ? "复制失败，请手动选中" : "复制"),
							]),
							createElement("code", { key: "c", style: styles.cmd }, installCmd),
							// Where the command came from. A command recovered from a
							// repository is not a registry-published install, and the
							// difference has to travel with the command itself.
							item.installSource?.text
								? createElement("div", { key: "p", style: styles.hint }, item.installSource.text)
								: null,
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
									style: { ...styles.button, ...styles.accent }, disabled: busy || installing,
									onClick: () => { onInstall(item); onClose(); },
								}, installing ? "处理中…" : item.deprecated ? "仍要安装" : "安装")
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
		// ---- skill space ------------------------------------------------------
		// A skill is a folder with a SKILL.md, not a connection: no handshake,
		// no tools, no health. Everything here is therefore read-only display
		// plus one action a person can check by eye — open the folder — so the
		// page never claims a state it cannot prove.

		/** 612 → "612 B", 6144 → "6.0 KB", 17825792 → "17.0 MB". */
		function byteText(n) {
			const value = Number(n);
			if (!Number.isFinite(value) || value < 0) return "";
			if (value < 1024) return `${Math.round(value)} B`;
			const units = ["KB", "MB", "GB"];
			let size = value / 1024;
			let unit = 0;
			while (size >= 1024 && unit < units.length - 1) {
				size /= 1024;
				unit += 1;
			}
			return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
		}

		/** ISO timestamp → "10-21" (the year is noise in this list). */
		function shortDay(iso) {
			const text = String(iso ?? "");
			const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
			return match ? `${match[2]}-${match[3]}` : "";
		}

		/** The first glyph is the card's only visual identity; keep it short. */
		function skillInitial(name) {
			const text = String(name ?? "").trim();
			if (!text) return "?";
			const first = Array.from(text)[0];
			return /^[a-z]$/i.test(first) ? first.toUpperCase() : first;
		}

		/** The Skill space's mark: a page with two lines, next to the star mark. */
		function skillGlyph(size = 18) {
			return createElement("svg", {
				width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false",
			}, [
				createElement("path", {
					key: "p", d: "M7.5 3.5h6l4 4v13h-10z", fill: "none",
					stroke: "currentColor", "stroke-width": "1.7", "stroke-linejoin": "round",
				}),
				createElement("path", {
					key: "l", d: "M9.8 12.2h4.4M9.8 15.6h3.2", fill: "none",
					stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round",
				}),
			]);
		}

		/** `version:` is written both ways in the wild; never print `vv1.2.3`. */
		function versionText(version) {
			const text = String(version ?? "").trim();
			if (!text) return "";
			return /^v/i.test(text) ? text : `v${text}`;
		}

        function RegistryColumns({ skill = false }) {
            const labels = skill ? ["名称与用途", "来源", "文件", "操作"] : ["连接器", "来源", "状态", "启用", "操作"];
            return createElement("div", { className: (skill ? "omkt-skill-columns" : "omkt-reg-columns") + " omkt-reg-head" }, labels.map((label, index) => createElement("span", { key: label, className: index === 1 ? skill ? "omkt-listmeta" : "omkt-reg-source" : index === 2 ? skill ? "omkt-listmeta" : "omkt-reg-status" : undefined }, label)));
        }

        function SkillCard({ skill, busy, onOpen, onReveal, onRemove, rootLabel }) {
            const meta = [Number.isFinite(skill.files) ? `${skill.files} 个文件` : "", byteText(skill.bytes)].filter(Boolean).join(" · ");
            return createElement("div", { className: "omkt-skillcard omkt-listrow omkt-skill-columns", style: styles.skillCard }, [
                createElement("div", { key: "identity", style: { display: "flex", gap: 12, alignItems: "center", minWidth: 0 } }, [
                createElement(SkillIcon, { key: "icon", item: skill, size: 36, initial: true }),
                createElement("div", { key: "main", style: styles.skillMain }, [
                    createElement("button", { key: "name", type: "button", style: { ...styles.textBtn, ...styles.skillName, padding: 0, textAlign: "left" }, onClick: () => onOpen(skill) }, skill.name),
                    skill.description ? createElement("div", { key: "desc", style: styles.skillDesc, title: skill.description }, skill.description) : null,
                ]),
                ]),
                createElement("span", { key: "source", className: "omkt-listmeta", style: { ...styles.listMeta, fontSize: 14 } }, createElement("span", { style: { padding: "3px 9px", borderRadius: 6, background: MCP_SOFT, display: "inline-block" } }, rootLabel || skill.origin || skill.root)),
                createElement("span", { key: "files", className: "omkt-listmeta", style: styles.listMeta, title: skill.dir }, meta),
                createElement("div", { key: "actions", style: styles.skillActs }, [
                    createElement("button", { key: "open", type: "button", className: "omkt-btn omkt-btn-text", style: { ...styles.textBtn, color: T.brand }, onClick: () => onOpen(skill) }, "查看"),
                    createElement(ActionMenu, { key: "more", label: `${skill.name} 更多操作` }, [
                        createElement("button", { key: "reveal", type: "button", style: styles.textBtn, disabled: busy, onClick: () => onReveal(skill) }, "打开目录"),
                        onRemove ? createElement("button", { key: "remove", type: "button", style: { ...styles.textBtn, color: T.red }, disabled: busy, onClick: () => onRemove(skill) }, "移除") : null,
                    ]),
                ]),
            ]);
        }

		function SkillDrawer({ skill, rootLabel, onClose, onReveal, onRemove }) {
			const [closing, setClosing] = useState(false);
			const close = () => {
				if (closing) return;
				setClosing(true);
				onClose();
			};
			const row = (label, value) => (value
				? createElement("div", { key: `kv-${label}`, style: styles.detailRow }, [
					createElement("span", { key: "k", style: styles.detailKey }, label),
					createElement("span", { key: "v", style: styles.detailValue }, value),
				])
				: null);
			const size = Number.isFinite(skill.files) ? `${skill.files} 个 · ${byteText(skill.bytes)}` : "";
			const sub = [rootLabel, skill.origin, size].filter(Boolean).join(" · ");
			const dirName = typeof skill.dir === "string"
				? skill.dir.split(/[\\/]/).filter(Boolean).pop() || ""
				: "";
			return createElement("div", {
				style: styles.overlay,
				onClick: (event) => { if (event.target === event.currentTarget) close(); },
			}, [
				createElement("div", {
					key: "c", className: "omkt-panel", style: styles.detailPanel,
					role: "dialog", "aria-label": `skill ${skill.name}`,
				}, [
					// The head is the MCP detail head: portrait tile, name, badges,
					// then the one line that says where the folder lives. Both cards
					// open from the same kind of tile and must read as one product.
					createElement("div", { key: "h", style: styles.skillCardHead }, [
						createElement("div", { key: "id", style: styles.skillCardId }, [
							createElement("span", { key: "a", style: styles.skillAvatar }, skillInitial(skill.name)),
							createElement("div", { key: "t", style: styles.skillCardNames }, [
								createElement("div", { key: "n", style: styles.skillCardName }, skill.name),
								createElement("div", { key: "s", style: styles.skillCardSub, title: skill.dir }, sub),
							]),
						]),
						createElement("button", {
							key: "c", type: "button", className: "omkt-btn omkt-btn-outline",
							style: styles.textBtn, onClick: close,
						}, "关闭"),
					]),
					skill.description
						? createElement("p", { key: "d", style: styles.detailDesc }, skill.description)
						: null,
					// Same labels the prototype card uses, in its order; 主页 only
					// when the frontmatter actually carries one.
					createElement("div", { key: "f", style: styles.detailFacts }, [
						row("名称", skill.name),
						row("版本", versionText(skill.version)),
						row("作者", skill.author),
						row("许可", skill.license),
						row("来源", skill.origin),
						row("目录", skill.dir),
						row("图标读取问题", skill.iconIssue),
						row("主页", skill.homepage),
						row("更新", skill.modifiedAt ? String(skill.modifiedAt).slice(0, 10) : ""),
					]),
					// We know how many files and how big, not their names — so the
					// block shows exactly that instead of inventing a listing.
					createElement("div", { key: "tree", style: styles.skillBlock }, [
						createElement("div", { key: "l", style: styles.skillBlockLab }, "目录结构"),
						createElement("div", { key: "t", style: styles.skillTree },
							`${dirName || "skill"}/\n  ${Number.isFinite(skill.files) ? skill.files : 0} 个文件 · ${byteText(skill.bytes)}`),
					]),
					createElement("div", { key: "hint", style: styles.skillHint }, [
						createElement("span", { key: "c", style: styles.skillHintChip }, "需重启 DSH"),
						createElement("span", { key: "t" },
							"这里展示的是磁盘上的事实：frontmatter、文件数、修改时间。宿主在会话启动时才读这些目录，新增或改完需要重启 DSH 才会被新会话看到。"),
					]),
					createElement("div", { key: "foot", style: styles.skillFoot }, [
						onRemove
							? createElement("button", {
								key: "x", type: "button", className: "omkt-btn omkt-btn-outline",
								style: { ...styles.textBtn, ...styles.dangerBtn, marginRight: "auto" },
								onClick: () => onRemove(skill),
							}, "移除")
							: null,
						createElement("button", {
							key: "r", type: "button", className: "omkt-btn omkt-btn-primary",
							style: styles.accent, onClick: () => onReveal(skill),
						}, "打开目录"),
					]),
				]),
			]);
		}
		/**
		 * Confirm moving one skill into the plugin's own trash directory.
		 *
		 * One confirmation, not two: the move *is* the undo — nothing is deleted,
		 * and `skills-trash/<stamp>/` is an ordinary folder. What the sheet must
		 * not do is read like a delete, so it names the exact directory that moves
		 * and says where it goes. Two of the four roots belong to other tools; the
		 * sheet says so, because "this folder is not ours" is the fact that decides
		 * whether the click is reasonable.
		 */
		/**
		 * One market row.
		 *
		 * The same card shape as the installed list on purpose: the two pages are
		 * the same list of things, and the reader already learned to read it.
		 */
		function SkillMarketCard({ item, installed, installing, onInstall }) {
			const name = item.title ?? item.name ?? "未命名";
			const downloads = typeof item.downloads === "number" ? item.downloads : NaN;
			const stars = typeof item.stars === "number" ? item.stars : NaN;
			const installable = item.installable !== false;
			const action = installed
				? createElement("span", { key: "i", style: styles.smBadge }, "已安装")
				: !installable
					? createElement("button", {
						key: "i", type: "button", disabled: true,
						style: { ...styles.smallBtn, opacity: 0.6, cursor: "default" },
						title: item.installNote ?? "这个来源只提供索引，没有可直接下载的包",
					}, "只提供索引")
					: createElement("button", {
						key: "i", type: "button", className: "omkt-primary", style: styles.smallPrimary,
						disabled: installing, onClick: () => onInstall(item),
					}, installing ? "安装中…" : "安装");
			return createElement("div", { className: "omkt-skillcard", style: styles.smCard }, [
				createElement("div", { key: "t", style: styles.smTop }, [
					createElement(SkillIcon, { key: "a", item, size: 48 }),
					createElement("div", { key: "m", style: styles.smBox }, [
						createElement("div", { key: "n", style: styles.smNm, title: name }, name),
						createElement("div", { key: "s", style: styles.smSrc }, [
							createElement("span", { key: "p", title: [skillSourceOrigin(item.source), versionText(item.version), item.category].filter(Boolean).join(" · ") }, item.author || skillSourceOrigin(item.source)),
						]),
					]),
                    createElement(ActionMenu, { key: "detail", label: `查看 ${name} 详情` }, [
                        createElement("strong", { key: "name", style: { overflowWrap: "anywhere", maxWidth: 280 } }, name),
                        createElement("div", { key: "about", style: { maxWidth: 280, fontSize: 14, color: T.text2, overflowWrap: "anywhere" } }, item.summary || "来源未提供描述"),
                        createElement("div", { key: "facts", style: { fontSize: 13, color: T.text3 } }, [skillSourceOrigin(item.source), versionText(item.version)].filter(Boolean).join(" · ")),
                    ]),
				]),
				createElement("p", { key: "d", style: styles.smDesc }, item.summary || "这个来源没给描述。"),
				createElement("div", { key: "f", style: styles.smFoot }, [
                    createElement("span", { key: "category", style: styles.tag }, SKILL_CATEGORY_LABELS[skillCategoryOf(item)]),
                    createElement("span", { key: "source", style: styles.smN, title: skillSourceOrigin(item.source) }, skillSourceLabel(item.source)),
                    Number.isFinite(downloads) && downloads >= 0 ? createElement("span", { key: "downloads", style: styles.smN, title: item.metrics?.error || (item.metrics?.at ? `统计时间 ${new Date(item.metrics.at).toLocaleString()}` : "收录时的统计") }, `↓ ${compactCount(downloads)} 次下载`) : null,
                    !(Number.isFinite(downloads) && downloads >= 0) && Number.isFinite(stars) && stars >= 0 ? createElement("span", { key: "stars", style: styles.smN, title: item.metrics?.error || (item.metrics?.at ? `统计时间 ${new Date(item.metrics.at).toLocaleString()}` : "收录时的统计") }, `★ ${compactCount(stars)}`) : null,
                    createElement("span", { key: "action", style: { marginLeft: "auto" } }, action),
                ]),
			]);
		}

		// ---- Skill 市场：每个来源自己报数，页面只负责把它说清楚 ----------------
		// 四个上游里只有三个会报总数（ClawHub 的 /api/v1/skills 是游标分页，
		// 只有 items + nextCursor），所以「N 个可用 Skill」只在四家都报数时才敢写；
		// 否则退回「本页列了几条」，并用 + 标出哪几个源是按页给的。
        const skillSourceTint = () => ({ background: T.soft, color: T.text3, borderColor: T.line2 });

		const skillSourceLabel = (id) => SKILL_MARKET_LABELS[id] ?? id;
        // Interpret the error for readers without changing the stored diagnostic.
        // In particular, a plain 403 is not evidence of rate limiting.
        function skillSourceErrorMessage(row) {
            const raw = String(row?.error ?? "");
            const github = row?.id === "official" || row?.id === "github";
            if (github && /secondary rate limit|abuse detection/i.test(raw)) {
                return "GitHub 请求过于频繁，已被暂时限制。请暂停刷新，稍后再试。";
            }
            if (github && /API rate limit exceeded/i.test(raw)) {
                return "GitHub 的访问次数已用完。请稍后重试；也可在「MCP → 已注册 → GitHub 访问」中检测本机登录或配置 Token。";
            }
            if (/\b401\b|bad credentials/i.test(raw)) {
                return "身份验证未通过。请检查该来源的登录状态或访问凭据。";
            }
            if (/\b429\b|too many requests|rate limit/i.test(raw)) {
                return "请求过于频繁，来源暂时限制了访问。请稍后再试。";
            }
            if (/\b403\b/.test(raw)) {
                return "来源拒绝了本次访问。请检查访问权限，或稍后重试。";
            }
            if (/\b5\d{2}\b/.test(raw)) {
                return "来源服务器暂时异常，请稍后重试。";
            }
            if (/timeout|timed out|超时/i.test(raw)) {
                return "连接来源超时，请检查网络后重试。";
            }
            if (/fetch failed|ENOTFOUND|ECONN|EAI_AGAIN|network|网络/i.test(raw)) {
                return "暂时无法连接来源，请检查网络或代理设置后重试。";
            }
            return "获取技能列表失败，请稍后重试；可展开查看原始错误。";
        }

		// Where a source actually comes from. The short label above is fine inside a
		// chip ("官方 19"); on a card the reader wants to know *which* official list.
		const SKILL_SRC_ORIGIN = {
			official: "anthropics/skills",
			skillhub: "SkillHub",
			clawhub: "ClawHub",
			github: "GitHub",
		};
		const skillSourceOrigin = (id) => SKILL_SRC_ORIGIN[id] ?? skillSourceLabel(id);

		// Eight buckets that every source can land in. SkillHub publishes a real
		// category, ClawHub publishes free-form topics (the same idea spelled three
		// ways: "Web Search" / "web-search" / "search-the-web"), and anthropics and
		// GitHub publish nothing at all — so the last two are read by keyword. The
		// table is here rather than in the host because it is a reading aid: the
		// host keeps reporting what it was told, this decides where it goes.
		const SKILL_CATEGORIES = [
			["dev", "开发编程"],
			["search", "搜索与检索"],
			["office", "办公与文档"],
			["content", "内容创作"],
			["data", "数据分析"],
			["knowledge", "知识与笔记"],
			["agent", "自动化与智能体"],
			["other", "其他"],
		];
		const SKILL_CATEGORY_LABELS = Object.fromEntries(SKILL_CATEGORIES);
		const skillCategoryOf = item => Object.hasOwn(SKILL_CATEGORY_LABELS, item?.marketCategory) ? item.marketCategory : "other";
		/**
		 * One source's count, and whether it is a real total.
		 *
		 * Errors say so instead of showing a number that only means "we have no
		 * idea" — an unreachable source is a different fact from a small one.
		 */
		function skillMarketSourceSize(row) {
			if (!row) return { text: "?", exact: false };
			if (row.error) return { text: "暂不可用", exact: false };
			// The upstream total and our own row count are two facts, not one:
			// `total` is the population (when the source publishes it), `indexed`
			// is what the local index holds. Printing the second as the first is
			// the exact lie the "+" exists to avoid.
			const indexed = Number(row.indexed);
			const held = Number.isFinite(indexed) && indexed > 0 ? " · 已收录 " + compactCount(indexed) : "";
			if (Number.isFinite(row.total)) return { text: compactCount(row.total) + held, exact: true };
			return { text: compactCount(Number(row.count) || 0) + "+" + held, exact: false };
		}
		function skillMarketTotals(data) {
			const sources = Array.isArray(data && data.sources) ? data.sources : [];
			const items = Array.isArray(data && data.items) ? data.items : [];
			const sizes = sources.map(skillMarketSourceSize);
			const exact = sources.length > 0 && sizes.every((size) => size.exact);
			// What the local index holds, summed over the sources that report it.
			// Kept apart from `total` for the same reason as the per-source chip.
			const indexed = sources.reduce((sum, row) => sum + (Number(row.indexed) || 0), 0);
			// `count` is what the page is listing; `total` is the whole market as far
			// as anyone tells us: per source its total when reported, else the page
			// it just handed over. `totalExact` says whether that sum is a real
			// total or only a lower bound.
			const count = exact
				? sources.reduce((sum, row) => sum + row.total, 0)
				: items.length;
			const total = sources.reduce(
				(sum, row) => sum + (Number.isFinite(row.total) ? row.total : Number(row.count) || 0),
				0,
			);
			return { sources, items, sizes, exact, count, indexed, total, totalExact: exact };
		}
		const skillMarketCount = (data) => skillMarketTotals(data).count;
		const skillMarketTotalLabel = (data) => {
			const totals = skillMarketTotals(data);
			const upstream = compactCount(totals.total) + (totals.totalExact ? "" : "+");
			// Once the local index holds rows, the tab says both numbers: the
			// population the sources claim, and how much of it is on this machine.
			return totals.indexed > 0 ? upstream + " · 收录 " + compactCount(totals.indexed) : upstream;
		};

		/**
		 * The wide cards highlight the first two ranked rows from the same list, not a second
		 * request — the tab has one budget and this spends no extra.
		 */
        function SkillMarketHero({ item, alt, installed, installing, onInstall }) {
            const name = item.title ?? item.name ?? "未命名";
            return createElement("div", { className: "omkt-skillhero", style: { ...styles.smHero, height: 128, boxSizing: "border-box" } }, [
                createElement("div", { key: "eyebrow", style: styles.smEyebrow }, alt ? "推荐技能" : "♛ 精选技能"),
                createElement("div", { key: "main", style: { display: "flex", gap: 14, alignItems: "center", minWidth: 0, flex: 1 } }, [
                    createElement(SkillIcon, { key: "icon", item, size: 54 }),
                    createElement("div", { key: "text", style: { flex: 1, minWidth: 0 } }, [
                        createElement("div", { key: "name", style: { ...styles.smHTitle, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }, title: name }, name),
                        createElement("div", { key: "summary", style: styles.smHDesc, title: item.summary }, item.summary || "来源未提供描述"),
                        createElement("span", { key: "source", title: [skillSourceOrigin(item.source), item.version && `v${item.version}`].filter(Boolean).join(" · "), style: { fontSize: 14, color: T.text3, display: "flex", alignItems: "center", gap: 6 } }, [createElement(UiIcon, { key: "source-icon", name: "layers", size: 15 }), skillSourceLabel(item.source)]),
                    ]),
                    installed ? createElement("span", { key: "installed", style: styles.smBadge }, "已安装")
                        : item.installable === false ? createElement("span", { key: "index", style: styles.smN, title: item.installNote }, "只提供索引")
                            : createElement("button", { key: "install", type: "button", className: "omkt-primary", style: styles.smallPrimary, disabled: installing, onClick: () => onInstall(item) }, installing ? "安装中…" : "安装"),
                ]),
            ]);
        }

		/**
		 * The Skill 市场 tab: four upstreams behind one search box.
		 *
		 * Each source reports for itself, so one upstream being down shows as a red
		 * chip instead of an empty page — that distinction is the point of asking
		 * four places at all.
		 */
		function SkillMarket({ data, error, busy, query, appliedQuery, onQuery, onSearch, onRefresh, installing, installed, onInstall, source, onSource, category, onCategory, page, pageSize, onPage, onPageSize, index, walk, walkBusy, fullSel, onFullSel, onWalk, sort = "default", onSort }) {
			// Per-source slice vs full, as recorded by the walk that wrote the file.
			const [indexDetailsOpen, setIndexDetailsOpen] = useState(false);
            const modes = (index && index.modes) || {};
            const toggleIndex = () => setIndexDetailsOpen(value => !value);
			const totals = skillMarketTotals(data);
			const { sources, items, sizes, exact, count } = totals;
			const paging = data?.paging;
			const indexed = paging?.mode === "index";
			const installedIds = Array.isArray(installed) ? installed : [];
			const searching = String(appliedQuery ?? "").trim().length > 0;
			const pageCount = Math.max(1, Math.ceil((paging?.matched ?? items.length) / pageSize));
			const safePage = paging ? Math.floor(paging.offset / paging.limit) : Math.min(page, pageCount - 1);
			const rows = busy || error ? [] : paging ? items : items.slice(safePage * pageSize, (safePage + 1) * pageSize);
			const heroes = safePage === 0 && !searching && category === "all" && sort !== "name" ? rows.slice(0, 2) : [];
			const pageRows = rows.slice(heroes.length);
			const cardFor = (item) => createElement(SkillMarketCard, {
				key: item.id,
				item,
				installed: installedIds.includes(item.id),
				installing: installing === item.id,
				onInstall,
			});
			return createElement("div", { className: "omkt-skillpanel", style: styles.market }, [
                createElement(PageHeading, { key: "heading", title: "发现 Skill", hint: paging ? `${compactCount(paging.matched)} 个匹配${indexed ? " · 本地索引" : " · 实时样本"}` : data ? `${items.length} 个已列出技能` : `浏览 ${sources.length} 个技能来源`, actions: [
                    createElement("button", { key: "manage", type: "button", style: { ...styles.textBtn, display: "inline-flex", gap: 8, alignItems: "center", color: T.brand }, disabled: Boolean(walk), "aria-expanded": indexDetailsOpen || Boolean(walk), onClick: toggleIndex }, [createElement(UiIcon, { key: "icon", name: "database" }), "管理来源"]),
                ] }),
				createElement("div", { key: "stick", style: styles.smSticky }, [
                    createElement(MarketToolbar, { key: "toolbar", skill: true, query, onQuery, onSearch, busy,
                        source: source || "all", sources: [["all", "全部来源"], ...Object.keys(SKILL_MARKET_LABELS).map(id => [id, skillSourceLabel(id)])], onSource,
                        category: category || "all", categories: [["all", "全部分类"], ...SKILL_CATEGORIES], onCategory,
                        sort, onSort, sorts: [["default", "热门排序（默认）"], ["name", "名称 A–Z"]], onRefresh,
                    }),
                    createElement("div", { key: "warn", style: { display: "flex", gap: 12, alignItems: "center", padding: "3px 8px", borderTop: `1px solid ${T.line2}`, flexWrap: "wrap", color: T.text2, fontSize: 14 } }, [
                        createElement(UiIcon, { key: "info", name: "info", size: 16 }),
                        createElement("span", { key: "text" }, "安装到本插件目录；重启 DSH 后在新会话中加载。"),
                        createElement("button", { key: "coverage", type: "button", style: { ...styles.textBtn, color: T.brand, marginLeft: "auto" }, "aria-expanded": indexDetailsOpen || Boolean(walk), disabled: Boolean(walk), onClick: toggleIndex }, "来源与索引详情"),
                    ]),
				error ? createElement("div", { key: "e", style: styles.error }, error) : null,
				createElement("details", { key: "metadata", "data-omkt": "index-details", className: "omkt-index-details", style: styles.sourceBox, open: Boolean(walk) || indexDetailsOpen }, [
                    createElement("summary", { key: "summary", style: { cursor: walk ? "default" : "pointer", color: T.text2 }, onClick: event => { event.preventDefault(); if (!walk) setIndexDetailsOpen(false); } }, `来源与本地索引 · ${sources.length} 个来源${index?.stale ? " · 索引已过期" : ""}${walk ? " · 正在收录" : ""}`),
                    createElement("div", { key: "s", style: { ...styles.smStat, paddingTop: 8 } }, [
					createElement("span", { key: "n" }, !data
						? "还没读过市场"
						: indexed
							? compactCount(Number(paging.matched) || 0) + " 行匹配（本地索引 " + compactCount(Number(paging.rows) || 0) + " 行）"
							: exact
								? compactCount(count) + " 个可用 Skill"
								: (paging?.matched ?? count) + " 个已列出（各源首屏）"),
					// The pager's range is the fetched window, not the catalog the tab
					// counts. Spell that out or the numbers look like a bug.
					createElement("span", { key: "p" }, !paging && count && items.length
						? " · 翻页只在这 " + items.length + " 条之内"
						: ""),
					sources.length && sizes.some((size) => size && !size.exact)
						? createElement("span", { key: "x" }, " · 带 + 的来源按页给，没有总数")
						: null,
					createElement("span", { key: "c", style: styles.smChips }, sources.map((row, index) => {
						const label = skillSourceLabel(row.id) + " " + (sizes[index]?.text ?? "?");
						// The walkable sources are the choice: a slice (the default) or
						// everything the upstream has. Official is fixed and stays a label,
						// and a failed source has to keep carrying its reason, so it is
						// never turned into a button.
						if (!onWalk || row.error || !["skillhub", "clawhub", "github"].includes(row.id)) {
							return createElement("span", {
								key: row.id,
								style: row.error
									? { ...styles.smSrcPill, ...styles.marketChipBad }
									: { ...styles.smSrcPill, ...skillSourceTint(row.id) },
								title: row.error ? skillSourceErrorMessage(row) : (row.total
									? (Number.isFinite(Number(row.minStars))
										? "上游报的总数（只算 ≥" + row.minStars + " 星的仓库）"
										: "上游报的总数")
									: "上游按页给，只有本页条数"),
							}, label);
						}
						const selected = Array.isArray(fullSel) && fullSel.includes(row.id);
						const modeFull = modes && modes[row.id] === "full";
						return createElement("button", {
							key: row.id,
							type: "button",
							style: {
								...styles.smSrcPill,
								...skillSourceTint(row.id),
								cursor: walkBusy ? "progress" : "pointer",
								outline: selected ? "2px solid #4d6bfe" : "none",
								outlineOffset: "1px",
								opacity: selected ? 1 : 0.82,
							},
							disabled: Boolean(walkBusy),
							"aria-pressed": selected ? "true" : "false",
							title: selected
								? "已选全量收录，再点一下取消（回到切片）"
								: modeFull
									? "本地已是全量；点一下选入下次收录"
									: "点一下选择「全量收录」：把该源收到底，而不是只收切片",
							onClick: () => onFullSel && onFullSel(row.id),
						}, label + (selected ? " · 全量" : modeFull ? " · 已全量" : ""));
					})),
				]),
				// The local index: what it holds, and the one verb that changes it.
				// It sits under the counts because it is about coverage rather than
				// about this page, and it is the only place a walk can be started.
				createElement("div", { key: "idx", style: styles.smHintRow }, [
					createElement("button", {
						key: "go", type: "button", className: "omkt-btn omkt-btn-outline",
						style: styles.outlineBtn, disabled: busy || walkBusy,
						onClick: () => onWalk && onWalk(walk ? "stop" : "start"),
					}, walk ? "停止收录" : "收录到本机"),
					createElement("span", { key: "t" }, walk
						? "正在收录：已收 " + compactCount(Number(walk.rows) || 0) + " 行 · 第 " + (Number(walk.requests) || 0) + " 次请求（点「刷新」看最新）"
						: index
							? "本地已收录 " + compactCount(Number(index.rows) || 0) + " 行"
								+ (index.at ? " · " + String(index.at).slice(0, 16).replace("T", " ") : "")
								+ (index.partial ? " · 上次没走完：" + index.partial : "")
								// The host's answer to "would a walk add anything":
								// an old file is worth refreshing, and saying so is
								// all this page is allowed to do about it — it never
								// starts a walk on its own.
								+ (index.stale && !index.partial ? " · 索引已过期，建议重新收录" : "")
							: "还没有本地索引：收录一次后，搜索与翻页都在本机完成"),
					// Say what the next 收录 means before it costs 200 MB or two hours.
					createElement("span", { key: "sel", style: styles.smHintChip }, fullSel && fullSel.length
						? " · 已选全量：" + fullSel.map((id) => skillSourceLabel(id)).join("、")
							+ "（其余按切片）"
							// The request budget is per run: SkillHub 2,103 + ClawHub
							// 3,000 + GitHub 390 is about 5,500, over the 3,500 cap, so
							// two or more full sources cannot finish in one click.
							+ (fullSel.length > 1 ? " · 一次跑不完会接着续跑" : "")
						: " · 按切片收录（点上面带圈出的来源可选全量）"),
				]),
                ]),
				]),
				...sources.filter((row) => row.error).map((row) => createElement("div", { key: `source-error:${row.id}`, style: { ...styles.error, overflowWrap: "anywhere", margin: "6px 0" } }, [
                    createElement("div", { key: "message", role: "alert" }, `${skillSourceLabel(row.id)}暂时无法更新：${skillSourceErrorMessage(row)}`),
                    createElement("details", { key: "diagnostic", style: { color: T.text2, marginTop: 4 } }, [
                        createElement("summary", { key: "summary", style: { cursor: "pointer", fontSize: 12 } }, "查看原始错误"),
                        createElement("pre", { key: "raw", style: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 120, overflow: "auto", fontSize: 12, margin: "6px 0" } }, String(row.error)),
                    ]),
                ])),
                busy ? createElement("div", { key: "l", style: styles.message }, "正在加载技能…") : null,
                createElement("div", { key: "scroll", "data-omkt": "scroller", style: styles.marketScroll }, [
				heroes.length
					? createElement("div", { key: "h", style: { ...styles.smSpotlight, marginBottom: 16 } },
						heroes.map((item, index) => createElement(SkillMarketHero, {
							key: item.id,
							item,
							alt: index > 0,
							installed: installedIds.includes(item.id),
							installing: installing === item.id,
							onInstall,
						})))
					: null,
				!busy && !error && paging?.deferredSkillHub ? createElement("div", { key: "skillhub-deferred", style: styles.message }, [
					createElement("span", { key: "text" }, `当前混排未显示 ${compactCount(paging.deferredSkillHub)} 条 SkillHub 结果。`),
					createElement("button", { key: "view", type: "button", style: styles.textBtn, onClick: () => onSource("skillhub") }, "查看 SkillHub"),
				]) : null,
				data && !items.length && !busy && !error && !paging?.deferredSkillHub
					? createElement("div", { key: "nores", style: styles.message },
						searching ? `没有匹配「${String(appliedQuery).trim()}」的 Skill，试试换个关键词或筛选条件。` : "当前筛选没有匹配的 Skill。")
					: null,
				createElement("div", { key: "g", className: "omkt-grid", style: styles.skillGrid }, pageRows.map(cardFor)),
                ]),
				// With a local index each page arrives already paged, so `rest` is
				// never longer than one page — gating the pager on `rest.length` hid
				// it from page 2 onwards (and after any search), making rows past
				// the first page unreachable. Gate on "there is more than one page"
				// instead, which is true for both the index and the live path.
                data && !busy && !error ? createElement(PageFooter, { key: "pager", page: safePage, pageCount, pageSize, onPage, onPageSize, note: `${sources.length} 个来源 · ${indexed ? "本地索引" : "实时目录"}` }) : null,

			]);
		}

// ---- 「调用」 -------------------------------------------------------
		// A read-only feed of what actually ran: the MCP round trips and the
		// skill events the host recorded (lib/calls.js owns the rows and their
		// redaction). Nothing on this tab changes a configuration, so every
		// control here is a filter on what is already in the file.
		const CALL_RANGES = [["1h", "近1小时"], ["24h", "近24小时"], ["7d", "近7天"]];

// How long repeated slash references count as one 调用 (the folding window).
const CALL_MERGES = [[0, "关"], [5 * 60 * 1000, "5 分"], [30 * 60 * 1000, "30 分"]];

const callStyles = {
  scroll: { flex: "1 1 auto", minHeight: 0, minWidth: 0, overflowY: "auto", paddingRight: 2 },
  mergeGroup: { display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" },
  mergeLabel: { fontSize: 14, color: T.text3 },
  hint: { display: "flex", gap: 8, flexWrap: "wrap", fontSize: 14, color: T.text3, alignItems: "center" },
  layout: { display: "flex", gap: 12, alignItems: "stretch", flex: "1 1 auto", minHeight: 0 },
  rail: {
    // Pinned beside the timeline (1.0.2), so it needs its own scroll: a machine
    // with thirty servers would otherwise push its own rows out of reach, since
    // the panel body is the box with overflow hidden.
    flex: "0 0 208px", display: "flex", flexDirection: "column", gap: 2,
    background: "rgba(255,255,255,0.72)", border: "1px solid " + T.line,
    borderRadius: 16, padding: "10px 8px",
    maxHeight: "100%", minHeight: 0, overflowY: "auto", overflowX: "hidden",
    boxShadow: "0 1px 2px rgba(31,35,41,.03), 0 6px 16px rgba(31,35,41,.04)",
  },
  railHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 17, color: T.text, padding: "2px 8px 6px" },
  railItem: {
    display: "flex", gap: 8, alignItems: "center", padding: "7px 9px", borderRadius: 10,
    border: "1px solid transparent", background: "transparent", font: "inherit", fontSize: 14,
    color: T.text2, cursor: "pointer", textAlign: "left",
  },
  railOnMcp: { background: MCP_SOFT, border: "1px solid #d5e0f8", color: "#3d5fd9" },
  railName: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  railCount: { fontSize: 13, fontVariantNumeric: "tabular-nums", color: T.text3 },
  toolbar: { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", width: "100%" },
  chip: { border: "1px solid " + T.line, background: T.cardBg, borderRadius: 999, padding: "4px 10px", fontSize: 14, font: "inherit", color: T.text2, cursor: "pointer" },
  note: { fontSize: 13, color: T.text3 },
  detail: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 },
  blk: { flex: "1 1 240px", minWidth: 0, display: "flex", flexDirection: "column", gap: 3 },
  blkLab: { fontSize: 13, fontWeight: 600, color: T.text2 },
  pre: { margin: 0, padding: 8, background: T.soft, borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap", wordBreak: "break-word", maxHeight: 220, overflow: "auto", color: T.text2 },
  why: { flex: "1 1 100%", fontSize: 13, color: T.text3, background: T.soft, borderRadius: 8, padding: "6px 8px" },
  empty: { border: "1px dashed " + T.line, borderRadius: 10, padding: "22px 16px", display: "flex", flexDirection: "column", gap: 6, alignItems: "center", textAlign: "center", color: T.text3 },
  emptyTitle: { fontSize: 13, fontWeight: 600, color: T.text2 },
  emptyHint: { fontSize: 14, lineHeight: 1.5, maxWidth: 460 },
};

function clockText(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  const date = new Date(at);
  const pad = (n) => String(n).padStart(2, "0");
  return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

/** null is "no result yet"; a number is milliseconds, seconds past 1000. */
function durationText(row) {
  if (row.status === "running") return "…";
  if (row.status === "lost") return "无结果";
  const ms = row.ms;
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return ms + " ms";
  return (ms / 1000).toFixed(1).replace(/\.0$/, "") + " s";
}

/** A small waveform, the way the prototype marks "there is nothing on the line yet". */
function callWave() {
  return createElement(
    "svg",
    { width: 44, height: 22, viewBox: "0 0 44 22", style: { color: SKILL_ACCENT, opacity: 0.6 } },
    createElement("path", {
      d: "M2 11 H8 L11 5 L15 17 L19 8 L23 14 L27 11 H42",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.6,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    }),
  );
}

/** Everything a search may hit, lower-cased once. */
function callHaystack(row) {
  return [row.tool, row.skill, row.kind, row.session, row.note, row.name]
    .filter((part) => typeof part === "string")
    .join(" ")
    .toLowerCase();
}

function callStatus(row) {
    if (row.via === "用户引用") return "已记录";
    return { ok: "成功", fail: "失败", running: "执行中", lost: "无结果" }[row.status] ?? "未知";
}

// A recorded slash reference contributes to completion, without an elapsed time.
function callMetrics(space, data, shown, narrowed) {
    const stats = data?.stats;
    if (space === "mcp" && !narrowed && stats) {
        return { ok: stats.ok ?? 0, fail: stats.fail ?? 0, rate: Number.isFinite(stats.rate) ? stats.rate : null,
            avgMs: Number.isFinite(stats.avgMs) ? stats.avgMs : null, scope: "当前时间范围", count: stats.shown ?? shown.length };
    }
    let loaded = 0, fail = 0, references = 0, count = 0, duration = 0, timed = 0;
    for (const row of shown) {
        if (space === "skill" && row.via === "用户引用") {
            const n = Number.isInteger(row.count) && row.count > 0 ? row.count : 1;
            references += n;
            count += n;
            continue;
        }
        count++;
        if (row.status === "ok") loaded++;
        else if (row.status === "fail") fail++;
        else continue;
        if (Number.isFinite(row.ms)) { duration += row.ms; timed++; }
    }
    const ok = loaded + references;
    const settled = ok + fail;
    return { ok, loaded, fail, references, rate: settled ? Math.round(ok / settled * 1000) / 10 : null,
        avgMs: timed ? Math.round(duration / timed) : null, scope: "当前列表", count };
}

function CallDetail({ row, onClose, onDiagnostics }) {
    const reference = row.via === "用户引用";
    const isSkill = row.space === "skill";
    const name = isSkill ? row.skill || row.tool || row.name : row.tool || row.name;
    const payload = [
        createElement("div", { key: "req", style: callStyles.blk }, [
            createElement("div", { key: "label", style: callStyles.blkLab }, "请求参数"),
            createElement("pre", { key: "value", style: callStyles.pre }, row.req || "没有记录请求内容"),
        ]),
        createElement("div", { key: "res", style: callStyles.blk }, [
            createElement("div", { key: "label", style: callStyles.blkLab }, reference ? "引用记录" : row.status === "fail" ? "错误响应" : "执行结果"),
            createElement("pre", { key: "value", style: callStyles.pre }, row.status === "running" ? "正在等待结果…" : row.res || "没有记录响应内容"),
        ]),
    ];
    const facts = [
        ["会话", row.session], ["记录 ID", row.id], [isSkill ? "事件" : "连接器", isSkill ? (reference ? "命令引用" : "工具加载") : row.server],
        ["耗时", reference ? "—" : durationText(row)], [isSkill ? "触发时间" : row.status === "fail" || row.status === "lost" ? "错误" : "说明", isSkill ? clockText(row.startedAt) : row.note],
    ].filter(([, value]) => value);
    return createElement("section", { className: "omkt-call-detail", "aria-label": "执行详情", style: { margin: "7px 12px", padding: "9px 16px", borderRadius: 10, border: `1px solid ${T.line}`, background: "rgba(114,130,167,.045)", minWidth: 0 } }, [
        createElement("div", { key: "heading", style: { ...styles.toolbar, justifyContent: "space-between", gap: 6, marginBottom: 8 } }, [
            createElement("div", { key: "title", style: { ...styles.toolbar, minWidth: 0, overflowWrap: "anywhere" } }, [
                createElement("strong", { key: "name", style: { fontSize: 17 } }, isSkill ? name : "执行详情"),
                createElement(CallStatusBadge, { key: "status", row }),
            ]),
            createElement("button", { key: "close", type: "button", "aria-label": "收起执行详情", style: { ...styles.textBtn, fontSize: 18, padding: "0 6px" }, onClick: onClose }, "×"),
        ]),
        createElement("div", { key: "facts", className: "omkt-call-facts", style: { display: "grid", gap: "2px 18px", fontSize: 14, lineHeight: 1.4, overflowWrap: "anywhere" } }, facts.map(([label, value]) => createElement("div", { key: label }, [
            createElement("span", { key: "label", style: { color: T.text3, marginRight: 10 } }, label), value,
        ]))),
        isSkill && row.note ? createElement("div", { key: "note", style: { ...callStyles.why, marginTop: 8 } }, row.note) : null,
        isSkill ? createElement("details", { key: "payload", style: { marginTop: 8, fontSize: 14 } }, [
            createElement("summary", { key: "toggle", style: { color: T.brand, cursor: "pointer" } }, "请求参数与原始响应"),
            createElement("div", { key: "content", style: callStyles.detail }, payload),
        ]) : createElement("div", { key: "payload", style: { ...callStyles.detail, marginTop: 10 } }, payload),
        onDiagnostics ? createElement("button", { key: "diagnostics", type: "button", style: { ...styles.textBtn, display: "inline-flex", gap: 7, alignItems: "center", color: T.brand, marginTop: 5, paddingLeft: 0 }, onClick: onDiagnostics }, [createElement(UiIcon, { key: "icon", name: "diagnostics", size: 16 }), "查看运行诊断"]) : null,
    ]);
}

function CallStatusBadge({ row }) {
    const reference = row.via === "用户引用";
    const success = !reference && row.status === "ok";
    const failure = !reference && (row.status === "fail" || row.status === "lost");
    const tone = success ? "#168342" : failure ? "#a45c08" : T.text3;
    return createElement("span", { style: { display: "inline-flex", alignItems: "center", justifySelf: "start", gap: 5, whiteSpace: "nowrap", fontSize: 14, fontWeight: 500, padding: "0 7px", borderRadius: 10, color: tone, background: success ? "rgba(36,186,98,.12)" : failure ? "rgba(255,157,0,.15)" : T.soft } }, [
        createElement("span", { key: "dot", "aria-hidden": true, style: { width: 7, height: 7, borderRadius: "50%", background: success ? "#23b960" : failure ? "#ea910b" : T.text4 } }), callStatus(row),
    ]);
}

function CallCard({ row, open, onToggle }) {
    const isSkill = row.space === "skill";
    const name = isSkill ? row.skill || row.tool || row.name : row.tool || row.name;
    const reference = row.via === "用户引用";
    return createElement("div", { style: { background: T.cardBg, borderBottom: `1px solid ${T.line2}` } }, [
        createElement("div", { key: "row", className: isSkill ? "omkt-callrow omkt-callrow-skill" : "omkt-callrow", style: { padding: "3px 12px", ...(open ? { background: row.status === "fail" ? "rgba(255,159,0,.14)" : "rgba(69,102,233,.09)" } : {}) } }, [
            createElement("span", { key: "time", style: { fontSize: 14, color: T.text2, fontVariantNumeric: "tabular-nums" }, title: row.startedAt }, clockText(row.startedAt)),
            createElement("div", { key: "identity", style: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 } }, [
                !isSkill && row.server ? createElement(ProductIcon, { key: "icon", item: { name: row.server }, size: 23 }) : null,
                createElement("div", { key: "text", style: { minWidth: 0 } }, [
                    createElement("div", { key: "name", style: { fontSize: 15, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: [name, row.session].filter(Boolean).join(" / ") }, [
                        createElement("strong", { key: "resource", style: { fontWeight: 600 } }, name || "调用"),
                        row.session ? createElement("span", { key: "session", style: { fontSize: 14, color: T.text2 } }, ` / ${row.session}`) : null,
                    ]),
                    isSkill ? createElement("div", { key: "meta", className: "omkt-callmeta", style: { fontSize: 13, color: T.text3 } }, reference ? `用户引用${row.count > 1 ? ` ×${row.count}` : ""}` : "工具加载") : null,
                ]),
            ]),
            isSkill ? createElement("span", { key: "event-type", className: "omkt-eventtype", style: { fontSize: 14, color: T.text2 } }, reference ? `命令引用${row.count > 1 ? ` ×${row.count}` : ""}` : "工具加载") : null,
            createElement(CallStatusBadge, { key: "status", row }),
            createElement("span", { key: "duration", className: "omkt-callduration", style: { fontSize: 14, fontVariantNumeric: "tabular-nums", color: T.text2 } }, reference ? "—" : durationText(row)),
            createElement("button", { key: "toggle", type: "button", className: "omkt-calltoggle", style: { ...styles.textBtn, padding: "3px 0", fontSize: 16 }, "aria-expanded": open, "aria-label": `${open ? "收起" : "展开"} ${name} 请求和响应`, onClick: onToggle }, open ? "⌃" : "⌄"),
        ]),
        open && isSkill ? createElement(CallDetail, { key: "detail", row, onClose: onToggle }) : null,
    ]);
}

const CALL_VIEW_DEFAULT = { mode: "all", id: null, page: 0, limit: 5 };

function CallsPanel({ space, data, error, busy, range, onRange, merge, onMerge, query, onQuery, filter, onFilter, onExport, note, view, onView, onDiagnostics }) {
    const selectedMode = view.mode;
    const isMcp = space === "mcp";
    const rail = Array.isArray(data?.rail) ? data.rail : [];
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    const needle = String(query ?? "").trim().toLowerCase();
    const shown = rows.filter((row) => (!needle || callHaystack(row).includes(needle)) && (
        selectedMode === "all" || selectedMode === "reference" && row.via === "用户引用"
        || selectedMode === "load" && row.via !== "用户引用" || selectedMode === row.status
    ));
    const metrics = callMetrics(space, data, shown, Boolean(needle) || selectedMode !== "all");
    const rangeLabel = CALL_RANGES.find(([id]) => id === range)?.[1] ?? range;
    const pageCount = Math.max(1, Math.ceil(shown.length / 6));
    const page = Math.min(view.page, pageCount - 1);
    const visible = isMcp ? shown.slice(0, view.limit) : shown.slice(page * 6, (page + 1) * 6);
    const selected = visible.find(row => row.id === view.id);
    const resetView = patch => onView({ id: null, page: 0, limit: 5, ...patch });
    const selectRow = row => onView({ id: view.id === row.id ? null : row.id });
    const chooseFilter = id => { onFilter(id); resetView(); };
    const stat = (key, label, value, hint) => createElement("div", { key, className: "omkt-callstat", style: { flex: "1 1 150px", minWidth: 136, padding: "10px 26px", borderRight: `1px solid ${T.line2}` } }, [
        createElement("div", { key: "label", style: { fontSize: 14, color: T.text3 } }, label),
        createElement("div", { key: "numbers", style: { display: "flex", alignItems: "baseline", gap: "2px 12px", flexWrap: "wrap" } }, [
            createElement("strong", { key: "value", style: { fontSize: 30, fontWeight: 700, fontVariantNumeric: "tabular-nums", lineHeight: 1.25 } }, value),
            createElement("span", { key: "hint", style: { fontSize: 13, color: T.text3 } }, hint),
        ]),
    ]);
    const railItem = (id, label, count) => createElement("button", {
        key: id, type: "button", "aria-pressed": filter === id,
        style: { ...callStyles.railItem, ...(filter === id ? callStyles.railOnMcp : {}) }, onClick: () => chooseFilter(id),
    }, [isMcp && id ? createElement(ProductIcon, { key: "icon", item: { name: id }, size: 23 }) : null, createElement("span", { key: "name", style: callStyles.railName }, label), createElement("span", { key: "count", style: callStyles.railCount }, count)]);
    return createElement("div", { className: "omkt-skillpanel", style: { display: "flex", flexDirection: "column", gap: 12, flex: "1 1 auto", minHeight: 0 } }, [
        createElement(PageHeading, { key: "heading", title: isMcp ? "MCP 调用记录" : "Skill 调用记录", hint: isMcp ? "追踪工具执行与连接异常" : "查看技能加载与命令引用事件", actions: [
            createElement("button", { key: "export", type: "button", className: "omkt-btn", style: { ...styles.button, display: "inline-flex", gap: 8, alignItems: "center" }, title: "导出当前筛选结果", onClick: () => onExport({ rows: shown, eventFilter: selectedMode }), disabled: !data || busy }, [createElement(UiIcon, { key: "icon", name: "upload", size: 16 }), "导出记录"]),
        ] }),
        createElement("div", { key: "stats", className: "omkt-callsummary", style: { display: "flex", flexWrap: "wrap", background: T.cardBg, border: `1px solid ${T.line}`, borderRadius: 12, minHeight: 88, overflow: "hidden" } }, [
            stat("count", isMcp ? "工具调用" : "触发事件", data ? String(metrics.count) : "—", metrics.scope),
            stat("rate", isMcp ? "成功率" : "触发完成", metrics.rate === null ? "—" : isMcp ? `${metrics.rate}%` : `${metrics.ok} / ${metrics.ok + metrics.fail}`, isMcp ? `${metrics.ok} 成功 · ${metrics.fail} 失败` : `${metrics.loaded} 加载成功 · ${metrics.references} 命令引用 · ${metrics.fail} 失败`),
            stat("avg", "平均耗时", metrics.avgMs === null ? "—" : durationText({ status: "ok", ms: metrics.avgMs }), isMcp ? "工具往返延迟" : "工具加载实测耗时"),
        ]),
        !isMcp ? createElement("div", { key: "hint", style: { ...callStyles.hint, background: T.soft, borderRadius: 8, padding: "8px 12px" } }, [createElement(UiIcon, { key: "icon", name: "info", size: 16 }), "斜杠命令引用计入触发完成数，合并后仍按实际引用次数计。引用没有实测耗时。新增或移除 Skill 后需重启 DSH。"]) : null,
        error ? createElement("div", { key: "error", role: "alert", style: styles.error }, error) : null,
        note ? createElement("div", { key: "note", style: styles.message }, note) : null,
        createElement("div", { key: "toolbar", style: callStyles.toolbar }, [
            createElement("div", { key: "range", className: "omkt-call-ranges", style: { display: "flex", alignItems: "center", gap: 3, padding: 2, borderRadius: 14, border: `1px solid ${T.line}`, background: T.cardBg } },
                CALL_RANGES.map(([id, label]) => createElement("button", { key: id, type: "button", style: { ...callStyles.chip, border: 0, padding: "5px 13px", fontWeight: range === id ? 600 : 500, ...(range === id ? { background: T.brand, color: "#fff" } : {}) }, "aria-pressed": range === id, onClick: () => { onRange(id); resetView(); } }, label))),
            !isMcp ? createElement("select", { key: "merge", className: "omkt-select", style: styles.select, value: merge ?? "", "aria-label": "合并命令引用", onChange: event => { onMerge(Number(event.target.value)); resetView(); } }, [
                merge == null ? createElement("option", { key: "loading", value: "", disabled: true }, "读取合并设置…") : null,
                ...CALL_MERGES.map(([id, label]) => createElement("option", { key: id, value: id }, id ? `合并 ${label}钟` : "不合并")),
            ]) : null,
            createElement(SearchField, { key: "search", value: query ?? "", onChange: value => { onQuery(value); resetView(); }, label: "搜索调用记录", placeholder: isMcp ? "搜索工具或会话…" : "搜索 Skill 或会话…", style: { flex: "1 1 220px", height: 38 } }),
            createElement("select", { key: "eventFilter", className: "omkt-select omkt-call-kind", style: styles.select, value: selectedMode, "aria-label": isMcp ? "按调用状态筛选" : "按事件类型筛选", onChange: event => resetView({ mode: event.target.value }) }, (
                isMcp ? [["all", "全部状态"], ["ok", "成功"], ["fail", "失败"], ["running", "执行中"], ["lost", "无结果"]]
                    : [["all", "全部事件"], ["load", "工具加载"], ["reference", "命令引用"], ["fail", "加载失败"]]
            ).map(([value, label]) => createElement("option", { key: value, value }, label))),
            createElement("select", { key: "resourceFilter", className: "omkt-select omkt-callfilter", style: styles.select, value: filter, "aria-label": isMcp ? "按连接器筛选调用" : "按 Skill 筛选事件", onChange: event => chooseFilter(event.target.value) }, [
                createElement("option", { key: "all", value: "" }, isMcp ? "全部连接器" : "全部 Skill"),
                ...rail.map((item) => createElement("option", { key: item.id, value: item.id }, item.name ?? item.id)),
                filter && !rail.some((item) => item.id === filter) ? createElement("option", { key: "current", value: filter }, filter) : null,
            ]),
        ]),
        createElement("div", { key: "layout", className: "omkt-calllayout", style: { ...callStyles.layout, alignItems: shown.length ? "stretch" : "flex-start" } }, [
            rail.length ? createElement("div", { key: "rail", className: "omkt-callrail", style: { ...callStyles.rail, flexBasis: isMcp ? 246 : 224, borderRadius: 12, background: T.cardBg, boxShadow: "none" } }, [
                createElement("div", { key: "heading", style: callStyles.railHead }, [createElement("strong", { key: "label" }, isMcp ? "连接器" : "Skill"), createElement("span", { key: "scope", style: { fontSize: 12, color: T.text3 } }, rangeLabel)]),
                railItem("", "全部", data?.stats?.inRange ?? 0),
                ...rail.map((item) => railItem(item.id, item.name ?? item.id, item.total ?? 0)),
            ]) : null,
            createElement("div", { key: "scroll", "data-omkt": "scroller", style: { ...callStyles.scroll, border: `1px solid ${T.line}`, borderRadius: 12, background: T.cardBg } }, [
                shown.length ? createElement("div", { key: "header", className: isMcp ? "omkt-callrow" : "omkt-callrow omkt-callrow-skill", style: { padding: "7px 12px", fontSize: 15, fontWeight: 500, color: T.text2, background: "rgba(114,130,167,.075)" } }, [
                    createElement("span", { key: "time" }, "时间"), createElement("span", { key: "tool" }, isMcp ? "工具 / 会话" : "Skill / 会话"), !isMcp ? createElement("span", { key: "type", className: "omkt-eventtype" }, "事件类型") : null, createElement("span", { key: "status" }, "状态"), createElement("span", { key: "duration", className: "omkt-callduration" }, "耗时"), createElement("span", { key: "spacer", className: "omkt-callspacer" }),
                ]) : null,
                busy && !rows.length ? createElement("div", { key: "loading", style: { ...styles.message, padding: 30 } }, "正在读取本机调用记录…")
                    : visible.length ? visible.map(row => createElement(CallCard, { key: row.id, row, open: selected === row, onToggle: () => selectRow(row) }))
                        : createElement("div", { key: "empty", style: { ...callStyles.empty, border: 0, padding: "40px 20px" } }, [
                            createElement("div", { key: "icon" }, callWave()),
                            createElement("div", { key: "title", style: callStyles.emptyTitle }, error ? "读取调用记录失败" : needle ? "没有匹配的调用记录" : selectedMode !== "all" || filter ? "当前筛选下没有记录" : "这段时间还没有调用"),
                            createElement("div", { key: "hint", style: callStyles.emptyHint }, error ? "上方显示了错误原因，可切换时间范围重试。" : needle || selectedMode !== "all" || filter ? "调整搜索词或清除筛选，查看其他记录。" : "可扩大时间范围，或在对话中使用已注册的连接器和 Skill。"),
                            createElement("button", { key: "action", type: "button", style: styles.button, onClick: () => {
                                if (needle || selectedMode !== "all" || filter) { onQuery(""); chooseFilter(""); resetView({ mode: "all" }); }
                                else onRange(range === "7d" ? "24h" : "7d");
                            } }, needle ? "清空搜索" : selectedMode !== "all" || filter ? "清除筛选" : range === "7d" ? "查看近 24 小时" : "查看近 7 天"),
                        ]),
                isMcp && selected ? createElement(CallDetail, { key: "detail", row: selected, onClose: () => selectRow(selected), onDiagnostics }) : null,
                isMcp && shown.length ? createElement("div", { key: "footer", style: { ...styles.toolbar, justifyContent: "space-between", borderTop: `1px solid ${T.line2}`, padding: "7px 14px", fontSize: 14, color: T.text3 } }, [
                    createElement("span", { key: "note" }, `显示 ${visible.length} 条 · 共 ${shown.length} 条 · ${rangeLabel}${rows.length >= 300 ? " · 最近 300 条范围内" : ""}`),
                    visible.length < shown.length ? createElement("button", { key: "more", type: "button", style: { ...styles.textBtn, color: T.brand }, onClick: () => onView({ limit: view.limit + 5 }) }, "加载更多") : null,
                ]) : null,
            ]),
        ]),
        !isMcp && shown.length ? createElement(PageFooter, { key: "pager", page, pageCount, onPage: next => onView({ page: next, id: null }), note: `显示 ${page * 6 + 1}–${page * 6 + visible.length} 条 · 共 ${shown.length} 条${rows.length >= 300 ? " · 最近 300 条范围内" : ""}` }) : null,
    ]);
}

		function SkillRemoveDialog({ skill, rootLabel, busy, onCancel, onConfirm }) {
			useEffect(() => {
				const onKey = (event) => { if (event.key === "Escape") onCancel(); };
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onCancel]);
			if (!skill) return null;
			const foreign = skill.root !== "plugin";
			return createElement("div", {
				style: styles.dialogScrim,
				onClick: (event) => { if (event.target === event.currentTarget) onCancel(); },
			}, [
				createElement("div", {
					key: "b", role: "dialog", "aria-label": `移除 skill ${skill.name}`,
					style: styles.dialogBox,
				}, [
					createElement("div", { key: "h", style: styles.dialogHead }, `移除 ${skill.name}？`),
					createElement("div", { key: "d", style: styles.dialogBody }, [
						createElement("div", { key: "w", style: styles.dialogLine },
							"只移动，不删除：这个目录会被搬到本插件的回收目录（$DSH_HOME/overall-mcp/skills-trash/），之后可以自己搬回来。"),
						createElement("div", { key: "p", style: styles.dialogLine },
							[rootLabel ? `${rootLabel} · ` : "", skill.dir ?? ""].join("")),
						foreign
							? createElement("div", { key: "f", style: styles.dialogLine },
								"这个目录属于另一个工具（不是本插件建的），所以这里只做移动。")
							: null,
						createElement("div", { key: "t", style: styles.dialogLine },
							"会话里的 skill 在启动时加载，移完要重启 DSH 才会消失。"),
					]),
					createElement("div", { key: "f", style: styles.dialogFoot }, [
						createElement("button", {
							key: "c", type: "button", className: "omkt-btn omkt-btn-outline",
							style: styles.textBtn, onClick: onCancel,
						}, "取消"),
						createElement("button", {
							key: "o", type: "button", className: "omkt-btn omkt-btn-outline",
							style: { ...styles.textBtn, ...styles.dangerBtn }, disabled: busy,
							onClick: onConfirm,
						}, busy ? "正在移动…" : "移到回收目录"),
					]),
				]),
			]);
		}
		/** Guard against a host that predates `rootLabel` on the row. */
		function sill(value) {
			return typeof value === "string" ? value : "";
		}

		/** The root label for a skill row, read from the scan's own root list. */
		function rootLabelOf(data, root) {
			const group = (Array.isArray(data?.roots) ? data.roots : []).find((row) => row.id === root);
			return sill(group?.label);
		}

		// Collapsible per-root block. A machine with four roots and hundreds of
		// skills has to be able to fold the ones it is not looking at, so the header
		// is the control and the body is simply absent while folded.

        function SkillPanel({ data, error, busy, query, onQuery, root, onRoot, onOpen, onReveal, onRemove, onRefresh, view, onView }) {
            const scrollRef = useRef(null);
            const pageSize = view.pageSize ?? 20;
            const roots = Array.isArray(data?.roots) ? data.roots : [];
            const skills = Array.isArray(data?.skills) ? data.skills : [];
            const needle = String(query ?? "").trim().toLowerCase();
            const total = data?.totals?.count ?? skills.length;
            const shown = skills.filter(skill => (!root || skill.root === root)
                && (!needle || `${skill.name} ${skill.description ?? ""} ${skill.origin ?? ""}`.toLowerCase().includes(needle)))
                .sort((a, b) => (view.order === "desc" ? -1 : 1) * String(a.name).localeCompare(String(b.name)));
            const pageCount = Math.max(1, Math.ceil(shown.length / pageSize));
            const page = Math.min(view.page, pageCount - 1);
            const start = page * pageSize;
            const rows = shown.slice(start, start + pageSize);
            const setPage = page => { onView({ page }); scrollRef.current?.scrollTo({ top: 0 }); };
            const setPageSize = pageSize => { onView({ pageSize, page: 0 }); scrollRef.current?.scrollTo({ top: 0 }); };
            const changeRoot = next => { onRoot(next); setPage(0); };
            const firstIndex = new Map();
            shown.forEach((skill, index) => {
                const letter = skill.name.trim().slice(0, 1).toUpperCase();
                if (!firstIndex.has(letter)) firstIndex.set(letter, index);
            });
            const directoryErrors = roots.filter(group => group.error && group.error !== "missing");
            return createElement("div", { style: { ...styles.skillPanel, flex: "1 1 auto", minHeight: 0 } }, [
                createElement("div", { key: "header", style: styles.regHeader }, [
                    createElement(PageHeading, { key: "heading", title: "已注册 Skill", hint: "浏览本机技能与来源", actions: [
                        createElement("button", { key: "refresh", type: "button", className: "omkt-btn", style: { ...styles.textBtn, color: T.brand }, disabled: busy, onClick: onRefresh }, busy ? "扫描中…" : "重新扫描"),
                        createElement("button", { key: "directories", type: "button", style: { ...styles.button, display: "inline-flex", gap: 8, alignItems: "center" }, "aria-expanded": view.directories, onClick: () => onView({ directories: !view.directories }) }, [createElement(UiIcon, { key: "icon", name: "folder" }), "技能目录"]),
                    ] }),
                    data ? createElement("div", { key: "stats", style: styles.stats }, `${total} 个 Skill　 ${roots.length} 个来源　 ${data.duplicates ? `已合并 ${data.duplicates} 个重复副本` : ""}`) : null,
                    createElement("div", { key: "hint", style: { ...styles.skillHint, padding: "9px 16px", gap: 10, borderRadius: 10, background: "rgba(69,102,233,.06)", border: `1px solid ${T.line}`, fontSize: 15 } }, [createElement(UiIcon, { key: "icon", name: "info" }), "Skill 在新会话启动时加载；新增或移除后需重启 DSH。"]),
                    createElement("div", { key: "filters", className: "omkt-reg-filters", style: styles.toolbar }, [
                        createElement(SearchField, { key: "search", value: query, onChange: value => { onQuery(value); setPage(0); }, label: "搜索 skill", placeholder: "搜索 Skill 名称或用途…", style: { flex: "1 1 240px" } }),
                        createElement("select", { key: "source", className: "omkt-select", style: styles.select, value: root, "aria-label": "按来源筛选 skill", onChange: event => changeRoot(event.target.value) }, [
                            createElement("option", { key: "all", value: "" }, "全部来源"),
                            ...roots.map(group => createElement("option", { key: group.id, value: group.id }, `${group.label}（${group.found ?? group.count}）`)),
                        ]),
                        createElement("select", { key: "order", className: "omkt-select", style: styles.select, value: view.order, "aria-label": "Skill 排序", onChange: event => onView({ order: event.target.value, page: 0 }) }, [
                            createElement("option", { key: "asc", value: "asc" }, "名称 A–Z"),
                            createElement("option", { key: "desc", value: "desc" }, "名称 Z–A"),
                        ]),
                    ]),
                    createElement("div", { key: "sources", style: styles.toolbar }, [
                        createElement("button", { key: "all", type: "button", style: { ...styles.sourceMiniBtn, fontSize: 15, borderRadius: 18, padding: "4px 16px", ...(!root ? { background: MCP_SOFT, color: T.brand } : {}) }, "aria-pressed": !root, onClick: () => changeRoot("") }, `全部 ${total}`),
                        ...roots.slice().sort((a,b) => Number(a.id === "plugin") - Number(b.id === "plugin")).map(group => createElement("button", { key: group.id, type: "button", style: { ...styles.sourceMiniBtn, fontSize: 15, borderRadius: 18, padding: "4px 16px", ...(root === group.id ? { background: MCP_SOFT, color: T.brand } : {}) }, "aria-pressed": root === group.id, onClick: () => changeRoot(group.id) }, `${group.label} ${group.found ?? group.count ?? 0}`)),
                    ]),
                ]),
                error ? createElement("div", { key: "error", role: "alert", style: styles.error }, error) : null,
                !data ? createElement("div", { key: "loading", style: styles.emptyBox }, busy ? "正在扫描 Skill 目录…" : "还没有读到 Skill 目录。") : null,
                createElement("div", { key: "scroll", ref: scrollRef, "data-omkt": "scroller", style: styles.regScroll }, [
                    (view.directories || directoryErrors.length) ? createElement("div", { key: "source-details", style: { ...styles.sourceBox, display: "grid", gap: 6, marginBottom: 12 } },
                        (view.directories ? roots : directoryErrors).map(group => createElement("div", { key: group.id, role: group.error && group.error !== "missing" ? "alert" : undefined, style: { ...styles.sectionHint, overflowWrap: "anywhere" } }, [
                            createElement("strong", { key: "label" }, group.label),
                            ` · ${group.dir || "未报告目录"}${group.error === "missing" ? " · 目录尚未创建" : group.error ? ` · 读取失败：${group.error}` : ""}${group.folded > 0 ? ` · ${group.folded} 个重复副本已折叠` : ""}`,
                        ]))) : null,
                    shown.length ? createElement("div", { key: "list-layout", style: { display: "flex", gap: 14, alignItems: "flex-start" } }, [
                        createElement("div", { key: "list", className: "omkt-skill-list", style: { flex: "1 1 auto", minWidth: 0 } }, [createElement(RegistryColumns, { key: "columns", skill: true }), ...rows.map(skill => createElement(SkillCard, { key: `${skill.root}:${skill.dir}`, skill, rootLabel: rootLabelOf(data, skill.root), busy, onOpen, onReveal, onRemove }))]),
                        createElement("nav", { key: "letters", className: "omkt-skill-alphabet", "aria-label": "按字母跳转" }, Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ").map(letter => createElement("button", {
                            key: letter, type: "button", disabled: !firstIndex.has(letter), title: `跳转到 ${letter}`, style: { ...styles.textBtn, padding: 0, minWidth: 20, height: 16, fontSize: 11, lineHeight: 1 }, onClick: () => {
                                const index = firstIndex.get(letter);
                                setPage(Math.floor(index / pageSize));
                            },
                        }, letter))),
                    ]) : data ? createElement("div", { key: "empty", style: styles.emptyBox }, needle ? "没有匹配的 Skill。" : "当前来源没有独有的 Skill。") : null,
                ]),
                data ? createElement(PageFooter, { key: "pager", page, pageCount, pageSize, onPageSize: setPageSize, onPage: setPage, note: rows.length ? `显示 ${start + 1}–${start + rows.length} 项，共 ${shown.length} 项` : "显示 0 项" }) : null,
            ]);
        }

		// Space classes remain selection hooks for theme, keyboard and layout checks.
const spaceClasses = (base, which) => `${base} ${base}-${which}`;
function Section({ close }) {
			ensureStyles();
			const [tab, setTab] = useState("registry");

			// ---- calls tab state ----
			// The badge must show today's count before the tab is ever opened, so
			// each space keeps its own number, read on its own.
			const [callBadges, setCallBadges] = useState({ mcp: null, skill: null });
			const [calls, setCalls] = useState(null);
			const [callsBusy, setCallsBusy] = useState(false);
			const [callsError, setCallsError] = useState("");
			const [callsNote, setCallsNote] = useState("");
			const [callRange, setCallRange] = useState("24h");
            const [callView, setCallView] = useState(CALL_VIEW_DEFAULT);
            const callsRequest = useRef(0);
			// null until the host says what it is folding with (or the reader picks).
			const [callMergeChoice, setCallMergeChoice] = useState(null);
			const callMerge = callMergeChoice ?? (Number.isFinite(calls?.merge) ? calls.merge : null);
			const [callQuery, setCallQuery] = useState("");
			const [callFilter, setCallFilter] = useState("");

			// ---- registry tab state ----
			const [servers, setServers] = useState(null);
			// 注册表文件读不出来时由宿主带回来的原因（见 index.js
			// readRegistryDocument）：列表会是空的，没有这句话就和「你从没加过
			// 服务器」长得一样。
			const [registryError, setRegistryError] = useState("");
			const [busy, setBusy] = useState(false);
			// Which rows have a 检查 in flight. Per row, not global: one slow
			// handshake must not freeze the rest of the list, and the row's button
			// has to say 检查中… for as long as this list contains it.
			const [checkingKeys, setCheckingKeys] = useState([]);
			// The row whose 「配置」 is asking its source what it takes. One at a
			// time is the honest model: the sheet is a single place, and each ask
			// is a request to a third party.
			const [configHintKey, setConfigHintKey] = useState(null);
			const [error, setError] = useState("");
			const [message, setMessage] = useState("");
			// A mount failure is its own block, not a one-line error: it carries
			// the host's raw reason, the model's explanation (when the host could
			// ask one), and what to do next — text that needs to survive the next
			// render without being overwritten by the next success message.
			const [installFailure, setInstallFailure] = useState("");
			// 用途说明的译文，键是「语言 + 原句」（见 localizeRows）。空对象就表示
			// 一行都还没翻，行上显示服务器原本的措辞。
			const [aboutI18n, setAboutI18n] = useState({});
			const [sourceFilter, setSourceFilter] = useState("");
			const [stateFilter, setStateFilter] = useState("");
			const [nameFilter, setNameFilter] = useState("");
			const [collapsed, setCollapsed] = useState(() => new Set());
            const [groupBySource, setGroupBySource] = useState(false);
            const [registryView, setRegistryView] = useState({ page: 0, pageSize: 20 });
            const registryScroll = useRef(null);
			// The row whose config sheet is open, if any. A row object rather than
			// a name: two rows can share a name, and the sheet must edit the one
			// that was clicked.
			const [configTarget, setConfigTarget] = useState(null);
			// The market card whose install is running, by item id. Deliberately
			// not the page-level `busy`: an install is one row's work (npx has to
			// fetch the package), and disabling every other card's button during
			// it made the whole market look frozen — the user's second install
			// just waited on a spinner nobody asked for.
			const [installingKey, setInstallingKey] = useState(null);
			// What this client is installing right now. `installingKey` drives the
			// spinner; this guards the click: a second click while the first POST is
			// in flight used to start a second install and overwrite the key, so the
			// spinner of the first was never shown again.
			const installingRef = useRef(null);

			// ---- market tab state ----
			const [market, setMarket] = useState(null);
			const [marketBusy, setMarketBusy] = useState(false);
			const [marketError, setMarketError] = useState("");
			const [marketQuery, setMarketQuery] = useState("");
			const [marketAppliedQuery, setMarketAppliedQuery] = useState("");
			const marketRequest = useRef({ id: 0, filters: { query: "", source: "" } });
			const [marketSource, setMarketSource] = useState("");
			const [marketAt, setMarketAt] = useState("");
			// ---- user-added catalogue sources ----
			// The five built-in sources are compiled in; these are the ones the
			// user points at (`$DSH_HOME/overall-mcp/sources.json`). `null` means
			// "not asked yet", and `sourcesMissing` records a host bundle that
			// predates the route, so the page can say which one it is talking to
			// instead of showing an empty list as if nothing was configured.
			const [catalogSources, setCatalogSources] = useState(null);
			const [sourcesMissing, setSourcesMissing] = useState(false);
			const [sourcesOpen, setSourcesOpen] = useState(false);
            const [catalogDetailsOpen, setCatalogDetailsOpen] = useState(false);
			const [sourceDraft, setSourceDraft] = useState("");
			const [sourceBusy, setSourceBusy] = useState(false);
			const [sourceNote, setSourceNote] = useState("");
			const [repoStats, setRepoStats] = useState({});
            const statsRequests = useRef(new Map());
            const mediaRequests = useRef(new Map());
            const statsBatch = useRef(0);
            const metricRefreshStamp = useRef(new Map());
            const [statsBusy, setStatsBusy] = useState(false);
            const [skillMetricNote, setSkillMetricNote] = useState("");
            const skillMetricRequest = useRef(0);
			const [repoMedia, setRepoMedia] = useState({});
			// Repos whose picture lookup failed. Kept separately because a failed
			// repo does get an empty media entry (the strip must render), so
			// "no images" and "could not ask" would otherwise look identical.
			const [mediaFailures, setMediaFailures] = useState([]);
			const [starNote, setStarNote] = useState("");
			const [marketSort, setMarketSort] = useState("default");
			const [marketGroup, setMarketGroup] = useState("");
			// 「仅看收藏」: a view filter over the loaded listing, plus the host's
			// own total so the page can say when the filter is hiding entries
			// rather than the set being empty. `favTotal` stays null until asked —
			// one small request, only when the user turns the filter on.
			const [favOnly, setFavOnly] = useState(false);
			const [favTotal, setFavTotal] = useState(null);
			const [marketPage, setMarketPage] = useState(0);
			const [pageSize, setPageSize] = useState(20);
			const [detail, setDetail] = useState(null);
			// The plugin's own update state, filled by 检查更新 (see
			// `doCheckUpdates`). `null` means "not asked yet", which is why the
			// head shows no update button on a fresh page.
			const [selfUpdate, setSelfUpdate] = useState(null);
			// ---- update queue ----
			// One queue for every update this page can start: a row's 「更新」 and
			// 「全部更新」 run through the same runner below. `null` means "nothing
			// has been updated yet in this session"; after a run the queue stays
			// put, held at its final state, because the outcome is what the user
			// came back to read. There is no percentage here and there cannot be
			// one: the host answers a single /update request only when the whole
			// rewrite-and-reconnect cycle is done, so the page reports the two
			// things it does know — how many items are finished, and which one is
			// running.
			const [updateJobs, setUpdateJobs] = useState(null);
			// The queue's answers outlive its progress panel. 关闭进度 puts the
			// panel away; it does not un-answer the entries the run settled, so
			// the batch count and the rows keep agreeing with the run instead of
			// falling back to a listing that may still carry the badge the run
			// was started from. A fresh answer (or a newer release) supersedes
			// the old one.
			const [updateAnswers, setUpdateAnswers] = useState({});
			const [jobsOpen, setJobsOpen] = useState(false);
			// Re-rendered about once a second while a queue runs, so the elapsed
			// time in the bar moves.
			const [clockMs, setClockMs] = useState(0);
			// A queue owns the registry file and the mcp-client fibers while it
			// runs. `busy` disables the buttons on the next render, but a double
			// click lands before that render — this ref is the guard that makes
			// "one writer at a time" true at click time rather than paint time.
			const updateRunRef = useRef(false);
			// The same guard for row actions and checks: a double click on 停用 or
			// 检查 lands before the disabled attribute is painted, and two writes
			// would race each other in the host.
			const actionRef = useRef(false);
			const checkRef = useRef(false);
			const pageRef = useRef(null);
            useEffect(() => {
                if (tab === "calls" && callView.id) pageRef.current?.querySelector(".omkt-call-detail")?.scrollIntoView({ block: "nearest" });
            }, [tab, callView.id]);
			const scrollerRef = useRef(null);
			const [showTop, setShowTop] = useState(false);

			// ---- the skill space --------------------------------------------
			// MCP and Skill are peers on one page: `space` is which one is on
			// screen, and the tab underneath (registered / market) keeps its own
			// value per space so flipping between them does not move the user.
			const [space, setSpace] = useState("mcp");
			const [skills, setSkills] = useState(null);
			const [skillsError, setSkillsError] = useState("");
			const [skillsBusy, setSkillsBusy] = useState(false);
			const [skillQuery, setSkillQuery] = useState("");
			const [skillRoot, setSkillRoot] = useState("");
            const [skillRegistryView, setSkillRegistryView] = useState({ page: 0, pageSize: 20, order: "asc", directories: false });
			const [skillTarget, setSkillTarget] = useState(null);
			const [skillNote, setSkillNote] = useState("");
			// The skill whose removal is being confirmed. A row object, not an id:
			// the sheet has to name the directory, and the list can be re-read
			// between the click and the confirmation.
			const [skillRemove, setSkillRemove] = useState(null);
			const [skillRemoving, setSkillRemoving] = useState(false);
			const [skillMarket, setSkillMarket] = useState(null);
			const [skillMarketError, setSkillMarketError] = useState("");
			const [skillMarketBusy, setSkillMarketBusy] = useState(false);
			const [skillMarketQuery, setSkillMarketQuery] = useState("");
            const [skillMarketSort, setSkillMarketSort] = useState("default");
			const [skillMarketSource, setSkillMarketSource] = useState("all");
			const [skillMarketCategory, setSkillMarketCategory] = useState("all");
			const skillMarketRequest = useRef({ id: 0, filters: { query: "", source: "all", category: "all", sort: "default", limit: 20, offset: 0 } });
			const [skillMarketAppliedQuery, setSkillMarketAppliedQuery] = useState("");
		// Market paging lives here rather than inside SkillMarket: that component is
		// rendered as a child element, and a hook declared there would be attributed
		// to the enclosing frame.
		const [skillMarketPage, setSkillMarketPage] = useState(0);
		const [skillMarketPageSize, setSkillMarketPageSize] = useState(20);
			const [skillMarketInstalling, setSkillMarketInstalling] = useState("");
			const skillsRequest = useRef(0);
            const skillMarketInstalled = useMemo(() => skills?.installedMarketIds ?? (skills?.skills ?? []).map(row => row.marketId).filter(Boolean), [skills]);
			const [skillWalkBusy, setSkillWalkBusy] = useState(false);
			// Which sources the next walk should take to the end. Empty = every
			// source on its slice, i.e. the 19.8k default.
			const [skillFullSel, setSkillFullSel] = useState([]);
			// Before the user touches a chip, the *recorded* modes are the
			// selection: a full crawl already on disk must not be silently
			// downgraded to a slice walk by the next 收录 click — that walk resets
			// the cursor and trims the file back to the slice cap.
			const skillFullTouched = useRef(false);
			// The GitHub access box starts folded; `ghAccessPinned` is what the
			// header's own toggle writes. A running census or recovery walk opens it
			// regardless (derived below), so progress is never hidden.
			const [ghAccessPinned, setGhAccessPinned] = useState(false);
			// ---- what this page is running, and what it has been doing ----
			// Both answers come from the host, not from this bundle:
			// `CLIENT_VERSION` is a literal compiled into the page, so it can only
			// say what the page *is* — never whether the code on disk has moved
			// ahead of the process serving it. That difference is not academic:
			// after the 2026-10-16 fixes the panel still reported a source as
			// unavailable, because DSH had been up since before the fix and
			// nothing on screen could say so.
			const [hostStatus, setHostStatus] = useState(null);
			const [statusError, setStatusError] = useState("");
			const [eventLog, setEventLog] = useState(null);
			const [logOpen, setLogOpen] = useState(false);
			const [logBusy, setLogBusy] = useState(false);
			// The GitHub credential. Held as a draft here and nowhere else: the
			// page never reads the token back from the host (it cannot — only a
			// mask comes back), so the box is empty until somebody types into it.
			const [authBusy, setAuthBusy] = useState(false);
			// Set when a detection came back empty-handed: from then on the same
			// spot offers the path that always works (create a token on the web)
			// instead of repeating a verb that just failed.
			const [webLogin, setWebLogin] = useState(false);
			const [authDraft, setAuthDraft] = useState("");
			const [authNote, setAuthNote] = useState("");

			// The servers the host's last 检查更新 marked as updatable. Derived
			// rather than stored, and derived from the *listing* rather than from
			// the queue: the page refreshes the registry after every update, so
			// the batch always acts on what is actually updatable right now and
			// never re-runs an entry it just upgraded.
			//
			// A row is identified by its slot in the registry, not by its name:
			// one client config can contribute the same server name more than once
			// (that is a registry problem, not this panel's), and updating the row
			// somebody clicked must not act on its twin. `slot ?? name` keeps the
			// old name-keyed behaviour against a host that does not publish slots.
			const updatable = useMemo(
				() => (servers ?? [])
					.filter((s) => s.update?.updateAvailable)
					.map((s) => ({
						key: rowKey(s),
						name: s.name,
						slot: s.slot ?? null,
						from: s.update?.current ?? null,
					})),
				[servers],
			);

			// 已用时 only has to move once a second, and only while something is
			// running. `requestAnimationFrame` is the ticker because it is the
			// one timer a headless render host does not have: the guard means a
			// probe or SSR pass never starts a loop it cannot clean up.
			useEffect(() => {
				if (!updateJobs?.running) return undefined;
				if (typeof requestAnimationFrame !== "function") return undefined;
				// A new queue starts its own clock. `clockMs` still holds the tick of
				// the previous run until the first frame lands, and the bar's very
				// first paint read that number — 已用时 jumped to the last run's
				// total for one frame, or for the whole run where rAF is missing.
				setClockMs((prev) => (prev >= updateJobs.startedAt ? prev : updateJobs.startedAt));
				let id = 0;
				const step = () => {
					const now = Date.now();
					setClockMs((prev) => (
						Math.floor(now / 1000) === Math.floor((prev || updateJobs.startedAt) / 1000) ? prev : now
					));
					id = requestAnimationFrame(step);
				};
				id = requestAnimationFrame(step);
				return () => { if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(id); };
			}, [updateJobs]);

			async function refresh() {
				const body = await api("/servers");
				// Anything but an array here (an `{ error }` body answered with 200, a
				// route that changed shape) used to reach `.map()` on the next render
				// and blank the page. The list is the page's spine: keep it an array.
				setServers(keepSessionHealth(Array.isArray(body?.servers) ? body.servers : []));
				setRegistryError(typeof body.registryError === "string" ? body.registryError : "");
				return body.servers;
			}

			/**
			 * The skill space's list.
			 *
			 * Read on demand: three directories and ~400 frontmatters take a
			 * quarter second on a warm disk — fine for a space the user just
			 * switched to, wrong for every page load. `refresh` also asks the
			 * host to skip its own one-minute cache.
			 */
            async function loadSkills({ refresh: force = false } = {}) {
                const id = ++skillsRequest.current;
                setSkillsBusy(true);
                try {
                    const body = await api(`/skills${force ? "?refresh=1" : ""}`, { method: "GET" });
                    if (id !== skillsRequest.current) return;
                    if (!Array.isArray(body?.skills)) throw new Error("技能列表响应缺少 skills 数组");
                    setSkills(body);
                    setSkillsError("");
                } catch (err) {
                    if (id !== skillsRequest.current) return;
                    setSkillsError(String(err.message || err));
                    throw err;
                } finally {
                    if (id === skillsRequest.current) setSkillsBusy(false);
                }
            }

			/**
			 * Read the skill market.
			 *
			 * Four upstreams are asked at once and each answers for itself: a dead
			 * one comes back as that source's `error` while the others still list.
			 */
			async function loadSkillMarket({ refresh = false, ...over } = {}) {
				const state = skillMarketRequest.current;
				const id = ++state.id;
				const filters = state.filters = { ...state.filters, ...over };
				setSkillMarketBusy(true);
				setSkillMarketError("");
				try {
					const initial = id === 1 && !refresh && !Object.keys(over).length;
					const body = await api("/skills/market", initial ? { method: "GET" } : {
						method: "POST", body: JSON.stringify({ ...filters, refresh }),
					});
					if (id !== state.id) return;
					if (!Array.isArray(body?.items)) throw new Error("Skill 市场返回了无效的列表");
					if (body.paging) {
						state.filters = { ...filters, offset: body.paging.offset };
						setSkillMarketPage(Math.floor(body.paging.offset / body.paging.limit));
					}
					setSkillMarket(body);
                    void enrichSkillMetrics(body.items, refresh, id);
					setSkillMarketAppliedQuery(filters.query);
					if (!skillFullTouched.current) {
						const recorded = body.index?.modes ?? {};
						setSkillFullSel(Object.keys(recorded).filter(id => recorded[id] === "full"));
					}
				} catch (err) {
					if (id === state.id) setSkillMarketError(String(err.message || err));
				} finally {
					if (id === state.id) setSkillMarketBusy(false);
				}
			}

			/**
			 * Start or stop the local index walk.
			 *
			 * The walk runs in the host and can last minutes, so this only sends
			 * the verb and then re-reads. Progress comes back with the next market
			 * payload (`walk`) and the next `/status` (`skillIndex`), not from a
			 * timer here — a timer would keep asking even when a page is idle.
			 */
			async function skillIndexAction(action, full) {
				setSkillWalkBusy(true);
				setSkillMarketError("");
				try {
					await api("/skills/market/walk", {
						method: "POST",
						// `full` is the whole selection, not a diff: a source left out
						// keeps its slice, so the body always says what "收录" means
						// this time.
						body: JSON.stringify({ action, full: Array.isArray(full) ? full : skillFullSel }),
						timeoutMs: 15000,
					});
					await loadStatus();
					await loadSkillMarket({ refresh: true });
				} catch (err) {
					setSkillMarketError(String(err.message || err));
				} finally {
					setSkillWalkBusy(false);
				}
			}

			/**
			 * Pick which sources a walk should take to the end.
			 *
			 * Per source, because the costs are not comparable: SkillHub in full
			 * is 210k rows and a 200 MB file, ClawHub paces at 3 s per 20 rows and
			 * has no total, GitHub without a star floor is 38,486 repositories.
			 */
			function toggleSkillFull(id) {
				// Once the user has expressed a preference, a refresh must not
				// overwrite it with what the file happened to record.
				skillFullTouched.current = true;
				setSkillFullSel((prev) => (prev.includes(id)
					? prev.filter((entry) => entry !== id)
					: [...prev, id]));
			}

			/**
			 * Install one row the market handed us.
			 *
			 * Only the id travels: the host looks the row up in its own index, so a
			 * crafted body cannot name a different download or a different target.
			 */
			async function doInstallMarket(item) {
				if (!item || skillMarketInstalling) return;
				setSkillMarketInstalling(item.id);
				setSkillNote("");
				try {
					const out = await api("/skills/market/install", {
						method: "POST",
						body: JSON.stringify({ id: item.id, root: "plugin" }),
					});
					if (out?.ok) {
						setSkillNote(`已安装到 ${out.dir ?? ""}（${out.files ?? 0} 个文件）· 重启 DSH 后可用`);
						await loadSkills({ refresh: true }).catch(err => {
                            setSkillNote(`安装已完成，但刷新技能列表失败：${String(err.message || err)}；请重新扫描确认状态`);
                        });
					} else {
						setSkillNote(`安装失败：${out?.error ?? "宿主没有给出原因"}`);
					}
				} catch (err) {
					setSkillNote(`安装失败：${String(err.message || err)}`);
				} finally {
					setSkillMarketInstalling("");
				}
			}

			/** Arrow keys select a space while focus stays on the tab list. */
			function onSpacesKeyDown(event) {
				if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
				if (typeof event.preventDefault === "function") event.preventDefault();
				switchSpace(space === "mcp" ? "skill" : "mcp");
			}

			/** Switching spaces is also the moment the other side is first read. */
			function switchSpace(next) {
				setSpace(next);
				setSkillNote("");
				// A server id and a skill id are two different namespaces: the
				// filter from one space would match nothing in the other, so the
				// feed starts unfiltered rather than looking mysteriously empty.
				setCallFilter("");
				setCallQuery("");
                setCallView(CALL_VIEW_DEFAULT);
				// The resource and the view are independent choices on the same bar.
				if (tab !== "calls") {
					const inMarket = tab === "market" || tab === "skillmarket";
					setTab(next === "mcp" ? (inMarket ? "market" : "registry") : (inMarket ? "skillmarket" : "skillregistry"));
				}
				if (next === "skill" && !skills && !skillsBusy) loadSkills().catch(() => {});
				// The 市场 tab carries a count, so the list has to be asked for
				// before that tab is ever opened — otherwise the number is missing
				// exactly when the tab bar is on screen. The host caches the four
				// upstream lists (60 s – 10 min), so this is one round of list
				// reads per session, not per click.
				if (next === "skill" && skillMarket === null && !skillMarketBusy) {
					loadSkillMarket({}).catch(() => {});
				}
			}

			/**
			 * Hand one scanned folder to the host's file manager.
			 *
			 * The id comes from the scan, never from the page: the host opens
			 * only paths it listed itself, so this cannot become a "launch
			 * anything on this machine" endpoint.
			 */
			async function doRevealSkill(skill) {
				setSkillNote("");
				try {
					const out = await api("/skills/reveal", {
						method: "POST",
						body: JSON.stringify({ id: skill.id ?? skill.name }),
					});
					setSkillNote(out?.ok
						? `已在文件管理器里打开：${out.dir ?? skill.dir ?? ""}`
						: `打开目录失败：${out?.error ?? "宿主没有给出原因"}`);
				} catch (err) {
					setSkillNote(`打开目录失败：${String(err.message || err)}`);
				}
			}

			/**
			 * Move the confirmed skill into the plugin's trash directory.
			 *
			 * `confirm: true` is part of the request, not a UI detail: the host
			 * refuses a bare id, so a stale page cannot move a skill the reader
			 * never saw. The answer names where it went — that path is the only
			 * way back, and it is shown, not just logged.
			 */
			async function confirmRemoveSkill() {
				const skill = skillRemove;
				if (!skill || skillRemoving) return;
				setSkillRemoving(true);
				setSkillNote("");
				try {
					const out = await api("/skills/remove", {
						method: "POST",
						body: JSON.stringify({ id: skill.id ?? skill.name, confirm: true }),
					});
					if (out?.ok) {
						setSkillNote(`已移到回收目录：${out.trashedTo ?? ""}`);
						setSkillRemove(null);
						setSkillTarget(null);
						await loadSkills({ refresh: true }).catch(err => {
                            setSkillNote(`技能已移入回收目录，但刷新列表失败：${String(err.message || err)}；请重新扫描确认状态`);
                        });
					} else {
						setSkillNote(`移除失败：${out?.error ?? "宿主没有给出原因"}`);
					}
				} catch (err) {
					setSkillNote(`移除失败：${String(err.message || err)}`);
				} finally {
					setSkillRemoving(false);
				}
			}

			useEffect(() => {
				refresh().catch((err) => setError(String(err.message || err)));
				loadSources();
				loadStatus();
				// The Skill pill shows how many skills the host found; that number
				// belongs on screen before the user ever clicks over to Skill, so
				// the list is read once up front instead of on first switch.
				loadSkills().catch(() => {});
			}, []);

			// 第一次拿到服务器列表后问一次翻译：一批最多 I18N_MAX_ITEMS 句，宿主机自己
			// 缓存，所以同一句话整台机器只翻一次。失败不弹错误——面板照常显示原文，
			// 「翻译不了」不该比「看清楚这台服务器干什么」更重要。
			useEffect(() => {
				if (!Array.isArray(servers) || servers.length === 0) return;
				const lang = pageLanguage();
				const items = [];
				for (const row of servers) {
					const about = row && row.about;
					if (!about || about.source !== "server" || typeof about.text !== "string") continue;
					if (about.text.trim() === "") continue;
					const key = aboutKey(lang, about.text);
					if (requestedAbout.has(key)) continue;
					requestedAbout.add(key);
					items.push({ name: row.name, text: about.text, source: about.source });
				}
				if (items.length === 0) return;
				api("/about-i18n", { method: "POST", body: JSON.stringify({ lang, items }), timeoutMs: 20000 })
					.then((reply) => {
						const translations = {};
						for (const [name, text] of Object.entries(reply?.translations ?? {})) {
							if (typeof text !== "string" || text === "") continue;
							const source = servers.find((row) => row && row.name === name)?.about?.text;
							if (typeof source === "string") translations[aboutKey(lang, source)] = text;
						}
						if (Object.keys(translations).length > 0) setAboutI18n((prev) => ({ ...prev, ...translations }));
					})
					.catch(() => { /* 保留原文 */ });
			}, [servers]);

			/**
			 * Which build is answering, and with which data files.
			 *
			 * One line of text, not a panel: the page has to stay readable, and
			 * the one fact worth interrupting for — the files on disk are newer
			 * than the running process — is called out on that same line.
			 */
			async function loadStatus() {
				try {
					setHostStatus(await api("/status"));
					setStatusError("");
				} catch (err) {
					const text = String(err.message || err);
					// An older host has no such route. That is a version fact
					// about the host, not a failure of this page, so it is not
					// shown as one.
					setStatusError(text.includes("404") ? "" : text);
				}
			}

			/**
			 * The host's own record of what the plugin did.
			 *
			 * Read on demand rather than with the page: it is the second thing
			 * somebody looks at, not the first, and every other part of this
			 * panel works without it.
			 */
			async function loadEvents() {
				setLogBusy(true);
				try {
					const body = await api("/events");
					setEventLog({
						events: Array.isArray(body.events) ? body.events : [],
						damaged: Number(body.damaged) || 0,
						total: Number(body.total) || 0,
					});
				} catch (err) {
					const text = String(err.message || err);
					// An older host has no such route. That is the same version
					// fact /status reports (and the page already knows how to
					// say it), so it is said inside the log box where the user
					// just looked, rather than as a failure of the whole page —
					// and never as "这次运行还没有记录", which would be a lie
					// about a log nobody could read.
					setEventLog({
						events: [], damaged: 0, total: 0,
						note: text.includes("404")
							? "宿主插件还是旧版本（没有 /api/overall-mcp/events）；重启 DSH 后再看运行日志"
							: `读取运行日志失败：${text}`,
					});
				} finally {
					setLogBusy(false);
				}
			}

			function toggleLog() {
				const next = !logOpen;
				setLogOpen(next);
				if (next) loadEvents();
			}

			/**
			 * Hand the host a GitHub token.
			 *
			 * This is the one place the panel sends a secret, so it sends it once
			 * and forgets it: the box is cleared whether or not GitHub accepted
			 * it, because a rejected token left in the field invites saving it
			 * again. What comes back is a mask, and that is what the panel shows
			 * from then on.
			 */
			async function saveGithubToken() {
				const token = authDraft.trim();
				if (!token || authBusy) return;
				setAuthBusy(true);
				setAuthNote("");
				try {
					const saved = await api("/auth", { method: "POST", body: JSON.stringify({ token }) });
					setAuthDraft("");
					const masked = saved?.masked ? `${saved.masked}` : "该凭据";
					setAuthNote(saved?.error
						? `GitHub 拒绝了它：${saved.error}`
						: `已启用 ${saved?.login ? `${saved.login} 的` : ""}凭据（${masked}）`);
					await loadStatus();
					if (logOpen) loadEvents();
				} catch (err) {
					setAuthNote(`保存失败：${String(err.message || err)}`);
				} finally {
					setAuthBusy(false);
				}
			}

			/**
			 * Ask the host to look for a local `gh` login.
			 *
			 * Spawning that process is a discovery, not a page load, which is why
			 * it is a button and why the route has to be told to do it (`?gh=1`).
			 */
			async function discoverGithubLogin() {
				if (authBusy) return;
				setAuthBusy(true);
				setAuthNote("");
				try {
					const found = await api("/auth?gh=1");
					setAuthNote(found?.inUse
						? `已用本机 gh 登录：${found.login ?? found.masked ?? "已认证"}`
						: found?.note || "本机没有可用的 gh 登录（未安装 gh，或它还没登录）");
					// An empty-handed detection is not a dead end: it is the moment
					// the box should stop offering the verb that just failed and
					// offer the one that cannot fail for lack of a local tool.
					setWebLogin(!found?.inUse);
					await loadStatus();
					if (logOpen) loadEvents();
				} catch (err) {
					setAuthNote(`检测失败：${String(err.message || err)}`);
				} finally {
					setAuthBusy(false);
				}
			}

			/** Remove a stored credential and go back to 60 requests an hour. */
			async function clearGithubToken() {
				if (authBusy) return;
				setAuthBusy(true);
				setAuthNote("");
				try {
					const cleared = await api("/auth", { method: "DELETE" });
					setAuthNote(cleared?.removed ? "已移除本插件保存的 token" : "本插件没有保存过 token");
					await loadStatus();
					if (logOpen) loadEvents();
				} catch (err) {
					setAuthNote(`移除失败：${String(err.message || err)}`);
				} finally {
					setAuthBusy(false);
				}
			}

			/**
			 * Ask for a census now, or end the one running.
			 *
			 * Both verbs existed in the host as side effects and neither was
			 * reachable: a walk only ever started because someone happened to
			 * browse the GitHub source, and once started it paced itself at 6.5s
			 * per request for up to 48 requests with no way to say stop. The
			 * button is the whole feature — the host already knew how to end one
			 * (this file's `dispose` did it), it just had no caller.
			 */
			async function censusAction(action) {
				if (authBusy) return;
				setAuthBusy(true);
				try {
					const state = await api("/census", { method: "POST", body: JSON.stringify({ action }), timeoutMs: 15000 });
					if (action === "stop") {
						setAuthNote(state?.stopping ? "正在停止普查…" : "没有在跑的普查");
					} else if (state?.started) {
						setAuthNote("普查已开始，每 6.5 秒读一个仓库");
					} else if (state?.skipped === "quota") {
						setAuthNote(`搜索额度还没恢复，约 ${Math.ceil((state.waitMs ?? 0) / 1000)} 秒后再试`);
					} else {
						setAuthNote("普查已经在跑了");
					}
					await loadStatus();
					if (logOpen) loadEvents();
				} catch (err) {
					setAuthNote(`普查操作失败：${String(err.message || err)}`);
				} finally {
					setAuthBusy(false);
				}
			}

			/**
			 * Ask the host to carry the install-command recovery on, or to end
			 * the pass running.
			 *
			 * The walk reads a repository's manifest files to turn a GitHub row
			 * into a row with a runnable command; it is the longest thing this
			 * plugin does (150ms between rows, up to 25 minutes and 6000 requests
			 * per pass), and until this function existed the only way to end one
			 * was to unload the plugin — the `dispose` path aborted it, no caller
			 * did.
			 */
			async function evidenceAction(action) {
				if (authBusy) return;
				setAuthBusy(true);
				try {
					const state = await api("/install-evidence", {
						method: "POST", body: JSON.stringify({ action }), timeoutMs: 15000,
					});
					if (action === "stop") {
						setAuthNote(state?.stopping ? "正在停止恢复安装命令…" : "没有在跑的恢复");
					} else if (state?.started) {
						setAuthNote("开始恢复安装命令，每个仓库 0.15 秒");
					} else if (state?.skipped === "no-census") {
						setAuthNote("还没有普查索引，先做一次普查");
					} else if (state?.skipped === "nothing-to-do") {
						setAuthNote("没有需要补的仓库了");
					} else {
						setAuthNote("恢复已经在跑了");
					}
					await loadStatus();
					if (logOpen) loadEvents();
				} catch (err) {
					setAuthNote(`恢复安装命令失败：${String(err.message || err)}`);
				} finally {
					setAuthBusy(false);
				}
			}

			/**
			 * One line per event, in the order a person reads it: when, what kind
			 * of thing, then only the fields that kind actually carries.
			 *
			 * A generic JSON dump was the alternative and it is worse here — the
			 * log is scanned for the one line that says why, and a wall of braces
			 * is how that line stays hidden. Every field is read defensively: an
			 * old line written by a newer plugin version must not break the list.
			 */
			function formatEvent(event) {
				if (!event || typeof event !== "object") return String(event ?? "");
				const at = typeof event.at === "string" ? event.at.slice(11, 19) : "";
				const parts = [at, event.kind];
				// Everything the fields below already say, so the tail does not
				// repeat it.
				const known = new Set(["at", "kind", "action", "source", "target", "query", "items",
					"ms", "waitMs", "cached", "notModified", "files", "rows", "error", "note",
					"masked", "login"]);
				if (event.action) parts.push(event.action);
				if (event.source) parts.push(event.source);
				if (event.target) parts.push(event.target);
				if (event.query) parts.push(`“${event.query}”`);
				if (typeof event.items === "number") parts.push(`${event.items} 条`);
				if (typeof event.ms === "number") parts.push(`${event.ms} ms`);
				if (typeof event.waitMs === "number") parts.push(`等待 ${Math.ceil(event.waitMs / 1000)} 秒`);
				if (event.cached) parts.push("缓存");
				if (event.notModified) parts.push(`304 ×${event.notModified}`);
				if (typeof event.files === "number") parts.push(`${event.files} 台`);
				if (typeof event.rows === "number") parts.push(`${event.rows} 行`);
				if (event.error) parts.push(`✗ ${event.error}`);
				if (event.note) parts.push(event.note);
				// A credential line names the mask and the account. The host has
				// no token to print even if this page asked for one.
				if (event.masked) parts.push(event.masked);
				if (event.login) parts.push(event.login);
				// Whatever this version of the panel does not know by name still
				// shows up: the log exists to explain a failure nobody planned
				// for, so a field added by a newer host must not become
				// invisible here. Falsy extras are left out (`cached: false`,
				// `skipped: 0`) so the line stays readable, and arrays keep
				// their element count rather than their contents.
				for (const [key, value] of Object.entries(event)) {
					if (known.has(key)) continue;
					if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
						if (value === "" || value === false || value === 0) continue;
						parts.push(`${key}=${value}`);
					} else if (Array.isArray(value) && value.length > 0) {
						parts.push(`${key}[${value.length}]`);
					}
					if (parts.length >= 14) { parts.push("…"); break; }
				}
				return parts.filter((part) => part !== undefined && part !== null && part !== "").join(" · ");
			}

			/**
			 * The user's own catalogue sources. Kept in its own request because it
			 * answers a different question from the listing ("what am I pointing
			 * at" vs "what is on the market") and the page needs it before it has
			 * any listing at all: the source filter and the per-source status line
			 * both name these rows.
			 */
			async function loadSources() {
				try {
					const body = await api("/sources");
					setCatalogSources({
						sources: Array.isArray(body.sources) ? body.sources : [],
						max: Number(body.max) > 0 ? Number(body.max) : 8,
						error: typeof body.error === "string" ? body.error : "",
					});
					setSourcesMissing(false);
				} catch (err) {
					const text = String(err.message || err);
					// An old host has no such route; that is a version fact, not a
					// failure of this page.
					const missing = text.includes("404");
					setSourcesMissing(missing);
					setCatalogSources({ sources: [], max: 8, error: missing ? "" : text });
				}
			}

			async function addCatalogSource() {
				const url = sourceDraft.trim();
				if (!url) { setSourceNote("先填一个 https 地址"); return; }
				setSourceBusy(true); setSourceNote("");
				try {
					const body = await api("/sources", { method: "POST", body: JSON.stringify({ url }) });
					setCatalogSources({ sources: body.sources ?? [], max: body.max ?? 8, error: "" });
					setSourceDraft("");
					setSourceNote(`已添加「${body.source?.label ?? url}」，正在重新拉取…`);
					setSourcesOpen(true);
					await loadMarket({ refresh: true });
					setSourceNote(`已添加「${body.source?.label ?? url}」`);
				} catch (err) {
					// The host refuses with a reason a user can act on (只接受 https、
					// 地址已添加过、上限 8 个); show it verbatim.
					setSourceNote(String(err.message || err));
				} finally {
					setSourceBusy(false);
				}
			}

			async function removeCatalogSource(id, label) {
				setSourceBusy(true); setSourceNote("");
				try {
					await api("/sources/remove", { method: "POST", body: JSON.stringify({ id }) });
					// Its rows must not come back from the listing this page already
					// holds, so the market is re-read rather than filtered here.
					setCatalogSources((prev) => ({ ...(prev ?? {}), sources: (prev?.sources ?? []).filter((s) => s.id !== id) }));
					setSourceNote(`已移除「${label}」`);
					await loadMarket({ refresh: true });
				} catch (err) {
					setSourceNote(String(err.message || err));
				} finally {
					setSourceBusy(false);
				}
			}

			/**
			 * Ask the host to look for install commands where the listing has none.
			 *
			 * The GitHub census knows thousands of repositories and none of them
			 * says how to run it, so the host walks the repositories themselves —
			 * a background job that costs thousands of requests and takes minutes.
			 * It starts when a reader actually opens the market (here) rather than
			 * on plugin load, and this page does not wait for it: the next visit
			 * finds the recovered commands on the rows. At most one ask per mount.
			 */
			// A ref, not an object in the render scope: this component re-renders on
			// every enrichment tick and every busy toggle, and a plain `{ done }` was
			// rebuilt with each of them — 「一次」 never held, so opening the market
			// re-POSTed the (expensive) walk on every repaint.
			const evidenceAskedRef = useRef(false);
			function askForInstallEvidence() {
				if (evidenceAskedRef.current) return;
				evidenceAskedRef.current = true;
				// Never fails the tab, never blocks it: the walk is the host's job
				// and a refusal there is reported next time the market is read.
				// The verb is explicit even though a bare POST still means "start"
				// (older panels send that, and the route keeps accepting it).
				api("/install-evidence", {
					method: "POST", body: JSON.stringify({ action: "start" }), timeoutMs: 15000,
				}).catch(() => {});
			}

			async function loadMarket(options = {}) {
                const state = marketRequest.current;
                const id = ++state.id;
                const filters = state.filters = {
                    query: options.query ?? state.filters.query,
                    source: options.source ?? state.filters.source,
                };
                if (options.keepPage !== true) setMarketPage(0);
				setMarketBusy(true); setMarketError("");
				try {
					const body = await api("/catalog", {
						method: "POST",
						timeoutMs: 120000,
						body: JSON.stringify({
							query: filters.query,
							source: filters.source,
							limit: 10000,
							refresh: options.refresh === true,
						}),
					});
                    if (id !== state.id) return;
                    if (!Array.isArray(body?.items)) throw new Error("连接器市场响应缺少 items 数组");
                    setMarket({ ...body, listingRevision: id, metricsRefresh: options.refresh === true });
                    setDetail(previous => previous ? body.items.find(item => itemKeyOf(item) === itemKeyOf(previous)) ?? previous : null);
                    setMarketAppliedQuery(filters.query);
					if (Array.isArray(body?.servers)) {
						const received = keepSessionHealth(body.servers);
						setServers(previous => previous ? previous.map(row => {
							const next = received[row.slot];
							if (!next || next.name !== row.name || next.source !== row.source) return row;
							return { ...row, artworkKey: next.artworkKey ?? row.artworkKey, icon: next.icon ?? row.icon, iconCandidates: next.iconCandidates ?? row.iconCandidates, config: row.config ?? next.config };
						}) : received);
					}
					setMarketAt(body.fetchedAt ? new Date(body.fetchedAt).toLocaleTimeString() : "");
					// A new listing invalidates the page you were on — unless the
					// reader stayed where they were: installing from page 7 of a
					// source keeps the context that made them install.
					if (options.keepPage !== true) setMarketPage(0);

					askForInstallEvidence();
				} catch (err) {
					if (id !== state.id) return;
					const text = String(err.message || err);
					// A bare 404 means the host bundle running in this window predates
					// the market route (the plugin was updated while the app was open).
					setMarketError(text.includes("404")
						? "宿主插件还是旧版本（缺少 /api/overall-mcp/catalog）。请完全退出 DSH 后重新打开，或在本页刷新一次再试。"
						: text);
				} finally {
					if (id === state.id) setMarketBusy(false);
				}
			}

            /** Measure the visible page in batches of 30. Cache successes for
             * five minutes; explicit refresh bypasses it once per listing.
             * Failed measurements retain old numbers with a visible warning. */
            async function enrichStars(items, refresh = false) {
                const repos = [...new Set(items.map(repoKeyOf).filter(Boolean))];
                const wanted = repos.filter(key => {
                    const hit = repoStats[key];
                    const force = refresh && metricRefreshStamp.current.get(key) !== market?.listingRevision;
                    if (force) metricRefreshStamp.current.set(key, market?.listingRevision);
                    return force || !hit || hit.stale || !hit.fetchedAt || Date.now() - Date.parse(hit.fetchedAt) >= 300_000;
                });
                if (!wanted.length) { setStarNote(""); return; }
                const batch = ++statsBatch.current;
                const revisions = new Map(wanted.map(key => {
                    const id = (statsRequests.current.get(key) ?? 0) + 1;
                    statsRequests.current.set(key, id); return [key, id];
                }));
                setStatsBusy(true);
                const failures = [];
                try {
                    for (let offset = 0; offset < wanted.length; offset += 30) {
                        const chunk = wanted.slice(offset, offset + 30);
                        const body = await api("/repo-stats", { method: "POST", timeoutMs: 120000, body: JSON.stringify({ repos: chunk, refresh }) });
                        if (!body?.stats || typeof body.stats !== "object") throw new Error("仓库统计响应格式无效");
                        const errors = body.errors ?? (body.rateLimited ? chunk.map(repo => ({ repo, message: "GitHub 访问限额已用完" })) : []);
                        for (const key of chunk) if (!body.stats[key] && !errors.some(row => row.repo === key)) errors.push({ repo: key, message: "来源未返回仓库统计" });
                        failures.push(...errors);
                        setRepoStats(previous => {
                            const next = { ...previous };
                            for (const key of chunk) {
                                if (statsRequests.current.get(key) !== revisions.get(key)) continue;
                                const error = errors.find(row => row.repo === key);
                                if (body.stats[key] || next[key] || error) next[key] = {
                                    ...next[key], ...body.stats[key], stale: Boolean(error), error: error?.message ?? null,
                                };
                            }
                            return next;
                        });
                        if (body.rateLimited) { failures.push(...wanted.slice(offset + 30).map(repo => ({ repo, message: "访问限额已用完，本次未更新" }))); break; }
                    }
                    if (batch === statsBatch.current) setStarNote(failures.length
                        ? `${failures.length} 个仓库的统计未能更新，保留已有数字。可稍后刷新，或检查 GitHub 登录与访问额度。`
                        : "本页仓库统计已更新");
                } catch (error) {
                    if (batch === statsBatch.current) setStarNote(`仓库统计更新失败，当前数字可能是旧数据：${String(error.message || error)}`);
                    setRepoStats(previous => {
                        const next = { ...previous };
                        for (const key of wanted) if (statsRequests.current.get(key) === revisions.get(key)) next[key] = { ...next[key], stale: true, error: String(error.message || error) };
                        return next;
                    });
                } finally { if (batch === statsBatch.current) setStatsBusy(false); }
            }

			/**
			 * Preview pictures for the cards, one bounded request per market load.
			 *
			 * READMEs are fetched by the host, not the page: they run to a
			 * megabyte on the big awesome lists and the raw host answers bursts
			 * with a rate limit. Only the ranked URLs come back, cached for
			 * hours, so paging through the market costs one request once.
			 *
			 * A failure is not fatal — a card without a picture is a complete
			 * card — but it is no longer silent: the host says which repos it
			 * could not ask about, and those are listed with a 重试 control
			 * instead of rendering as "this repo has no images".
			 */
            async function enrichMedia(items, refresh = false) {
                const repos = [...new Set(items.map(repoKeyOf).filter(Boolean))].filter(key => refresh || !repoMedia[key]);
                const revisions = new Map(repos.map(key => {
                    const id = (mediaRequests.current.get(key) ?? 0) + 1;
                    mediaRequests.current.set(key, id); return [key, id];
                }));
                for (let offset = 0; offset < repos.length; offset += 24) {
                    const chunk = repos.slice(offset, offset + 24);
                    const current = key => mediaRequests.current.get(key) === revisions.get(key);
                    try {
                        const body = await api("/repo-media", { method: "POST", timeoutMs: 120000, body: JSON.stringify({ repos: chunk, refresh }) });
                        if (!body?.media || typeof body.media !== "object") throw new Error("配图响应格式无效");
                        setRepoMedia(previous => ({ ...previous, ...Object.fromEntries(Object.entries(body.media).filter(([key]) => current(key))) }));
                        setMediaFailures(previous => [...previous.filter(row => !chunk.includes(row.repo) || !current(row.repo)), ...(body.errors ?? []).filter(row => current(row.repo))]);
                    } catch (error) {
                        setMediaFailures(previous => [...previous.filter(row => !chunk.includes(row.repo) || !current(row.repo)), ...chunk.filter(current).map(repo => ({ repo, error: String(error.message || error) }))]);
                    }
                }
            }

            async function enrichSkillMetrics(items, refresh, listingId) {
                const id = ++skillMetricRequest.current;
                const ids = items.filter(item => ['clawhub', 'skillhub', 'github'].includes(item.source)).map(item => item.id);
                if (!ids.length) { setSkillMetricNote(""); return; }
                setSkillMetricNote("正在更新本页下载量和 Star…");
                try {
                    const body = await api("/skills/market/metrics", { method: "POST", timeoutMs: 25000, body: JSON.stringify({ ids, refresh }) });
                    if (id !== skillMetricRequest.current || listingId !== skillMarketRequest.current.id) return;
                    if (!body?.items || typeof body.items !== "object") throw new Error("技能统计响应格式无效");
                    setSkillMarket(previous => ({ ...previous, items: previous.items.map(item => ({ ...item, ...body.items[item.id] })) }));
                    setSkillMetricNote(body.errors?.length
                        ? `本页 ${body.errors.length} 项统计更新失败，保留上次数字；可稍后刷新重试。`
                        : `本页 ${body.updated ?? 0} 项统计已更新。热门顺序按已收录数据及已更新统计计算。`);
                } catch (error) {
                    if (id === skillMetricRequest.current && listingId === skillMarketRequest.current.id) setSkillMetricNote(`本页统计更新失败，保留已有数字：${String(error.message || error)}`);
                }
            }

			/**
			 * Read the feed for one space.
			 *
			 * Everything a reader can change (time window, one server or skill,
			 * the words in the box) is a query parameter: the host owns the
			 * filtering, so the page never filters a page of rows and calls it a
			 * total.
			 */
			async function loadCalls(options) {
				const asked = options ?? {};
				const spaceNow = asked.space ?? space;
				const rangeNow = asked.range ?? callRange;
				const params = new URLSearchParams({ space: spaceNow, range: rangeNow });
				const filterNow = asked.filter ?? callFilter;
				const qNow = asked.q ?? callQuery;
				// A reading rule, so the panel chooses it and the host folds on read.
				// Omitted until there is a choice: the host answers with the window it
				// used, so the default does not live in two places.
				const mergeNow = asked.merge ?? callMergeChoice;
				if (spaceNow === "skill" && mergeNow !== null && mergeNow !== undefined) {
					params.set("merge", String(mergeNow));
				}
				if (filterNow) params.set("filter", filterNow);
				if (qNow) params.set("q", qNow);
				const request = (callsRequest.current ?? 0) + 1;
                callsRequest.current = request;
                setCalls(null);
                setCallsBusy(true);
				setCallsError("");
				setCallsNote("");
				try {
					const body = await api("/calls?" + params.toString(), { method: "GET" });
					if (callsRequest.current !== request) return;
                    // A resource selected in another window must not remain as
                    // a hidden zero-count filter after its events age out.
                    if (filterNow && Array.isArray(body?.rail) && !body.rail.some(item => item.id === filterNow)) setCallFilter("");
                    setCalls(body && typeof body === "object" ? body : null);
					const today = body?.stats?.today;
					if (Number.isFinite(today)) setCallBadges((prev) => ({ ...prev, [spaceNow]: today }));
				} catch (err) {
					if (callsRequest.current === request) setCallsError(String(err.message || err));
				} finally {
					if (callsRequest.current === request) setCallsBusy(false);
				}
			}

			/**
			 * The two badges, read once at mount.
			 *
			 * 「今日」 has a fixed meaning per space (MCP counts tool calls, Skill
			 * counts loads plus triggers), so it cannot be a single number that
			 * follows the tab; and a badge that appears only after the tab opens
			 * would be no badge at all.
			 */
			async function refreshCallBadges() {
				const read = async (asked) => {
					try {
						const body = await api("/calls?space=" + asked + "&range=1h", { method: "GET" });
						const today = body?.stats?.today;
						if (Number.isFinite(today)) setCallBadges((prev) => ({ ...prev, [asked]: today }));
					} catch {
						// A badge is not worth an error line: the tab reports its own failures.
					}
				};
				await Promise.all([read("mcp"), read("skill")]);
			}

			/** What is on screen, as JSON — the same rows, with the filters that produced them. */
			async function exportCalls(view = {}) {
				const rows = Array.isArray(view.rows) ? view.rows : [];
				const text = JSON.stringify({ space, range: callRange, filter: callFilter, q: callQuery, eventFilter: view.eventFilter ?? "all", rows }, null, 2);
				try {
					await navigator.clipboard.writeText(text);
					setCallsNote("已复制 " + rows.length + " 条 JSON");
				} catch {
					setCallsNote("复制失败：这个窗口不允许写剪贴板。可以逐条点「展开」看请求与响应。");
				}
			}

			// The badge counts before either tab is opened.
			useEffect(() => {
				void refreshCallBadges();
			}, []);

			// The feed re-asks when a control changes. The words in the box do not:
			// they filter the rows already on screen, so typing never costs a request.
			useEffect(() => {
				if (tab !== "calls") return;
				void loadCalls({ range: callRange, filter: callFilter, space, q: "" });
			}, [tab, space, callRange, callFilter, callMergeChoice]);

			// The fold window is remembered by the host (the page cannot persist it:
			// the GUI's port changes between restarts, so storage is per run).
			useEffect(() => {
				api("/prefs").then((body) => {
					if (Number.isFinite(body?.merge)) setCallMergeChoice(body.merge);
				}).catch(() => {});
			}, []);

			// Deep link: `?space=skill&tab=calls` should land here. Read once at
			// mount; a shell that gives this panel no query string simply has
			// nothing to parse.
			useEffect(() => {
				let search = "";
				try {
					search = window.location?.search ?? "";
				} catch {
					search = "";
				}
				if (!search) return;
				const params = new URLSearchParams(search);
				const askedSpace = params.get("space");
				const askedTab = params.get("tab");
				if (askedSpace === "mcp" || askedSpace === "skill") setSpace(askedSpace);
				if (askedTab === "calls" || askedTab === "market" || askedTab === "registry" || askedTab === "skillmarket") setTab(askedTab);
			}, []);

			// The market lists itself the first time its tab is opened.
			useEffect(() => {
				if (tab === "market" && market === null && !marketBusy) loadMarket({});
				if (tab === "skillmarket" && space === "skill" && skillMarket === null && !skillMarketBusy) {
					loadSkillMarket({}).catch(() => {});
				}
			}, [tab, space]);

			async function run(fn, okMessage) {
				if (actionRef.current) return;
				actionRef.current = true;
				setBusy(true); setError(""); setMessage("");
				try {
					const value = await fn();
					await refresh();
					if (okMessage) setMessage(okMessage(value));
				} catch (err) {
					setError(String(err.message || err));
				} finally {
					actionRef.current = false;
					setBusy(false);
				}
			}

			const doScan = () => run(
				() => api("/scan", { method: "POST", timeoutMs: 120000 }),
				(r) => `扫描完成：新增 ${r.added.length} 台，跳过 ${r.skipped.length} 台（${r.scannedFiles} 个配置文件）`,
			);
			// `note` wins when the host has one: it is the honest wording for an
			// entry another mcp-client mount provides, where「已停用」/「已移除」
			// would claim an effect this plugin cannot have.
			const doToggle = (server, enabled) => run(
				() => api("/set-enabled", { method: "POST", body: JSON.stringify({ ...rowRef(server), enabled }) }),
				(r) => r.note ?? `${r.name} ${r.enabled ? "已启用并连接" : "已停用"}`,
			);
			const doToggleSource = (source, enabled) => run(
				() => api("/set-source-enabled", { method: "POST", body: JSON.stringify({ source, enabled }) }),
				(r) => r.note ?? `${sourceLabel(r.source)}：${r.changed} 台已${r.enabled ? "启用" : "停用"}`,
			);
			const doRemove = (server) => run(
				() => api("/remove", { method: "POST", body: JSON.stringify(rowRef(server)) }),
				(r) => r.note ?? `${r.removed} 已移除`,
			);
			// 「测一下这台服务器能不能用」. `retry: true` lets the host attempt one
			// mount when the row is enabled but nothing is mounted — that turns a
			// dead row into either a working one or a real error text, which is
			// more useful than reporting「未挂载」back at the user who clicked 检查.
			//
			// Two things this click owns beyond the request:
			//   - the row says 检查中… for the whole window (a first-run mount can
			//     spend tens of seconds in `npx` before its handshake), and
			//   - a handshake that is *still* starting is not a verdict about the
			//     row: the check follows the same mount up to HEALTH_ATTEMPTS
			//     times instead of calling a download a failure.
			const doHealth = async (server) => {
				const key = rowKey(server);
				// Two guards: the list says which rows are being checked (and keeps
				// saying it across renders), the ref closes the frame between a
				// double click and the paint that would have disabled the button.
				if (checkingKeys.includes(key) || checkRef.current) return;
				checkRef.current = true;
				setCheckingKeys((prev) => [...prev, key]);
				setError(""); setMessage("");
				try {
					let reply = null;
					for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
						reply = await api("/health", {
							method: "POST",
							body: JSON.stringify({ ...rowRef(server), retry: true }),
							timeoutMs: API_TIMEOUT_MS,
						});
						const handshake = (reply?.health?.checks ?? []).find((check) => check?.id === "handshake");
						if (handshake?.ok !== false || attempt === HEALTH_ATTEMPTS) break;
						setMessage(`${reply?.server?.name ?? server.name} 还在握手（首次运行要先下载 CLI），${HEALTH_RETRY_GAP_MS / 1000}s 后再看一次…`);
						await new Promise((resolve) => setTimeout(resolve, HEALTH_RETRY_GAP_MS));
					}
					// 只有本次亲手问出来的结论才允许显示（refresh() 会按这个集合过滤）。
					checkedThisSession.add(reply?.server?.name ?? server.name);
					await refresh();
					const bad = (reply?.health?.checks ?? []).find((check) => check?.ok === false);
					setMessage(`${reply?.server?.name ?? server.name}：${reply?.ok ? "健康" : "不健康"}${bad?.detail ? `（${bad.detail}）` : ""}`);
				} catch (err) {
					setError(String(err.message || err));
				} finally {
					checkRef.current = false;
					setCheckingKeys((prev) => prev.filter((k) => k !== key));
				}
			};
			// Opening the sheet is the whole click; the save is the sheet's own
			// POST, because only it holds the values (and only it knows which of
			// them was actually touched).
			//
			// One detour first: a row knows it takes configuration without knowing
			// what it takes (a Smithery entry installed before its schema was
			// fetched). Opening an empty form there is the 「装了却没有配置界面」
			// complaint — the server does declare a key, nobody asked. So ask, once,
			// on the click, and open whatever the row says afterwards.
			const doConfigure = async (server) => {
				const key = rowKey(server);
				if (!server.config && server.channel === "cli-json") {
					// Asking the source takes up to 8 s on a slow one. The row says
					// so while it waits (「确认中…」), and a second click is a second
					// request nobody wanted.
					if (configHintKey === key) return;
					setConfigHintKey(key);
					try {
						const reply = await api("/config-hints", {
							method: "POST",
							body: JSON.stringify(rowRef(server)),
							timeoutMs: 8000,
						});
						if (reply?.server) {
							setConfigTarget(reply.server);
							return;
						}
						// The source had nothing to declare: that is an answer, say it
						// rather than letting the sheet appear to have ignored the ask.
						setMessage(`${server.name} 的来源没有声明配置项；下面的表单可以直接手填。`);
					} catch (err) {
						// Ask-a-source is best-effort: an unreachable registry must not
						// stop the sheet from opening, it only means it has nothing to
						// declare yet.
						setMessage(`${server.name} 的来源这次没有回应（${String(err?.message ?? err)}）；表单仍可手填。`);
					} finally {
						setConfigHintKey(null);
					}
				}
				setConfigTarget(server);
			};
			const afterConfigure = async () => {
				// The reply already carries the fresh row list; refetch anyway so
				// badges and counts on the page agree with the registry file.
				const freshServers = await refresh();
				if (configTarget) {
					const all = Array.isArray(freshServers) ? freshServers : [];
					const fresh = (Number.isInteger(configTarget.slot) ? all.find((s) => s.slot === configTarget.slot) : null)
						?? all.find((s) => s.name === configTarget.name);
					if (fresh) {
						setConfigTarget(fresh);
					}
				}
			};
			// One action for the whole set of rows the last scan proved are gone:
			// they are all the same kind of leftover, and removing them one by one
			// is exactly what a name-keyed 移除 got wrong.
			const doCleanOrphans = () => run(
				() => api("/forget-orphans", { method: "POST" }),
				(r) => (r.count
					? `已清理 ${r.count} 条来源已删除的记录（${[...new Set(r.removed.map((x) => x.name))].join("、")}）`
					: "没有需要清理的记录"),
			);
			// 「检查更新」 answers two questions at once: which mounted MCP
			// servers have a newer package, and whether *this plugin* does. The
			// second answer is what decides if the head shows an update button,
			// so a refresh action (which the 分类 row already has as 刷新) never
			// sits in the primary slot.
			const doCheckUpdates = () => run(
				async () => {
					const body = await api("/updates", { method: "POST", timeoutMs: 300000 });
					setSelfUpdate(body.self ?? null);
					return body;
				},
				(r) => {
					// Three outcomes, not two: a lookup can also have failed (the
					// host counts those as `failed`). The two-way message this
					// replaces called an offline run 「均已是最新版本」, which is a
					// verdict nobody had.
					const failed = r.failed ?? 0;
					const ok = Math.max(0, r.checked - failed);
					const parts = [];
					if (r.updatable > 0) {
						parts.push(`${r.checked} 个可检测，其中 ${r.updatable} 个有可用更新`
							+ (failed > 0 ? `，${failed} 个查不到最新版本` : ""));
					} else if (failed === 0) {
						parts.push(`${r.checked} 个可检测，均已是最新版本`);
					} else if (ok === 0) {
						parts.push(`${r.checked} 个可检测，全部都查不到最新版本（网络或包注册表不可用）`);
					} else {
						parts.push(`${r.checked} 个可检测，${ok} 个已是最新、${failed} 个查不到最新版本`);
					}
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
					const body = await api("/self-update", { method: "POST", timeoutMs: 600000 });
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
			async function doExportLog() {
				try {
					// The host's own account of this run, fetched now rather than
					// reused from the panel's state: the export has to be true at
					// the moment it is written, and 运行日志 may never have been
					// opened at all.
					const [status, events] = await Promise.all([
						api("/status").catch(() => null),
						api("/events").catch(() => null),
					]);
					const payload = {
						exportedAt: new Date().toISOString(),
						plugin: {
							id: "dsh-overall-mcp", version: CLIENT_VERSION,
							// What the process serving this page actually is. The
							// bundle's own constant cannot answer that question —
							// it is compiled into the page.
							host: status?.plugin ?? null,
						},
						host: status
							? {
								process: status.host ?? null, data: status.data ?? null,
								census: status.census ?? null, evidence: status.evidence ?? null,
								quota: status.quota ?? null,
							}
							: null,
						// The reasons that outlive the panel's own memory: why a
						// source was unavailable, when a census started, what an
						// install did.
						events: events
							? { total: events.total ?? 0, damaged: events.damaged ?? 0, lines: events.events ?? [] }
							: null,
						registry: {
							total: stats.total, enabled: stats.enabled, disabled: stats.disabled,
							connected: stats.connected, failed: stats.failed, servers,
						},
						market: market
							? {
								total: market.total, counts: market.counts ?? null,
								cached: market.cached === true, fetchedAt: market.fetchedAt ?? null,
								// Per-source facts: a missing count or a stale row is
								// otherwise invisible in a screenshot.
								sources: market.sources ?? null,
								notModified: market.notModified ?? 0,
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
					setMessage(`已导出日志：${stats.total} 台服务器、${marketItems?.length ?? 0} 条市场条目${events?.events?.length ? `、${events.events.length} 条运行日志` : ""}`);
				} catch (err) {
					setError(`导出失败：${String(err.message || err)}`);
				}
			}

			// Return-to-top: this page is its own scroller (the centre column
			// does not scroll), so the listener goes on the tab's own scrolling
			// box — the registry tab body, or the market's card region.
			// Re-runs on a tab change AND when the content that creates the box
			// changes: the market's card region only exists once a listing has
			// arrived, so a `[tab]`-only effect latched onto the window on the
			// first open and then never re-bound to the box the user drags.
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
				// `market` (the listing that creates the card region) and `servers`
				// (the rows that make the registry body tall) both arrive after the
				// first render, so they belong in the deps. Only state declared above
				// this effect may appear here — the memoized page slice is declared
				// further down and would be in its temporal dead zone.
			}, [tab, market, servers]);

			function backToTop() {
				const target = scrollerRef.current;
				if (target && typeof target.scrollTo === "function") target.scrollTo({ top: 0, behavior: "smooth" });
				else if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
					window.scrollTo({ top: 0, behavior: "smooth" });
				}
			}
			/**
			 * Put the progress panel away. This dismisses the *panel*, not the
			 * answers the run gave: those live in `updateAnswers`, so the entries
			 * a finished run settled do not come straight back as a batch to run
			 * again off a listing that has not caught up yet.
			 */
			function closeJobs() {
				setUpdateJobs(null);
				setJobsOpen(false);
			}
			/**
			 * Run one or more updates through one sequential queue.
			 *
			 * Sequential, not parallel: every update rewrites the registry file
			 * and re-mounts an mcp-client fiber, and N concurrent rewrites of one
			 * file is how a registry gets truncated. The queue is also the only
			 * reason this page can show progress at all — it knows how many items
			 * it handed over and how many answers came back.
			 *
			 * A failure does not stop the queue. Each item records its own
			 * outcome and the summary separates updated / already-current /
			 * failed, because those three ask for different reactions.
			 */
			const runUpdates = async (rows) => {
				// Rows arrive two ways: the batched `updatable` list, already
				// flattened, or straight from a row's 更新 button, which hands over
				// the server. Both carry a slot; the version a row was showing only
				// exists on the server, so read it from either place.
				const list = rows.map((row) => ({
					key: rowKey(row),
					name: row.name,
					slot: row.slot ?? null,
					from: row.from ?? row.update?.current ?? null,
				}));
				if (list.length === 0) return;
				if (updateRunRef.current) return;
				updateRunRef.current = true;
				const items = list.map((row) => ({ ...row, status: "pending", message: "" }));
				setBusy(true); setError(""); setMessage("");
				setUpdateJobs({
					total: list.length, done: 0, running: true,
					startedAt: Date.now(), current: list[0].name, items,
				});
				setJobsOpen(list.length > 1);
				let updated = 0; let skipped = 0; let failed = 0;
				for (let i = 0; i < list.length; i += 1) {
					const row = list[i];
					setUpdateJobs((prev) => (prev ? {
						...prev,
						current: row.name,
						items: prev.items.map((it, j) => (j === i ? { ...it, status: "running" } : it)),
					} : prev));
					let settled;
					try {
						// `slot` names the exact row, `from` the version it was
						// showing: the host needs one of them to act on the entry
						// that was clicked when two rows share a name.
						const result = await api("/update", {
							method: "POST",
							timeoutMs: 300000,
							body: JSON.stringify({ name: row.name, from: row.from, slot: row.slot }),
						});
						if (result.updated) {
							updated += 1;
							settled = {
								status: "updated",
								// The version this answer covers. A row hides its 更新
								// button only while the listing still offers exactly
								// that version, so a newer release supersedes the
								// answer instead of being hidden by it.
								answer: result.to,
								message: `${result.from} → ${result.to}${result.reconnected ? "（已重连）" : ""}`,
							};
						} else {
							skipped += 1;
							settled = { status: "skipped", answer: result.version, message: result.reason ?? "无需更新" };
						}
					} catch (err) {
						failed += 1;
						settled = { status: "failed", message: String(err?.message || err) };
					}
					const patch = settled;
					setUpdateJobs((prev) => (prev ? {
						...prev,
						done: i + 1,
						items: prev.items.map((it, j) => (j === i ? { ...it, ...patch } : it)),
					} : prev));
					// Record what the host said about this entry, separately from
					// the panel that shows it. A failure records nothing: that
					// entry is still outstanding, so it has to keep the badge and
					// the button that reach it again.
					setUpdateAnswers((prev) => {
						const next = { ...prev };
						if (patch.status === "failed") delete next[row.key];
						else next[row.key] = { status: patch.status, answer: patch.answer };
						return next;
					});
				}
				setUpdateJobs((prev) => (prev
					? { ...prev, running: false, current: null, finishedAt: Date.now() }
					: prev));
				try { await refresh(); } catch (err) { setError(String(err.message || err)); }
				const parts = [`${updated} 台已更新`];
				if (skipped) parts.push(`${skipped} 台无需更新`);
				if (failed) parts.push(`${failed} 台失败`);
				const who = list.length === 1 ? list[0].name : `${list.length} 台服务器`;
				const summary = `${who}：${parts.join("，")}`;
				// One failure in a batch is still an error even when the rest
				// worked: the reader has to act on that one, and a success toast
				// would bury it.
				if (failed) setError(summary); else setMessage(summary);
				updateRunRef.current = false;
				setBusy(false);
			};
			/** A row's own 「更新」 — the same queue with one item in it, so a
			 * single update reports through the same bar a batch does. */
			const doUpdate = (row) => runUpdates([row]);
			/** 「全部更新」 — whatever is still outstanding: the rows the host last marked
			 * updatable, minus the entries this queue has already settled. */
			const doUpdateAll = () => runUpdates(pending);
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
				const key = itemKeyOf(item);
				const next = !item.favorite;
				// Matched by key, never by object identity. The optimistic flip
				// below replaces the item with a copy, so the object in this
				// handler is no longer the one in the list — a rollback that
				// compared identities rolled nothing back and left the star
				// lying about a save that had failed.
				const setFavorite = (favorite) => {
					setMarket((prev) => (prev?.items
						? { ...prev, items: prev.items.map((i) => (itemKeyOf(i) === key ? { ...i, favorite } : i)) }
						: prev));
					setDetail((prev) => (prev && itemKeyOf(prev) === key ? { ...prev, favorite } : prev));
				};
				setFavorite(next);
				try {
					// `on` states the wanted end state instead of asking the host to
					// flip whatever it has: the star is already flipped here, and the
					// two would drift apart if the host's copy had moved on.
					await api("/favorite", { method: "POST", body: JSON.stringify({ key, on: next }) });
					setFavTotal((prev) => (prev === null ? prev : Math.max(0, prev + (next ? 1 : -1))));
				} catch (err) {
					// Roll the optimistic flip back — a bookmark that lies about
					// being saved is worse than one that never moved.
					setFavorite(!next);
					setError(String(err.message || err));
				}
			};

			const doInstall = async (item) => {
				// One install at a time from this panel. The host serialises the work
				// anyway; a second click while the first was in flight only landed a
				// second POST whose spinner overwrote the first one's.
				if (installingRef.current) return;
				installingRef.current = itemKeyOf(item);
				setError(""); setMessage(""); setInstallFailure("");
				setInstallingKey(itemKeyOf(item));
				try {
					const result = await api("/install", { method: "POST", timeoutMs: 300000, body: JSON.stringify({ item }) });
					await refresh();
					// The listing is rebuilt (the card must now read 已安装), but the
					// page the reader installed from is kept: being thrown back to
					// page 1 after every install made browsing a source a chore.
					await loadMarket({ keepPage: true });
					// A 200 with `connect.ok === false` means the row was written and
					// nothing mounted. Reporting 「已安装并连接」 for it was the one
					// lie this panel told about its own work.
					// A row that installed but declared a required setting opens its
					// config sheet straight away: it mounted nothing usable, and the
					// next thing the user needs is the form, not a toast.
					if (result?.needConfig === true || result?.channel === "cli-json") {
						// Prefer the row that is itself pending: two rows can share a
						// name (a client config plus a registry entry), and opening the
						// form on the one that does not need it would show no fields.
						const same = (result.servers ?? []).filter((s) => s.name === result.server);
						const row = same.find((s) => s.needConfig === true) ?? same.find((s) => s.channel === "cli-json") ?? same[0];
						if (row) setConfigTarget(row);
						setMessage(result?.needConfig === true
							? `${result.server ?? "这个条目"} 已安装，还需要填写配置才能使用。`
							: `${result.server ?? "这个条目"} 已安装；这类服务器通常要填一个密钥才能用，配置在这里填写。`);
					} else if (result?.connect?.ok === false) setInstallFailure(installFailureText(result, item));
					else setMessage(`${result.server ?? "这个条目"} 已安装并连接`);
				} catch (err) {
					setError(String(err.message || err));
				} finally {
					installingRef.current = null;
					setInstallingKey(null);
				}
			};

			const all = servers || [];
			// 每行那句「这台服务器是干什么的」是服务器自己写的一句话（见
			// lib/about.js），语言由它的作者决定。这里是它被换成本页语言的地方：
			// 译文按「语言 + 原句」缓存，原文留在 about.original 里当 tooltip，
			// 所以翻译只是把同一句话换成读者看得懂的说法，不是改写事实。
			const localized = localizeRows(all, aboutI18n, pageLanguage());
			const stats = {
				total: all.length,
				enabled: all.filter((s) => s.enabled !== false).length,
				disabled: all.filter((s) => s.enabled === false).length,
				connected: all.filter((s) => s.enabled !== false && s.connected && !s.error && !s.starting && s.health?.ok !== false).length,
				failed: all.filter((s) => s.error || s.health?.ok === false && !s.starting).length,
			};
			// Mounted and enabled, but a required setting is empty — the rows whose
			// tool calls will fail. A stopped row is not 「还差配置」, it is stopped.
			const needConfigCount = all.filter((s) => s.needConfig === true && s.enabled !== false).length;
            const firstFailedServer = all.find(server => server.error || server.health?.ok === false && !server.starting);

			// ---- the update queue, derived for render ----
			// The bar reports two facts and no more: how many items the host has
			// already answered for, and how long the queue has been going. A
			// "download percentage" would be a number nobody measured — /update
			// answers once, when the whole rewrite-and-reconnect is done.
			const updateRunning = updateJobs?.running === true;
			const updateProgress = updateJobs ? Math.round((updateJobs.done / updateJobs.total) * 100) : 0;
			const updateElapsed = updateJobs
				? Math.max(0, Math.round((((updateRunning && clockMs) || updateJobs.finishedAt || Date.now()) - updateJobs.startedAt) / 1000))
				: 0;
			// ---- what 「全部更新」 may still act on ----
			// The listing is not the last word. An entry this queue already
			// answered must not be re-advertised off a listing that still carries
			// the badge it was clicked from — that is the page arguing with its own
			// result, and it is why a dismissed bar used to come straight back as
			// 「全部更新（1）」. The answer is matched against the version that same
			// row offers now, so a NEWER release no longer matches and is offered
			// again. A failure answers nothing, because retrying it is the next
			// thing a reader wants. (The host rewrites the entry's check too; this
			// keeps the count honest until that refresh lands — and keeps it honest
			// for good when the host has not been restarted into the new code yet.)
			const answered = (row) => {
				const info = updateAnswers[row.key];
				if (!info || info.answer == null) return false;
				const latest = (servers ?? []).find((s) => rowKey(s) === row.key)?.update?.latest;
				return latest != null && String(latest) === String(info.answer);
			};
			const pending = updatable.filter((row) => !answered(row));
			// Rows the last scan proved their own source no longer defines. They
			// are one kind of leftover, so they get one action rather than a
			// per-row 移除 that a name-keyed host call used to aim at the wrong row.
			const orphans = (servers ?? []).filter((s) => s.orphan === true);
			const jobsFinished = updateJobs !== null && !updateRunning;
			const jobsFailed = (updateJobs?.items ?? []).filter((it) => it.status === "failed").length;
			const jobsUpdated = (updateJobs?.items ?? []).filter((it) => it.status === "updated").length;
			// Finished, nothing failed, and nothing left outstanding: the bar stops
			// asking a question. `pending.length` matters — a row's own 更新 settles
			// that row while other updatable servers are still waiting, and hiding
			// the batch button then would take away the only control that reaches
			// them.
			const queueSettled = jobsFinished && jobsFailed === 0 && pending.length === 0;
			// A row's own slice of the queue: is it in this run, is it the one
			// being rewritten right now, and has the run already answered it. The
			// answer travels with the item so the row can stop offering work that
			// is done without waiting for the listing to catch up.
			const jobOf = (server) => {
				const key = rowKey(server);
				const item = (updateJobs?.items ?? []).find((it) => it.key === key);
				if (!item) return null;
				return { ...item, answered: answered({ key, name: server.name }), outcome: updateAnswers[key]?.answer };
			};
			const JOB_ICON = { pending: "○", running: "◌", updated: "✓", skipped: "·", failed: "✗" };
			const JOB_TEXT = { pending: "等待中", running: "更新中…" };
			// One status colour per outcome; the icon is where a reader looks
			// first in a list of ten, so the colour has to agree with it.
			const jobIconStyle = (status) => (
				status === "failed" ? { ...styles.jobIcon, ...styles.jobFailed }
					: status === "updated" ? { ...styles.jobIcon, ...styles.jobUpdated }
						: styles.jobIcon
			);

			const sourceOptions = useMemo(() => {
				const set = new Set(all.map((s) => s.source || "manual"));
				return [...set].sort();
			}, [servers]);

			const groups = useMemo(() => {
				const needle = nameFilter.trim().toLowerCase();
				// The field advertises 「名称、来源或命令」, so all three (plus the URL
				// a streamable-http entry has instead of a command) are searched —
				// otherwise the box silently refuses to find what its own title
				// says it can.
				const matches = (server) => {
					if (!needle) return true;
					const hay = [server.name, server.source, server.command, server.url, server.about?.text]
						.filter((v) => typeof v === "string" && v)
						.join(" ")
						.toLowerCase();
					return hay.includes(needle);
				};
				const bySource = new Map();
				// `localized`, not `all`: the rows the user reads carry the sentence
				// in their own language, and everything downstream (grouping, the
				// counts per group) is about those same rows.
				for (const server of localized) {
					const source = server.source || "manual";
					if (sourceFilter && source !== sourceFilter) continue;
					if (stateFilter === "enabled" && server.enabled === false) continue;
					if (stateFilter === "disabled" && server.enabled !== false) continue;
					if (stateFilter === "connected" && (!server.connected || server.error || server.starting || server.health?.ok === false)) continue;
					if (stateFilter === "failed" && !server.error && server.health?.ok !== false) continue;
					if (!matches(server)) continue;
					if (!bySource.has(source)) bySource.set(source, []);
					bySource.get(source).push(server);
				}
				return [...bySource.entries()]
					.map(([source, list]) => [source, list.sort((a, b) => a.name.localeCompare(b.name))])
					.sort((a, b) => a[0].localeCompare(b[0]));
			}, [servers, aboutI18n, sourceFilter, stateFilter, nameFilter]);
            // Filter the complete registry first, then page the exact row
            // objects so row slots and source-wide operations keep their identity.
            const registryRows = groups.flatMap(([, rows]) => rows);
            const registryPageCount = Math.max(1, Math.ceil(registryRows.length / registryView.pageSize));
            const registryPage = Math.min(registryView.page, registryPageCount - 1);
            const registryStart = registryPage * registryView.pageSize;
            const registryPageRows = registryRows.slice(registryStart, registryStart + registryView.pageSize);
            const registryPageRowsSet = new Set(registryPageRows);
            const registryPageGroups = groups.map(([source, rows]) => [source, rows.filter(row => registryPageRowsSet.has(row))])
                .filter(([, rows]) => rows.length);
            const changeRegistryView = update => {
                setRegistryView(previous => ({ ...previous, ...update }));
                registryScroll.current?.scrollTo({ top: 0 });
            };


			const toggleCollapsed = (source) => setCollapsed((prev) => {
				const next = new Set(prev);
				if (next.has(source)) next.delete(source); else next.add(source);
				return next;
			});

			const marketItems = market?.items ?? null;
			const installedCount = marketItems ? marketItems.filter((i) => i.installed).length : 0;
			// The user's own sources, as rows the page can filter and label by.
			// Their ids come from the host, so a listing filtered by one of them
			// is the same request the built-in five use.
			const customSourceRows = catalogSources?.sources ?? [];
			const marketSourceOptions = [
				// The census view sits next to the source it reads, so the two read as
				// one choice with two scopes rather than as two catalogues that happen
				// to hold the same repositories.
				...MARKET_SOURCES.flatMap((row) => (row[0] === "github-mcp" ? [row, CENSUS_OPTION] : [row])),
				...customSourceRows.map((s) => [s.id, s.label]),
			];
			// Custom ids are long and machine-made (`custom:raw-github…`); the
			// per-source counters line uses the label the user chose instead.
			const shortSourceName = (id) => SOURCE_SHORT[id]
				?? customSourceRows.find((s) => s.id === id)?.label
				?? (id.startsWith("custom:") ? id.slice(7, 21) : id);
			// Entries the listing marks as favourites (the host annotates every
			// item it returns). Only the loaded listing can be counted here; the
			// set's own size comes from `/favorites`.
			const favoriteCount = marketItems ? marketItems.filter((i) => i.favorite).length : 0;

			/**
			 * Read the favourite set itself, for its size.
			 *
			 * Failure is not an error state for the page: the filter still works
			 * off the listing's own marks, it just cannot say how many favourites
			 * the current view is hiding. So a failure leaves `favTotal` null and
			 * nothing is reported to the user.
			 */
			const loadFavorites = async () => {
				try {
					const body = await api("/favorites");
					setFavTotal(typeof body.count === "number" ? body.count : null);
				} catch {
					setFavTotal(null);
				}
			};

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
					if (!item.group) { uncategorized += 1; continue; }
					counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
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
					.filter((i) => !favOnly || i.favorite)
					// 「默认」 means the order the host sent: it walks the sources
					// round-robin so one marketplace cannot fill a page, and sorting
					// that by quality here threw the mix away and served five
					// S-ranked rows per page. A chosen order is applied; the
					// default is left exactly as it arrived.
					.slice()
					.sort((a, b) => (marketSort === "default" ? 0 : compareMarket(a, b, marketSort, repoStats)))
				: null), [marketItems, marketGroup, marketSort, repoStats, favOnly]);
			const pageCount = sortedItems ? Math.max(1, Math.ceil(sortedItems.length / pageSize)) : 0;
			const safePage = Math.min(marketPage, pageCount - 1);
			const pageItems = sortedItems
				? sortedItems.slice(safePage * pageSize, safePage * pageSize + pageSize)
				: null;
            const visibleMetricsKey = (pageItems ?? []).map(repoKeyOf).filter(Boolean).join('|');
            useEffect(() => {
                if (space !== "mcp" || tab !== "market" || marketBusy || !market) return;
                const items = detail ? [...(pageItems ?? []), detail] : pageItems ?? [];
                void enrichStars(items, market.metricsRefresh === true);
                void enrichMedia(items, market.metricsRefresh === true);
            }, [space, tab, market?.listingRevision, marketBusy, visibleMetricsKey, safePage, pageSize, marketGroup, marketSort, favOnly, detail?.id]);


			// The sub-line answers "what am I looking at" — see subLineText.
			const running = subLineText(hostStatus);
			const staleSource = hostStatus?.plugin?.source?.stale === true;

			// The credential line for the GitHub box. `source` is the host's
			// answer to "where did this come from" — a token the panel stored, an
			// environment variable, a local gh login, or nothing at all.
			const auth = hostStatus?.auth ?? null;
			const authLine = !auth
				? "宿主插件还是旧版本，读不到凭据状态"
				: auth.source === "anonymous"
					? "匿名访问 · 60 次/小时"
					: [
						`已认证${auth.login ? `：${auth.login}` : ""}`,
						auth.masked,
						auth.rateLimit
							? `剩余 ${compactCount(auth.rateLimit.remaining)}/${compactCount(auth.rateLimit.limit)}`
							: null,
						auth.source === "env"
							? "来自环境变量"
							: auth.source === "gh"
								? auth.cached
									// The login was found and validated once; this
									// startup reads that answer instead of making
									// gh log in again. Saying so is the difference
									// between "remembered" and "re-checked".
									? "本机 gh（沿用上次检测）"
									: "来自本机 gh"
								: null,
					].filter(Boolean).join(" · ");
			// Two different ways of asking the same question — "who is calling
			// GitHub?" — and which one the box offers depends on whether the
			// local one can answer. `needsLogin` means a token was tried and
			// refused, which is the same dead end as finding nothing.
			const showWebLogin = webLogin || auth?.needsLogin === true;
			// The two background walks this plugin runs, described separately.
			// One builds the local GitHub census (search API, one request every
			// 6.5s, at most 48); the other turns census rows into rows that carry
			// a runnable command (raw.githubusercontent, one request every 150ms,
			// up to 25 minutes and 6000 requests). They share no budget and no
			// clock — calling both "普查" is how a reader came to press the wrong
			// button and then wonder why the other one kept going.
			const census = hostStatus?.census ?? null;
			const censusWalk = census?.progress ?? null;
			const censusLine = !census
				? "宿主插件还是旧版本，读不到普查状态"
				: census.walking
					? [
						`正在普查：已收 ${compactCount(censusWalk?.rows ?? census.rows ?? 0)} 行`,
						censusWalk?.requests ? `${censusWalk.requests} 次请求` : null,
						"每 6.5 秒一次请求，可以随时停止",
					].filter(Boolean).join(" · ")
					: [
						census.rows ? `普查索引 ${compactCount(census.rows)} 行` : "还没有普查索引",
						census.at ? `${census.complete ? "读完于" : "上次读到"} ${sourceClock(census.at)}` : null,
						census.ended?.reason === "user" ? "上次是手动停止的" : null,
						typeof census.partial === "string" && census.partial ? `没读完：${clipReason(census.partial, 40)}` : null,
						census.damaged ? `文件损坏：${census.damaged}` : null,
					].filter(Boolean).join(" · ");

			// The recovery walk, in the same shape: what is on disk, whether a
			// pass is running, how far through its own plan it is, and — the file
			// cannot say this — whether it was a reader or the host unload that
			// ended the last one.
			const evidence = hostStatus?.evidence ?? null;
			const evidenceWalk = evidence?.progress ?? null;
			const evidencePlan = evidence?.plan ?? null;
			const evidencePartial = typeof evidence?.partial === "string" ? evidence.partial : "";
			const evidenceLine = !evidence
				? "宿主插件还是旧版本，读不到恢复安装命令的状态"
				: evidence.walking
					? [
						`正在恢复安装命令：已试 ${compactCount(evidenceWalk?.attempted ?? evidencePlan?.attempted ?? 0)} / ${compactCount(evidenceWalk?.planned ?? evidencePlan?.planned ?? 0)} 个仓库`,
						evidenceWalk?.id ? `正在读 ${String(evidenceWalk.id).replace(/^github:/, "")}` : null,
						evidenceWalk?.requests ? `${compactCount(evidenceWalk.requests)} 次请求` : null,
						"可以随时停止",
					].filter(Boolean).join(" · ")
					: [
						evidence.rows ? `查过 ${compactCount(evidencePlan?.attempted ?? evidence.rows)} 个仓库` : "还没有查过仓库",
						evidence.withCommand ? `恢复出 ${compactCount(evidence.withCommand)} 条安装命令` : null,
						evidence.at ? `${evidence.complete ? "读完于" : "上次读到"} ${sourceClock(evidence.at)}` : null,
						evidence.ended?.reason === "user" ? "上次是手动停止的" : null,
						evidencePartial ? `没读完：${evidencePartial}` : null,
						evidence.damaged ? `文件损坏：${evidence.damaged}` : null,
					].filter(Boolean).join(" · ");
			// What the button says: the two other labels are the same verb
			// ("start") because the walk itself skips rows that already have
			// evidence — "接着恢复" is only honest when there is something left.
			const evidenceButton = evidence?.walking
				? "停止恢复"
				: (evidencePartial || (evidencePlan?.remaining ?? 0) > 0 ? "接着恢复" : "开始恢复");

			// The GitHub access box is folded by default: it is four rows of
			// settings above a list the reader came for. It opens on request, and
			// it stays open while a census or a recovery walk is running — a
			// collapsed box while work is in flight would hide the progress and
			// the stop button exactly when they matter.
			const ghAccessOpen = ghAccessPinned || Boolean(census?.walking || evidence?.walking);

			// The one outlined control that belongs beside the sub-line rather
			// than in the run of text buttons on the first row.
            const highlightCount = marketSort === "default" && safePage === 0 && !marketAppliedQuery.trim() && !marketGroup && !favOnly && (pageItems?.length ?? 0) > 2 ? 2 : 0;
            const marketCard = (item, i, featured = false) => createElement(MarketCard, {
                key: `${item.source}:${item.id ?? item.title}`, item, stats: repoStats, busy,
                installing: installingKey === itemKeyOf(item), featured,
                rank: marketSort === "default" ? null : safePage * pageSize + i + 1,
                usageSort: marketSort === "installs", onInstall: doInstall, onOpen: setDetail, onToggleFavorite: doToggleFavorite,
            });
			const logButton = createElement("button", {
				key: "hd-log", type: "button", className: "omkt-btn omkt-btn-outline",
				style: styles.outlineBtn, onClick: doExportLog,
			}, "⤓ 导出日志");
			return createElement("div", { className: "omkt-page", style: styles.page, ref: pageRef }, [

                createElement("div", { key: "head", style: styles.headWrap }, [
                    createElement("div", { key: "hd-panel", className: spaceClasses("omkt-pagehead", space), style: styles.pageHead }, [
                        createElement("div", { key: "title", style: styles.titleRow }, [
                            createElement("span", { key: "mark", style: { ...styles.brandTile, width: 40, height: 40, background: MCP_SOFT, color: T.brand } }, brandMark(24)),
                            createElement("strong", { key: "name", style: styles.pageTitle }, "全局 MCP & Skill"),
                            createElement("span", { key: "version", style: styles.versionChip, title: "插件版本" }, `v${CLIENT_VERSION}`),
                            selfUpdate?.updateAvailable ? createElement("button", {
                                key: "hd-self", type: "button", style: { ...styles.button, ...styles.primary }, title: `更新到 v${selfUpdate.latest}`, disabled: busy, onClick: doSelfUpdate,
                            }, `更新到 v${selfUpdate.latest}`) : null,
                        ]),
                        createElement("div", { key: "actions", style: styles.headCol }, [
                            createElement("span", { key: "status", style: { ...styles.hint, display: "inline-flex", gap: 9, alignItems: "center", fontSize: 14, color: T.text } }, [
                                createElement("span", { key: "dot", style: { width: 7, height: 7, borderRadius: "50%", background: statusError ? T.red : hostStatus ? T.green : T.text4 } }),
                                statusError ? "连接异常" : hostStatus ? "宿主已连接" : "连接中…",
                            ]),
                            createElement("button", { key: "hd-events", type: "button", className: "omkt-btn", style: { ...styles.outlineBtn, fontSize: 14, display: "inline-flex", gap: 8, alignItems: "center" }, title: running, onClick: toggleLog, "aria-expanded": logOpen }, [createElement(UiIcon, { key: "icon", name: "diagnostics", size: 17 }), logOpen ? "收起诊断" : "运行诊断"]),
                            createElement(ActionMenu, { key: "more", label: "插件操作" }, [
                                createElement("button", { key: "scan", type: "button", style: styles.textBtn, disabled: busy, onClick: doScan }, "重新扫描宿主机"),
                                createElement("button", { key: "github", type: "button", style: styles.textBtn, onClick: () => { switchSpace("mcp"); setTab("registry"); setGhAccessPinned(value => !value); } }, "GitHub 访问设置"),
                                createElement("button", { key: "hd-updates", type: "button", style: styles.textBtn, disabled: busy, onClick: doCheckUpdates }, "检查更新"),
                                logButton,
                                starPill(),
                                close ? createElement("button", { key: "close", type: "button", style: styles.textBtn, onClick: close }, "关闭") : null,
                            ]),
                        ]),
                    ]),
                    staleSource ? createElement("div", { key: "stale", role: "status", style: styles.error }, "代码已更新，重启 DSH 后生效") : null,
                    statusError ? createElement("div", { key: "error", role: "alert", style: styles.error }, statusError) : null,
                ]),
				// 运行日志 — the host's own account of what this plugin did, which
				// outlives the request that produced it and the process that knew
				// the reason. Folded away until asked for.
				logOpen
					? createElement("div", { key: "log", style: styles.logBox }, [
                        createElement("div", { key: "build", style: styles.identText, title: running }, subLineText(hostStatus)),
						createElement("div", { key: "log-hd", style: styles.logHead }, [
							createElement("span", { key: "log-t", style: styles.logTitle },
								eventLog === null
									? "运行日志"
									: `运行日志 · 显示 ${eventLog.events.length} 条`
										+ (eventLog.total > eventLog.events.length ? `（共 ${eventLog.total} 条）` : "")
										+ (eventLog.damaged ? ` · ${eventLog.damaged} 行损坏` : "")),
							createElement("button", {
								key: "log-r", type: "button", className: "omkt-btn omkt-btn-text",
								style: styles.textBtn, disabled: logBusy, onClick: loadEvents,
							}, logBusy ? "读取中…" : "刷新"),
						]),
						createElement("div", { key: "log-body", style: styles.logBody },
							eventLog === null
								? "读取中…"
								: eventLog.note
									? eventLog.note
									: eventLog.events.length === 0
										? "这次运行还没有记录。"
										: eventLog.events.slice().reverse().map((event, index) => createElement("div", {
											key: `ev-${index}`,
										}, formatEvent(event)))),
					])
					: null,

				createElement("div", { key: "navigation", className: "omkt-navigation", style: { borderBottom: `1px solid ${T.line}`, marginBottom: 13 } }, [
					createElement("div", {
						key: "spaces", className: "omkt-spaceswitch", style: styles.spaceSwitch, role: "tablist", "aria-label": "资源",
						tabIndex: 0, onKeyDown: onSpacesKeyDown,
					}, [
						...[["mcp", "MCP"], ["skill", "Skill"]].map(([id, label]) => createElement("button", {
							key: id, type: "button", role: "tab", tabIndex: -1, className: "omkt-spacep",
							"aria-selected": space === id ? "true" : "false",
							style: { ...styles.spacePill, ...(space === id ? styles.spacePillOn : {}) },
							onClick: () => { if (space !== id) switchSpace(id); },
						}, label)),
						createElement("span", { key: "divider", "aria-hidden": true, style: { marginInlineStart: 2, width: 1, height: 17, background: T.line } }),
					]),
				createElement("div", { key: "tabs", className: spaceClasses("omkt-tabbar", space), role: "tablist", "aria-label": "页面", style: { ...styles.tabBar, gap: 12, marginBottom: 0 } },
					space === "mcp"
						? [
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
							}, "市场"),
							createElement("button", {
								key: "calls", type: "button", className: "omkt-tab",
								role: "tab", "aria-selected": tab === "calls" ? "true" : "false",
								style: { ...styles.tab, ...(tab === "calls" ? styles.tabActive : {}) },
								onClick: () => setTab("calls"),
							}, "调用记录" + (callBadges.mcp ? " (" + callBadges.mcp + ")" : "")),
						]
						: [
							createElement("button", {
								key: "skills", type: "button", className: "omkt-tab",
								role: "tab",
								// Only 市场 and 调用 take the highlight away: everything else
								// in this space is the 已注册 list, so comparing against
								// "skillmarket" alone lit this tab up while 调用 was open.
								"aria-selected": tab === "skillmarket" || tab === "calls" ? "false" : "true",
								style: { ...styles.tab, ...(tab === "skillmarket" || tab === "calls" ? {} : styles.tabActive) },
								onClick: () => setTab("skillregistry"),
							}, `已注册${skills ? ` (${skills.totals?.count ?? (skills.skills?.length ?? 0)})` : ""}`),
							createElement("button", {
								key: "skillmarket", type: "button", className: "omkt-tab",
								role: "tab", "aria-selected": tab === "skillmarket" ? "true" : "false",
								style: { ...styles.tab, ...(tab === "skillmarket" ? styles.tabActive : {}) },
								onClick: () => setTab("skillmarket"),
							}, "市场"),
							createElement("button", {
								key: "calls", type: "button", className: "omkt-tab",
								role: "tab", "aria-selected": tab === "calls" ? "true" : "false",
								style: { ...styles.tab, ...(tab === "calls" ? styles.tabActive : {}) },
								onClick: () => setTab("calls"),
							}, "调用记录" + (callBadges.skill ? " (" + callBadges.skill + ")" : "")),
						]),
                    createElement("button", { key: "directory", type: "button", "aria-label": "管理目录源", title: "管理目录源", style: { ...styles.textBtn, display: "inline-flex", gap: 8, alignItems: "center", marginLeft: "auto", fontSize: 14, minHeight: 34, flexShrink: 0, whiteSpace: "nowrap" }, onClick: () => { switchSpace("mcp"); setTab("market"); setCatalogDetailsOpen(true); setSourcesOpen(true); } }, [createElement(UiIcon, { key: "icon", name: "layers", size: 17 }), createElement("span", { key: "label", className: "omkt-directory-label" }, "管理目录源")]),
                ]),

				// ---------------- calls tab ----------------
				// Read-only: every control on it filters what the host already
				// recorded, so this tab can never change a configuration.
				space && tab === "calls" ? createElement("div", {
					// Its own header stays put and the timeline scrolls: the panel
					// owns the one scroller (see CallPanel).
					key: "callsbody", className: "omkt-tabbody", style: styles.market,
				}, [
					createElement(CallsPanel, {
						key: "panel",
						space,
						data: calls,
						error: callsError,
						busy: callsBusy,
						range: callRange,
						onRange: setCallRange,
						merge: callMerge,
						onMerge: (next) => {
							setCallMergeChoice(next);
							// Remembered on the host: the page cannot persist it (the GUI's
							// port changes between restarts, so browser storage is per run).
							api("/prefs", { method: "POST", body: JSON.stringify({ merge: next }) }).catch((err) => setCallsNote(`合并设置保存失败：${err.message || err}`));
						},
						query: callQuery,
						onQuery: setCallQuery,
						onSearch: () => loadCalls({}),
						filter: callFilter,
						onFilter: setCallFilter,
						onExport: exportCalls,
						note: callsNote,
                        view: callView,
                        onView: patch => setCallView(previous => ({ ...previous, ...patch })),
                        onDiagnostics: () => { if (!logOpen) toggleLog(); },
					}),
				]) : null,
				// ---------------- skill market tab ----------------
				// Its own body, because the four upstreams answer separately and the
				// per-source chips are the answer to "which one is empty".
				space === "skill" && tab === "skillmarket" ? createElement("div", {
					key: "skillmarketbody", className: "omkt-tabbody", style: styles.market,
				}, [
                    skillsError ? createElement("div", { key: "scan-error", role: "alert", style: styles.error }, `技能列表读取失败，已安装状态可能尚未同步：${skillsError}`) : null,
					skillNote ? createElement("div", { key: "note", style: styles.message }, skillNote) : null,
                    skillMetricNote ? createElement("div", { key: "metrics-note", role: "status", style: styles.hint }, skillMetricNote) : null,
					createElement(SkillMarket, {
						key: "market", sort: skillMarketSort, onSort: (next) => {
							setSkillMarketSort(next);
							return loadSkillMarket({ sort: next, offset: 0 });
						},
						data: skillMarket,
						error: skillMarketError,
						busy: skillMarketBusy,
						query: skillMarketQuery,
						appliedQuery: skillMarketAppliedQuery,
						onQuery: setSkillMarketQuery,
						source: skillMarketSource,
						onSource: (next) => {
							setSkillMarketSource(next);
							return loadSkillMarket({ source: next, offset: 0 });
						},
						category: skillMarketCategory,
						onCategory: (next) => {
							setSkillMarketCategory(next);
							return loadSkillMarket({ category: next, offset: 0 });
						},
						page: skillMarketPage,
						pageSize: skillMarketPageSize,
						onPage: (next) => skillMarket?.paging
							? loadSkillMarket({ offset: next * skillMarketPageSize }) : setSkillMarketPage(next),
						onPageSize: (size) => {
							setSkillMarketPageSize(size);
							setSkillMarketPage(0);
							return loadSkillMarket({ limit: size, offset: 0 });
						},
						onSearch: () => {
							setSkillMarketPage(0);
							return loadSkillMarket({ query: skillMarketQuery, offset: 0 });
						},
						onRefresh: () => {
							setSkillMarketQuery(skillMarketRequest.current.filters.query);
							return loadSkillMarket({ refresh: true });
						},
						installing: skillMarketInstalling,
						installed: skillMarketInstalled,
						onInstall: doInstallMarket,
						// Three separate facts, kept separate on purpose: what the
						// index holds (`index`), whether a walk is in flight (`walk`),
						// and the verb that changes either one.
						index: skillMarket && skillMarket.index ? skillMarket.index : null,
						walk: skillMarket && skillMarket.walk
							? skillMarket.walk
							: (hostStatus && hostStatus.skillIndex && hostStatus.skillIndex.walking
								? (hostStatus.skillIndex.progress ?? { requests: 0, rows: 0 })
								: null),
						walkBusy: skillWalkBusy,
						fullSel: skillFullSel,
						onFullSel: toggleSkillFull,
						onWalk: skillIndexAction,
					}),
				]) : null,

				error ? createElement("div", { key: "error", style: styles.error }, error) : null,
				installFailure ? createElement("div", { key: "installfail", style: styles.installFailure }, installFailure) : null,
				message ? createElement("div", { key: "message", style: styles.message }, message) : null,
				registryError ? createElement("div", { key: "regwarn", style: styles.registryWarn }, `⚠ ${registryError}`) : null,

				// ---------------- registry tab ----------------
				// Both 已注册 bodies are chrome + one scrolling box: the filter row
				// sits outside it so the scrollbar belongs to the list and starts
				// below the header. The `scroller` hook lives on that inner box — it
				// is a *descendant* of the page rather than an ancestor, so the
				// return-to-top effect could never find it by walking up (the button
				// stayed hidden on this tab no matter how far the list was scrolled).
				// ---------------- skill space ----------------
				// The MCP bodies below are skipped wholesale while this space is on
				// screen: they fetch nothing on their own, but rendering them would
				// still show the other space's numbers.
				space === "skill" && tab !== "skillmarket" && tab !== "calls" ? createElement("div", {
					// Not the scroller any more: the filter row is chrome above it and
					// the list has its own box, so the scrollbar spans only the list
					// (same shape as the market tab). `data-omkt="scroller"` moved to
					// that inner box or the return-to-top button would bind to a box
					// that never scrolls.
					key: "skillbody", className: "omkt-tabbody", style: styles.market,
				}, [
					skillNote ? createElement("div", { key: "note", style: styles.message }, skillNote) : null,
					createElement(SkillPanel, {
						key: "panel",
						data: skills,
						error: skillsError,
						busy: skillsBusy,
						query: skillQuery,
						onQuery: setSkillQuery,
						root: skillRoot,
                        view: skillRegistryView,
                        onView: patch => setSkillRegistryView(previous => ({ ...previous, ...patch })),
						onRoot: setSkillRoot,
						onOpen: setSkillTarget,
						onReveal: doRevealSkill,
						onRemove: setSkillRemove,
						onRefresh: () => { void loadSkills({ refresh: true }).catch(() => { /* loadSkills renders the scan error */ }); },
					}),
				]) : null,

				space === "mcp" && tab === "registry" ? createElement("div", {
					// The registry body is chrome + one scrolling box, not one big
					// scroller: the filter row stays fixed above the server list, so
					// the scrollbar starts under it instead of running up beside it.
					key: "reg", className: "omkt-tabbody", style: styles.market,
				}, [
					createElement("div", { key: "reghead", style: styles.regHeader }, [
                    createElement(PageHeading, { key: "heading", title: "已注册 MCP", hint: "管理连接器与连接状态", actions: [
                        createElement("button", { key: "scan", type: "button", className: "omkt-btn", style: styles.button, disabled: busy, onClick: doScan }, "重新扫描"),
                        createElement("button", { key: "market", type: "button", className: "omkt-btn", style: { ...styles.button, ...styles.primary }, onClick: () => setTab("market") }, "添加连接器"),
                    ] }),
					createElement("div", { key: "stats", style: styles.stats }, [
						createElement("span", { key: "t" }, `${stats.total} 台服务器`),
						createElement("span", { key: "e" }, `${stats.enabled} 已启用`),
						createElement("span", { key: "d" }, `${stats.disabled} 已停用`),
						createElement("span", { key: "c" }, `${stats.connected} 已连接`),
						stats.failed ? createElement("span", { key: "f", style: styles.error }, `${stats.failed} 连接异常`) : null,
					]),
                    firstFailedServer ? createElement("div", { key: "connection-warning", role: "alert", style: { display: "flex", gap: 12, alignItems: "center", padding: "3px 16px", minHeight: 40, border: "1px solid rgba(255,125,0,.3)", background: "rgba(255,125,0,.07)", borderRadius: 9, fontSize: 14 } }, [
                        createElement("span", { key: "icon", style: { color: T.amber } }, "ⓘ"),
                        createElement("span", { key: "reason", style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: firstFailedServer.error || healthLine(firstFailedServer.health) }, `${firstFailedServer.name} · ${firstFailedServer.error || healthLine(firstFailedServer.health)}`),
                        createElement("button", { key: "diagnosis", type: "button", style: { ...styles.textBtn, color: T.brand }, disabled: busy || checkingKeys.includes(rowKey(firstFailedServer)), onClick: () => { setSourceFilter(""); setStateFilter(""); setNameFilter(firstFailedServer.name); doHealth(firstFailedServer); } }, "查看诊断"),
                    ]) : null,
					!error && servers === null ? createElement("div", { key: "loading", style: styles.message }, "加载中…") : null,
					// 来源已删除 — records the last scan proved no config file on
					// this machine still defines. They are one kind of leftover (the
					// old `name-<source>` rename left four of them), so they get one
					// action for the whole set. The bar says why they are listed at
					// all rather than quietly dropping them: a record nobody wrote
					// deserves an explanation, not a silent edit of the registry.
					orphans.length > 0
						? createElement("div", { key: "orphanbar", style: styles.updateBar }, [
							createElement("span", { key: "msg", style: styles.jobMsg, title: orphans.map((s) => `${s.name}（${sourceLabel(s.source)}）`).join("\n") },
								`${orphans.length} 条记录的来源配置里已经没有它们了（${[...new Set(orphans.map((s) => sourceLabel(s.source)))].join("、")}）`),
							createElement("span", { key: "spacer", style: styles.spacer }),
							createElement("button", {
								key: "clean", type: "button", className: "omkt-btn",
								style: styles.button, disabled: busy,
								title: "从本插件的注册表里删掉这些记录；它们已经没有配置文件定义，也不会提供任何工具",
								onClick: doCleanOrphans,
							}, `清理 ${orphans.length} 条`),
						])
						: null,
					// 更新队列 — under 已注册, because those are the rows it
					// updates. It appears only while there is something to
					// update or something to report, so an idle page keeps no
					// furniture: a listing whose updates were all answered is
					// not 「something to update」 any more.
					pending.length > 0 || updateJobs
						? createElement("div", { key: "updatebar", style: styles.updateBar }, [
							createElement("button", {
								key: "all", type: "button",
								className: queueSettled ? "omkt-btn omkt-btn-done" : "omkt-btn omkt-btn-primary",
								style: { ...styles.button, ...styles.primary },
								// No updatable server is not an error state: the
								// button stays in place and disabled, because it is
								// the affordance 「检查更新」 fills in — and once this
								// queue settles it turns into the outcome itself.
								disabled: busy || pending.length === 0 || queueSettled,
								title: pending.length
									? `依次更新这 ${pending.length} 台有可用更新的服务器`
									: "当前没有检测到可更新的服务器（先点「检查更新」）",
								onClick: doUpdateAll,
							}, updateRunning && updateJobs.total > 1
								? "更新中…"
								: queueSettled
									// The queue answered its own question: this slot
									// reports the outcome instead of offering the
									// same batch again off a stale count.
									? `✓ 已完成${jobsUpdated > 0 ? `（${jobsUpdated} 台已更新）` : "（无需更新）"}`
									: `全部更新${pending.length ? `（${pending.length}）` : ""}`),
							updateJobs
								? [
									createElement("div", {
										key: "track", className: `omkt-progress${updateRunning ? " omkt-progress-live" : ""}`,
										// A finished queue has no progress left to
										// report: the outcome above says the rest,
										// and a full black track next to 「已完成」
										// still reads as work in flight.
										style: queueSettled ? { ...styles.progressTrack, display: "none" } : styles.progressTrack, role: "progressbar",
										"aria-valuemin": 0, "aria-valuemax": updateJobs.total,
										"aria-valuenow": updateJobs.done,
										"aria-label": `MCP 更新进度：已完成 ${updateJobs.done}/${updateJobs.total}`,
									}, createElement("div", {
										key: "fill",
										style: { ...styles.progressFill, width: `${updateProgress}%` },
									})),
									createElement("span", { key: "text", style: styles.progressText },
										updateRunning
											? `${updateJobs.done}/${updateJobs.total} · 正在更新 ${updateJobs.current} · 已用时 ${updateElapsed}s`
											: `已用时 ${updateElapsed}s`),
									updateJobs.items.length > 1
										? createElement("button", {
											key: "togglejobs", type: "button", className: "omkt-btn omkt-btn-text",
											style: styles.textBtn, "aria-expanded": jobsOpen ? "true" : "false",
											onClick: () => setJobsOpen((v) => !v),
										}, jobsOpen ? "收起明细" : "展开明细")
										: null,
									// A finished bar is dismissible; a running one is
									// not, because hiding it would hide the only
									// sign that a long rewrite is still in flight.
									updateRunning ? null : createElement("button", {
										key: "clearjobs", type: "button", className: "omkt-btn omkt-btn-text",
										style: styles.textBtn,
										onClick: closeJobs,
									}, "关闭进度"),
									updateJobs.items.length > 1 && jobsOpen
										? createElement("div", { key: "jobs", className: "omkt-jobs", style: styles.jobList },
											updateJobs.items.map((it) => createElement("div", {
												key: it.key ?? it.name, style: styles.jobRow,
											}, [
												createElement("span", { key: "icon", style: jobIconStyle(it.status) },
													JOB_ICON[it.status] ?? "·"),
												createElement("span", { key: "n", style: styles.jobName }, it.name),
												createElement("span", { key: "m", style: styles.jobMsg },
													it.message || JOB_TEXT[it.status] || ""),
											])))
										: null,
								]
								: null,
						])
						: null,
					// GitHub 访问 — the census and the market's GitHub sources both
					// read github.com, and anonymously that is 60 requests an hour
					// for the whole machine. It sits in 已注册 because that is
					// where its effect shows (普查 rows still missing an install
					// command). Folded by default: the header line keeps the state
					// visible (已认证 / 匿名 · 剩余次数), so a credential nobody can
					// find is still one click away without four rows of chrome
					// standing between the reader and the server list.
					createElement("div", { key: "authbox", hidden: !ghAccessOpen && !auth?.error && !authNote, style: styles.sourceBox }, [
						createElement("div", { key: "head", style: styles.sourceHead }, [
							createElement("button", {
								key: "t", type: "button",
								style: {
									...styles.textBtn, fontWeight: 600, color: T.text,
									padding: 0, background: "transparent", border: "none", cursor: "pointer",
								},
								"aria-expanded": ghAccessOpen ? "true" : "false",
								title: ghAccessOpen
									? "收起 GitHub 访问设置（token、普查、恢复安装命令）"
									: "展开 GitHub 访问设置：token、普查、恢复安装命令",
								// Pin the opposite of what is *shown*, not of what is
								// pinned: while a walk forces the box open, flipping
								// `pinned` would leave it stuck open after the walk ends.
								onClick: () => setGhAccessPinned(!ghAccessOpen),
							}, (ghAccessOpen ? "▾ " : "▸ ") + "GitHub 访问"),
							createElement("span", {
								key: "s", style: styles.hint,
								title: auth?.checkedAt ? `上次校验：${auth.checkedAt}` : undefined,
							}, authLine),
							createElement("span", { key: "spacer", style: styles.spacer }),
							// One slot, two verbs, chosen by whether the local
							// answer exists. Repeating 「检测本机登录」 after it
							// just reported nothing is the definition of a dead
							// button; the web path is offered instead, and the
							// detection stays one small step away for the case
							// where `gh` was logged in meanwhile.
							showWebLogin
								? createElement("a", {
									key: "ghweb", className: "omkt-btn omkt-btn-outline",
									style: styles.sourceMiniBtn,
									href: GH_TOKEN_URL, target: "_blank", rel: "noreferrer",
									title: "在 github.com 创建一个只读 token（read:user），粘贴到左边的输入框再点保存",
									onClick: (e) => openExternal(e, GH_TOKEN_URL),
								}, "去网页登录")
								: createElement("button", {
									key: "gh", type: "button", className: "omkt-btn omkt-btn-outline",
									style: styles.sourceMiniBtn, disabled: authBusy,
									title: "让宿主机执行 `gh auth token`，用你本机已经登录的账号；凭据由宿主进程持有，本页面只看到掩码",
									onClick: discoverGithubLogin,
								}, authBusy ? "处理中…" : "检测本机登录"),
							showWebLogin
								? createElement("button", {
									key: "ghretry", type: "button", className: "omkt-btn omkt-btn-text",
									style: styles.textBtn, disabled: authBusy,
									title: "如果你刚在终端里 `gh auth login` 过，再试一次本机检测",
									onClick: discoverGithubLogin,
								}, authBusy ? "处理中…" : "再检测一次")
								: null,
							auth && auth.source !== "anonymous"
								? createElement("button", {
									key: "del", type: "button", className: "omkt-btn omkt-btn-outline",
									style: { ...styles.sourceMiniBtn, ...styles.sourceMiniBtnDanger },
									disabled: authBusy,
									title: auth.source === "env"
										? "这份来自你启动 DSH 时的环境变量，本插件只能移除自己保存的那份"
										: "删掉 github-auth.json，回到每小时 60 次请求",
									onClick: clearGithubToken,
								}, "移除")
								: null,
						]),
						// Everything but the header: the token field, the explanation,
						// the census verb and the recovery verb. Hidden by display
						// rather than unmounted so the walk's progress line and the
						// stop button keep their state while folded away.
						createElement("div", { key: "authbody", style: { display: ghAccessOpen ? "block" : "none" } }, [
						createElement("div", { key: "row", style: styles.sourceRow }, [
							createElement("input", {
								key: "in", className: "omkt-input", style: styles.sourceInput,
								type: "password", value: authDraft, spellCheck: false, autoComplete: "off",
								placeholder: "粘贴 GitHub token（ghp_… 或 github_pat_…）",
								onChange: (e) => setAuthDraft(e.target.value),
								onKeyDown: (e) => { if (e.key === "Enter") saveGithubToken(); },
							}),
							createElement("button", {
								key: "save", type: "button", className: "omkt-btn omkt-btn-outline",
								style: styles.sourceMiniBtn,
								disabled: authBusy || !authDraft.trim(),
								onClick: () => saveGithubToken(),
							}, authBusy ? "处理中…" : "保存"),
						]),
						createElement("div", { key: "tip", style: { ...styles.hint, paddingTop: 2 } },
							"不填也能跑：匿名每小时 60 次请求，填一个只读 token 后 5000 次/小时。token 存在本机数据目录的 github-auth.json（只有本插件读它），只发给 api.github.com 与 raw.githubusercontent.com；页面拿到的永远只是掩码。"),
						// Only in the empty-handed state: the steps in the order a
						// reader performs them, since the box otherwise assumes
						// they already have a token to paste.
						showWebLogin
							? createElement("div", { key: "weblogin", style: styles.hint },
								"本机没有可用的 gh 登录。点「去网页登录」在 github.com 创建只读 token（read:user），粘贴到上面的输入框点保存；之后每次启动都直接用它，不会再检测本机。")
							: null,
						auth?.error
							? createElement("div", { key: "autherr", style: styles.error }, `⚠ ${auth.error}`)
							: null,
						authNote ? createElement("div", { key: "note", style: styles.hint }, authNote) : null,
						// The census, with the two verbs a reader owns. It used to
						// be reachable only as a side effect of browsing the GitHub
						// source and stoppable only by restarting DSH; the line is
						// always here because "is one running?" is a question the
						// answer to which changes what the buttons do.
						census
							? createElement("div", { key: "censusline", style: styles.sourceRow }, [
								createElement("span", {
									key: "m", style: styles.jobMsg,
									title: census.walking
										? "普查按 6.5 秒一个请求走，最长 48 个请求；索引每收一批就落盘，停止不会丢掉已收到的"
										: "普查结果存在本机数据目录的 github-index.json，读它不花网络请求",
								}, censusLine),
								createElement("span", { key: "spacer", style: styles.spacer }),
								census.walking
									? createElement("button", {
										key: "stop", type: "button", className: "omkt-btn omkt-btn-outline",
										style: { ...styles.sourceMiniBtn, ...styles.sourceMiniBtnDanger },
										disabled: authBusy,
										title: "停止当前普查；已收到的行会保留，下次「开始普查」从剩下的仓库接着走",
										onClick: () => censusAction("stop"),
									}, "停止普查")
									: createElement("button", {
										key: "start", type: "button", className: "omkt-btn omkt-btn-outline",
										style: styles.sourceMiniBtn, disabled: authBusy,
										title: "现在就走一遍普查（不等缓存过期）；已收到的不重读，只补缺的",
										onClick: () => censusAction("start"),
									}, "开始普查"),
							])
							: null,
						// The recovery walk, with its own verbs. Same reasoning as
						// the census line, and one more: this is the walk that reads
						// two thousand repositories at 150ms each, so the reader who
						// started it is the one who most needs to be able to end it.
						// The partial text ("上次没读完：…") rides in this line rather
						// than in a row of its own, because it is the same subject.
						evidence
							? createElement("div", { key: "evidenceline", style: styles.sourceRow }, [
								createElement("span", {
									key: "m", style: styles.jobMsg,
									title: evidence.walking
										? "恢复安装命令按 0.15 秒一个请求走，一轮最多 25 分钟 / 6000 个请求；每读到一个仓库就落盘，停止不会丢掉已恢复的"
										: "恢复出的命令存在本机数据目录的 install-evidence.json；每条都带出处，且都去 npm / PyPI 确认过包存在",
								}, evidenceLine),
								createElement("span", { key: "spacer", style: styles.spacer }),
								evidence.walking
									? createElement("button", {
										key: "stop", type: "button", className: "omkt-btn omkt-btn-outline",
										style: { ...styles.sourceMiniBtn, ...styles.sourceMiniBtnDanger },
										disabled: authBusy,
										title: "停止恢复；已读到的仓库会保留，下次接着读剩下的",
										onClick: () => evidenceAction("stop"),
									}, "停止恢复")
									: createElement("button", {
										key: "start", type: "button", className: "omkt-btn omkt-btn-outline",
										style: styles.sourceMiniBtn, disabled: authBusy,
										title: evidencePartial
											? "从上次停下的地方接着读剩下的仓库，不会从头再来"
											: "把还没有安装命令的行补上（已恢复的仓库不重读）",
										onClick: () => evidenceAction("start"),
									}, evidenceButton),
							])
							: null,
						]),
					]),
					// 「N 台还差配置」: the one line that turns a per-row badge into
					// something a reader notices without scanning the list. It sits
					// above the filters because it is about the whole page, not a
					// filtered view of it.
					needConfigCount > 0
						? createElement("div", {
							key: "needconfig", style: styles.configBanner,
						}, [
							createElement("span", { key: "t" },
								`有 ${needConfigCount} 台服务器装好了但还差配置：工具调用在填好之前不会通。`),
							createElement("span", { key: "sp", style: styles.spacer }),
							createElement("button", {
								key: "go", type: "button", className: "omkt-btn omkt-btn-primary",
								style: { ...styles.button, ...styles.primary, padding: "4px 12px", fontSize: 12.5 },
								onClick: () => {
									const first = all.find((s) => s.needConfig === true && s.enabled !== false);
									if (first) setConfigTarget(first);
								},
							}, "去配置"),
						])
						: null,
                    servers ? createElement("div", { key: "filters", className: "omkt-reg-filters", style: styles.filters }, [
                        createElement(SearchField, { key: "name", value: nameFilter, onChange: value => { setNameFilter(value); changeRegistryView({ page: 0 }); }, label: "搜索 MCP", placeholder: "搜索名称或用途…", style: { flex: "1 1 240px" } }),
						createElement("select", {
							key: "source", className: `omkt-select${sourceFilter ? " omkt-select-on" : ""}`,
							style: sourceFilter ? { ...styles.select, ...styles.filterSelectOn } : styles.select,
							value: sourceFilter,
							title: sourceFilter ? `来源：${sourceLabel(sourceFilter)}` : "按来源筛选",
							onChange: (e) => { setSourceFilter(e.target.value); changeRegistryView({ page: 0 }); },
						}, [
							createElement("option", { key: "", value: "" }, "全部来源"),
							...sourceOptions.map((s) => createElement("option", { key: s, value: s }, sourceLabel(s))),
						]),
						createElement("select", {
							key: "state", className: `omkt-select${stateFilter ? " omkt-select-on" : ""}`,
							style: stateFilter ? { ...styles.select, ...styles.filterSelectOn } : styles.select,
							value: stateFilter,
							title: stateFilter ? "按连接状态筛选" : "全部状态",
							onChange: (e) => { setStateFilter(e.target.value); changeRegistryView({ page: 0 }); },
						}, [
							createElement("option", { key: "", value: "" }, "全部状态"),
							createElement("option", { key: "enabled", value: "enabled" }, "已启用"),
							createElement("option", { key: "disabled", value: "disabled" }, "已停用"),
							createElement("option", { key: "connected", value: "connected" }, "已连接"),
							createElement("option", { key: "failed", value: "failed" }, "连接异常"),
						]),
                        createElement("button", { key: "grouping", type: "button", style: { ...styles.button, ...(groupBySource ? { color: T.brand, background: MCP_SOFT } : {}) }, "aria-pressed": groupBySource, onClick: () => { setGroupBySource((value) => !value); changeRegistryView({ page: 0 }); } }, [createElement(UiIcon, { key: "icon", name: "layers", size: 17 }), "按来源分组"]),
					]) : null,
					]),
					// The list is the only thing that scrolls; the return-to-top button
					// binds to this box (`data-omkt="scroller"`).
					createElement("div", { key: "regscroll", ref: registryScroll, "data-omkt": "scroller", style: styles.regScroll }, [
					servers && servers.length === 0
						? createElement("div", { key: "empty", style: styles.message },
							"注册表为空，点击「重新扫描宿主机」导入已有 MCP 配置。")
						: null,
					servers && servers.length > 0 && groups.length === 0
						? createElement("div", { key: "nomatch", style: styles.message }, "没有符合筛选条件的服务器。")
						: null,
					...(groupBySource ? registryPageGroups.map(([source, list]) => createElement(SourceGroup, {
						key: source, source, servers: list, allServers: all.filter(row => (row.source || "manual") === source), busy, checkingKeys, hintingKey: configHintKey, jobOf,
						collapsed: collapsed.has(source),
						onToggleCollapsed: () => toggleCollapsed(source),
						onToggleSource: doToggleSource,
						onToggleServer: doToggle,
						onRemove: doRemove,
						onUpdate: doUpdate,
						onConfigure: doConfigure,
						onHealth: doHealth,
					})) : [createElement("div", { key: "flat", className: "omkt-reg-table" }, [createElement(RegistryColumns, { key: "columns" }), ...registryPageRows.map((server) => createElement(ServerRow, {
                        key: rowKey(server), server, busy, checking: checkingKeys.includes(rowKey(server)), hinting: configHintKey === rowKey(server), job: jobOf(server),
                        onToggle: doToggle, onRemove: doRemove, onUpdate: doUpdate, onConfigure: doConfigure, onHealth: doHealth,
                    }))]) ]),
					]),
                    servers ? createElement(PageFooter, { key: "registry-pager", page: registryPage, pageCount: registryPageCount,
                        pageSize: registryView.pageSize, onPage: page => changeRegistryView({ page }),
                        onPageSize: pageSize => changeRegistryView({ pageSize, page: 0 }),
                        note: registryPageRows.length ? `显示 ${registryStart + 1}–${registryStart + registryPageRows.length} 项，共 ${registryRows.length} 项` : "显示 0 项",
                    }) : null,
				]) : null,

				// ---------------- market tab ----------------
				space === "mcp" && tab === "market" ? createElement("div", {
					key: "mkt", className: "omkt-tabbody", "data-omkt": "market", style: styles.market,
				}, [
                    createElement(PageHeading, { key: "heading", title: "发现 MCP 连接器", hint: market ? `${compactCount(market.total ?? marketItems.length)} 个可用连接器` : "浏览各个目录源的连接器", actions: [
                        createElement("span", { key: "coverage", style: { fontSize: 13, color: T.text3 } }, market?.counts ? `聚合 ${Object.keys(market.counts).length} 个目录源${market.deduped ? " · 已去重" : ""}` : ""),
                        createElement("button", { key: "sources", type: "button", style: { ...styles.textBtn, color: T.brand }, "aria-expanded": catalogDetailsOpen, onClick: () => setCatalogDetailsOpen(value => !value) }, "来源详情"),
                    ] }),
                    createElement(MarketToolbar, {
                        key: "toolbar", query: marketQuery, onQuery: setMarketQuery, onSearch: () => loadMarket({ query: marketQuery }), busy: marketBusy,
                        source: marketSource, sources: marketSourceOptions.map(([value, label]) => [value, value ? label : "全部来源"]),
                        onSource: value => { setMarketSource(value); setMarketGroup(""); loadMarket({ source: value }); },
                        category: marketGroup, onCategory: value => { setMarketGroup(value); setMarketPage(0); },
                        categories: [["", "全部分类"], ...groupOptions.map(([name]) => [name, name === "__none__" ? "未分类" : name])],
                        sort: marketSort, sorts: SORT_OPTIONS.map(([value, label]) => [value, value === "default" ? "推荐排序" : label]), onSort: value => { setMarketSort(value); setMarketPage(0); },
                        favOnly, onFavorite: async () => { const next = !favOnly; setFavOnly(next); setMarketPage(0); if (next && favTotal === null) await loadFavorites(); },
                        onRefresh: () => { setMarketQuery(marketRequest.current.filters.query); return loadMarket({ refresh: true, keepPage: true }); },
                    }),
					// 「使用量最多」 sums three counters that do not share a unit:
					// Smithery's invocation count, Docker's pull count and this
					// panel's own install count (`usageOf`). The cards state each
					// number with its own label, so the sorted order needs the same
					// caveat — otherwise the label reads as one comparable metric.
					marketSort === "installs"
						? createElement("div", { key: "installnote", style: styles.hint },
							"使用量最多：Smithery 的调用次数 + Docker 的拉取次数 + 本面板的安装次数；三者单位不同，仅作热度参考。")
						: null,
					// The filter is a view over the loaded listing, so a favourite
					// kept under another source (or hidden by the search box) is not
					// on screen. The host's own count is what tells "没有收藏" apart
					// from "这个筛选下没有" — and it is asked for only when needed.
					favOnly && favTotal !== null && favTotal > favoriteCount
						? createElement("div", { key: "favnote", style: styles.hint },
							`共 ${favTotal} 条收藏；当前来源与搜索下能看到 ${favoriteCount} 条。`)
						: null,
                    createElement("details", { key: "catalog-details", open: true, hidden: !catalogDetailsOpen && !sourcesOpen && !sourceNote && !catalogSources?.error, style: { fontSize: 13, color: T.text3 } }, [
                        createElement("summary", { key: "summary", style: { cursor: "pointer", padding: "2px 0" } }, `目录源与数据详情${market?.counts ? ` · ${Object.keys(market.counts).length} 个来源` : ""}${marketAt ? ` · 读取于 ${marketAt}` : ""}`),
                        createElement("div", { key: "details", style: { display: "grid", gap: 8, paddingTop: 8, maxHeight: 240, overflow: "auto" } }, [
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
								? createElement("span", { key: "at", style: styles.metaTail,
									// Three clocks meet on this tab and used to all read
									// 「更新于」: when a repository was pushed upstream
									// (the cards), when a source's data was walked (the
									// source line), and when *we* read the catalogs.
									// This one is the third, and now says so.
									title: "本地读取时间：这些目录数据是什么时候取到的，不是条目在上游的发布时间" },
									`列表读取于 ${marketAt}${market && market.cached ? "（缓存）" : ""}`
									+ (market && market.notModified > 0
										// Conditional requests mean a re-walk can cost
										// nothing; say so, or "refreshed" and "not
										// refetched" look identical from here.
										? ` · ${market.notModified} 源未变`
										: ""))
								: null,
						].filter(Boolean))
						: createElement("div", { key: "meta", style: styles.metaLine }, "正在发现…"),
					// Provenance counts are facts about the catalogue, not
					// controls, so they get a quiet line of their own instead of
					// competing with the chip row. Each source carries its own age
					// and state because they now age independently: one can answer
					// from a TTL entry while another re-validates upstream.
					market && market.counts
						? createElement("details", { key: "srcline", style: styles.hint }, [
                            createElement("summary", { key: "summary", style: { cursor: "pointer" } }, "来源详情 · " + Object.keys(market.counts).length + " 个目录源"),
                            createElement("div", { key: "data", style: { paddingTop: 6 },
							title: "各来源的数字是去重后计入本页的条数；括号里是来源自己的状态与本地时间（读取/普查），不是上游发布时间" },
							[
								Object.entries(market.counts)
									.map(([s, n]) => {
										const st = market.sources?.[s];
										const state = st?.error ? "不可用" : st?.stale ? "旧" : st?.cached ? "缓存" : "";
										const at = sourceClock(st?.at);
										// "部分" flags a source whose own note says the list is
										// cut short (see the 内置 line below for the reason).
										const marks = [state, st?.note ? "部分" : "", at].filter(Boolean);
										// The number beside a source is what it contributes to
										// *this merged listing*, not the raw rows it walked:
										// one repository reached through two sources is one
										// card here, so the raw counts could sum to more than
										// 「共 N 条」 and made the panel's own arithmetic look
										// broken. The overlap is stated once, just below.
										const shown = typeof st?.merged === "number" ? st.merged : n;
										// The reader may have asked for a *view* of this source
										// (`?source=census`): the number is still the upstream's
										// — one upstream, one number, so 「共 N 条」 keeps adding
										// up — but the name on it is the one they chose. The
										// option's own label is used, so the filter and this line
										// cannot drift apart.
										const name = market.aliasOf === s && marketSource
											? (marketSourceOptions.find(([value]) => value === marketSource)?.[1] ?? shortSourceName(s))
											: shortSourceName(s);
										return `${name} ${compactCount(shown)}${marks.length ? `（${marks.join(" ")}）` : ""}`;
									}).join(" · "),
								`其中 ${installedCount} 个已安装`,
								market.deduped
									? `去重合并 ${compactCount(market.deduped)} 条（同一仓库被多个来源收录）`
									: null,
								marketGroup && sortedItems
									? `「${marketGroup === "__none__" ? "未分类" : marketGroup}」筛选后 ${sortedItems.length} 条`
									: null,
							].filter(Boolean).join(" · "))])
						: null,
					// The user's own sources, in one collapsible box: the market's
					// filter row is not the place to add or remove one, but the
					// listing's own numbers are what tell a user whether a source
					// they added actually answered.
					sourcesMissing
						? createElement("div", { key: "srcold", style: styles.hint },
							"自定义目录源需要新版宿主插件：请完全退出 DSH（桌面版注意托盘图标）后重新打开。")
						: createElement("div", { key: "srcedit", style: styles.sourceBox }, [
							createElement("div", { key: "head", style: styles.sourceHead }, [
								createElement("span", { key: "t", style: styles.sourceLabel }, "目录源"),
								createElement("span", { key: "n", style: styles.hint },
									`自定义 ${customSourceRows.length} / ${catalogSources?.max ?? 8}`),
								createElement("button", {
									key: "toggle", type: "button", className: "omkt-btn omkt-btn-outline",
									style: { ...styles.sourceMiniBtn, marginLeft: "auto" },
									onClick: () => setSourcesOpen((v) => !v),
								}, sourcesOpen ? "收起" : "管理"),
							]),
							sourcesOpen
								? createElement("div", { key: "body" }, [
									// What each one last did, read off the listing the page
									// already holds — no extra request.
									createElement("div", { key: "builtin", style: { ...styles.hint, paddingTop: 8 } },
										`内置：${MARKET_SOURCES.slice(1).map(([id, label]) => {
											const st = market?.sources?.[id];
											if (market?.sources && !st) return `${label} 未参与`;
											// A source that answered nothing shows why, in the
											// same words the custom rows use — a bare `0` would
											// read as "this catalog is empty".
											if (st?.error) return `${label} 不可用：${st.error}`;
											const at = sourceClock(st?.at);
											// `st.note` is the source saying its list is only
											// part of what exists (Docker Hub's anonymous page
											// cap). The row count alone would overstate it.
											const note = st?.note ? `（${st.note}）` : "";
											// The census count and the recovered-command
											// count are different facts: the first is how
											// many repositories exist, the second is how
											// many came back with a way to run them.
											const recovered = st?.install?.withCommand
												? `（已从仓库恢复 ${st.install.withCommand} 条安装命令${st.install.walking ? "，还在继续" : ""}）`
												: "";
											return `${label} ${market?.counts?.[id] ?? 0}${st?.stale ? "（旧）" : ""}${at ? `（${at}）` : ""}${note}${recovered}`;
										}).join(" · ")}`),
									...customSourceRows.map((s) => {
										const st = market?.sources?.[s.id];
										const at = sourceClock(st?.at);
										return createElement("div", { key: s.id, style: styles.sourceRow }, [
											createElement("span", { key: "l", style: styles.sourceLabel }, s.label),
											createElement("span", { key: "u", style: styles.sourceUrl, title: s.url }, s.url),
											createElement("span", { key: "c", style: styles.hint },
												st?.error
													? `不可用：${st.error}`
													: `${market?.counts?.[s.id] ?? 0} 条${at ? ` · ${at}` : ""}${st?.stale ? " · 本次未更新" : ""}`),
											// Only lists that live in a GitHub repository can take a
											// submission, and only they carry this target; every other
											// source renders no link at all.
											s.submission?.url
												? createElement(LinkChip, {
													key: "sub", href: s.submission.url,
													label: "投稿 ↗",
													title: `在 ${s.submission.repo} 开一条已预填的收录 issue`,
												})
												: null,
											createElement("button", {
												key: "del", type: "button", className: "omkt-btn omkt-btn-outline",
												style: { ...styles.sourceMiniBtn, ...styles.sourceMiniBtnDanger },
												disabled: sourceBusy,
												onClick: () => removeCatalogSource(s.id, s.label),
											}, "移除"),
										]);
									}),
									!customSourceRows.length
										? createElement("div", { key: "none", style: { ...styles.hint, paddingTop: 8 } },
											"还没有自定义源。加一个你自己的 registry.json 地址，它和内置五个来源一起出现在市场里。")
										: null,
									createElement("div", { key: "add", style: styles.sourceRow }, [
										createElement("input", {
											key: "in", className: "omkt-input", style: styles.sourceInput,
											type: "url", value: sourceDraft, spellCheck: false,
											placeholder: "https://raw.githubusercontent.com/<owner>/<repo>/<branch>/registry.json",
											onChange: (e) => setSourceDraft(e.target.value),
											onKeyDown: (e) => { if (e.key === "Enter") addCatalogSource(); },
										}),
										createElement("button", {
											key: "addbtn", type: "button", className: "omkt-btn omkt-btn-outline",
											style: styles.sourceMiniBtn,
											disabled: sourceBusy || !sourceDraft.trim(),
											onClick: () => addCatalogSource(),
										}, sourceBusy ? "处理中…" : "添加"),
									]),
									createElement("div", { key: "tip", style: { ...styles.hint, paddingTop: 2 } },
										"只接受 https（地址里的安装命令会被本机执行）；最多 8 个；私有源请用本机文件或带鉴权的宿主，不要把口令写进地址。"),
									catalogSources?.error
										? createElement("div", { key: "err", style: styles.error }, `sources.json：${catalogSources.error}`)
										: null,
									sourceNote
										? createElement("div", { key: "note", style: styles.hint }, sourceNote)
										: null,
								])
								: null,
						]),
                        ]),
                    ]),
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
						? createElement("div", { key: "warn", style: styles.hint,
							title: market.errors
								.map((e) => `${shortSourceName(e.source)}：${String(e.message ?? "")}`)
								.join("\n") },
							`部分来源不可用：${market.errors.map((e) => {
								const label = shortSourceName(e.source);
								const reason = clipReason(e.message);
								// A source that failed but still answered from its last
								// walk is behind; one that answered nothing is missing.
								// Those are different facts and the words say which.
								const kind = e.stale ? "旧数据" : "不可用";
								return reason ? `${label}（${kind}：${reason}）` : `${label}（${kind}）`;
							}).join("、")}`)
						: null,
					starNote || statsBusy ? createElement("div", { key: "star", style: styles.hint }, statsBusy ? "正在更新本页仓库统计…" : starNote) : null,
					// The host reports which repo lookups failed; those repos have an
					// empty media entry, so without this line "加载失败" would read as
					// "这个仓库没有配图". The retry asks the host again regardless of
					// its TTLs.
					mediaFailures.length
						? createElement("div", { key: "mediafail", style: styles.hint }, [
							`${mediaFailures.length} 个仓库的配图加载失败（${mediaFailures.map((e) => e.repo).join("、")}）。`,
							createElement("button", {
								key: "retry", type: "button", className: "omkt-btn omkt-btn-outline",
								style: { ...styles.outlineBtn, marginLeft: 8, padding: "2px 8px", fontSize: 12 },
								disabled: marketBusy,
								onClick: () => enrichMedia(mediaFailures.map(row => ({ repository: `https://github.com/${row.repo}` })), true),
							}, "重试"),
						])
						: null,
					pageItems && pageItems.length === 0 && !marketBusy
						? createElement("div", { key: "none", style: styles.message },
							favOnly ? "当前筛选下没有收藏的条目。" : "没有匹配的 MCP。")
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
                                [highlightCount ? createElement("div", { key: "highlights", style: { ...styles.smSpotlight, marginBottom: 16 } }, pageItems.slice(0, highlightCount).map((item, i) => marketCard(item, i, true))) : null,
                                createElement("div", { key: "grid", className: "omkt-grid", style: styles.cardColumns }, pageItems.slice(highlightCount).map((item, i) => marketCard(item, i + highlightCount))) ]))

						: null,

                    sortedItems ? createElement(PageFooter, { key: "pager", page: safePage, pageCount, pageSize,
                        onPage: setMarketPage, onPageSize: value => { setPageSize(value); setMarketPage(0); }, note: marketAt ? `列表读取于 ${marketAt}${market?.cached ? "（缓存）" : ""}${market?.notModified > 0 ? ` · ${market.notModified} 源未变` : ""}` : "",
                    }) : null,

				]) : null,

				// The detail overlay is a sibling of the page content, not a child
				// of the market tab, so it survives a tab switch and closes cleanly.
				detail
					? createElement(MarketDetail, {
							// Keyed by the entry, not by "the detail panel": the panel
							// holds per-entry state (the copy button's verdict), and a
							// second entry opened in the same slot must not inherit it.
							key: `detail:${detail.source}:${detail.id ?? detail.title}`,
							item: marketItems?.find(item => itemKeyOf(item) === itemKeyOf(detail)) ?? detail, stats: repoStats, media: repoMedia, busy,
							installing: installingKey === itemKeyOf(detail),
							mediaFailed: mediaFailures.some((e) => e.repo === repoKeyOf(detail)),
							onRetryMedia: () => enrichMedia([detail], true),
							onClose: () => setDetail(null),
							onInstall: doInstall,
							onToggleFavorite: doToggleFavorite,
						})
					: null,

				// The confirmation sits beside the drawer, not inside it: a removal
				createElement(SkillRemoveDialog, {
					key: `remove:` + String(skillRemove?.id ?? skillRemove?.name ?? ''),
					skill: skillRemove,
					rootLabel: skillRemove ? rootLabelOf(skills, skillRemove.root) : '',
					busy: skillRemoving,
					onCancel: () => setSkillRemove(null),
					onConfirm: () => { confirmRemoveSkill().catch(() => {}); },
				}),

				// The config sheet is a sibling for the same reason the detail
				// panel is: it must outlive a tab switch and close on its own.
				configTarget
					? createElement(ConfigDialog, {
						key: `config:${rowKey(configTarget)}`,
						server: configTarget,
						onClose: () => setConfigTarget(null),
						onSaved: afterConfigure,
					})
					: null,




				// One skill, opened from its card. Keyed by the skill's id so two
				// cards opened in a row cannot inherit each other's state.
				skillTarget
					? createElement(SkillDrawer, {
						key: `skill:${skillTarget.id ?? skillTarget.name}`,
						skill: skillTarget,
						rootLabel: rootLabelOf(skills, skillTarget.root),
						onClose: () => setSkillTarget(null),
						onReveal: doRevealSkill,
						onRemove: setSkillRemove,
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
		/**
		 * `react.Component` is always there in the shell, but this bundle is also
		 * loaded by the repo's headless probes (tools/*.mjs) through a shim that
		 * carries only the hooks. `class X extends undefined` throws while the
		 * factory is being evaluated — before any of this file runs — so a partial
		 * React must degrade to a base class here instead of taking the whole
		 * bundle down. The guard simply never fires in the app.
		 */
		const BoundaryBase = typeof react.Component === "function"
			? react.Component
			: class {
				constructor(props) { this.props = props; this.state = {}; }
				setState(next) {
					this.state = { ...this.state, ...(typeof next === "function" ? next(this.state) : next) };
				}
				render() { return null; }
			};

		/**
		 * The page has no error boundary of its own: one throw inside a row
		 * renderer unmounts the whole section, and what the user sees is a blank
		 * page — that is exactly what 「装完就白屏」 was. A single unexpected
		 * field (an install response whose shape differs from the list shape, a
		 * catalogue item missing an array) must degrade to an inline message, not
		 * to nothing at all.
		 */
		class Boundary extends BoundaryBase {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			componentDidCatch(error, info) {
				try { console.error("[overall-mcp] panel crashed", error, info); } catch { /* ignore */ }
			}
			render() {
				if (!this.state.error) return this.props.children ?? null;
				const retry = () => this.setState({ error: null });
				const rescan = () => {
					fetch("/api/overall-mcp/scan", { method: "POST" }).catch(() => {});
					retry();
				};
				return createElement("div", { style: { padding: 20, display: "grid", gap: 10 } }, [
					createElement("strong", { key: "t" }, "全局 MCP & Skill 面板渲染失败"),
					createElement("div", { key: "e", style: { color: "#c33", fontSize: 13 } },
						String(this.state.error?.message ?? this.state.error)),
					createElement("div", { key: "h", style: { fontSize: 12, opacity: 0.7 } },
						"后端仍然可用：对话里可以直接调用 overall_mcp_list / overall_mcp_scan。"),
					createElement("div", { key: "a", style: { display: "flex", gap: 8 } }, [
						createElement("button", { key: "retry", type: "button", onClick: retry }, "重试渲染"),
						createElement("button", { key: "scan", type: "button", onClick: rescan }, "重新扫描宿主机"),
					]),
				]);
			}
		}

		/** Registered page component: the guarded section. */
		function Container(props) {
			return createElement(Boundary, null, createElement(Section, props));
		}

		function apply(ctx) {
			// Kept for link handling only (see `openExternal`): the registration
			// below needs `ctx.slots`, and a link click much later needs the two
			// Sidebar services, read lazily so their absence is a fallback.
			hostCtx = ctx;
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
					// The same name as the page head — the rail used to say only "全局 MCP",
					// so the entry and the page it opens disagreed.
					label: "全局 MCP & Skill",
				}, PanelGlyph);
				return typeof off === "function" ? off : () => {};
			});
			ctx.slots.inject("main", () => {
				const off = ctx.slots.register({ name: "main", key: PANEL_ID }, Container);
				return typeof off === "function" ? off : () => {};
			});
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		// Exposed for the render probes under tools/ only: the detail panel once
		// shipped with labels and no values, the card once shipped its front-door
		// link inside a <button> (click raced the navigation), and the sub-line's
		// fallback for a host without /status is a branch no render can reach
		// once the route answers. No test that avoids real rendering could catch
		// the first two, and none that renders once can catch the third.
		exports.__test = {
			MarketDetail, MarketCard, DetailRow, LinkChip, PanelGlyph, subLineText, styles,
            SkillCard, SkillPanel, SkillMarket, skillSourceErrorMessage, CallsPanel, CallCard, callMetrics, callStatus, ensureStyles,
			// The config sheet leaves the page only through a click, so no probe
			// that renders the section can reach it; rendering it directly is the
			// only way to catch a throw that happens before the first paint.
			ConfigDialog,
			// The three-bag routing, so a probe can prove a declared `config` key is
			// not silently written to `env`.
			splitValues,
			// What the save button refuses to submit, and what the CLI will receive:
			// both are pure functions over (fields, values, custom).
			requiredStillMissing, previewCliConfig,
			// A row's 检查 button and its verdict line exist only on a row, so
			// tools/render-server-health.mjs renders ServerRow directly with the
			// three shapes the host sends (never checked / healthy / no tools).
			ServerRow,
			// A verdict belongs to the page session that asked for it, not to the
			// row: the filter that enforces that is worth a probe of its own.
			keepSessionHealth, checkedThisSession, healthLine,
			// 用途说明换语言是纯映射，探针能直接喂它三行（服务器散文 / 本插件生成的
			// 工具行 / 命令）来证明只有该动的那一行动了。
			localizeRows, aboutKey, pageLanguage,
			version: CLIENT_VERSION, bundleName: BUNDLE_NAME, panelId: PANEL_ID,
		};
		// Section is exported for tools/render-market-tab.mjs: the market tab's
		// chrome (stat line, filters, masonry wrapper, favourite wiring) exists
		// nowhere else, and a wrong state name or prop only throws at render.
		exports.Section = Section;
		return module.exports;
	},
});
