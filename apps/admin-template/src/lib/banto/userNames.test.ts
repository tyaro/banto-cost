import { describe, expect, it } from 'vitest';
import { userNameOptions } from './userNames';

describe('user name options', () => {
	it('labels each account by its display name, in the given order', () => {
		expect(
			userNameOptions([
				{ id: 3, displayName: '佐藤 一郎' },
				{ id: 1, displayName: '田中 花子' }
			])
		).toEqual([
			{ value: 3, label: '佐藤 一郎' },
			{ value: 1, label: '田中 花子' }
		]);
	});

	it('appends the id when two accounts share a display name', () => {
		expect(
			userNameOptions([
				{ id: 2, displayName: '山田 太郎' },
				{ id: 5, displayName: '山田 太郎' },
				{ id: 4, displayName: '鈴木 次郎' }
			])
		).toEqual([
			{ value: 2, label: '山田 太郎 (#2)' },
			{ value: 5, label: '山田 太郎 (#5)' },
			{ value: 4, label: '鈴木 次郎' }
		]);
	});
});
