/**
 * Minimal, pure Server-Sent-Events line parser (spec §3.5, §11.3).
 *
 * `EventSource` cannot be used for `/api/events` because it has no way to
 * attach `Authorization`/`X-Banto-Client` headers (spec §11.2's bearer-token
 * + CSRF-header requirements), so `createSseEventProvider` (events.ts) reads
 * the response body as a raw byte/text stream via `fetch` +
 * `ReadableStream` instead. This module only knows how to turn that raw text
 * (delivered in arbitrarily-sized chunks - a `data:` line or the blank line
 * ending an event can land split across two chunks) into complete event
 * payload strings; it has no knowledge of fetch, tokens, or reconnection.
 *
 * Only the `data:` field is extracted (multiple `data:` lines within one
 * event are joined with `\n`, per the SSE spec) - `event:`/`id:`/`retry:`
 * fields are not needed for `AppEvent` (events.ts) and are ignored. Lines
 * starting with `:` are comments, used by the server as keep-alive pings
 * (`banto-server`'s `KeepAlive` layer) and produce no event.
 */

/** Stateful (buffers a partial trailing line across calls), otherwise side-effect-free. */
export interface SseParser {
	/** Feed a chunk of raw response text; returns any complete event `data:` payloads it completes. */
	push(chunk: string): string[];
}

/** Extract the joined `data:` payload from one event's raw text, or `null` if it had no `data:` line (e.g. a bare comment). */
function extractDataPayload(rawEvent: string): string | null {
	const dataLines: string[] = [];
	for (const rawLine of rawEvent.split('\n')) {
		// A trailing '\r' can still be present on the last line of a "\r\n"
		// terminated line whose own line-ending was already stripped by the
		// caller's boundary search (which only looks for "\n\n").
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		if (line === '' || line.startsWith(':')) continue;
		if (line.startsWith('data:')) {
			const value = line.slice(5);
			dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
		}
		// Other fields (event:/id:/retry:) are intentionally ignored (see module doc).
	}
	return dataLines.length > 0 ? dataLines.join('\n') : null;
}

/**
 * Create a new parser with its own internal buffer. Feed it every chunk read
 * from the response body's `ReadableStream`, in order; `push` returns the
 * `data:` payload of every event completed by that chunk (zero, one, or
 * several - a single chunk can contain multiple whole events).
 */
export function createSseParser(): SseParser {
	let buffer = '';

	return {
		push(chunk: string): string[] {
			// Normalize "\r\n" to "\n" up front so the rest of this module only
			// ever has to look for a single blank-line spelling ("\n\n"). Safe to
			// redo on the full buffer (including any carry-over) on every call: a
			// lone trailing "\r" left over from a chunk boundary has no "\n" to
			// pair with yet, so it simply stays put until the next chunk supplies
			// one.
			buffer = (buffer + chunk).replace(/\r\n/g, '\n');

			const events: string[] = [];
			let boundary = buffer.indexOf('\n\n');
			while (boundary !== -1) {
				const rawEvent = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const payload = extractDataPayload(rawEvent);
				if (payload !== null) events.push(payload);
				boundary = buffer.indexOf('\n\n');
			}
			return events;
		}
	};
}
