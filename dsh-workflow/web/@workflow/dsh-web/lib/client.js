// client.js - Workflow entry for the DSH web shell (classic-script factory
// form). Contributes:
//   - a "Workflow" button in the sidebar footer actions;
//   - a full-screen shell.overlay embedding the Workflow Core web app.
// The Core URL defaults to http://127.0.0.1:8710 and can be overridden per
// browser via localStorage["workflow.coreUrl"].
window.__ModuleLoader__.load({
	id: "@workflow/dsh-web",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");

		const CORE_URL_KEY = "workflow.coreUrl";
		const DEFAULT_CORE_URL = "http://127.0.0.1:8710";

		function coreUrl() {
			try { return localStorage.getItem(CORE_URL_KEY) || DEFAULT_CORE_URL; }
			catch { return DEFAULT_CORE_URL; }
		}

		let open = false;
		const listeners = new Set();
		function setOpen(next) {
			open = next;
			listeners.forEach((listener) => listener());
		}
		function useOpenState() {
			const [value, setValue] = react.useState(open);
			react.useEffect(() => {
				listeners.add(setValue);
				return () => listeners.delete(setValue);
			}, []);
			return [value, setOpen];
		}

		const e = react.createElement;

		function WorkflowLauncher() {
			const [visible] = useOpenState();
			if (visible) return null;
			return e("button", {
				onClick: () => setOpen(true),
				style: { background: "none", border: "none", color: "inherit", cursor: "pointer", font: "inherit", padding: "6px 0", textAlign: "left" },
			}, "⚙ Workflow");
		}

		function WorkflowOverlay() {
			const [visible] = useOpenState();
			if (!visible) return null;
			return e("div", {
				"data-workflow-overlay": true,
				style: { position: "absolute", inset: 0, zIndex: 40, display: "flex", flexDirection: "column", background: "#17181c" },
			},
				e("div", { style: { display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderBottom: "1px solid #2c2f37", color: "#e6e7ea", font: "14px/1.4 system-ui, sans-serif" } },
					e("span", { style: { fontWeight: 600, color: "#f0a35a" } }, "Workflow"),
					e("span", { style: { flex: 1 } }),
					e("button", { onClick: () => window.open(coreUrl(), "_blank", "noopener"), style: panelButton }, "在新窗口打开"),
					e("button", { onClick: () => setOpen(false), style: panelButton }, "关闭"),
				),
				e("iframe", {
					src: coreUrl(),
					title: "Workflow",
					style: { flex: 1, width: "100%", border: "none", background: "#fff" },
				}),
			);
		}

		const panelButton = { background: "#2c2f37", color: "#e6e7ea", border: "none", borderRadius: 8, padding: "4px 10px", cursor: "pointer" };

		/** Required client services. */
		const inject = ["slots"];

		/**
		* Client plugin body: contribute the sidebar action and the overlay.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "workflow-open",
			}, WorkflowLauncher));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "workflow-overlay",
			}, WorkflowOverlay));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});
