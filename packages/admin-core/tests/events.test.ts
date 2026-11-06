import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	connectEvents,
	createSseEventProvider,
	createTauriEventProvider,
	type AppEvent,
	type EventProvider,
	type EventSubscriptionHooks
} from '../src/events';
import { onSessionEnded } from '../src/sessionEnded';
import { onInvalidate } from '../src/invalidate';
import { initBanto } from '../src/registry.svelte';
import type { AuthProvider, DataProvider, Notifier } from '../src/provider';
import {
	getSessionController,
	resetDefaultSessionController,
	resolveSettled
} from '../src/sessionController.svelte';
import { ALICE, flush, makeProbeProvider } from './sessionHarness';
import { STUB_SESSION } from './stubAuth';

function stubProviders(notifier?: Notifier): void {
	const dataProvider: DataProvider = {
		getList: async () => ({ rows: [], totalCount: 0 }),
		getOne: async () => ({}) as never,
		create: async () => ({}) as never,
		update: async () => ({}) as never,
		deleteOne: async () => {}
	};
	const authProvider: AuthProvider = {
		login: async () => ({ success: true }),
		logout: async () => {},
		...STUB_SESSION
	};
	initBanto({ dataProvider, authProvider, resources: [], notifier });
}

describe('createTauriEventProvider', () => {
	it('listens on banto://event and forwards AppEvent payloads only', async () => {
		let capturedCb: ((e: { payload: unknown }) => void) | null = null;
		const unlistenFn = vi.fn();
		const listen = vi.fn(async (eventName: string, cb: (e: { payload: unknown }) => void) => {
			expect(eventName).toBe('banto://event');
			capturedCb = cb;
			return unlistenFn;
		});

		const provider = createTauriEventProvider({ listen });
		const handler = vi.fn();
		const unsubscribe = provider.subscribe(handler);

		await Promise.resolve();
		await Promise.resolve();

		capturedCb!({ payload: { kind: 'resource_changed', resource: 'items' } });
		expect(handler).toHaveBeenCalledWith({ kind: 'resource_changed', resource: 'items' });

		capturedCb!({ payload: { unrelated: true } });
		expect(handler).toHaveBeenCalledTimes(1);

		unsubscribe();
		await Promise.resolve();
		expect(unlistenFn).toHaveBeenCalledTimes(1);
	});

	it('tears down immediately if unsubscribed before listen() resolves', async () => {
		const unlistenFn = vi.fn();
		let resolveListen!: (fn: () => void) => void;
		const listen = vi.fn(
			() =>
				new Promise<() => void>((resolve) => {
					resolveListen = resolve;
				})
		);

		const provider = createTauriEventProvider({ listen });
		const unsubscribe = provider.subscribe(vi.fn());
		unsubscribe();
		resolveListen(unlistenFn);
		await Promise.resolve();
		expect(unlistenFn).toHaveBeenCalledTimes(1);
	});
});

describe('createSseEventProvider', () => {
	function fakeStreamResponse(chunks: string[]): Response {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			}
		});
		return new Response(stream);
	}

	it('does not connect while getToken() returns null', async () => {
		const fetchFn = vi.fn();
		const provider = createSseEventProvider({ getToken: () => null, fetchFn, reconnectDelayMs: 5 });
		const unsubscribe = provider.subscribe(vi.fn());
		await Promise.resolve();
		expect(fetchFn).not.toHaveBeenCalled();
		unsubscribe();
	});

	it('connects with Authorization + X-Banto-Client headers and dispatches parsed events', async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(
				fakeStreamResponse(['data: {"kind":"notice","level":"info","message":"hi"}\n\n'])
			);
		const provider = createSseEventProvider({
			getToken: () => 'tok123',
			fetchFn,
			baseUrl: 'http://x'
		});
		const handler = vi.fn();
		const unsubscribe = provider.subscribe(handler);

		await vi.waitFor(() => expect(handler).toHaveBeenCalled());

		expect(fetchFn).toHaveBeenCalledWith(
			'http://x/api/events',
			expect.objectContaining({
				headers: expect.objectContaining({
					'X-Banto-Client': 'banto',
					Authorization: 'Bearer tok123'
				})
			})
		);
		expect(handler).toHaveBeenCalledWith({ kind: 'notice', level: 'info', message: 'hi' });
		unsubscribe();
	});

	// Issue #241: the stream's reconnect policy after the session is revoked.
	describe('reconnect policy (Issue #241)', () => {
		const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

		it('a 401 stops reconnecting with that token and reports it once', async () => {
			const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
			const onUnauthorized = vi.fn();
			const provider = createSseEventProvider({
				getToken: () => 'revoked',
				fetchFn,
				reconnectDelayMs: 5,
				tokenWaitDelayMs: 5
			});
			const unsubscribe = provider.subscribe(vi.fn(), { onUnauthorized });

			await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
			await sleep(80);
			expect(fetchFn).toHaveBeenCalledTimes(1);
			expect(onUnauthorized).toHaveBeenCalledTimes(1);
			unsubscribe();
		});

		it('resumes with a different token after a 401 (a new login)', async () => {
			let token = 'revoked';
			const fetchFn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
				const auth = (init?.headers as Record<string, string>).Authorization;
				if (auth === 'Bearer revoked') return Promise.resolve(new Response(null, { status: 401 }));
				return new Promise<Response>(() => {
					// the new session's stream stays open
				});
			});
			const onUnauthorized = vi.fn();
			const provider = createSseEventProvider({
				getToken: () => token,
				fetchFn,
				reconnectDelayMs: 5,
				tokenWaitDelayMs: 5
			});
			const unsubscribe = provider.subscribe(vi.fn(), { onUnauthorized });

			await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
			token = 'fresh';
			await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
			const headers = fetchFn.mock.calls[1][1]?.headers as Record<string, string>;
			expect(headers.Authorization).toBe('Bearer fresh');
			unsubscribe();
		});

		it('a token cleared after its own 401 is not reported again as cleared', async () => {
			let token: string | null = 'revoked';
			const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
			const onUnauthorized = vi.fn(() => {
				token = null; // what the confirmation's check() does
			});
			const onTokenCleared = vi.fn();
			const provider = createSseEventProvider({
				getToken: () => token,
				fetchFn,
				reconnectDelayMs: 5,
				tokenWaitDelayMs: 5
			});
			const unsubscribe = provider.subscribe(vi.fn(), { onUnauthorized, onTokenCleared });

			await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
			await sleep(60);
			expect(onTokenCleared).not.toHaveBeenCalled();
			unsubscribe();
		});

		it('reports a cleared token once, then waits quietly for a new login', async () => {
			let token: string | null = 'shared';
			const fetchFn = vi.fn(
				async () => new Response(new ReadableStream({ start: (c) => c.close() }))
			);
			const onTokenCleared = vi.fn();
			const provider = createSseEventProvider({
				getToken: () => token,
				fetchFn,
				reconnectDelayMs: 5,
				tokenWaitDelayMs: 5
			});
			const unsubscribe = provider.subscribe(vi.fn(), { onTokenCleared });

			await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
			token = null;
			await vi.waitFor(() => expect(onTokenCleared).toHaveBeenCalledTimes(1));
			const sent = fetchFn.mock.calls.length;
			await sleep(60);
			expect(onTokenCleared).toHaveBeenCalledTimes(1);
			expect(fetchFn.mock.calls.length).toBe(sent);
			unsubscribe();
		});

		for (const [label, failure] of [
			[
				'a 500 (the server could not verify)',
				() => Promise.resolve(new Response(null, { status: 500 }))
			],
			['an unreachable server', () => Promise.reject(new TypeError('Failed to fetch'))],
			['a stream the server ended', () => Promise.resolve(fakeStreamResponse([]))]
		] as const) {
			it(`${label} keeps reconnecting with the same token`, async () => {
				const fetchFn = vi.fn(failure);
				const onUnauthorized = vi.fn();
				const provider = createSseEventProvider({
					getToken: () => 'tok',
					fetchFn,
					reconnectDelayMs: 5,
					tokenWaitDelayMs: 5
				});
				const unsubscribe = provider.subscribe(vi.fn(), { onUnauthorized });

				await vi.waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(3));
				unsubscribe();
				expect(onUnauthorized).not.toHaveBeenCalled();
			});
		}
	});

	it('aborts the in-flight request on unsubscribe', async () => {
		let capturedSignal: AbortSignal | undefined;
		const fetchFn: typeof fetch = vi.fn((_input, init) => {
			capturedSignal = init?.signal ?? undefined;
			return new Promise<Response>(() => {
				// never resolves - simulates a still-open connection
			});
		});
		const provider = createSseEventProvider({ getToken: () => 'tok', fetchFn });
		const unsubscribe = provider.subscribe(vi.fn());

		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
		unsubscribe();
		expect(capturedSignal?.aborted).toBe(true);
	});
});

describe('connectEvents', () => {
	it('dispatches resource_changed to invalidate()', () => {
		stubProviders();
		let handler: ((event: AppEvent) => void) | null = null;
		const fakeProvider: EventProvider = {
			subscribe: (h) => {
				handler = h;
				return vi.fn();
			}
		};
		const invalidated = vi.fn();
		onInvalidate('items', invalidated);

		connectEvents(fakeProvider);
		handler!({ kind: 'resource_changed', resource: 'items' });

		expect(invalidated).toHaveBeenCalledTimes(1);
	});

	it('dispatches notice to the notifier, falling back to info for an unrecognized level', () => {
		const seen: { kind: string; message: string }[] = [];
		stubProviders({ notify: (kind, message) => seen.push({ kind, message }) });
		let handler: ((event: AppEvent) => void) | null = null;
		const fakeProvider: EventProvider = {
			subscribe: (h) => {
				handler = h;
				return vi.fn();
			}
		};

		connectEvents(fakeProvider);
		handler!({ kind: 'notice', level: 'error', message: 'oops' });
		handler!({ kind: 'notice', level: 'warning', message: 'careful' });
		handler!({ kind: 'notice', level: 'weird', message: 'fallback' });

		expect(seen).toEqual([
			{ kind: 'error', message: 'oops' },
			{ kind: 'warning', message: 'careful' },
			{ kind: 'info', message: 'fallback' }
		]);
	});

	// Issue #241: a stream the server rejected (or whose token another tab
	// cleared) is a signal to the default SessionController (Issue #260
	// 実装-3, design §6.1): it confirms the session with a probe started after
	// the signal, retrying with backoff inside the controller.
	describe('a rejected stream (Issue #241) signals the controller', () => {
		beforeEach(() => {
			resetDefaultSessionController();
		});

		async function signedIn() {
			const p = makeProbeProvider();
			initBanto({ dataProvider: {} as DataProvider, authProvider: p.provider, resources: [] });
			const first = resolveSettled(getSessionController());
			p.active(0, ALICE);
			await first;
			return p;
		}

		function capturedHooks(): { hooks: () => EventSubscriptionHooks; provider: EventProvider } {
			let captured: EventSubscriptionHooks | undefined;
			return {
				hooks: () => captured!,
				provider: {
					subscribe: (_h, hooks) => {
						captured = hooks;
						return vi.fn();
					}
				}
			};
		}

		for (const hook of ['onUnauthorized', 'onTokenCleared'] as const) {
			it(`${hook}: a probe confirms \`none\` and onSessionEnded hears it once`, async () => {
				const p = await signedIn();
				const ended = vi.fn();
				const off = onSessionEnded(ended);
				const { hooks, provider } = capturedHooks();
				connectEvents(provider);

				hooks()[hook]!();
				expect(p.probes).toHaveLength(2);
				p.none(1, { clear: true });
				await flush();
				expect(ended).toHaveBeenCalledTimes(1);
				expect(getSessionController().snapshot.status).toBe('none');
				off();
			});
		}

		it('a signal while an older probe is in flight is answered only by a newer probe (I-9)', async () => {
			const p = await signedIn();
			const pending = resolveSettled(getSessionController(), { cause: 'navigation' });
			expect(p.probes).toHaveLength(2);
			const { hooks, provider } = capturedHooks();
			connectEvents(provider);

			hooks().onUnauthorized!();
			expect(p.probes[1].signal?.aborted).toBe(true);
			expect(p.probes).toHaveLength(3);
			p.none(2, { clear: true });
			await expect(pending).resolves.toMatchObject({
				outcome: 'confirmed',
				snapshot: { status: 'none' }
			});
		});

		for (const [label, settle] of [
			[
				'the session is still valid',
				(p: ReturnType<typeof makeProbeProvider>) => p.active(1, ALICE)
			],
			[
				'the provider could not verify (500 / unreachable)',
				(p: ReturnType<typeof makeProbeProvider>) => p.fail(1)
			]
		] as const) {
			it(`does not end the session when ${label}`, async () => {
				const p = await signedIn();
				const ended = vi.fn();
				const off = onSessionEnded(ended);
				const { hooks, provider } = capturedHooks();
				connectEvents(provider);

				hooks().onUnauthorized!();
				settle(p);
				await flush();
				expect(ended).not.toHaveBeenCalled();
				expect(getSessionController().snapshot).toMatchObject({
					status: 'active',
					owner: 'account:alice'
				});
				off();
			});
		}
	});

	it('returns the provider unsubscribe function', () => {
		stubProviders();
		const unsub = vi.fn();
		const fakeProvider: EventProvider = { subscribe: () => unsub };
		const result = connectEvents(fakeProvider);
		result();
		expect(unsub).toHaveBeenCalledTimes(1);
	});
});
