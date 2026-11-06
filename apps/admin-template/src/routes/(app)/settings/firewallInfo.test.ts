import { describe, expect, it } from 'vitest';
import type { ServerStatus } from '#lib/banto/serverAdmin.js';
import {
	firewallCommands,
	firewallGuide,
	firewallRuleNames,
	isValidAppIdentifier,
	isValidPort,
	quotePowerShellLiteral,
	sameFirewallTarget,
	type FirewallInfo
} from './firewallInfo';

const EXE = 'C:\\Program Files\\banto-admin\\banto-admin.exe';
const ID = 'dev.banto.admin';

function status(patch: Partial<ServerStatus> = {}): ServerStatus {
	return {
		enabled: true,
		running: true,
		// Saved values deliberately differ from `live`: the guide must use `live`.
		bind: '127.0.0.1',
		port: 9999,
		viewerPublic: false,
		live: { bind: '0.0.0.0', port: 8721 },
		urls: [],
		qrSvgs: [],
		uiEmbedded: true,
		generation: 4,
		executablePath: EXE,
		platform: 'windows',
		...patch
	};
}

describe('quotePowerShellLiteral (Issue #219)', () => {
	it('wraps a plain value in single quotes', () => {
		expect(quotePowerShellLiteral(EXE)).toBe(`'${EXE}'`);
	});

	it('doubles an ASCII apostrophe so it cannot end the literal', () => {
		expect(quotePowerShellLiteral("C:\\O'Brien\\a.exe")).toBe("'C:\\O''Brien\\a.exe'");
		// The classic break-out attempt stays one literal.
		expect(quotePowerShellLiteral("x'; Remove-Item C:\\ -Recurse; '")).toBe(
			"'x''; Remove-Item C:\\ -Recurse; '''"
		);
	});

	it('doubles the typographic single quotes PowerShell also accepts', () => {
		for (const q of ['\u2018', '\u2019', '\u201A', '\u201B']) {
			expect(quotePowerShellLiteral(`a${q}b`)).toBe(`'a${q}${q}b'`);
		}
	});

	it('leaves $, $(), backticks, double quotes, spaces and Japanese as plain characters', () => {
		const value = 'C:\\アプリ $(calc) `n "x" $env:TEMP\\a b.exe';
		expect(quotePowerShellLiteral(value)).toBe(`'${value}'`);
	});

	it('refuses control characters (a line break would split the command)', () => {
		expect(quotePowerShellLiteral('a\nb')).toBeNull();
		expect(quotePowerShellLiteral('a\rb')).toBeNull();
		expect(quotePowerShellLiteral('a\u0000b')).toBeNull();
		expect(quotePowerShellLiteral('a\u0085b')).toBeNull();
	});

	it('round-trips: undoing the doubling inside the quotes gives the original value', () => {
		const value = "a'b\u2019c''d";
		const quoted = quotePowerShellLiteral(value)!;
		const inner = quoted.slice(1, -1);
		expect(inner.replace(/(['\u2018\u2019\u201A\u201B])\1/g, '$1')).toBe(value);
	});
});

describe('isValidPort / isValidAppIdentifier', () => {
	it('accepts only integer ports in 1-65535', () => {
		for (const ok of [1, 80, 8721, 65535]) expect(isValidPort(ok)).toBe(true);
		for (const bad of [0, -1, 65536, 8721.5, Number.NaN, '8721', null, undefined]) {
			expect(isValidPort(bad)).toBe(false);
		}
	});

	it("accepts Tauri's identifier alphabet only", () => {
		expect(isValidAppIdentifier('dev.banto.admin')).toBe(true);
		expect(isValidAppIdentifier('com.example.my-app2')).toBe(true);
		for (const bad of ['', '.leading', "a'b", 'a b', 'a$b', 'アプリ', null, 42]) {
			expect(isValidAppIdentifier(bad)).toBe(false);
		}
	});
});

describe('firewallRuleNames / firewallCommands', () => {
	it('names the group and both rules after the app identifier, without the port', () => {
		expect(firewallRuleNames(ID)).toEqual({
			group: ID,
			programName: `${ID}.lan.tcp.program`,
			portName: `${ID}.lan.tcp.port`,
			programDisplayName: `${ID} LAN (TCP-In, program)`,
			portDisplayName: `${ID} LAN (TCP-In, port)`
		});
	});

	const WARN = (name: string) => `exists: ${name}`;

	it('builds the per-executable and per-port commands', () => {
		const create = (name: string, rest: string) =>
			`$n = '${name}'; if (Get-NetFirewallRule -Name $n -ErrorAction SilentlyContinue) { Write-Warning 'exists: ${name}' } else { New-NetFirewallRule -Name $n ${rest} }`;
		expect(firewallCommands(ID, 8721, EXE, WARN)).toEqual({
			program: create(
				`${ID}.lan.tcp.program`,
				`-DisplayName '${ID} LAN (TCP-In, program)' -Group '${ID}' -Direction Inbound -Program '${EXE}' -Protocol TCP -Profile Private -RemoteAddress LocalSubnet -Action Allow`
			),
			port: create(
				`${ID}.lan.tcp.port`,
				`-DisplayName '${ID} LAN (TCP-In, port)' -Group '${ID}' -Direction Inbound -LocalPort 8721 -Protocol TCP -Profile Private -RemoteAddress LocalSubnet -Action Allow`
			)
		});
	});

	it('uses the same -Name for any port, so a re-run never adds a duplicate', () => {
		const a = firewallCommands(ID, 8721, EXE)!;
		const b = firewallCommands(ID, 9000, EXE)!;
		const nameOf = (command: string) => /^\$n = ('[^']*');/.exec(command)![1];
		expect(nameOf(a.port)).toBe(nameOf(b.port));
		expect(nameOf(a.port)).not.toContain('8721');
		expect(nameOf(a.program!)).toBe(nameOf(b.program!));
		expect(nameOf(a.port)).not.toBe(nameOf(a.program!));
	});

	// Owner review on PR #463: an existing rule of the same name may have been
	// changed to Block, narrowed to some remote addresses, or point at another
	// installation's executable. The command must leave it as it is - so it
	// never removes anything, and creates only when no rule of that name
	// exists. (Structure of the generated string; PowerShell is not run.)
	it('never removes a rule, and creates only when no rule of the name exists', () => {
		const { program, port } = firewallCommands(ID, 8721, EXE)!;
		for (const command of [program!, port]) {
			expect(command).not.toMatch(/[\r\n]/);
			expect(command).not.toContain('Remove-NetFirewallRule');
			expect(command).not.toContain('Set-NetFirewallRule');
			const shape =
				/^\$n = ('[^']*'); if \(Get-NetFirewallRule -Name \$n -ErrorAction SilentlyContinue\) \{ Write-Warning ('(?:[^']|'')*') \} else \{ (New-NetFirewallRule -Name \$n [^{}]*) \}$/.exec(
					command
				);
			expect(shape).not.toBeNull();
			const [, , warning, create] = shape!;
			// The "exists" branch only warns; New-NetFirewallRule is in the else
			// branch only, exactly once.
			expect(warning).not.toContain('NetFirewallRule -Name $n');
			expect(command.split('New-NetFirewallRule').length).toBe(2);
			expect(command.indexOf('New-NetFirewallRule')).toBeGreaterThan(command.indexOf('} else {'));
			expect(create).toContain('-Action Allow');
		}
	});

	it('quotes the warning as a single-quoted literal, even with quotes in it', () => {
		const { port } = firewallCommands(
			ID,
			8721,
			null,
			(name) => `Rule '${name}' exists; don’t $(calc) \`x`
		)!;
		expect(port).toContain(
			`Write-Warning 'Rule ''${ID}.lan.tcp.port'' exists; don’’t $(calc) \`x' } else {`
		);
		// The default (English) warning names the rule in quotes, too.
		expect(firewallCommands(ID, 8721, null)!.port).toContain(
			`-Name ''${ID}.lan.tcp.port'' | Format-List`
		);
		// A warning that cannot be quoted builds no command at all.
		expect(firewallCommands(ID, 8721, EXE, () => 'a\nb')).toBeNull();
	});

	it('quotes the names as PowerShell single-quoted literals', () => {
		const { port } = firewallCommands('app.example-1', 8721, null)!;
		expect(port).toContain("$n = 'app.example-1.lan.tcp.port';");
		expect(port).toContain("-Group 'app.example-1'");
	});

	it('escapes the executable path inside the command', () => {
		const exe = "C:\\Users\\O'Brien\\$(calc)\\`x\\a\u2019.exe";
		const commands = firewallCommands(ID, 8721, exe)!;
		expect(commands.program).toContain(
			"-Program 'C:\\Users\\O''Brien\\$(calc)\\`x\\a\u2019\u2019.exe' "
		);
	});

	it('omits only the per-executable command without a usable path', () => {
		expect(firewallCommands(ID, 8721, null)?.program).toBeNull();
		expect(firewallCommands(ID, 8721, 'C:\\a\nb.exe')?.program).toBeNull();
		expect(firewallCommands(ID, 8721, null)?.port).toContain('-LocalPort 8721 ');
	});

	it('builds nothing for an invalid port or identifier (never a fallback to Any)', () => {
		expect(firewallCommands(ID, 0, EXE)).toBeNull();
		expect(firewallCommands(ID, 70000, EXE)).toBeNull();
		expect(firewallCommands(ID, 80.5, EXE)).toBeNull();
		expect(firewallCommands("x' ; calc ; '", 8721, EXE)).toBeNull();
	});
});

describe('firewallGuide (Issue #219 / #216)', () => {
	it('shows the live port and bind, never the saved ones', () => {
		const guide = firewallGuide(status(), ID);
		expect(guide.kind).toBe('show');
		if (guide.kind !== 'show') return;
		expect(guide.info).toMatchObject({
			executablePath: EXE,
			port: 8721,
			bind: '0.0.0.0',
			generation: 4
		});
		expect(guide.info.commands?.port).toContain('-LocalPort 8721 ');
		expect(guide.info.commands?.port).not.toContain('9999');
	});

	it('also shows for a specific non-loopback IPv4 bind', () => {
		expect(firewallGuide(status({ live: { bind: '192.168.1.20', port: 8721 } }), ID).kind).toBe(
			'show'
		);
	});

	it('says no rule is needed while stopped', () => {
		expect(firewallGuide(status({ running: false, live: null }), ID)).toEqual({
			kind: 'notNeeded',
			reason: 'stopped'
		});
	});

	it('says no rule is needed for any loopback bind in 127.0.0.0/8', () => {
		for (const bind of ['127.0.0.1', '127.0.0.2', '127.255.255.254']) {
			expect(firewallGuide(status({ live: { bind, port: 8721 } }), ID)).toEqual({
				kind: 'notNeeded',
				reason: 'localOnly'
			});
		}
	});

	it('is hidden outside Windows and on hosts that do not report the platform', () => {
		for (const platform of ['macos', 'linux', undefined]) {
			expect(firewallGuide(status({ platform }), ID)).toEqual({ kind: 'hidden' });
		}
		expect(firewallGuide(null, ID)).toEqual({ kind: 'hidden' });
	});

	it('is hidden for an IPv6 bind (not guided) and for a running host without a live listener', () => {
		expect(firewallGuide(status({ live: { bind: '::', port: 8721 } }), ID)).toEqual({
			kind: 'hidden'
		});
		expect(firewallGuide(status({ live: { bind: '::1', port: 8721 } }), ID)).toEqual({
			kind: 'hidden'
		});
		expect(firewallGuide(status({ live: undefined }), ID)).toEqual({ kind: 'hidden' });
	});

	it('shows the values without commands while the identifier is unknown', () => {
		const guide = firewallGuide(status(), null);
		expect(guide.kind === 'show' && guide.info.commands).toBeNull();
	});

	it('shows an unknown executable path as null', () => {
		const guide = firewallGuide(status({ executablePath: null }), ID);
		expect(guide.kind === 'show' && guide.info.executablePath).toBeNull();
		expect(guide.kind === 'show' && guide.info.commands?.program).toBeNull();
	});
});

describe('sameFirewallTarget', () => {
	const info = (firewallGuide(status(), ID) as { kind: 'show'; info: FirewallInfo }).info;

	it('matches the same snapshot', () => {
		expect(sameFirewallTarget(info, firewallGuide(status(), ID))).toBe(true);
	});

	it('rejects a new generation, port, bind or executable, or a stopped server', () => {
		for (const patch of [
			{ generation: 5 },
			{ live: { bind: '0.0.0.0', port: 8722 } },
			{ live: { bind: '192.168.1.20', port: 8721 } },
			{ executablePath: 'C:\\other.exe' },
			{ running: false, live: null }
		]) {
			expect(sameFirewallTarget(info, firewallGuide(status(patch), ID))).toBe(false);
		}
	});
});
