import { env } from '$env/dynamic/private';
import { error } from '@sveltejs/kit';
import { requireCapabilityAccess, readJsonBody } from '$lib/server/access';
import { parseChat } from '$lib/server/ai/config';
import { chatResponse } from '$lib/server/ai/chat';
import { logEvent } from '$lib/server/log';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async (event) => {
	if (env.AI_ENABLED !== 'true') error(404, 'AI chat is disabled.');
	await requireCapabilityAccess(event);
	const body = await readJsonBody(event.request);
	let input: ReturnType<typeof parseChat>;
	try {
		input = parseChat(env, body);
	} catch {
		await logEvent('warn', 'ai.chat', { outcome: 'invalid-request' });
		error(400, 'Check the approved provider/model, key and conversation limits.');
	}
	await logEvent('info', 'ai.chat.start', {
		provider: input.provider,
		model: input.model,
		messages: input.messages.length,
		chars: input.messages.reduce((total, message) => total + message.content.length, 0)
	});
	return chatResponse(input, event.request.signal, (outcome) => {
		logEvent(outcome === 'ok' ? 'info' : 'warn', 'ai.chat.end', {
			provider: input.provider,
			model: input.model,
			outcome
		}).catch(() => undefined);
	});
};
