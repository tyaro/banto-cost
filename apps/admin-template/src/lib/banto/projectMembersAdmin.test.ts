import { describe, expect, it } from 'vitest';
import { sortMembers, type ProjectMember } from './projectMembersAdmin';

describe('sortMembers (review F-2, §8-15)', () => {
	it('lists the manager, the sales owners, then the workers, each in name order', () => {
		const members: ProjectMember[] = [
			{ projectId: 1, userId: 3, kind: 'worker' },
			{ projectId: 1, userId: 2, kind: 'worker' },
			{ projectId: 1, userId: 9, kind: 'worker' },
			{ projectId: 1, userId: 3, kind: 'sales' },
			{ projectId: 1, userId: 2, kind: 'manager' }
		];
		// Names came in the order 3, 2 (user 9 has no name: last).
		const order = new Map([
			[3, 0],
			[2, 1]
		]);
		expect(sortMembers(members, order).map((m) => `${m.kind}:${m.userId}`)).toEqual([
			'manager:2',
			'sales:3',
			'worker:3',
			'worker:2',
			'worker:9'
		]);
	});
});
