/**
 * Spec §11.4 (LAN settings UX: documenting the OS-side Windows Firewall
 * behavior). Pure decisions behind the settings screen's "information needed to allow
 * through the firewall" block (Issue #219, stage 1 / PR-A): whether to show
 * it at all, and the values + PowerShell commands it shows and copies.
 * `FirewallInfoPanel.svelte` renders the result; nothing here touches the
 * DOM, Tauri, or the message catalog (conventions §13 - the panel builds
 * every display string).
 *
 * Input is always the backend's live snapshot (`ServerStatus.live`, Issue
 * #459), never the saved settings or an unsaved draft (owner design review
 * 2026-10-11, point 2): a rule for a port nothing listens on would be worse
 * than no rule.
 *
 * Safety of the commands (security audit 2026-10-21, priority 1): an admin
 * pastes them into an elevated PowerShell, so they are a code-execution
 * boundary. They are a fixed template; the only inputs are a port checked to
 * be an integer in 1-65535, the app identifier checked against Tauri's
 * identifier alphabet, and the executable path, which goes in only as a
 * PowerShell single-quoted literal ({@link quotePowerShellLiteral}) - never
 * double-quoted (that would expand `$(...)`) and never bare.
 */
import type { ServerStatus } from '#lib/banto/serverAdmin.js';
import { isIpv4Bind, isLoopbackHost } from './connectivityScope';
import type { StatusRefresh } from './serverStatusRequests';

/** Direction, protocol, profile and remote range the guide recommends (PowerShell parameter values). */
export const FIREWALL_DIRECTION = 'Inbound';
export const FIREWALL_PROTOCOL = 'TCP';
export const FIREWALL_PROFILE = 'Private';
/**
 * `-RemoteAddress LocalSubnet`: the subnets of every interface of this PC
 * (VPN adapters included), resolved by Windows. The listener's bind address
 * alone does not tell the subnet mask, so the guide names this keyword
 * rather than computing a CIDR - and never falls back to `Any`.
 */
export const FIREWALL_REMOTE_ADDRESS = 'LocalSubnet';

/**
 * The characters PowerShell treats as a single quote inside a single-quoted
 * string: ASCII `'` plus the typographic ones (U+2018-U+201B). Each one must
 * be doubled, or it ends the literal.
 */
const POWERSHELL_SINGLE_QUOTES = /['‘’‚‛]/g;

/**
 * Control characters (C0, DEL, C1). No real Windows path contains one; a
 * line break in particular would split the pasted command into two.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * `value` as a PowerShell single-quoted string literal: wrapped in `'` with
 * every single-quote character doubled. Inside such a literal PowerShell
 * expands nothing (`$`, `$(...)`, backticks and `"` are plain characters),
 * so the result always parses as exactly one string argument whose value
 * is `value`. `null` when `value` contains a control character (refused
 * rather than escaped - see `CONTROL_CHARACTERS`).
 */
export function quotePowerShellLiteral(value: string): string | null {
	if (CONTROL_CHARACTERS.test(value)) return null;
	return `'${value.replace(POWERSHELL_SINGLE_QUOTES, (quote) => quote + quote)}'`;
}

/** Whether `port` is a TCP port number a rule can name (an integer in 1-65535). */
export function isValidPort(port: unknown): port is number {
	return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Tauri's bundle identifier alphabet (ASCII letters, digits, `-` and `.`),
 * starting with a letter or digit. The identifier names the rules
 * ({@link firewallRuleNames}), so anything else yields no commands.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;

export function isValidAppIdentifier(identifier: unknown): identifier is string {
	return typeof identifier === 'string' && IDENTIFIER.test(identifier);
}

/**
 * Rule names that do not collide between apps derived from this template:
 * the Tauri bundle `identifier` (reverse-DNS, unique per app by design and
 * changed by the rename recipe) is the `-Group`, and prefixes the rest.
 *
 * `name` is the rule's identity (`-Name`): deterministic per shape and
 * deliberately free of the port. `New-NetFirewallRule` without `-Name`
 * creates a new rule with a random name every time, and `-DisplayName` /
 * `-Group` do not replace anything, so a fixed `name` is what keeps a second
 * run from adding a duplicate. The command never removes or changes a rule:
 * when a rule of this `name` already exists (possibly narrowed or turned into
 * a Block by an administrator, or pointing at another install's exe) it only
 * warns and leaves it alone, so a port or shape change is for the
 * administrator to apply to the existing rule by hand. These are command content,
 * not UI text, so they stay ASCII and untranslated.
 */
export function firewallRuleNames(identifier: string): {
	group: string;
	programName: string;
	portName: string;
	programDisplayName: string;
	portDisplayName: string;
} {
	return {
		group: identifier,
		programName: `${identifier}.lan.tcp.program`,
		portName: `${identifier}.lan.tcp.port`,
		programDisplayName: `${identifier} LAN (TCP-In, program)`,
		portDisplayName: `${identifier} LAN (TCP-In, port)`
	};
}

export interface FirewallCommands {
	/** Allows TCP inbound to the executable on any port it listens on (`null` without a usable path). */
	program: string | null;
	/** Allows TCP inbound on the live port, for any program. */
	port: string;
}

/**
 * The warning a command prints when a rule of its name already exists
 * (`name` is the rule's `-Name`). The panel passes the i18n message
 * (`settings.firewallRuleExists`); this English text is only the default for
 * callers without one (tests).
 */
export type FirewallRuleExistsWarning = (name: string) => string;

const DEFAULT_RULE_EXISTS_WARNING: FirewallRuleExistsWarning = (name) =>
	`A firewall rule named ${name} already exists, so nothing was changed. Check it with Get-NetFirewallRule -Name '${name}' | Format-List, then update or remove it yourself.`;

/**
 * The two commands (the rule shape - per executable or per port - is still
 * an ADR decision, so both are offered; Issue #219 addendum 2026-10-21).
 * Each is one line so it pastes as one:
 *
 *     $n = '<name>'; if (Get-NetFirewallRule -Name $n -ErrorAction SilentlyContinue) { Write-Warning '<warning>' } else { New-NetFirewallRule -Name $n ... }
 *
 * The deterministic `-Name` keeps a re-run from adding a duplicate, and a
 * rule of that name that already exists is left exactly as it is: the
 * command never removes or changes a rule (owner review on PR #463 - the
 * existing one may have been narrowed or changed to Block by an
 * administrator, or point at another installation's executable, and a
 * remove-then-create loses it if the create fails). Checking and updating
 * an existing rule is left to the administrator (docs/recipes/lan-access.md).
 *
 * `null` when the port or identifier is invalid, or the warning cannot be
 * quoted: no command is better than a wrong one.
 */
export function firewallCommands(
	identifier: string,
	port: number,
	executablePath: string | null,
	existsWarning: FirewallRuleExistsWarning = DEFAULT_RULE_EXISTS_WARNING
): FirewallCommands | null {
	if (!isValidPort(port) || !isValidAppIdentifier(identifier)) return null;
	const names = firewallRuleNames(identifier);
	// The names come from a checked identifier, so they need no escaping -
	// but quoting them the same way keeps one rule for every string in the
	// command.
	const group = quotePowerShellLiteral(names.group);
	const programName = quotePowerShellLiteral(names.programName);
	const portName = quotePowerShellLiteral(names.portName);
	const programDisplay = quotePowerShellLiteral(names.programDisplayName);
	const portDisplay = quotePowerShellLiteral(names.portDisplayName);
	const programWarning = quotePowerShellLiteral(existsWarning(names.programName));
	const portWarning = quotePowerShellLiteral(existsWarning(names.portName));
	if (
		group === null ||
		programName === null ||
		portName === null ||
		programDisplay === null ||
		portDisplay === null ||
		programWarning === null ||
		portWarning === null
	) {
		return null;
	}
	const common = `-Protocol ${FIREWALL_PROTOCOL} -Profile ${FIREWALL_PROFILE} -RemoteAddress ${FIREWALL_REMOTE_ADDRESS} -Action Allow`;
	const createIfAbsent = (name: string, warning: string, create: string) =>
		`$n = ${name}; if (Get-NetFirewallRule -Name $n -ErrorAction SilentlyContinue) { Write-Warning ${warning} } else { New-NetFirewallRule -Name $n ${create} }`;
	const program = executablePath ? quotePowerShellLiteral(executablePath) : null;
	return {
		program:
			program === null
				? null
				: createIfAbsent(
						programName,
						programWarning,
						`-DisplayName ${programDisplay} -Group ${group} -Direction ${FIREWALL_DIRECTION} -Program ${program} ${common}`
					),
		port: createIfAbsent(
			portName,
			portWarning,
			`-DisplayName ${portDisplay} -Group ${group} -Direction ${FIREWALL_DIRECTION} -LocalPort ${port} ${common}`
		)
	};
}

/** What the firewall block shows for a status snapshot. */
export type FirewallGuide =
	/** Nothing at all: not Windows, an unknown/older host, or an IPv6 bind (not guided, Issue #216). */
	| { kind: 'hidden' }
	/** No rule needed: nothing listens (`stopped`), or only this PC can connect (`localOnly`). */
	| { kind: 'notNeeded'; reason: 'stopped' | 'localOnly' }
	| { kind: 'show'; info: FirewallInfo };

export interface FirewallInfo {
	/** `null` when the backend could not tell (shown as unknown; no per-program command). */
	executablePath: string | null;
	/** The live listener's port and bind (never the saved ones). */
	port: number;
	bind: string;
	/** `ServerStatus.generation` of the snapshot this came from (`null` from an older host). */
	generation: number | null;
	/** `null` when the app identifier is unavailable or invalid. */
	commands: FirewallCommands | null;
}

/**
 * Decides the firewall block for `status` (`null` = not loaded yet).
 * `identifier` is the Tauri bundle identifier (`null` until known).
 *
 * - Windows only (`status.platform`): the commands and profile names are
 *   Windows Defender Firewall's. The whole server card is Tauri-only already,
 *   so a LAN browser never gets here.
 * - Not running, or no live listener reported: nothing to allow.
 * - Live bind not IPv4: hidden - IPv6 is not guided (Issue #216), and the
 *   card already says so.
 * - Live bind in 127.0.0.0/8: only this PC can connect, so no rule needed.
 */
export function firewallGuide(
	status: ServerStatus | null,
	identifier: string | null,
	existsWarning?: FirewallRuleExistsWarning
): FirewallGuide {
	if (status === null || status.platform !== 'windows') return { kind: 'hidden' };
	if (!status.running) return { kind: 'notNeeded', reason: 'stopped' };
	const live = status.live;
	if (!live) return { kind: 'hidden' };
	if (!isIpv4Bind(live.bind)) return { kind: 'hidden' };
	if (isLoopbackHost(live.bind)) return { kind: 'notNeeded', reason: 'localOnly' };
	if (!isValidPort(live.port)) return { kind: 'hidden' };
	const executablePath = status.executablePath ? status.executablePath : null;
	return {
		kind: 'show',
		info: {
			executablePath,
			port: live.port,
			bind: live.bind,
			generation: status.generation ?? null,
			commands:
				identifier === null
					? null
					: firewallCommands(identifier, live.port, executablePath, existsWarning)
		}
	};
}

/**
 * Whether `next` still describes the listener `info` was built from: same
 * generation, port, bind and executable. The panel re-reads the status
 * before copying and refuses to copy when this is false, so what is copied
 * is always what was on screen (security audit 2026-10-21, priority 1).
 */
export function sameFirewallTarget(info: FirewallInfo, next: FirewallGuide): boolean {
	return (
		next.kind === 'show' &&
		next.info.generation === info.generation &&
		next.info.port === info.port &&
		next.info.bind === info.bind &&
		next.info.executablePath === info.executablePath
	);
}

/**
 * Whether a copy may go ahead after the panel re-read the status
 * (`refreshed`) for the target it showed (`shown`): `copy` only when the
 * read is still the latest and describes the same listener. `stale` (the
 * panel shows the updated values and asks to check them again) when the
 * read was dropped - an apply or a newer read came after it, or it was
 * older than what is shown (owner review on PR #463) - or the listener
 * changed.
 */
export function firewallCopyCheck(
	shown: FirewallInfo,
	refreshed: StatusRefresh,
	identifier: string | null
): 'copy' | 'stale' | 'unavailable' {
	if (refreshed.kind === 'unavailable') return 'unavailable';
	if (refreshed.kind === 'superseded') return 'stale';
	return sameFirewallTarget(shown, firewallGuide(refreshed.status, identifier)) ? 'copy' : 'stale';
}
