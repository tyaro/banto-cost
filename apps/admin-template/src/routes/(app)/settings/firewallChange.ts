/**
 * Spec §11.4 (LAN settings UX). Pure decisions behind the settings screen's
 * stage-2 firewall change (Issue #219, ADR-0021 E3): which of "allow" /
 * "remove" the Windows Firewall status offers, what the confirmation screen
 * sends back (decision 13), and what a `firewall_rule_change` answer reads
 * as (decision 11). `FirewallRuleStatusPanel.svelte` renders it; nothing
 * here touches the DOM or Tauri. The text itself lives in the message
 * catalog (conventions §13) - this module only names the keys, so
 * `svelte-check` fails on a key that does not exist.
 *
 * Decision 11: exit code 0 is "done", never "reachable". Every "done" /
 * "already" of `allow` points to the reach check instead; the only proof
 * that another device can connect is that check's record.
 */
import type {
	FirewallChangeOperation,
	FirewallChangeResult,
	FirewallChangeTarget,
	FirewallRuleStatus
} from '#lib/banto/serverAdmin.js';

/**
 * The operations the panel offers for `status` (the read it shows), in
 * button order. Nothing when the viewer is not an administrator, when the
 * executable path or the rule names are unknown (the confirmation screen
 * must show both), or when the read says this is not something the helper
 * can change (not Windows, an invalid identifier):
 *
 * - no per-executable rule: "allow";
 * - a rule of that name: "remove" (the helper removes only a rule it owns
 *   and answers `conflict` otherwise - the result says so);
 * - the state could not be read: both (the helper reads it itself).
 */
export function firewallChangeActions(input: {
	admin: boolean;
	status: FirewallRuleStatus;
	ruleName: string | null;
}): FirewallChangeOperation[] {
	const { admin, status, ruleName } = input;
	if (!admin || ruleName === null || status.expected.executablePath === null) return [];
	const program = status.program;
	switch (program.state) {
		case 'missing':
			return ['allow'];
		case 'present':
			return ['remove'];
		case 'unknown':
			return program.reason === 'notWindows' || program.reason === 'invalidIdentifier'
				? []
				: ['allow', 'remove'];
	}
}

/** The way to do an operation by hand, when the helper cannot (not under Program Files). */
export type FirewallChangeManualKey =
	'settings.firewallChangeDescAllow' | 'settings.firewallChangeDescRemove';

/**
 * The by-hand way the panel's description names for the operations it
 * offers (`actions`, in button order): the allow command above for "allow",
 * `Remove-NetFirewallRule` or the advanced firewall console for "remove"
 * (Codex review on PR #475: a panel offering only "remove" must not point at
 * the command that adds the rule). Both when both are offered.
 */
export function firewallChangeManualHints(
	actions: readonly FirewallChangeOperation[]
): FirewallChangeManualKey[] {
	return actions.map((operation) =>
		operation === 'allow' ? 'settings.firewallChangeDescAllow' : 'settings.firewallChangeDescRemove'
	);
}

/** What the confirmation screen sends (decision 13): the shown read's own target. */
export function firewallChangeTarget(status: FirewallRuleStatus): FirewallChangeTarget {
	return { executablePath: status.expected.executablePath, generation: status.generation };
}

/**
 * Whether `value` has the shape of a `firewall_rule_change` answer. An older
 * host has no such command (the IPC answers `null` or rejects), which reads
 * as "no answer", never as a result. `outcome` / `refusal` may be codes this
 * screen does not know (they get the fallback text).
 */
export function isFirewallChangeResult(value: unknown): value is FirewallChangeResult {
	if (typeof value !== 'object' || value === null) return false;
	const result = value as Record<string, unknown>;
	const numberOrNull = (v: unknown) => v === null || v === undefined || typeof v === 'number';
	return (
		(result.operation === 'allow' || result.operation === 'remove') &&
		typeof result.outcome === 'string' &&
		(result.refusal === null ||
			result.refusal === undefined ||
			typeof result.refusal === 'string') &&
		numberOrNull(result.exitCode) &&
		numberOrNull(result.osError) &&
		(result.stale === undefined || typeof result.stale === 'boolean')
	);
}

/** How a result is shown: success (green), notice (neutral) or error (red). */
export type FirewallChangeTone = 'success' | 'notice' | 'error';

/** The headline of a result (one catalog key per case). */
export type FirewallChangeMessageKey =
	| 'settings.firewallChangeDoneAllow'
	| 'settings.firewallChangeDoneRemove'
	| 'settings.firewallChangeAlreadyAllow'
	| 'settings.firewallChangeAlready'
	| 'settings.firewallChangeConflict'
	| 'settings.firewallChangePolicy'
	| 'settings.firewallChangePrecondition'
	| 'settings.firewallChangeCancelled'
	| 'settings.firewallChangeLaunchFailed'
	| 'settings.firewallChangeFailed'
	| 'settings.firewallChangeUsage'
	| 'settings.firewallChangeUnexpectedExit'
	| 'settings.firewallChangeTargetChanged'
	| 'settings.firewallChangeBusy'
	| 'settings.firewallChangeUnknownOutcome';

/** Why the placement was refused (decision 8), as one catalog key. */
export type FirewallRefusalMessageKey =
	| 'settings.firewallRefusalNotUnderProgramFiles'
	| 'settings.firewallRefusalHelperMissing'
	| 'settings.firewallRefusalLayout'
	| 'settings.firewallRefusalReparsePoint'
	| 'settings.firewallRefusalOwner'
	| 'settings.firewallRefusalWritable'
	| 'settings.firewallRefusalUnverifiable'
	| 'settings.firewallRefusalIdentifierMismatch'
	| 'settings.firewallRefusalUnsupported'
	| 'settings.firewallRefusalHelper'
	| 'settings.firewallRefusalUnknown';

/** What a `firewall_rule_change` answer reads as on screen. */
export interface FirewallChangeView {
	tone: FirewallChangeTone;
	message: FirewallChangeMessageKey;
	/** For `precondition`: why (the app's own check, or the helper's exit 2). */
	refusal: FirewallRefusalMessageKey | null;
	/** The helper's exit code or the OS error, when the headline alone does not tell. */
	exitCode: number | null;
	osError: number | null;
	/** The UAC prompt was never shown (nothing was started). */
	noPrompt: boolean;
	/** The target changed while the helper ran: the outcome is about what is no longer shown. */
	stale: boolean;
	/** Point to stage 1's manual commands above (stage 2 cannot do it here). */
	manual: boolean;
	/** The same for a removal: point to deleting the rule by hand (never the allow guidance). */
	manualRemove: boolean;
	/** Point to the reach check (a rule is not "reachable", decision 11). */
	reach: boolean;
}

/**
 * The app's refusal codes (`firewall_change::refusal_code` / `REFUSAL_*`),
 * grouped by what the administrator can do about them. An unknown code gets
 * the generic text.
 */
export function firewallRefusalMessage(refusal: string | null): FirewallRefusalMessageKey {
	switch (refusal) {
		case null:
			// The helper itself refused after it started (exit 2).
			return 'settings.firewallRefusalHelper';
		case 'notUnderProgramFiles':
			return 'settings.firewallRefusalNotUnderProgramFiles';
		case 'helperMissing':
			return 'settings.firewallRefusalHelperMissing';
		case 'mainMissing':
		case 'folderMissing':
		case 'anchorNotChecked':
		case 'wrongName':
		case 'notSameFolder':
		case 'folderChainMismatch':
		case 'wrongKind':
		case 'notMainExe':
			return 'settings.firewallRefusalLayout';
		case 'reparsePoint':
			return 'settings.firewallRefusalReparsePoint';
		case 'untrustedOwner':
			return 'settings.firewallRefusalOwner';
		case 'writableByOthers':
		case 'nullDacl':
			return 'settings.firewallRefusalWritable';
		case 'unreadableAce':
		case 'unverifiable':
			return 'settings.firewallRefusalUnverifiable';
		case 'identifierMismatch':
			return 'settings.firewallRefusalIdentifierMismatch';
		case 'unsupported':
			return 'settings.firewallRefusalUnsupported';
		default:
			return 'settings.firewallRefusalUnknown';
	}
}

const BASE = {
	refusal: null,
	exitCode: null,
	osError: null,
	noPrompt: false,
	manual: false,
	manualRemove: false,
	reach: false
} as const;

export function firewallChangeView(result: FirewallChangeResult): FirewallChangeView {
	const stale = result.stale === true;
	const exitCode = result.exitCode ?? null;
	const osError = result.osError ?? null;
	const allow = result.operation === 'allow';
	const view = (
		fields: Partial<FirewallChangeView> & Pick<FirewallChangeView, 'tone' | 'message'>
	) => {
		// `manual` is asked for by outcome only; which guide it is depends on the operation.
		const wantsManual = fields.manual === true;
		return {
			...BASE,
			stale,
			...fields,
			manual: wantsManual && allow,
			manualRemove: wantsManual && !allow
		} satisfies FirewallChangeView;
	};
	switch (result.outcome) {
		case 'done':
			return allow
				? view({ tone: 'success', message: 'settings.firewallChangeDoneAllow', reach: true })
				: view({ tone: 'success', message: 'settings.firewallChangeDoneRemove' });
		case 'already':
			return allow
				? view({ tone: 'success', message: 'settings.firewallChangeAlreadyAllow', reach: true })
				: view({ tone: 'success', message: 'settings.firewallChangeAlready' });
		case 'conflict':
			// A rule of that name failed the ownership check (decision 6): it may
			// belong to another app or an administrator. No by-hand guide - not
			// "delete it" for a removal (Codex review on PR #475), and for an allow
			// stage 1's command would only warn about the same name.
			return view({ tone: 'error', message: 'settings.firewallChangeConflict' });
		case 'policy':
			return view({ tone: 'error', message: 'settings.firewallChangePolicy' });
		case 'precondition': {
			// The app's own check refused before asking for elevation: no prompt.
			const ownCheck = typeof result.refusal === 'string';
			return view({
				tone: 'error',
				message: 'settings.firewallChangePrecondition',
				refusal: firewallRefusalMessage(ownCheck ? result.refusal : null),
				noPrompt: ownCheck,
				manual: true
			});
		}
		case 'cancelled':
			return view({ tone: 'notice', message: 'settings.firewallChangeCancelled' });
		case 'launchFailed':
			return view({
				tone: 'error',
				message: 'settings.firewallChangeLaunchFailed',
				osError,
				manual: true
			});
		case 'failed':
			return view({
				tone: 'error',
				message: 'settings.firewallChangeFailed',
				exitCode,
				manual: true
			});
		case 'usage':
			return view({
				tone: 'error',
				message: 'settings.firewallChangeUsage',
				exitCode,
				manual: true
			});
		case 'unexpectedExit':
			return view({
				tone: 'error',
				message: 'settings.firewallChangeUnexpectedExit',
				exitCode,
				manual: true
			});
		case 'targetChanged':
			return view({
				tone: 'notice',
				message: 'settings.firewallChangeTargetChanged',
				noPrompt: true
			});
		case 'busy':
			return view({ tone: 'notice', message: 'settings.firewallChangeBusy', noPrompt: true });
		default:
			// A code this screen does not know: say nothing about what happened.
			return view({
				tone: 'error',
				message: 'settings.firewallChangeUnknownOutcome',
				exitCode,
				osError
			});
	}
}
