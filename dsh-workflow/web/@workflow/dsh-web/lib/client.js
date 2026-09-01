// client.js - Workflow 原生 DSH 客户端插件：在 DSH 侧边栏底部直接注册
// 任务/项目/节点/同步四个菜单项，点击各自打开全屏面板（原生 React，
// 直接 fetch 本地 Core API，不用 iframe）。
window.__ModuleLoader__.load({
	id: "@workflow/dsh-web",
	factory: function(require) {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");
		var h = React.createElement;

		var CORE_URL_KEY = "workflow.coreUrl";
		var TOKEN_KEY = "workflow.coreToken";

		function coreUrl() {
			try { return localStorage.getItem(CORE_URL_KEY) || "http://127.0.0.1:8710"; }
			catch(e) { return "http://127.0.0.1:8710"; }
		}
		function getToken() {
			try { return localStorage.getItem(TOKEN_KEY) || ""; }
			catch(e) { return ""; }
		}
		function setToken(t) {
			try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch(e) {}
		}

		async function api(path, opts) {
			var url = coreUrl().replace(/\/+$/, "") + path;
			var headers = { "content-type": "application/json" };
			var tk = getToken();
			if (tk) headers.authorization = "Bearer " + tk;
			var resp = await fetch(url, Object.assign({ headers: headers }, opts || {}));
			var body = await resp.json().catch(function() { return {}; });
			if (!resp.ok) throw { status: resp.status, message: body.error || body.code || ("HTTP " + resp.status) };
			return body;
		}

		// 当前打开的页面：null | "tasks" | "projects" | "peers" | "sync" | "login"
		var activePage = null;
		var pageListeners = new Set();
		function setActivePage(v) { activePage = v; pageListeners.forEach(function(f) { f(v); }); }
		function useActivePage() {
			var s = React.useState(activePage);
			React.useEffect(function() {
				pageListeners.add(s[1]);
				return function() { pageListeners.delete(s[1]); };
			}, []);
			return [s[0], setActivePage];
		}

		var S = {
			panel: function(sidebarWidth) { return { position: "fixed", left: sidebarWidth + "px", right: 0, top: 0, bottom: 0, zIndex: 38, display: "flex", flexDirection: "column", background: "var(--dsw-surface, #17181c)", color: "#e6e7ea", fontFamily: "system-ui, sans-serif", fontSize: "14px" }; },
			nav: { display: "flex", alignItems: "center", gap: "4px", padding: "8px 12px", borderBottom: "1px solid #2c2f37", background: "#1f2127", flexShrink: 0 },
			spacer: { flex: 1 },
			dim: { color: "#8b8f99" },
			content: { flex: 1, overflow: "auto", padding: "16px" },
			table: { width: "100%", borderCollapse: "collapse" },
			th: { textAlign: "left", color: "#8b8f99", fontWeight: 500, padding: "8px 10px", borderBottom: "1px solid #2c2f37" },
			td: { padding: "8px 10px", borderBottom: "1px solid #2c2f37" },
			btn: { background: "#e38c3c", color: "#17181c", border: "none", borderRadius: "8px", padding: "6px 14px", cursor: "pointer", fontWeight: 600 },
			btnGhost: { background: "none", color: "#8b8f99", border: "none", cursor: "pointer", fontSize: "14px" },
			btnDanger: { background: "#d95f5f", color: "#17181c", border: "none", borderRadius: "8px", padding: "6px 14px", cursor: "pointer" },
			input: { background: "#1f2127", color: "#e6e7ea", border: "1px solid #2c2f37", borderRadius: "8px", padding: "7px 10px" },
			form: { display: "flex", flexDirection: "column", gap: "10px", maxWidth: "360px", margin: "10vh auto", padding: "28px", background: "#1f2127", border: "1px solid #2c2f37", borderRadius: "14px" },
			label: { display: "flex", flexDirection: "column", gap: "4px", color: "#8b8f99", fontSize: "13px" },
			cards: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "12px" },
			card: { background: "#1f2127", border: "1px solid #2c2f37", borderRadius: "12px", padding: "14px" },
			err: { color: "#d95f5f" },
			menuBtn: { background: "none", border: "none", color: "inherit", cursor: "pointer", font: "inherit", padding: "6px 0", textAlign: "left", display: "block", width: "100%" }
		};

		function pillStyle(status) {
			var bg = { done: "#23402a", failed: "#402323", running: "#403423", dispatched: "#403423", queued: "#2c2f37", cancelled: "#2c2f37", awaiting_input: "#2b2b40" };
			var fg = { done: "#58b368", failed: "#d95f5f", running: "#f0a35a", dispatched: "#f0a35a", queued: "#8b8f99", cancelled: "#8b8f99", awaiting_input: "#9aa5e3" };
			return { display: "inline-block", padding: "2px 10px", borderRadius: "999px", fontSize: "12px", background: bg[status] || "#2c2f37", color: fg[status] || "#8b8f99" };
		}

		var LABELS = { queued: "排队", dispatched: "已派发", running: "运行中", done: "完成", failed: "失败", awaiting_input: "等待输入", cancelled: "已取消" };

		// === 登录 ===
		function LoginView(props) {
			var email = React.useState("");
			var pass = React.useState("");
			var err = React.useState(null);
			var busy = React.useState(false);
			return h("form", {
				style: S.form,
				onSubmit: function(e) {
					e.preventDefault();
					busy[1](true); err[1](null);
					api("/api/v1/auth/client-login", { method: "POST", body: JSON.stringify({ email: email[0].trim(), password: pass[0] }) })
						.then(function(r) { setToken(r.access_token); if (props.onLogin) props.onLogin(); })
						.catch(function(e) { err[1](e.message || String(e)); })
						.finally(function() { busy[1](false); });
				}
			},
				h("h2", { style: { margin: "0 0 8px", color: "#f0a35a" } }, "Workflow 登录"),
				h("label", { style: S.label }, "邮箱", h("input", { type: "email", value: email[0], onChange: function(e) { email[1](e.target.value); }, style: S.input, required: true })),
				h("label", { style: S.label }, "密码", h("input", { type: "password", value: pass[0], onChange: function(e) { pass[1](e.target.value); }, style: S.input, required: true })),
				err[0] ? h("div", { style: S.err }, err[0]) : null,
				h("button", { type: "submit", disabled: busy[0], style: S.btn }, busy[0] ? "登录中…" : "登录")
			);
		}

		// === 任务 ===
		function TasksView() {
			var tasks = React.useState([]);
			var err = React.useState(null);
			var filter = React.useState("");
			React.useEffect(function() {
				var q = filter[0] ? "?status=" + filter[0] : "";
				api("/api/v1/tasks" + q).then(function(r) { tasks[1](r.tasks || []); err[1](null); }).catch(function(e) { err[1](e.message); });
			}, [filter[0]]);
			return h("div", null,
				h("div", { style: { display: "flex", gap: "8px", marginBottom: "12px" } },
					h("select", { value: filter[0], onChange: function(e) { filter[1](e.target.value); }, style: S.input },
						h("option", { value: "" }, "全部状态"),
						Object.keys(LABELS).map(function(k) { return h("option", { key: k, value: k }, LABELS[k]); })
					)
				),
				err[0] ? h("div", { style: S.err }, err[0]) : null,
				h("table", { style: S.table },
					h("thead", null, h("tr", null, h("th", { style: S.th }, "任务"), h("th", { style: S.th }, "状态"), h("th", { style: S.th }, "项目"), h("th", { style: S.th }, "执行节点"))),
					h("tbody", null, tasks[0].map(function(t) {
						return h("tr", { key: t.task_id },
							h("td", { style: S.td }, (t.title || (t.brief && t.brief.prompt ? t.brief.prompt : t.task_id)).slice(0, 40)),
							h("td", { style: S.td }, h("span", { style: pillStyle(t.status) }, LABELS[t.status] || t.status)),
							h("td", { style: S.td }, t.project_id || "-"),
							h("td", { style: S.td }, t.executor_node_id || "-")
						);
					}))
				),
				!tasks[0].length && !err[0] ? h("div", { style: S.dim }, "没有任务") : null
			);
		}

		// === 项目 ===
		function ProjectsView() {
			var proj = React.useState([]);
			var err = React.useState(null);
			React.useEffect(function() {
				api("/api/v1/workflow/projects").then(function(r) { proj[1](r.projects || []); }).catch(function(e) { err[1](e.message); });
			}, []);
			return h("div", null,
				err[0] ? h("div", { style: S.err }, err[0]) : null,
				h("table", { style: S.table },
					h("thead", null, h("tr", null, h("th", { style: S.th }, "项目"), h("th", { style: S.th }, "Owner 节点"), h("th", { style: S.th }, "状态"))),
					h("tbody", null, proj[0].map(function(p) {
						return h("tr", { key: p.id },
							h("td", { style: S.td }, p.name),
							h("td", { style: S.td }, (p.metadata && p.metadata.owner_node_id) || h("span", { style: S.dim }, "未指定")),
							h("td", { style: S.td }, p.status)
						);
					}))
				),
				!proj[0].length && !err[0] ? h("div", { style: S.dim }, "没有项目") : null
			);
		}

		// === 节点 ===
		function PeersView() {
			var data = React.useState({ peers: [], cursors: [] });
			var err = React.useState(null);
			function reload() { api("/api/v1/admin/peers").then(function(r) { data[1]({ peers: r.peers || [], cursors: r.cursors || [] }); }).catch(function(e) { err[1](e.message); }); }
			React.useEffect(function() { reload(); }, []);
			return h("div", null,
				h("div", { style: { marginBottom: "12px" } }, h("button", { onClick: reload, style: S.btnGhost }, "刷新")),
				err[0] ? h("div", { style: S.err }, err[0]) : null,
				h("table", { style: S.table },
					h("thead", null, h("tr", null, h("th", { style: S.th }, "节点"), h("th", { style: S.th }, "状态"), h("th", { style: S.th }, "端点"), h("th", { style: S.th }, "操作"))),
					h("tbody", null, data[0].peers.map(function(p) {
						return h("tr", { key: p.node_id },
							h("td", { style: S.td }, p.node_id),
							h("td", { style: S.td }, h("span", { style: pillStyle(p.status === "active" ? "done" : "failed") }, p.status === "active" ? "活跃" : "已撤销")),
							h("td", { style: Object.assign({}, S.td, S.dim) }, p.endpoint_url || "-"),
							h("td", { style: S.td }, p.status === "active"
								? h("button", { onClick: function() { api("/api/v1/admin/peers/" + p.node_id + "/revoke", { method: "POST" }).then(reload).catch(function(e) { err[1](e.message); }); }, style: S.btnDanger }, "撤销")
								: h("button", { onClick: function() { api("/api/v1/admin/peers/" + p.node_id + "/activate", { method: "POST" }).then(reload).catch(function(e) { err[1](e.message); }); }, style: S.btn }, "恢复")
							)
						);
					}))
				),
				!data[0].peers.length && !err[0] ? h("div", { style: S.dim }, "没有已注册节点") : null
			);
		}

		// === 同步 ===
		function SyncView() {
			var sync = React.useState(null);
			var err = React.useState(null);
			React.useEffect(function() {
				var timer = setInterval(function() {
					api("/api/v1/admin/peer-sync").then(function(r) { sync[1](r.sync); err[1](null); }).catch(function(e) { err[1](e.message); });
				}, 5000);
				return function() { clearInterval(timer); };
			}, []);
			if (!sync[0] && !err[0]) return h("div", { style: S.dim }, "加载中…");
			if (err[0]) return h("div", { style: S.err }, err[0]);
			var s = sync[0] || {};
			return h("div", null,
				h("div", { style: S.cards },
					h("div", { style: S.card }, h("div", { style: { color: "#8b8f99", fontSize: "12px" } }, "本节点"), h("div", { style: { fontSize: "18px", fontWeight: 600 } }, s.node_id || "-"), h("div", { style: S.dim }, "outbox " + (s.head_seq || 0))),
					h("div", { style: S.card }, h("div", { style: { color: "#8b8f99", fontSize: "12px" } }, "签名"), h("div", { style: { fontSize: "18px", fontWeight: 600 } }, s.signing ? "已启用" : "未启用")),
					h("div", { style: S.card }, h("div", { style: { color: "#8b8f99", fontSize: "12px" } }, "中继"), h("div", { style: { fontSize: "18px", fontWeight: 600 } }, s.relay ? "已启用" : "关闭")),
					h("div", { style: S.card }, h("div", { style: { color: "#8b8f99", fontSize: "12px" } }, "收件箱"), h("div", { style: { fontSize: "18px", fontWeight: 600 } }, String(Object.values(s.inbox || {}).reduce(function(a, b) { return a + b; }, 0))))
				)
			);
		}

		var VIEWS = { tasks: TasksView, projects: ProjectsView, peers: PeersView, sync: SyncView };

		// 在主工作区显示：不遮侧边栏。测量侧边栏实际宽度作偏移。
		function useSidebarWidth() {
			var width = React.useState(248);
			React.useEffect(function() {
				function measure() {
					try {
						var overlay = document.querySelector('[data-shell-overlay]');
						var root = overlay && overlay.parentElement;
						if (!root) return;
						// 侧边栏 = shell 下最靠左、高度大于 0 的常规流子元素
						var sb = Array.from(root.children).find(function(el) {
							if (el === overlay) return false;
							var r = el.getBoundingClientRect();
							return r.left <= 1 && r.height > 100 && r.width >= 20 && r.width < 500;
						});
						if (sb) width[1](sb.getBoundingClientRect().width);
					} catch(e) { /* keep default */ }
				}
				measure();
				window.addEventListener("resize", measure);
				var t = setTimeout(measure, 300);
				return function() { window.removeEventListener("resize", measure); clearTimeout(t); };
			}, []);
			return width[0];
		}

		// 主工作区面板：替换 DSH 主视图区域，侧边栏/顶栏保留。
		// 后台管理模式：未登录 → 全屏登录墙盖住整个 DSH；登录成功 → 收起，
		// 显示 DSH 页面（侧边栏含 Workflow 菜单）。点菜单打开对应页面，
		// 未登录时点菜单也会弹登录墙。
		function WorkflowPanel() {
			var sbWidth = useSidebarWidth();
			var pageState = useActivePage();
			var page = pageState[0];
			var authed = !!getToken();
			// 未登录：全屏登录墙，挡住一切
			if (!authed) return fullScreenLogin(sbWidth);
			// 已登录且未点菜单：不遮挡，DSH 正常显示
			if (!page) return null;
			var View = VIEWS[page] || TasksView;
			var titles = { tasks: "任务", projects: "项目", peers: "节点", sync: "同步" };
			// 干净的页面：细标题行 + 内容，无横向 tab
			return h("div", { style: S.panel(sbWidth) },
				h("div", { style: { display: "flex", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid #2c2f37", flexShrink: 0 } },
					h("span", { style: { fontWeight: 500, fontSize: "13px", color: "#8b8f99" } }, titles[page] || "Workflow"),
					h("span", { style: S.spacer }),
					h("button", { onClick: function() { setActivePage(null); }, style: Object.assign({}, S.btnGhost, { fontSize: "12px" }) }, "返回")
				),
				h("div", { style: S.content }, h(View))
			);
		}

		// 全屏登录墙：盖住整个 DSH，只显示 Workflow 登录
		function fullScreenLogin(sbWidth) {
			return h("div", {
				style: { position: "fixed", inset: 0, zIndex: 60, background: "var(--dsw-surface, #17181c)", display: "flex", alignItems: "center", justifyContent: "center", color: "#e6e7ea", fontFamily: "system-ui, sans-serif" }
			}, h(LoginView, { onLogin: function() { setActivePage(null); } }));
		}

		// DSH 风格线性图标：16px、stroke 继承文字色
		function Icon(props) {
			return h("svg", {
				width: "16", height: "16", viewBox: "0 0 16 16", fill: "none",
				stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round", strokeLinejoin: "round",
				style: { flexShrink: 0 }
			}, props.children);
		}
		var ICONS = {
			tasks: h(Icon, null,
				h("rect", { x: "2", y: "2.5", width: "3", height: "3", rx: "0.5" }),
				h("path", { d: "M7 4h7M7 8h7M7 12h4" }),
				h("rect", { x: "2", y: "6.5", width: "3", height: "3", rx: "0.5" }),
				h("rect", { x: "2", y: "10.5", width: "3", height: "3", rx: "0.5" })
			),
			projects: h(Icon, null,
				h("path", { d: "M1.5 4.5A1 1 0 0 1 2.5 3.5h3l1.5 2h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10.5a1 1 0 0 1-1-1z" })
			),
			peers: h(Icon, null,
				h("circle", { cx: "8", cy: "3", r: "1.8" }),
				h("circle", { cx: "3", cy: "12", r: "1.8" }),
				h("circle", { cx: "13", cy: "12", r: "1.8" }),
				h("path", { d: "M8 4.8 4 10.2M8 4.8l4 5.4M4.8 12h6.4" })
			),
			sync: h(Icon, null,
				h("path", { d: "M13.5 8a5.5 5.5 0 0 1-9.4 3.9M2.5 8a5.5 5.5 0 0 1 9.4-3.9" }),
				h("path", { d: "M12 1.5v3h-3M4 14.5v-3h3" })
			)
		};

		// 侧边栏菜单组：一个注册项内部竖排 4 个菜单，避免 DSH 横排多个 action
		function WorkflowMenu() {
			var pageState = useActivePage();
			var items = [["任务", "tasks"], ["项目", "projects"], ["节点", "peers"], ["同步", "sync"]];
			return h("div", { style: { display: "flex", flexDirection: "column", gap: "2px", width: "100%" } },
				h("div", { style: { fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #6b6f78)", padding: "8px 0 2px", letterSpacing: "0.05em" } }, "WORKFLOW"),
				items.map(function(item) {
					var active = pageState[0] === item[1];
					return h("button", {
						key: item[1],
						onClick: function() { setActivePage(item[1]); },
						style: {
							background: active ? "var(--dsw-alias-interactive-bg-hover, #2c2f37)" : "none",
							border: "none",
							color: active ? "var(--dsw-alias-label-primary, #e6e7ea)" : "var(--dsw-alias-label-secondary, #8b8f99)",
							cursor: "pointer", font: "inherit", fontSize: "13px",
							padding: "5px 8px", textAlign: "left", borderRadius: "6px", width: "100%",
							display: "flex", alignItems: "center", gap: "8px"
						}
					}, ICONS[item[1]], item[0]);
				})
			);
		}

		var inject = ["slots"];

		function apply(ctx) {
			ctx.effect(function() {
				ctx.slots.inject("sidebar.footer.action", function() {
					return ctx.slots.register({ name: "sidebar.footer.action", id: "workflow-menu", order: 30 }, WorkflowMenu);
				});
				ctx.slots.inject("shell.overlay", function() {
					return ctx.slots.register({ name: "shell.overlay", id: "workflow-overlay" }, WorkflowPanel);
				});
			}, "workflow: sidebar menus and overlay");
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
