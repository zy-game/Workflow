// index.js - host-side entry: registers a stub for API endpoints the DSH web
// client polls when no agent backend is attached, stopping retry loops that
// would otherwise flood the page with 404s.
export const name = 'workflow-dsh-web-host';
export const inject = ['webServer'];

export function apply(ctx) {
	if (!ctx?.webServer?.register) return;
	const stubs = {
		'/api/commands/list': { commands: [] },
	};
	for (const [path, body] of Object.entries(stubs)) {
		ctx.effect(() => ctx.webServer.register({
			kind: 'exact',
			path,
			handler: (_req, res) => {
				res.writeHead(200, { 'content-type': 'application/json' });
				res.end(JSON.stringify(body));
			},
		}), `workflow-web: stub ${path}`);
	}
}
