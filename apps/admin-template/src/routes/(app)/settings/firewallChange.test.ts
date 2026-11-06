import { describe, expect, it } from 'vitest';
import RUST from '../../../../src-tauri/src/firewall_change.rs?raw';
import en from '../../../../messages/en.json';
import ja from '../../../../messages/ja.json';
import type {
	FirewallChangeResult,
	FirewallRuleCheck,
	FirewallRuleStatus
} from '#lib/banto/serverAdmin.js';
import {
	firewallChangeActions,
	firewallChangeManualHints,
	firewallChangeTarget,
	firewallChangeView,
	firewallRefusalMessage,
	isFirewallChangeResult
} from './firewallChange';

const EXE = 'C:\\Program Files\\Banto\\banto-admin.exe';
const RULE = 'dev.banto.admin.lan.tcp.program';

const PRESENT: FirewallRuleCheck = {
	state: 'present',
	rule: {
		enabled: 'True',
		direction: 'Inbound',
		action: 'Allow',
		protocol: 'TCP',
		profile: 'Private',
		program: EXE,
		localPorts: ['Any'],
		remoteAddresses: ['LocalSubnet']
	},
	origin: null,
	enforcement: { state: 'enforced' },
	local: { state: 'same' },
	mismatches: [],
	unchecked: []
};

function status(
	program: FirewallRuleCheck,
	executablePath: string | null = EXE,
	generation = 3
): FirewallRuleStatus {
	return {
		generation,
		expected: { executablePath, port: 8721 },
		program,
		port: { state: 'missing' },
		groupOtherRules: 0
	};
}

function result(overrides: Partial<FirewallChangeResult> = {}): FirewallChangeResult {
	return {
		operation: 'allow',
		outcome: 'done',
		exitCode: 0,
		refusal: null,
		osError: null,
		stale: false,
		status: status({ state: 'missing' }),
		...overrides
	};
}

// The Rust side is the source of the codes: read them so a new code there
// fails here until the screen has a text for it.
const camel = (variant: string) => variant[0].toLowerCase() + variant.slice(1);
const RUST_OUTCOMES = [
	...(RUST.match(/pub\(crate\) enum FirewallChangeOutcome \{([\s\S]*?)\n\}/)?.[1] ?? '').matchAll(
		/^\s{4}(\w+),$/gm
	)
].map((match) => camel(match[1]));
const RUST_REFUSALS = [
	...[...(RUST.match(/fn refusal_code\([\s\S]*?\n\}/)?.[0] ?? '').matchAll(/=> "(\w+)",/g)].map(
		(match) => match[1]
	),
	...[...RUST.matchAll(/pub\(crate\) const REFUSAL_\w+: &str = "(\w+)";/g)].map((match) => match[1])
];

describe('firewallChangeActions', () => {
	it('offers allow when there is no rule, remove when there is one', () => {
		expect(
			firewallChangeActions({ admin: true, status: status({ state: 'missing' }), ruleName: RULE })
		).toEqual(['allow']);
		expect(firewallChangeActions({ admin: true, status: status(PRESENT), ruleName: RULE })).toEqual(
			['remove']
		);
		// A rule that differs (e.g. Block) is still one of that name: remove (the helper answers conflict when it is not its own).
		expect(
			firewallChangeActions({
				admin: true,
				status: status({ ...PRESENT, mismatches: ['action'] }),
				ruleName: RULE
			})
		).toEqual(['remove']);
	});

	it('offers both when the state could not be read, none when the helper cannot act', () => {
		expect(
			firewallChangeActions({
				admin: true,
				status: status({ state: 'unknown', reason: 'timeout' }),
				ruleName: RULE
			})
		).toEqual(['allow', 'remove']);
		for (const reason of ['notWindows', 'invalidIdentifier'] as const) {
			expect(
				firewallChangeActions({
					admin: true,
					status: status({ state: 'unknown', reason }),
					ruleName: RULE
				})
			).toEqual([]);
		}
	});

	it('offers nothing to a non-admin, or without the exe path or the rule name', () => {
		const missing = status({ state: 'missing' });
		expect(firewallChangeActions({ admin: false, status: missing, ruleName: RULE })).toEqual([]);
		expect(firewallChangeActions({ admin: true, status: missing, ruleName: null })).toEqual([]);
		expect(
			firewallChangeActions({
				admin: true,
				status: status({ state: 'missing' }, null),
				ruleName: RULE
			})
		).toEqual([]);
	});
});

describe('firewallChangeManualHints', () => {
	it('names the by-hand way of each offered operation, never the allow command for a removal (Codex review on PR #475)', () => {
		expect(firewallChangeManualHints(['allow'])).toEqual(['settings.firewallChangeDescAllow']);
		expect(firewallChangeManualHints(['remove'])).toEqual(['settings.firewallChangeDescRemove']);
		expect(firewallChangeManualHints(['allow', 'remove'])).toEqual([
			'settings.firewallChangeDescAllow',
			'settings.firewallChangeDescRemove'
		]);
		expect(firewallChangeManualHints([])).toEqual([]);
	});

	it('keeps the shared description free of the allow command, and the removal text on Remove-NetFirewallRule', () => {
		const catalogs: Record<string, Record<string, string>> = { en, ja };
		for (const catalog of Object.values(catalogs)) {
			expect(catalog['settings.firewallChangeDesc']).not.toMatch(/PowerShell/);
			expect(catalog['settings.firewallChangeDescRemove']).toContain(
				'Remove-NetFirewallRule -Name'
			);
			expect(catalog['settings.firewallChangeDescRemove']).not.toMatch(/New-NetFirewallRule/);
		}
	});
});

describe('firewallChangeTarget', () => {
	it('is the shown read own executable path and generation (decision 13)', () => {
		expect(firewallChangeTarget(status(PRESENT, EXE, 7))).toEqual({
			executablePath: EXE,
			generation: 7
		});
	});
});

describe('isFirewallChangeResult', () => {
	it('accepts the host answer, rejects an older host and malformed ones', () => {
		expect(isFirewallChangeResult(result())).toBe(true);
		expect(isFirewallChangeResult(result({ outcome: 'somethingNew' }))).toBe(true);
		expect(isFirewallChangeResult(null)).toBe(false);
		expect(isFirewallChangeResult({})).toBe(false);
		expect(isFirewallChangeResult({ ...result(), operation: 'status' })).toBe(false);
		expect(isFirewallChangeResult({ ...result(), outcome: 0 })).toBe(false);
		expect(isFirewallChangeResult({ ...result(), stale: 'yes' })).toBe(false);
		expect(isFirewallChangeResult({ ...result(), exitCode: '0' })).toBe(false);
	});
});

describe('firewallChangeView', () => {
	it('never says "reachable" for done / already: allow points to the reach check (decision 11)', () => {
		const done = firewallChangeView(result());
		expect(done).toMatchObject({
			tone: 'success',
			message: 'settings.firewallChangeDoneAllow',
			reach: true,
			manual: false
		});
		expect(firewallChangeView(result({ operation: 'remove', outcome: 'done' }))).toMatchObject({
			message: 'settings.firewallChangeDoneRemove',
			reach: false
		});
		expect(firewallChangeView(result({ outcome: 'already', exitCode: 3 }))).toMatchObject({
			message: 'settings.firewallChangeAlreadyAllow',
			reach: true
		});
	});

	it('words cancelled, busy and targetChanged as notices', () => {
		expect(firewallChangeView(result({ outcome: 'cancelled', exitCode: null }))).toMatchObject({
			tone: 'notice',
			message: 'settings.firewallChangeCancelled',
			noPrompt: false
		});
		expect(firewallChangeView(result({ outcome: 'busy', exitCode: null }))).toMatchObject({
			tone: 'notice',
			message: 'settings.firewallChangeBusy',
			noPrompt: true
		});
		expect(firewallChangeView(result({ outcome: 'targetChanged', exitCode: null }))).toMatchObject({
			tone: 'notice',
			message: 'settings.firewallChangeTargetChanged',
			noPrompt: true
		});
	});

	it('gives a precondition its reason and the stage-1 guide', () => {
		expect(
			firewallChangeView(
				result({ outcome: 'precondition', exitCode: null, refusal: 'notUnderProgramFiles' })
			)
		).toMatchObject({
			tone: 'error',
			message: 'settings.firewallChangePrecondition',
			refusal: 'settings.firewallRefusalNotUnderProgramFiles',
			noPrompt: true,
			manual: true
		});
		// Exit 2: the helper refused after the prompt was approved.
		expect(
			firewallChangeView(result({ outcome: 'precondition', exitCode: 2, refusal: null }))
		).toMatchObject({ refusal: 'settings.firewallRefusalHelper', noPrompt: false, manual: true });
	});

	it('points a failed removal to deleting by hand, never to the allow guide', () => {
		for (const outcome of ['precondition', 'launchFailed', 'failed', 'usage', 'unexpectedExit']) {
			expect(firewallChangeView(result({ operation: 'remove', outcome }))).toMatchObject({
				manual: false,
				manualRemove: true
			});
			expect(firewallChangeView(result({ operation: 'allow', outcome }))).toMatchObject({
				manual: true,
				manualRemove: false
			});
		}
	});

	it('never guides deleting (or re-adding) a same-named rule it does not own (Codex review on PR #475)', () => {
		for (const operation of ['allow', 'remove'] as const) {
			expect(firewallChangeView(result({ operation, outcome: 'conflict', exitCode: 4 }))).toEqual(
				expect.objectContaining({
					tone: 'error',
					message: 'settings.firewallChangeConflict',
					manual: false,
					manualRemove: false,
					reach: false
				})
			);
		}
	});

	it('words conflict / policy / failures, with the code when it adds something', () => {
		expect(firewallChangeView(result({ outcome: 'conflict', exitCode: 4 }))).toMatchObject({
			tone: 'error',
			message: 'settings.firewallChangeConflict',
			manual: false,
			manualRemove: false
		});
		expect(firewallChangeView(result({ outcome: 'policy', exitCode: 5 }))).toMatchObject({
			tone: 'error',
			message: 'settings.firewallChangePolicy'
		});
		expect(firewallChangeView(result({ outcome: 'failed', exitCode: 1 }))).toMatchObject({
			message: 'settings.firewallChangeFailed',
			exitCode: 1
		});
		expect(
			firewallChangeView(result({ outcome: 'launchFailed', exitCode: null, osError: 2 }))
		).toMatchObject({ message: 'settings.firewallChangeLaunchFailed', osError: 2 });
		expect(firewallChangeView(result({ outcome: 'unexpectedExit', exitCode: 99 }))).toMatchObject({
			message: 'settings.firewallChangeUnexpectedExit',
			exitCode: 99
		});
		expect(firewallChangeView(result({ outcome: 'usage', exitCode: 64 }))).toMatchObject({
			message: 'settings.firewallChangeUsage',
			exitCode: 64
		});
	});

	it('marks a stale result and falls back safely for an unknown outcome', () => {
		expect(firewallChangeView(result({ stale: true }))).toMatchObject({
			stale: true,
			message: 'settings.firewallChangeDoneAllow'
		});
		expect(firewallChangeView(result({ outcome: 'somethingNew', exitCode: 7 }))).toMatchObject({
			tone: 'error',
			message: 'settings.firewallChangeUnknownOutcome',
			exitCode: 7,
			reach: false
		});
	});

	it('has a text of its own for every outcome src-tauri sends', () => {
		expect(RUST_OUTCOMES).toContain('done');
		expect(RUST_OUTCOMES.length).toBeGreaterThanOrEqual(12);
		for (const outcome of RUST_OUTCOMES) {
			expect(firewallChangeView(result({ outcome })).message, outcome).not.toBe(
				'settings.firewallChangeUnknownOutcome'
			);
		}
	});
});

describe('firewallRefusalMessage', () => {
	it('has a reason for every refusal code src-tauri sends', () => {
		expect(RUST_REFUSALS).toContain('writableByOthers');
		expect(RUST_REFUSALS).toContain('helperMissing');
		expect(RUST_REFUSALS).toContain('identifierMismatch');
		for (const code of RUST_REFUSALS) {
			expect(firewallRefusalMessage(code), code).not.toBe('settings.firewallRefusalUnknown');
		}
		expect(firewallRefusalMessage('somethingNew')).toBe('settings.firewallRefusalUnknown');
	});
});

describe('message keys', () => {
	it('every key a result can show exists in both catalogs', () => {
		const views = [
			...RUST_OUTCOMES.flatMap((outcome) => [
				firewallChangeView(result({ outcome })),
				firewallChangeView(result({ outcome, operation: 'remove' }))
			]),
			firewallChangeView(result({ outcome: 'somethingNew' }))
		];
		const keys = new Set([
			...views.map((view) => view.message),
			...[...RUST_REFUSALS, null, 'somethingNew'].map(firewallRefusalMessage)
		]);
		const catalogs: Record<string, Record<string, string>> = { en, ja };
		for (const [locale, catalog] of Object.entries(catalogs)) {
			for (const key of keys) expect(catalog[key], `${locale}: ${key}`).toBeTruthy();
		}
	});
});
