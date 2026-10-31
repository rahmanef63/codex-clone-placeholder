import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { logEvent, redact } from './log';

const state = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => ({ env: state.env }));

let dir = '';
const read = async () => readFile(join(dir, 'activity.jsonl'), 'utf8').catch(() => '');

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), 'activity-log-'));
	delete state.env.LOG_LEVEL;
	state.env.LOG_FILE = join(dir, 'activity.jsonl');
});
afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test('unset or unknown LOG_LEVEL writes nothing at all', async () => {
	await logEvent('error', 'ai.chat.start', { provider: 'openai' });
	state.env.LOG_LEVEL = 'verbose';
	await logEvent('error', 'ai.chat.start', { provider: 'openai' });
	state.env.LOG_LEVEL = '';
	await logEvent('error', 'ai.chat.start', { provider: 'openai' });
	expect(await read()).toBe('');
});

test('LOG_LEVEL enables the file and filters below the threshold', async () => {
	state.env.LOG_LEVEL = 'warn';
	await logEvent('info', 'ai.chat.start', { provider: 'openai' });
	await logEvent('error', 'ai.chat.end', { outcome: 'error' });
	const records = (await read())
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
	expect(records).toHaveLength(1);
	expect(records[0]).toMatchObject({ level: 'error', event: 'ai.chat.end', outcome: 'error' });
	expect(typeof records[0].at).toBe('string');
});

test('records are flat primitives only, so a body or error object cannot reach the file', async () => {
	state.env.LOG_LEVEL = 'debug';
	await logEvent('debug', 'ai.chat.start', {
		messages: 2,
		body: { messages: [{ content: 'secret prompt' }] },
		list: ['a'],
		apiKey: 'sk-live-abcdefghijklmnop',
		authorization: 'Bearer abc.def.ghi'
	});
	const line = (await read()).trim();
	expect(line).not.toContain('secret prompt');
	expect(line).not.toContain('sk-live');
	expect(line).not.toContain('abc.def');
	expect(JSON.parse(line)).toEqual(expect.objectContaining({ messages: 2 }));
});

test('redact strips key shapes and URL query strings but keeps the path', () => {
	const out = redact(
		'https://api.example/v1/chat?key=leak&x=1 sk-abcdefghijkl x-api-key: deadbeef Authorization: Bearer token-value'
	);
	expect(out).not.toMatch(/leak|abcdefghijkl|deadbeef|token-value/);
	expect(out).toContain('https://api.example/v1/chat?[redacted]');
});

test('a write failure is swallowed, and a long record is capped', async () => {
	state.env.LOG_LEVEL = 'info';
	// A directory where the file should be: appendFile fails fast with EISDIR.
	state.env.LOG_FILE = dir;
	await expect(logEvent('info', 'ai.chat.start', { provider: 'openai' })).resolves.toBeUndefined();
	state.env.LOG_FILE = join(dir, 'activity.jsonl');
	const many = Object.fromEntries(
		Array.from({ length: 20 }, (_, index) => [`f${index}`, 'x'.repeat(500)])
	);
	await logEvent('info', 'ai.chat.start', many);
	const line = (await read()).trim();
	expect(Buffer.byteLength(line)).toBeLessThanOrEqual(4096);
	expect(JSON.parse(line)).toMatchObject({ truncated: true, event: 'ai.chat.start' });
});
