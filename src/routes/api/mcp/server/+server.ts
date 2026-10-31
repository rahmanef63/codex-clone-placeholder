import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { error } from '@sveltejs/kit';
import { consumeBurst, matchesSecret, readJsonBody, requireAppOrigin } from '$lib/server/access';
import { statusMcpResponse } from '$lib/server/mcp/server';
import { logEvent } from '$lib/server/log';
import type { RequestHandler } from './$types';

// The JSON-RPC method name is the only field of the body this route ever records.
function methodOf(body: unknown): string {
	const method =
		typeof body === 'object' && body !== null ? (body as { method?: unknown }).method : null;
	return typeof method === 'string' && /^[a-z][a-z/._-]{0,63}$/i.test(method) ? method : 'unknown';
}

export const POST: RequestHandler = async ({ request }) => {
	if (env.MCP_SERVER_ENABLED !== 'true') error(404, 'MCP server is disabled.');
	const token = env.MCP_SERVER_TOKEN;
	if (!token || token.length < 32 || token.length > 4096)
		error(503, 'MCP server setup is incomplete.');
	if (!matchesSecret(request.headers.get('authorization') ?? '', `Bearer ${token}`))
		error(401, 'MCP authorization required.');
	if (request.headers.has('origin')) requireAppOrigin(request, publicEnv.PUBLIC_SITE_URL);
	consumeBurst(`mcp-server:${token}`);
	const body = await readJsonBody(request);
	try {
		const response = await statusMcpResponse(request, body);
		await logEvent('info', 'mcp.server', {
			method: methodOf(body),
			status: response.status,
			outcome: 'ok'
		});
		return response;
	} catch {
		await logEvent('warn', 'mcp.server', { method: methodOf(body), outcome: 'error' });
		error(500, 'MCP request could not be processed.');
	}
};
