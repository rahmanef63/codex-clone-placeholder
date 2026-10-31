import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { env } from '$env/dynamic/private';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type LogLevel = keyof typeof LEVELS;

// One record stays small enough to read by hand and far too small to hold a payload.
const MAX_BYTES = 4096;
const MAX_FIELD_CHARS = 512;

// Keys handed to the app, a bearer header value, or a query string never leave the process.
const SECRET = /(?:sk-[A-Za-z0-9_-]{4,}|Bearer\s+\S+|x-api-key["'\s:=]+\S+)/gi;

export function redact(value: string): string {
	return value
		.replace(/(https?:\/\/[^?#\s]+)\?[^#\s]*/gi, '$1?[redacted]')
		.replace(SECRET, '[redacted]');
}

// Only flat primitives pass; an object or array is dropped rather than serialized, so a
// request body or a provider error payload has no route into a record.
function clean(fields: Record<string, unknown>): Record<string, string | number | boolean | null> {
	const out: Record<string, string | number | boolean | null> = {};
	for (const [key, value] of Object.entries(fields)) {
		if (!/^[a-z][a-zA-Z0-9]{0,31}$/.test(key)) continue;
		if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
		else if (typeof value === 'string')
			out[key] = redact(value)
				.slice(0, MAX_FIELD_CHARS)
				.replace(/[\r\n]+/g, ' ');
	}
	return out;
}

let ensured = '';
async function ensureDir(dir: string): Promise<void> {
	if (ensured === dir) return;
	await mkdir(dir, { recursive: true });
	ensured = dir;
}

async function write(path: string, line: string): Promise<void> {
	try {
		await ensureDir(dirname(path));
		await appendFile(path, line, 'utf8');
	} catch {
		// ponytail: a log write is best effort; a read-only volume must not fail a request.
	}
}

/**
 * Append one NDJSON activity record. Silent unless `LOG_LEVEL` is one of
 * `debug|info|warn|error`, which only an operator sets: unset means no output and no file,
 * including in production. Never throws and never blocks the caller.
 */
export async function logEvent(
	level: LogLevel,
	event: string,
	fields: Record<string, unknown> = {}
): Promise<void> {
	const configured = env.LOG_LEVEL ?? '';
	if (!Object.hasOwn(LEVELS, configured)) return;
	if (LEVELS[level] < LEVELS[configured as LogLevel]) return;
	const path = env.LOG_FILE || join('.local-logs', 'activity.jsonl');
	const name = /^[a-z][a-z0-9.]{0,63}$/.test(event) ? event : 'unknown';
	const head = { at: new Date().toISOString(), level, event: name };
	let line = `${JSON.stringify({ ...head, ...clean(fields) })}\n`;
	if (Buffer.byteLength(line) > MAX_BYTES)
		line = `${JSON.stringify({ ...head, truncated: true })}\n`;
	return write(path, line);
}
