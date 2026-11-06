/**
 * Thin wrapper around the src-tauri embedded-server lifecycle commands
 * (spec §11.4). Every export here only makes sense inside the Tauri
 * webview - callers must guard with `isTauri()` (setup.ts) first, same as
 * any other capability-gated UI (spec §11.3: functionality a LAN browser
 * client cannot use is hidden by capability judgement, not disabled/greyed
 * out).
 */
import { getIdentifier } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { isProviderError, ProviderError, type ErrorBody } from '@banto/admin-core';

/** One LAN access URL and its QR code (as an inline SVG string), for the settings screen (spec §11.4). */
export interface QrSvg {
	url: string;
	svg: string;
}

/**
 * Mirrors src-tauri's `server_status`/`server_apply` command response shape.
 *
 * Issue #459: `enabled`/`bind`/`port`/`viewerPublic` are the SAVED settings
 * (what the next launch uses - the settings form starts from them); `running`,
 * `live`, `urls` and `qrSvgs` describe the listener that is actually serving.
 * Both halves come from one snapshot, identified by `generation`.
 */
export interface ServerStatus {
	enabled: boolean;
	running: boolean;
	bind: string;
	port: number;
	/**
	 * 閲覧公開 (Issue #189): whether LAN clients may obtain a synthetic
	 * `viewer` session without logging in (`POST /api/auth/grant/publicViewer`).
	 * Persisted with the other server settings; it has no effect inside this
	 * window, only on the LAN surface.
	 */
	viewerPublic: boolean;
	/**
	 * The listener that is actually serving, from its bound address (`null`
	 * when nothing is). Optional so older mocks and hosts read as "unknown"
	 * (see {@link liveBind}).
	 */
	live?: ServerListener | null;
	/** URLs (and QR codes) of the live listener - empty when nothing is serving. */
	urls: string[];
	qrSvgs: QrSvg[];
	/**
	 * Issue #478: whether this build embeds the web UI that other devices
	 * get from the LAN listener. `false` (a plain `tauri build` / `tauri dev`)
	 * means that page is a placeholder, so no URL, QR or connection check is
	 * offered (see `lanUiMissing`).
	 */
	uiEmbedded: boolean;
	/**
	 * Changes whenever the live listener is replaced (each `server_apply`).
	 * Anything shown or copied from the live values should be re-read when
	 * it changes.
	 */
	generation?: number;
	/**
	 * The last `server_apply` that failed after stopping the old listener,
	 * and what became of that listener (`null` when none since the last
	 * successful apply). Codes only - any text is built from the messages.
	 */
	applyFailure?: ServerApplyFailure | null;
	/**
	 * What the launch-time auto-start did because the saved port was in use
	 * (`null` when nothing happened, or after a successful `server_apply`).
	 * Codes and port numbers only - the text is built from the messages
	 * (`serverPortNotice.ts`, conventions §13). Optional so older mocks and
	 * hosts that never send it read as "nothing happened".
	 */
	portNotice?: ServerPortNotice | null;
	/**
	 * Issue #219: absolute path of this desktop executable (`std::env::current_exe()`),
	 * for the firewall information. `null` when the OS cannot tell; optional
	 * so older mocks and hosts read as "unknown". Only an admin ever gets a
	 * status at all, so this local information stays with the admin.
	 */
	executablePath?: string | null;
	/**
	 * `std::env::consts::OS` of the desktop host (`'windows'`, `'macos'`,
	 * `'linux'`, ...). A code, not text. Optional: unknown hosts show no
	 * Windows firewall information.
	 */
	platform?: string;
}

/**
 * Mirrors src-tauri's `ServerPortNotice`: at launch the saved port was in
 * use, so the server either started on `port` (right behind it; `saved`:
 * whether `server.port` now holds it) or, with every port up to `lastPort`
 * in use too, did not start.
 */
export type ServerPortNotice =
	| { kind: 'fallback'; requestedPort: number; port: number; saved: boolean }
	| { kind: 'exhausted'; requestedPort: number; lastPort: number; allInUse: boolean };

/** Mirrors src-tauri's `ServerListener`: the serving listener's actual address and port. */
export interface ServerListener {
	bind: string;
	port: number;
}

/**
 * Mirrors src-tauri's `ServerApplyFailure`: what a failed `server_apply`
 * asked for (nothing was saved), why it failed, and whether the listener
 * that was running before is back (`restored`), was never there (`none`),
 * or could not be brought back (`restoreFailed` - nothing serves).
 */
export interface ServerApplyFailure {
	enabled: boolean;
	bind: string;
	port: number;
	reason: 'portInUse' | 'bindFailed' | 'saveFailed';
	previous: 'none' | 'restored' | 'restoreFailed';
}

/**
 * Mirrors src-tauri's `firewall_status::UnknownReason`: why a firewall rule's
 * state could not be read (Issue #219 PR-B). Codes only.
 */
export type FirewallUnknownReason =
	| 'notWindows'
	| 'invalidIdentifier'
	| 'launchFailed'
	| 'timeout'
	| 'queryFailed'
	| 'unreadableOutput';

/** Mirrors src-tauri's `firewall_status::FirewallField`. */
export type FirewallField =
	| 'enabled'
	| 'direction'
	| 'action'
	| 'protocol'
	| 'profile'
	| 'program'
	| 'localPort'
	| 'remoteAddress'
	| 'active'
	| 'enforcement';

/** Mirrors src-tauri's `FirewallRuleValues`: a rule as `Get-NetFirewall*` reports it. */
export interface FirewallRuleValues {
	enabled: string;
	direction: string;
	action: string;
	protocol: string;
	profile: string;
	program: string;
	localPorts: string[];
	remoteAddresses: string[];
}

/**
 * Mirrors src-tauri's `SourceKind`: what the ActiveStore rule's
 * `PolicyStoreSourceType` (traced with `-TracePolicyStore`) names.
 * `unknown` = not reported; `other` = a value outside the documented ones.
 */
export type FirewallSourceKind =
	| 'local'
	| 'groupPolicy'
	| 'dynamic'
	| 'generated'
	| 'hardcoded'
	| 'mdm'
	| 'hostFirewallLocal'
	| 'hostFirewallGroupPolicy'
	| 'hostFirewallDynamic'
	| 'hostFirewallMdm'
	| 'unknown'
	| 'other';

/** Mirrors src-tauri's `RuleOrigin`: where the rule in effect (the ActiveStore's) comes from. */
export interface FirewallRuleOrigin {
	kind: FirewallSourceKind;
	/** `PolicyStoreSourceType` as reported (`null` when not reported). */
	sourceType: string | null;
	/** `PolicyStoreSource`: `PersistentStore` for a local rule, the policy otherwise (`null` when not reported). */
	source: string | null;
}

/**
 * Mirrors src-tauri's `Enforcement`: whether the rule in effect is applied
 * (the ActiveStore's `EnforcementStatus`). Only `Full` is `enforced`; a
 * documented other code is `notEnforced` with its names (`InactiveProfile`,
 * `LocalFirewallRulesDisallowed`, ...); no code or an unknown one is
 * `unknown` (`values`: the raw codes).
 */
export type FirewallEnforcement =
	| { state: 'enforced' }
	| { state: 'notEnforced'; reasons: string[] }
	| { state: 'unknown'; values: number[] };

/** Mirrors src-tauri's `LocalRule`: the local (PersistentStore) rule next to the one in effect. */
export type FirewallLocalRule =
	| { state: 'missing' }
	| { state: 'same' }
	| { state: 'differs'; rule: FirewallRuleValues }
	| { state: 'unknown' };

/** Mirrors src-tauri's `FirewallRuleCheck`: one rule's state. */
export type FirewallRuleCheck =
	| { state: 'missing' }
	| {
			state: 'present';
			/**
			 * The rule in effect (the ActiveStore's); the local one when it is
			 * not in the ActiveStore (`origin` and `enforcement` are then `null`
			 * and `mismatches` has `active`).
			 */
			rule: FirewallRuleValues;
			origin: FirewallRuleOrigin | null;
			/** Not `enforced`: `mismatches` has `enforcement`; `unknown`: `unchecked` has it. */
			enforcement: FirewallEnforcement | null;
			local: FirewallLocalRule;
			/** What differs from the rule the administrator command creates (empty = as expected). */
			mismatches: FirewallField[];
			/** What could not be compared (no live listener or executable path to compare with). */
			unchecked: FirewallField[];
	  }
	| { state: 'unknown'; reason: FirewallUnknownReason };

/**
 * Mirrors src-tauri's `FirewallRuleStatus` (`firewall_rule_status`): the
 * Banto rules in Windows Defender Firewall, read without elevation and
 * compared with the server snapshot of `generation`.
 */
export interface FirewallRuleStatus {
	generation: number;
	/** The comparison basis: the same snapshot's executable path and live port. */
	expected: { executablePath: string | null; port: number | null };
	program: FirewallRuleCheck;
	port: FirewallRuleCheck;
	/** Other rules in `-Group <identifier>` (`null` when unknown). */
	groupOtherRules: number | null;
}

/**
 * Mirrors src-tauri's `firewall_change::FirewallChangeOperation` (Issue #219
 * stage 2, ADR-0021): the two changing operations. The state is read with
 * `firewall_rule_status`, never through this command.
 */
export type FirewallChangeOperation = 'allow' | 'remove';

/**
 * Mirrors src-tauri's `FirewallChangeTarget` (ADR-0021 decision 13): what the
 * confirmation screen showed - `expected.executablePath` and `generation` of
 * the `firewall_rule_status` answer it displayed.
 */
export interface FirewallChangeTarget {
	executablePath: string | null;
	generation: number;
}

/**
 * Mirrors src-tauri's `FirewallChangeOutcome` (ADR-0021 decisions 11, 13).
 * `done` is exit code 0 - never "reachable" (that is the reach check's).
 */
export type FirewallChangeOutcome =
	| 'busy'
	| 'targetChanged'
	| 'precondition'
	| 'cancelled'
	| 'launchFailed'
	| 'done'
	| 'already'
	| 'conflict'
	| 'policy'
	| 'failed'
	| 'usage'
	| 'unexpectedExit';

/**
 * Mirrors src-tauri's `FirewallChangeResult` (`firewall_rule_change`).
 * `refusal` is the code of the app's own pre-elevation refusal
 * (`firewall_change::refusal_code` / `REFUSAL_*`); `stale`: the target
 * changed while the helper ran; `status` is always a fresh stage-1 read.
 * `outcome` and `refusal` are kept as plain strings here: a newer host may
 * send codes this screen does not know, and it must still say something.
 */
export interface FirewallChangeResult {
	operation: FirewallChangeOperation;
	outcome: FirewallChangeOutcome | (string & {});
	exitCode: number | null;
	refusal: string | null;
	osError: number | null;
	stale: boolean;
	status: unknown;
}

/**
 * Mirrors src-tauri's `ReachCheckRefusal`: why `reach_check_issue` issued
 * nothing (Issue #219 PR-C2, lan-reach-check-design §3.5). Codes only.
 */
export type ReachCheckRefusal =
	| 'notListening'
	| 'unsupportedBind'
	| 'loopbackOnly'
	| 'unknownHost'
	| 'staleGeneration'
	| 'localAddressesUnavailable';

/**
 * Mirrors src-tauri's `ReachCheckIssueResult` (`reach_check_issue`,
 * lan-reach-check-design §5.1). `url` holds the one-time token in its
 * fragment (`#t=...`) - never log it. Both answers name the server
 * `generation` they were judged against.
 */
export type ReachCheckIssueResult =
	| {
			status: 'issued';
			generation: number;
			issueId: number;
			url: string;
			qrSvg: string;
			expiresInMs: number;
	  }
	| { status: 'refused'; generation: number; reason: ReachCheckRefusal };

/** Mirrors `banto_server::ReachOutcome`. */
export type ReachOutcome = 'pending' | 'recorded' | 'expired';

/** Mirrors `banto_server::LastIssue` (no token in it). */
export interface ReachLastIssue {
	issueId: number;
	host: string;
	port: number;
	/** Epoch milliseconds. */
	expiresAt: number;
	outcome: ReachOutcome;
	/** Remaining validity while `pending`, else 0. */
	expiresInMs: number;
}

/** Mirrors `banto_server::ReachRecord`: one reach from another device. */
export interface ReachRecord {
	issueId: number;
	/** Epoch milliseconds. */
	at: number;
	peerIp: string;
	host: string;
	port: number;
}

/**
 * Mirrors `banto_server::ReachCheckStatus` (`reach_check_status`): the reach
 * check of listener `generation`. `lastIssue` is `null` when nothing was
 * issued in this generation (unverified).
 */
export interface ReachCheckStatus {
	generation: number;
	lastIssue: ReachLastIssue | null;
	/**
	 * Epoch milliseconds of the last access from this PC itself with the last
	 * issuance's URL, if any (every new issuance clears it, so it never stands
	 * for an earlier issuance).
	 */
	selfAccessAt: number | null;
	/** Newest first. */
	records: ReachRecord[];
}

/**
 * The bind address the status line should describe: the live listener's
 * when the host reports one, else the saved `bind` (older hosts, or nothing
 * serving).
 */
export function liveBind(status: ServerStatus): string {
	return status.live?.bind ?? status.bind;
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

/** Same type guard as systemAdmin.ts / providers/tauri.ts (spec §10/§11.1). */
function isErrorBody(value: unknown): value is ErrorBody {
	if (typeof value !== 'object' || value === null) return false;
	const kind = (value as { kind?: unknown }).kind;
	return typeof kind === 'string' && ERROR_KINDS.has(kind);
}

/** Tauri rejects with a `{ kind, message }` object, not an `Error` (Issue #287). */
export function toProviderError(err: unknown): ProviderError {
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

/** Current saved settings + the live listener, as one snapshot (spec §11.4, Issue #459). */
export function getServerStatus(): Promise<ServerStatus> {
	return invokeCommand('server_status');
}

/**
 * Whether Windows Defender Firewall has the Banto rules (Issue #219 PR-B,
 * spec §11.4). Read-only, no elevation; admin-only like `server_status`.
 * Resolves to whatever the host returned - check it with
 * `firewallRuleStatus.ts::isFirewallRuleStatus` (an older host has no such
 * command).
 */
export function getFirewallRuleStatus(): Promise<unknown> {
	return invokeCommand('firewall_rule_status');
}

/**
 * Add (`allow`) or remove (`remove`) the per-executable firewall rule through
 * the UAC-elevated helper (Issue #219 stage 2, ADR-0021). Admin-only,
 * desktop-only; waits until the UAC prompt is answered and the helper ended.
 * `target` is what the confirmation screen showed (decision 13). Resolves to
 * whatever the host returned - check it with
 * `firewallChange.ts::isFirewallChangeResult` (an older host has no such
 * command).
 */
export function changeFirewallRule(
	operation: FirewallChangeOperation,
	target: FirewallChangeTarget
): Promise<unknown> {
	return invokeCommand('firewall_rule_change', { operation, target });
}

/**
 * Issue a one-time reach-check URL for `host` - one of the live listener's
 * non-loopback URL hosts (Issue #219 PR-C2). Admin-only, desktop-only.
 */
export function issueReachCheck(host: string): Promise<ReachCheckIssueResult> {
	return invokeCommand('reach_check_issue', { host });
}

/** The reach check of the live listener (Issue #219 PR-C2). Admin-only, read-only. */
export function getReachCheckStatus(): Promise<ReachCheckStatus> {
	return invokeCommand('reach_check_status');
}

/**
 * The Tauri bundle identifier (`tauri.conf.json` `identifier`), which names
 * the firewall rules so apps derived from this template do not collide
 * (Issue #219). `null` when it cannot be read - the caller then offers no
 * commands rather than guessing a name.
 */
export async function getAppIdentifier(): Promise<string | null> {
	try {
		const identifier: unknown = await getIdentifier();
		return typeof identifier === 'string' ? identifier : null;
	} catch {
		return null;
	}
}

/** Persist new settings, stop/restart the server to match, and return the resulting status. */
export function applyServerSettings(
	enabled: boolean,
	bind: string,
	port: number,
	viewerPublic: boolean
): Promise<ServerStatus> {
	return invokeCommand('server_apply', { enabled, bind, port, viewerPublic });
}
