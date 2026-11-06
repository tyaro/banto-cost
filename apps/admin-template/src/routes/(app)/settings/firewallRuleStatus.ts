/**
 * Spec §11.4 (LAN settings UX: documenting the OS-side Windows Firewall
 * behavior). Pure decisions behind the settings screen's "Windows Firewall
 * status" (Issue #219, stage 1 / PR-B): whether a `firewall_rule_status`
 * response may be shown, and what each rule's state reads as.
 * `FirewallRuleStatusPanel.svelte` renders it; nothing here touches the
 * DOM, Tauri or the message catalog (conventions §13).
 *
 * A rule that exists is not the same as being reachable from the LAN
 * (security audit 2026-10-21): this only tells what Windows Defender
 * Firewall holds under these names, and the panel says so. What is compared
 * is the rule in effect (the ActiveStore's), which a central policy of the
 * same name can override; the local rule is only a supplement (Codex review
 * on PR #465). Being in the ActiveStore is not being applied: only an
 * `enforced` status reads as applied, and a rule whose status is not known
 * never reads as plainly "as expected" (owner review on PR #465).
 *
 * Responses are ordered the same way as `serverStatusRequests.ts` (owner
 * review on PR #463): each check gets a ticket, an apply or a newer check
 * makes the older ones stale, and a response is shown only when it was
 * compared with the very snapshot the panel shows (same `generation`, live
 * port and executable path) - never one for a listener that is gone.
 */
import type {
	FirewallEnforcement,
	FirewallField,
	FirewallRuleCheck,
	FirewallRuleStatus,
	FirewallRuleValues,
	FirewallSourceKind,
	FirewallUnknownReason
} from '#lib/banto/serverAdmin.js';
import type { FirewallInfo } from './firewallInfo';

const STATES = new Set(['missing', 'present', 'unknown']);
const LOCAL_STATES = new Set(['missing', 'same', 'differs', 'unknown']);
const SOURCE_KINDS: ReadonlySet<string> = new Set<FirewallSourceKind>([
	'local',
	'groupPolicy',
	'dynamic',
	'generated',
	'hardcoded',
	'mdm',
	'hostFirewallLocal',
	'hostFirewallGroupPolicy',
	'hostFirewallDynamic',
	'hostFirewallMdm',
	'unknown',
	'other'
]);
/** Sources that are central management: what applies is the policy's. */
const POLICY_KINDS: ReadonlySet<FirewallSourceKind> = new Set<FirewallSourceKind>([
	'groupPolicy',
	'mdm',
	'hostFirewallGroupPolicy',
	'hostFirewallMdm'
]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isTextOrNull(value: unknown): boolean {
	return value === null || typeof value === 'string';
}

function isOrigin(value: unknown): boolean {
	return (
		value === null ||
		(isObject(value) &&
			typeof value.kind === 'string' &&
			SOURCE_KINDS.has(value.kind) &&
			isTextOrNull(value.sourceType) &&
			isTextOrNull(value.source))
	);
}

function isEnforcement(value: unknown): boolean {
	if (value === null) return true;
	if (!isObject(value)) return false;
	switch (value.state) {
		case 'enforced':
			return true;
		case 'notEnforced':
			return (
				Array.isArray(value.reasons) &&
				value.reasons.length > 0 &&
				value.reasons.every((r) => typeof r === 'string')
			);
		case 'unknown':
			return Array.isArray(value.values) && value.values.every((v) => typeof v === 'number');
		default:
			return false;
	}
}

function isLocalRule(value: unknown): boolean {
	if (!isObject(value) || typeof value.state !== 'string' || !LOCAL_STATES.has(value.state)) {
		return false;
	}
	return value.state !== 'differs' || isObject(value.rule);
}

function isRuleCheck(value: unknown): value is FirewallRuleCheck {
	if (typeof value !== 'object' || value === null) return false;
	const check = value as Record<string, unknown>;
	if (typeof check.state !== 'string' || !STATES.has(check.state)) return false;
	if (check.state === 'unknown') return typeof check.reason === 'string';
	if (check.state === 'present') {
		return (
			isObject(check.rule) &&
			isOrigin(check.origin) &&
			isEnforcement(check.enforcement) &&
			isLocalRule(check.local) &&
			Array.isArray(check.mismatches) &&
			Array.isArray(check.unchecked)
		);
	}
	return true;
}

/**
 * Whether `value` has the shape of a `firewall_rule_status` response. An
 * older host has no such command (a stub or the IPC answers `null`), and
 * that must read as "could not check", not as "no rule".
 */
export function isFirewallRuleStatus(value: unknown): value is FirewallRuleStatus {
	if (typeof value !== 'object' || value === null) return false;
	const status = value as Record<string, unknown>;
	const expected = status.expected as Record<string, unknown> | null | undefined;
	return (
		typeof status.generation === 'number' &&
		typeof expected === 'object' &&
		expected !== null &&
		isRuleCheck(status.program) &&
		isRuleCheck(status.port)
	);
}

/**
 * Whether `status` was compared with the snapshot `info` shows: same
 * generation, live port and executable path. A host without `generation`
 * cannot be matched, so nothing is shown for it.
 */
export function firewallStatusMatches(info: FirewallInfo, status: FirewallRuleStatus): boolean {
	return (
		info.generation !== null &&
		status.generation === info.generation &&
		status.expected.port === info.port &&
		(status.expected.executablePath ?? null) === info.executablePath
	);
}

/** A local field and its value, where the local rule differs from the one in effect. */
export interface FirewallLocalValue {
	field: FirewallField;
	value: string;
}

/** The local rule next to the one in effect, as the panel words it. */
export type FirewallLocalView =
	/** Nothing to add: the local rule is the one shown, or has its values. */
	| { kind: 'same' }
	/** No local rule of this name (what applies comes from elsewhere). */
	| { kind: 'missing' }
	/** The local rule has other values (`values`, the local ones), and they do not apply. */
	| { kind: 'differs'; values: FirewallLocalValue[] }
	| { kind: 'unknown' };

/**
 * Where the rule in effect comes from, when it is not the local store's
 * rule. `policy`: central management (Group Policy, MDM) decides what
 * applies. `kind: 'unknown'`: the source was not reported (never taken for
 * central management).
 */
export interface FirewallOriginView {
	kind: Exclude<FirewallSourceKind, 'local'>;
	sourceType: string | null;
	source: string | null;
	policy: boolean;
}

/** What a present rule carries besides its headline. */
interface FirewallPresentView {
	/** What could not be compared, except `enforcement` (`enforcement` words that). */
	unchecked: FirewallField[];
	/** `null` when the rule in effect is the local store's own rule. */
	origin: FirewallOriginView | null;
	/** `null` when the rule is not in the ActiveStore (`active` is then a mismatch). */
	enforcement: FirewallEnforcement | null;
	local: FirewallLocalView;
}

/** What one rule's state reads as on screen. */
export type FirewallRuleView =
	| { kind: 'missing' }
	/** Present, as the administrator command creates it, and applied (`Full`). */
	| ({ kind: 'matches' } & FirewallPresentView)
	/**
	 * The values are as the command creates them, but whether Windows
	 * applies the rule is not known (no or an unknown `EnforcementStatus`).
	 */
	| ({ kind: 'unconfirmed' } & FirewallPresentView)
	/**
	 * The values are as the command creates them, but the ActiveStore says the
	 * rule is present and not applied (`EnforcementStatus` other than `Full`,
	 * e.g. `CategoryOff` while another vendor's firewall is on). Not a
	 * difference in the rule, so nothing here asks for a re-create (#479).
	 */
	| ({ kind: 'notEnforced'; reasons: string[] } & FirewallPresentView)
	/**
	 * Present but different (`fields`, e.g. changed to Block, a narrower
	 * source range, another exe, an old port, not applied).
	 */
	| ({ kind: 'differs'; fields: FirewallField[] } & FirewallPresentView)
	| { kind: 'unknown'; reason: FirewallUnknownReason };

const VALUE_FIELDS: readonly FirewallField[] = [
	'enabled',
	'direction',
	'action',
	'protocol',
	'profile',
	'program',
	'localPort',
	'remoteAddress'
];

/**
 * The fields where `local` differs from `effective`, ignoring case (as
 * src-tauri's `same_values`). The ActiveStore expands environment variables
 * in a program path, so a local path with `%` is not held against it.
 */
function localDifferences(
	local: FirewallRuleValues,
	effective: FirewallRuleValues
): FirewallLocalValue[] {
	const values: FirewallLocalValue[] = [];
	for (const field of VALUE_FIELDS) {
		const a = ruleFieldValue(local, field) ?? '';
		const b = ruleFieldValue(effective, field) ?? '';
		if (field === 'program' && a.includes('%')) continue;
		if (a.toLowerCase() !== b.toLowerCase()) values.push({ field, value: a });
	}
	return values;
}

function localView(check: Extract<FirewallRuleCheck, { state: 'present' }>): FirewallLocalView {
	switch (check.local.state) {
		case 'same':
			return { kind: 'same' };
		case 'missing':
			return { kind: 'missing' };
		case 'unknown':
			return { kind: 'unknown' };
		case 'differs': {
			const values = localDifferences(check.local.rule, check.rule);
			return values.length === 0 ? { kind: 'same' } : { kind: 'differs', values };
		}
	}
}

export function firewallRuleView(check: FirewallRuleCheck): FirewallRuleView {
	switch (check.state) {
		case 'missing':
			return { kind: 'missing' };
		case 'unknown':
			return { kind: 'unknown', reason: check.reason };
		case 'present': {
			const origin = check.origin;
			const present: FirewallPresentView = {
				unchecked: check.unchecked.filter((field) => field !== 'enforcement'),
				origin:
					origin === null || origin.kind === 'local'
						? null
						: {
								kind: origin.kind,
								sourceType: origin.sourceType,
								source: origin.source,
								policy: POLICY_KINDS.has(origin.kind)
							},
				enforcement: check.enforcement,
				local: localView(check)
			};
			const contentMismatches = check.mismatches.filter((field) => field !== 'enforcement');
			if (contentMismatches.length > 0) {
				return { kind: 'differs', fields: check.mismatches, ...present };
			}
			if (check.mismatches.length > 0) {
				// Only the enforcement differs: the rule's values are as expected.
				return check.enforcement?.state === 'notEnforced'
					? { kind: 'notEnforced', reasons: check.enforcement.reasons, ...present }
					: { kind: 'differs', fields: check.mismatches, ...present };
			}
			// Applied only when the status says so; a status that is missing or
			// unknown never reads as plainly "as expected".
			return check.enforcement?.state === 'enforced'
				? { kind: 'matches', ...present }
				: { kind: 'unconfirmed', ...present };
		}
	}
}

/**
 * The value of `field` in `check`'s rule (the one in effect), as the
 * firewall reports it (lists joined with `, `). `null` for `active` and
 * `enforcement` (the panel words them) and when the rule is not present.
 */
export function firewallFieldValue(check: FirewallRuleCheck, field: FirewallField): string | null {
	return check.state === 'present' ? ruleFieldValue(check.rule, field) : null;
}

function ruleFieldValue(rule: FirewallRuleValues, field: FirewallField): string | null {
	switch (field) {
		case 'enabled':
			return rule.enabled;
		case 'direction':
			return rule.direction;
		case 'action':
			return rule.action;
		case 'protocol':
			return rule.protocol;
		case 'profile':
			return rule.profile;
		case 'program':
			return rule.program;
		case 'localPort':
			return rule.localPorts.join(', ');
		case 'remoteAddress':
			return rule.remoteAddresses.join(', ');
		case 'active':
		case 'enforcement':
			return null;
	}
}

/** What a check came to. */
export type FirewallCheckOutcome =
	/** Still the latest, and compared with the snapshot shown: show `status`. */
	| { kind: 'ok'; status: FirewallRuleStatus }
	/** An apply or a newer check came after it: dropped. */
	| { kind: 'superseded' }
	/**
	 * Compared with another snapshot than the one shown: dropped. `newer`:
	 * the host is already past what is shown, so the server status should be
	 * re-read (the panel then checks again for the new snapshot).
	 */
	| { kind: 'stale'; newer: boolean }
	/** The read failed or the host answered something else (still the latest). */
	| { kind: 'unavailable' };

export class FirewallStatusRequests {
	#latest = 0;

	/** Makes every check started so far stale (their responses are dropped). */
	invalidate(): void {
		this.#latest++;
	}

	/**
	 * Reads the status with `get`, and decides whether it may be shown for
	 * what the panel shows when the answer arrives (`shown`, read then - not
	 * when the check started).
	 */
	async check(
		get: () => Promise<unknown>,
		shown: () => FirewallInfo | null
	): Promise<FirewallCheckOutcome> {
		const ticket = ++this.#latest;
		let value: unknown;
		try {
			value = await get();
		} catch {
			return ticket === this.#latest ? { kind: 'unavailable' } : { kind: 'superseded' };
		}
		if (ticket !== this.#latest) return { kind: 'superseded' };
		return judgeFirewallStatus(value, shown());
	}

	/**
	 * Runs a firewall change (`run`) whose answer carries a fresh status read
	 * (ADR-0021 decision 11; `statusOf` picks it out), in the same order as
	 * the checks: the change takes a ticket when it starts, so the checks
	 * pending then are dropped, and an apply or a check started while it waits
	 * for UAC drops ITS read (`superseded`) - that newer check shows the
	 * status, and an older read never clears it (owner review on PR #475).
	 * The answer itself (`value`) is always returned; a failure of `run`
	 * propagates.
	 */
	async change<T>(
		run: () => Promise<T>,
		statusOf: (value: T) => unknown,
		shown: () => FirewallInfo | null
	): Promise<{ value: T; outcome: FirewallCheckOutcome }> {
		const ticket = ++this.#latest;
		const value = await run();
		if (ticket !== this.#latest) return { value, outcome: { kind: 'superseded' } };
		return { value, outcome: judgeFirewallStatus(statusOf(value), shown()) };
	}
}

/**
 * What the panel does with the read a firewall change ended with:
 * - `show`: nobody overtook the change - show its read (`nextFirewallPanelState`).
 * - `recheck`: an apply or a check started while the change waited, so its
 *   read was dropped - but that check may have read BEFORE the helper
 *   changed the rule (owner review on PR #475: a check of the new generation
 *   saw "no rule", then the helper made it). The rule is per executable, so
 *   the change also applies to what is shown now: start a new check, which
 *   reads after the change ended and drops any check still pending.
 * - `none`: dropped while settings are still being applied - the check the
 *   panel starts once the apply ends reads after the change, so no second
 *   read here.
 */
export function firewallChangeFollowUp(
	outcome: FirewallCheckOutcome,
	applying: boolean
): 'show' | 'recheck' | 'none' {
	if (outcome.kind !== 'superseded') return 'show';
	return applying ? 'none' : 'recheck';
}

/**
 * Whether a status read (`value`, as the host answered it) may be shown for
 * what the panel shows now (`info`; `null` = nothing). Shared by the checks
 * above and the re-read a firewall change ends with (ADR-0021 decision 11).
 */
export function judgeFirewallStatus(
	value: unknown,
	info: FirewallInfo | null
): FirewallCheckOutcome {
	if (!isFirewallRuleStatus(value)) return { kind: 'unavailable' };
	if (info === null) return { kind: 'superseded' };
	if (!firewallStatusMatches(info, value)) {
		return {
			kind: 'stale',
			newer: info.generation !== null && value.generation > info.generation
		};
	}
	return { kind: 'ok', status: value };
}

/** What the panel shows: the last result and what went wrong with the last check. */
export interface FirewallPanelState {
	result: FirewallRuleStatus | null;
	problem: 'unavailable' | 'changed' | null;
}

/**
 * The panel's state after a check came to `outcome` (`superseded` changes
 * nothing). A failed check (`unavailable`, or answered for an older snapshot)
 * CLEARS the previous result instead of showing it next to the error, so an
 * old "as expected" or "no rule" is never read as the answer to this check
 * (owner review on PR #465). `refresh`: the host is already past what is
 * shown - re-read the server status (the panel then checks again).
 */
export function nextFirewallPanelState(
	state: FirewallPanelState,
	outcome: FirewallCheckOutcome
): FirewallPanelState & { refresh: boolean } {
	switch (outcome.kind) {
		case 'superseded':
			return { ...state, refresh: false };
		case 'ok':
			return { result: outcome.status, problem: null, refresh: false };
		case 'unavailable':
			return { result: null, problem: 'unavailable', refresh: false };
		case 'stale':
			return outcome.newer
				? { result: null, problem: null, refresh: true }
				: { result: null, problem: 'changed', refresh: false };
	}
}
