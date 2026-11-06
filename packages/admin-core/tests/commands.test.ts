import { describe, expect, it, vi } from 'vitest';
import { searchCommands, type PaletteCommand } from '../src/commands';

function makeCommand(overrides: Partial<PaletteCommand> & { id: string }): PaletteCommand {
	return {
		title: overrides.id,
		group: 'テスト',
		run: () => {},
		...overrides
	};
}

describe('searchCommands', () => {
	it('empty query returns every visible command in original order', () => {
		const commands = [makeCommand({ id: 'a', title: 'A' }), makeCommand({ id: 'b', title: 'B' })];
		expect(searchCommands(commands, '').map((c) => c.id)).toEqual(['a', 'b']);
	});

	it('whitespace-only query behaves like an empty query', () => {
		const commands = [makeCommand({ id: 'a', title: 'A' }), makeCommand({ id: 'b', title: 'B' })];
		expect(searchCommands(commands, '   ').map((c) => c.id)).toEqual(['a', 'b']);
	});

	it('excludes commands whose visible() returns false', () => {
		const commands = [
			makeCommand({ id: 'admin-only', title: 'ユーザー管理', visible: () => false }),
			makeCommand({ id: 'everyone', title: '商品' })
		];
		expect(searchCommands(commands, '').map((c) => c.id)).toEqual(['everyone']);
		expect(searchCommands(commands, '管理').map((c) => c.id)).toEqual([]);
	});

	it('commands with no visible() are always included', () => {
		const commands = [makeCommand({ id: 'a', title: 'A' })];
		expect(searchCommands(commands, '').map((c) => c.id)).toEqual(['a']);
	});

	it('prefix match outranks word-start match, which outranks substring match', () => {
		const commands = [
			makeCommand({ id: 'substring', title: 'the settings page' }), // 'set' only appears mid-string via "settings"... actually word-start
			makeCommand({ id: 'wordstart', title: 'quick settings' }),
			makeCommand({ id: 'prefix', title: 'settings' })
		];
		// 'set' is a substring of "quick settings" via word "settings" (word-start)
		// and a prefix of "settings". Build a genuine substring-only case:
		const substringOnly = makeCommand({ id: 'mid', title: 'presetting' }); // 'set' appears mid-word, not at a word boundary
		const all = [substringOnly, ...commands];
		const results = searchCommands(all, 'set').map((c) => c.id);
		expect(results.indexOf('prefix')).toBeLessThan(results.indexOf('wordstart'));
		expect(results.indexOf('wordstart')).toBeLessThan(results.indexOf('mid'));
	});

	it('matches are case-insensitive', () => {
		const commands = [makeCommand({ id: 'a', title: 'Dashboard' })];
		expect(searchCommands(commands, 'DASH').map((c) => c.id)).toEqual(['a']);
		expect(searchCommands(commands, 'dash').map((c) => c.id)).toEqual(['a']);
	});

	it('matches keywords in addition to title', () => {
		const commands = [
			makeCommand({ id: 'a', title: 'ダッシュボード', keywords: ['dashboard', 'home'] })
		];
		expect(searchCommands(commands, 'home').map((c) => c.id)).toEqual(['a']);
		expect(searchCommands(commands, 'dash').map((c) => c.id)).toEqual(['a']);
	});

	it('matches Japanese text by plain substring, no normalization', () => {
		const commands = [
			makeCommand({ id: 'items', title: '商品' }),
			makeCommand({ id: 'users', title: 'ユーザー管理' }),
			makeCommand({ id: 'audit', title: '監査ログ' })
		];
		expect(searchCommands(commands, '管理').map((c) => c.id)).toEqual(['users']);
		expect(searchCommands(commands, 'ログ').map((c) => c.id)).toEqual(['audit']);
	});

	it('excludes commands with no match at all', () => {
		const commands = [
			makeCommand({ id: 'a', title: 'Dashboard' }),
			makeCommand({ id: 'b', title: 'Items' })
		];
		expect(searchCommands(commands, 'zzz').map((c) => c.id)).toEqual([]);
	});

	it('empty query: recentIds entries come first, in the given order', () => {
		const commands = [
			makeCommand({ id: 'a', title: 'A' }),
			makeCommand({ id: 'b', title: 'B' }),
			makeCommand({ id: 'c', title: 'C' })
		];
		expect(searchCommands(commands, '', ['c', 'a']).map((cmd) => cmd.id)).toEqual(['c', 'a', 'b']);
	});

	it('recentIds entries not present in commands are ignored', () => {
		const commands = [makeCommand({ id: 'a', title: 'A' }), makeCommand({ id: 'b', title: 'B' })];
		expect(searchCommands(commands, '', ['ghost', 'b']).map((cmd) => cmd.id)).toEqual(['b', 'a']);
	});

	it('non-empty query: recentIds breaks ties within the same score', () => {
		const commands = [
			makeCommand({ id: 'a', title: 'Items' }),
			makeCommand({ id: 'b', title: 'Items admin' }),
			makeCommand({ id: 'c', title: 'Items export' })
		];
		// All three start with "Items" -> same (prefix) score. Recency should reorder them.
		expect(searchCommands(commands, 'items', ['c', 'a']).map((cmd) => cmd.id)).toEqual([
			'c',
			'a',
			'b'
		]);
	});

	it('a higher score always wins over recency', () => {
		const commands = [
			makeCommand({ id: 'prefix', title: 'settings' }),
			makeCommand({ id: 'recent-but-weaker', title: 'presetting' })
		];
		// 'recent-but-weaker' is recent but only substring-matches; prefix should still win.
		expect(searchCommands(commands, 'set', ['recent-but-weaker']).map((cmd) => cmd.id)).toEqual([
			'prefix',
			'recent-but-weaker'
		]);
	});

	it('run() is a plain function reference, never invoked by search itself', () => {
		const run = vi.fn();
		const commands = [makeCommand({ id: 'a', title: 'A', run })];
		searchCommands(commands, 'a');
		expect(run).not.toHaveBeenCalled();
	});
});
