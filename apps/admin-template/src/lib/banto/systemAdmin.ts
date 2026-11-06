/**
 * Client for the `admin`-only System Info API (M-review 2026-08 §2.4「縮小版⑤」).
 * Same Tauri/REST split as `auditLogAdmin.ts`/`usersAdmin.ts`: the Tauri webview
 * calls `invoke('system_info')` directly (the command in
 * `apps/admin-template/src-tauri/src/lib.rs`), a LAN browser client served by
 * the embedded server calls `fetch()` against `GET /api/system/info`
 * (`crates/banto-server/src/routes/system_info.rs`, merged in
 * `apps/admin-template/core/src/rest/mod.rs`), reusing the same bearer-token/
 * CSRF-header mechanism the generic providers use.
 *
 * Deliberately NOT built on `@banto/admin-core`'s generic `DataProvider` - same
 * reasoning as `auditLogAdmin.ts`: this is a small, dedicated read surface with
 * its own Tauri command name, not a `{resource}_list`-shaped CRUD resource.
 *
 * Plain `vite dev`/`vite preview` (demo mode, no Rust backend at all): there is
 * no live server to probe, so `getSystemInfo` rejects with a `ProviderError`
 * carrying `DEMO_MODE_MESSAGE`, and the settings card is hidden via
 * `isSystemInfoAvailable()` - mirroring the audit/backups cards.
 */
import { invoke } from '@tauri-apps/api/core';
import { getAuthProvider, isProviderError, ProviderError, type ErrorBody } from '@banto/admin-core';
import { CSRF_HEADER, getBantoMode } from './setup';

/**
 * Mirrors `banto_server::routes::SystemInfo` (camelCase on the wire), the
 * shape both `GET /api/system/info` and the `system_info` Tauri command return.
 */
export interface SystemInfo {
	/** Compiled-in Banto version (`env!("CARGO_PKG_VERSION")`). */
	appVersion: string;
	/** SQL dialect of the live DB handle: `'sqlite'` or `'postgres'`. */
	dbDialect: string;
	/** Round-trip latency of a `SELECT 1` probe, in milliseconds. */
	dbLatencyMs: number;
	/** Highest applied migration version, or `null` if unreadable. */
	migrationVersion: number | null;
	/** Seconds since the server/app started. */
	uptimeSecs: number;
	/** Active LAN bearer sessions (an upper bound - see the Rust doc comment). */
	activeSessions: number;
	/** Total attachment size in bytes, or `null` when the feature is absent/unknown. */
	attachmentBytes: number | null;
	/**
	 * Host/process CPU and memory (ADR-0013, Issue #185), or `null` when the
	 * `system-metrics` Cargo feature is off, or the host platform is
	 * unsupported by `sysinfo`.
	 */
	metrics: SystemMetrics | null;
}

/**
 * Mirrors `banto_admin_services::system_metrics::SystemMetrics` (camelCase on
 * the wire), folded into {@link SystemInfo.metrics} by both backends.
 */
export interface SystemMetrics {
	/** Host-wide CPU usage, as a percentage (0..=100). */
	hostCpuPercent: number;
	/** Total host physical memory, in bytes. */
	hostMemoryTotalBytes: number;
	/** Used host physical memory, in bytes. */
	hostMemoryUsedBytes: number;
	/** Total host swap, in bytes. `0` on a host with no swap configured. */
	hostSwapTotalBytes: number;
	/** Used host swap, in bytes. */
	hostSwapUsedBytes: number;
	/** This process's own CPU usage, as a percentage (can exceed 100 on a multi-core host). */
	processCpuPercent: number;
	/** This process's resident memory (RSS), in bytes. */
	processMemoryBytes: number;
	/** Logical CPU count, for interpreting `processCpuPercent`. */
	cpuCount: number;
}

export const DEMO_MODE_MESSAGE = 'デモモードでは利用できません';

function demoModeError(): ProviderError {
	return new ProviderError({ kind: 'other', message: DEMO_MODE_MESSAGE });
}

/** Is this environment backed by a real server to probe (Tauri or the embedded server)? False in plain-browser demo mode. */
export function isSystemInfoAvailable(): boolean {
	return getBantoMode() !== 'demo';
}

const ERROR_KINDS = new Set([
	'not_found',
	'validation',
	'bad_request',
	'unauthorized',
	'forbidden',
	'storage',
	'other'
]);

/** Same type guard as providers/tauri.ts / providers/http.ts / auditLogAdmin.ts (spec §10/§11.1). */
function isErrorBody(value: unknown): value is ErrorBody {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return typeof kind === 'string' && ERROR_KINDS.has(kind);
}

function toProviderError(err: unknown): ProviderError {
	if (isProviderError(err)) return err;
	if (isErrorBody(err)) return new ProviderError(err);
	const message = err instanceof Error ? err.message : String(err);
	return new ProviderError({ kind: 'other', message });
}

async function invokeCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
	try {
		return (await invoke(cmd, args)) as T;
	} catch (err) {
		throw toProviderError(err);
	}
}

const NETWORK_ERROR_MESSAGE = 'サーバーに接続できません';

/** Same token lookup as auditLogAdmin.ts - see that file's doc comment. */
function currentToken(): string | null {
	const auth = getAuthProvider() as { getToken?: () => string | null };
	return auth.getToken ? auth.getToken() : null;
}

interface HttpInit {
	method: string;
	body?: unknown;
}

async function httpRequest<T>(path: string, init: HttpInit): Promise<T> {
	const hasBody = init.body !== undefined;
	const headers: Record<string, string> = { ...CSRF_HEADER };
	if (hasBody) headers['Content-Type'] = 'application/json';
	const token = currentToken();
	if (token) headers.Authorization = `Bearer ${token}`;

	let response: Response;
	try {
		response = await fetch(path, {
			method: init.method,
			headers,
			body: hasBody ? JSON.stringify(init.body) : undefined
		});
	} catch {
		throw new ProviderError({ kind: 'other', message: NETWORK_ERROR_MESSAGE });
	}

	if (!response.ok) {
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			throw new ProviderError({
				kind: 'other',
				message: `${response.status} ${response.statusText}`
			});
		}
		if (isErrorBody(body)) throw new ProviderError(body);
		throw new ProviderError({
			kind: 'other',
			message: `${response.status} ${response.statusText}`
		});
	}

	return (await response.json()) as T;
}

/** Admin-only system diagnostics (version/uptime/DB/sessions/storage). `admin`-only (rejected with a `forbidden` `ProviderError` otherwise); unavailable in demo mode. */
export async function getSystemInfo(): Promise<SystemInfo> {
	if (!isSystemInfoAvailable()) throw demoModeError();
	if (getBantoMode() === 'tauri') return invokeCommand<SystemInfo>('system_info');
	return httpRequest<SystemInfo>('/api/system/info', { method: 'GET' });
}
