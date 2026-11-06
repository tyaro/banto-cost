/** Shared desktop IPC/asset fixture; no production test switch. */
import type { Page } from '@playwright/test';

/** One of `TAURI_ORIGINS` (environment.ts): where Tauri serves its own assets on Windows. */
const TAURI_ORIGIN = 'http://tauri.localhost';

/**
 * Serves `TAURI_ORIGIN` from banto-serve (the project's `baseURL`): every
 * request to it is fetched from the real server and fulfilled as-is, so
 * `location.origin` is a Tauri asset origin while the static build is the
 * real one. Pass the page's own relative paths to `page.goto(tauriUrl(...))`.
 */
export async function serveOnTauriOrigin(page: Page, baseURL: string | undefined): Promise<void> {
	if (!baseURL) throw new Error('project baseURL is required');
	await page.route(`${TAURI_ORIGIN}/**`, async (route) => {
		const url = new URL(route.request().url());
		const response = await route.fetch({ url: new URL(url.pathname + url.search, baseURL).href });
		await route.fulfill({ response });
	});
}

export const tauriUrl = (path: string): string => `${TAURI_ORIGIN}${path}`;

/** Installs the IPC stub. Knobs live on `window.__bantoMock` (see `mock()`). */
export async function installTauriStub(page: Page): Promise<void> {
	await page.addInitScript(() => {
		type Callback = (payload: unknown) => void;
		const callbacks = new Map<number, Callback>();
		let nextId = 1;
		const mock = {
			serverStatusFails: false,
			authConfigFails: false,
			/** When set, `server_status` waits for it (a slow first load). */
			serverStatusGate: null as Promise<void> | null,
			releaseServerStatus: null as (() => void) | null,
			listens: [] as { event: string; handler: number; eventId: number }[],
			unlistens: [] as number[],
			destroyed: 0,
			callbacks,
			/**
			 * The Rust session slot (Issue #260): `auth_resolve` answers from it,
			 * and `auth_config_apply(true)` re-binds it to the synthetic local
			 * session, advancing `seq` (owner review of #266 P1). The provider
			 * does not observe that advance until its next `auth_resolve`.
			 */
			slot: { seq: 1, local: false, none: false, role: 'admin' as string },
			resolves: [] as { checked: number; kind: string }[],
			/** Merged into every `server_status` answer (Issue #219: a running Windows host). */
			serverStatusPatch: {} as Record<string, unknown>,
			/** `@tauri-apps/api/app`'s `getIdentifier()` answer. */
			appIdentifier: null as string | null,
			/** `firewall_rule_status`'s answer (Issue #219 PR-B; `null` = an older host). */
			firewallRuleStatus: null as unknown,
			/** `reach_check_status`'s answer (Issue #219 PR-C3; `null` = an older host). */
			reachCheckStatus: null as unknown,
			/** `reach_check_issue`'s answer. */
			reachCheckIssue: null as unknown,
			/** Becomes `reachCheckStatus` when `reach_check_issue` is called (the host's new issuance). */
			reachStatusAfterIssue: null as unknown,
			/** The hosts `reach_check_issue` was called with. */
			reachIssueHosts: [] as string[],
			/**
			 * `firewall_rule_change`'s answer (Issue #219 stage 2, ADR-0021 E3).
			 * Its `status` (the re-read) also becomes `firewallRuleStatus`.
			 */
			firewallChange: null as unknown,
			/** The args `firewall_rule_change` was called with. */
			firewallChangeCalls: [] as unknown[],
			/** When set, `firewall_rule_change` waits for it (the UAC prompt is open). */
			firewallChangeGate: null as Promise<void> | null
		};
		mock.serverStatusGate = new Promise<void>((resolve) => {
			mock.releaseServerStatus = resolve;
		});
		(window as unknown as { __bantoMock: typeof mock }).__bantoMock = mock;

		const serverStatus = {
			enabled: false,
			running: false,
			bind: '127.0.0.1',
			port: 8721,
			viewerPublic: false,
			urls: [],
			qrSvgs: [],
			uiEmbedded: true
		};
		const authSettings = {
			disabled: false,
			disabledRole: 'admin',
			autologinEnabled: false,
			autologinUsername: null
		};

		async function invoke(cmd: string, args: Record<string, unknown> = {}): Promise<unknown> {
			switch (cmd) {
				case 'auth_check':
					return true;
				case 'auth_identity':
					return { id: 'admin', name: 'E2E管理者', role: 'admin' };
				// Issue #260 実装-2: the route guard asks through the
				// SessionController, i.e. the provider's one-round-trip
				// `auth_resolve`.
				case 'auth_resolve': {
					const { seq, local, none, role } = mock.slot;
					const answer = none
						? { identity: null, kind: null, checked: seq, current: seq, stale: false }
						: local
							? {
									identity: { id: '0', name: 'ローカルユーザー', role },
									kind: 'local',
									checked: seq,
									current: seq,
									stale: false
								}
							: {
									identity: { id: 'admin', name: 'E2E管理者', role: 'admin' },
									kind: 'account',
									checked: seq,
									current: seq,
									stale: false
								};
					mock.resolves.push({ checked: seq, kind: answer.kind ?? 'none' });
					return answer;
				}
				case 'auth_config_apply': {
					const disabled = args.disabled === true;
					authSettings.disabled = disabled;
					authSettings.disabledRole = String(args.disabledRole);
					if (disabled) {
						const rebinding = !mock.slot.local || mock.slot.role !== authSettings.disabledRole;
						mock.slot = {
							seq: mock.slot.seq + (rebinding ? 1 : 0),
							local: true,
							none: false,
							role: authSettings.disabledRole
						};
					} else if (mock.slot.local) {
						// S-99: turning the mode off ends the synthetic session at once.
						mock.slot = { seq: mock.slot.seq + 1, local: false, none: true, role: 'admin' };
					}
					return { ...authSettings };
				}
				case 'auth_status':
					return { initialized: true };
				case 'auth_config_get':
					if (mock.authConfigFails) throw 'auth settings unavailable (stub)';
					return authSettings;
				case 'server_status':
					if (mock.serverStatusGate) await mock.serverStatusGate;
					if (mock.serverStatusFails) throw 'server status unavailable (stub)';
					return { ...serverStatus, ...mock.serverStatusPatch };
				case 'plugin:app|identifier':
					return mock.appIdentifier;
				case 'firewall_rule_status':
					return mock.firewallRuleStatus;
				case 'reach_check_status':
					return mock.reachCheckStatus;
				case 'reach_check_issue':
					mock.reachIssueHosts.push(String(args.host));
					if (mock.reachStatusAfterIssue !== null)
						mock.reachCheckStatus = mock.reachStatusAfterIssue;
					return mock.reachCheckIssue;
				case 'firewall_rule_change': {
					mock.firewallChangeCalls.push(args);
					if (mock.firewallChangeGate) await mock.firewallChangeGate;
					const answer = mock.firewallChange as { status?: unknown } | null;
					if (answer?.status !== undefined) mock.firewallRuleStatus = answer.status;
					return answer;
				}
				case 'vibrancy_status':
					return { supported: false, applied: false };
				case 'plugin:event|listen': {
					const eventId = nextId++;
					mock.listens.push({
						event: String(args.event),
						handler: Number(args.handler),
						eventId
					});
					return eventId;
				}
				case 'plugin:event|unlisten':
					mock.unlistens.push(Number(args.eventId));
					return null;
				case 'plugin:window|destroy':
					mock.destroyed++;
					return null;
				default:
					return null;
			}
		}

		(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
			metadata: {
				currentWindow: { label: 'main' },
				currentWebview: { windowLabel: 'main', label: 'main' }
			},
			invoke,
			transformCallback(callback: Callback) {
				const id = nextId++;
				callbacks.set(id, callback);
				return id;
			},
			unregisterCallback(id: number) {
				callbacks.delete(id);
			},
			convertFileSrc: (path: string) => path
		};
		// `@tauri-apps/api/event`'s unlisten also tells the event plugin's
		// in-page registry; nothing to do here.
		(
			window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }
		).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
	});
}

/** Loaded desktop settings for responsive UI checks, without invoking a backend. */
export async function installSettingsLayoutStub(page: Page): Promise<void> {
	await installTauriStub(page);
	await page.addInitScript(() => {
		const host = window as unknown as {
			__bantoMock: {
				serverStatusGate: unknown;
				serverStatusPatch: Record<string, unknown>;
				appIdentifier: string | null;
			};
			__TAURI_INTERNALS__: {
				invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
			};
		};
		host.__bantoMock.serverStatusGate = null;
		host.__bantoMock.appIdentifier = 'jp.banto.template';
		host.__bantoMock.serverStatusPatch = {
			enabled: true,
			running: true,
			bind: '0.0.0.0',
			urls: ['http://192.168.1.10:8721'],
			qrSvgs: [
				'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200" data-layout-qr><rect width="200" height="200" fill="white"/><path d="M10 10h50v50H10z" fill="black"/></svg>'
			],
			platform: 'windows',
			executablePath:
				'C:\\Apps\\Banto\\An application folder for a long executable path\\banto.exe',
			generation: 1
		};
		const original = host.__TAURI_INTERNALS__.invoke;
		host.__TAURI_INTERNALS__.invoke = async (command, args) => {
			if (command === 'audit_config_get') return { retentionDays: 90, retentionRows: 100_000 };
			if (command === 'backups_list') return [];
			if (command === 'system_info') {
				return {
					appVersion: '6.9.1',
					dbDialect: 'sqlite',
					dbLatencyMs: 1,
					migrationVersion: 4,
					uptimeSecs: 3600,
					activeSessions: 1,
					attachmentBytes: 0,
					metrics: null
				};
			}
			return original(command, args);
		};
	});
}
