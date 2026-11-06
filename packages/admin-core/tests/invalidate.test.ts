import { describe, expect, it, vi } from 'vitest';
import { invalidate, invalidateAll, onInvalidate } from '../src/invalidate';

describe('invalidate bus', () => {
	it('calls subscribers for the matching resource only', () => {
		const itemsCb = vi.fn();
		const usersCb = vi.fn();
		onInvalidate('items-a', itemsCb);
		onInvalidate('users-a', usersCb);

		invalidate('items-a');

		expect(itemsCb).toHaveBeenCalledTimes(1);
		expect(usersCb).not.toHaveBeenCalled();
	});

	it('unsubscribe stops future notifications', () => {
		const cb = vi.fn();
		const unsubscribe = onInvalidate('items-b', cb);
		unsubscribe();
		invalidate('items-b');
		expect(cb).not.toHaveBeenCalled();
	});

	it('invalidate with no subscribers is a no-op', () => {
		expect(() => invalidate('nothing-registered')).not.toThrow();
	});

	it('supports multiple subscribers for the same resource', () => {
		const a = vi.fn();
		const b = vi.fn();
		onInvalidate('items-c', a);
		onInvalidate('items-c', b);
		invalidate('items-c');
		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});

	it('passes the reason: default change, resync from invalidateAll', () => {
		const cb = vi.fn();
		const off = onInvalidate('items-d', cb);
		invalidate('items-d');
		expect(cb).toHaveBeenLastCalledWith('items-d', 'change');
		invalidateAll();
		expect(cb).toHaveBeenLastCalledWith('items-d', 'resync');
		off();
	});
});
