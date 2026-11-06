/**
 * `createImageStore` (ADR-0020, shared-primitives-upstream-plan §3.7, PR-14, Issue #438):
 * originals, de-duplication by hash, the total size, shared object URLs, pin / release, stale
 * adds, and the boundaries (after dispose, double release, dropping while pinned, re-entrant
 * revoke). Effects are covered in `storeEffect.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
	ImageAssetError,
	createImageStore,
	isImageAssetError,
	sha256Hex,
	type ImageDecoder,
	type ImageImportLimits,
	type ImageStore,
	type ImageStoreOptions
} from '../src/index';
import { png } from './images';

const limits: ImageImportLimits = {
	maxBytes: 1024 * 1024,
	maxEdge: 8192,
	maxPixels: 16_000_000,
	formats: ['png', 'jpeg']
};

/** A decoder that answers each blob with the size in the PNG header (enough for the check). */
const decode: ImageDecoder = async (blob) => {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const view = new DataView(bytes.buffer);
	return { width: view.getUint32(16), height: view.getUint32(20) };
};

/** A decoder whose answer the test releases (or fails) by hand. */
function gatedDecoder() {
	const gates: { resolve: () => void; reject: () => void }[] = [];
	const gated: ImageDecoder = (blob) =>
		new Promise((resolve, reject) => {
			gates.push({
				resolve: () => void decode(blob).then(resolve),
				reject: () => reject(new Error('cannot decode'))
			});
		});
	const opened = async () => {
		// Let the add reach the decoder (reading the input is asynchronous).
		for (let i = 0; i < 20 && gates.length === 0; i++) await Promise.resolve();
	};
	return { decode: gated, gates, opened };
}

function urls() {
	let next = 0;
	const created: string[] = [];
	const revoked: string[] = [];
	return {
		created,
		revoked,
		objectUrls: {
			create: vi.fn((blob: Blob) => {
				void blob;
				const url = `blob:test/${++next}`;
				created.push(url);
				return url;
			}),
			revoke: vi.fn((url: string) => {
				revoked.push(url);
			})
		}
	};
}

function store(options: Partial<ImageStoreOptions> = {}): ImageStore {
	return createImageStore({
		maxTotalBytes: 1024 * 1024,
		objectUrls: urls().objectUrls,
		...options
	});
}

function caught(fn: () => unknown) {
	try {
		fn();
	} catch (e) {
		if (isImageAssetError(e)) return { code: e.code, detail: e.detail };
		throw e;
	}
	throw new Error('did not throw');
}

async function rejection(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (e) {
		if (isImageAssetError(e)) return { code: e.code, detail: e.detail };
		throw e;
	}
	throw new Error('did not reject');
}

async function bytesOf(blob: Blob): Promise<number[]> {
	return [...new Uint8Array(await blob.arrayBuffer())];
}

async function added(target: ImageStore, width = 3, height = 2): Promise<string> {
	const meta = await target.add(png(width, height), limits, { decode });
	if (!meta) throw new Error('add went stale');
	return meta.sha256;
}

describe('createImageStore options', () => {
	it('requires a positive safe integer maxTotalBytes', () => {
		for (const maxTotalBytes of [undefined, 0, -1, 1.5, Number.NaN, Infinity, 2 ** 53, '1'])
			expect(
				caught(() => createImageStore({ maxTotalBytes } as unknown as ImageStoreOptions))
			).toEqual({ code: 'invalid-limits', detail: { field: 'maxTotalBytes' } });
	});

	it('rejects a missing options object and broken object URL functions', () => {
		expect(caught(() => createImageStore(null as unknown as ImageStoreOptions))).toEqual({
			code: 'invalid-limits',
			detail: { field: 'options' }
		});
		for (const objectUrls of [null, {}, { create: () => 'x' }, { revoke: () => {} }, 'x'])
			expect(
				caught(() =>
					createImageStore({ maxTotalBytes: 1, objectUrls } as unknown as ImageStoreOptions)
				)
			).toEqual({ code: 'invalid-limits', detail: { field: 'objectUrls' } });
	});

	it('uses the object URL functions given at creation, even if the object changes later', async () => {
		const given = urls().objectUrls;
		const target = createImageStore({ maxTotalBytes: 1024, objectUrls: given });
		given.create = vi.fn(() => 'blob:replaced');
		const hash = await added(target);
		expect(target.acquireUrl(hash).url).toBe('blob:test/1');
	});
});

describe('ImageStore add (originals and de-duplication)', () => {
	it('keeps the original bytes as a Blob typed from the header, keyed by its SHA-256', async () => {
		const target = store();
		const bytes = png(3, 2);
		const meta = await target.add(bytes, limits, { decode });
		expect(meta).toMatchObject({ format: 'png', width: 3, height: 2, byteLength: bytes.length });
		expect(meta!.sha256).toBe(await sha256Hex(bytes));
		expect(target.has(meta!.sha256)).toBe(true);
		expect(target.metadata(meta!.sha256)).toBe(meta);
		const blob = target.blob(meta!.sha256);
		expect(blob.type).toBe('image/png');
		expect(await bytesOf(blob)).toEqual([...bytes]);
		expect(target.count).toBe(1);
		expect(target.totalBytes).toBe(bytes.length);
	});

	it('accepts a Blob and keeps its bytes (not its declared type)', async () => {
		const target = store();
		const bytes = png(4, 4);
		const meta = await target.add(new Blob([bytes], { type: 'text/plain' }), limits, { decode });
		expect(target.blob(meta!.sha256).type).toBe('image/png');
		expect(await bytesOf(target.blob(meta!.sha256))).toEqual([...bytes]);
	});

	it('copies the caller memory once: rewriting it while the check runs changes nothing kept', async () => {
		const target = store();
		const bytes = png(3, 2);
		const original = [...bytes];
		const gate = gatedDecoder();
		const pending = target.add(bytes, limits, { decode: gate.decode });
		await gate.opened();
		bytes.fill(0);
		gate.gates[0].resolve();
		const meta = await pending;
		expect(await bytesOf(target.blob(meta!.sha256))).toEqual(original);
		expect(meta!.sha256).toBe(await sha256Hex(new Uint8Array(original)));
	});

	it('keeps the same content once and returns the metadata already kept', async () => {
		const target = store();
		const first = await target.add(png(3, 2), limits, { decode });
		const second = await target.add(new Blob([png(3, 2)]), limits, { decode });
		expect(second).toBe(first);
		expect(target.count).toBe(1);
		expect(target.totalBytes).toBe(first!.byteLength);
	});

	it('two concurrent adds of the same content keep it once', async () => {
		const target = store();
		const [a, b] = await Promise.all([
			target.add(png(3, 2), limits, { decode }),
			target.add(png(3, 2), limits, { decode })
		]);
		expect(a).toBe(b);
		expect(target.count).toBe(1);
	});

	it('reports the import check failure and keeps nothing', async () => {
		const target = store();
		expect(await rejection(target.add(new Uint8Array([1, 2, 3]), limits, { decode }))).toEqual({
			code: 'unsupported-format',
			detail: {}
		});
		expect(await rejection(target.add(png(3, 2), { ...limits, maxBytes: 0 }))).toEqual({
			code: 'invalid-limits',
			detail: { field: 'maxBytes' }
		});
		expect(target.count).toBe(0);
		expect(target.busy('')).toBe(false);
	});
});

describe('ImageStore total size', () => {
	it('refuses an original that would go over maxTotalBytes (store-full) and keeps nothing', async () => {
		const size = png(3, 2).length;
		const target = store({ maxTotalBytes: size * 2 - 1 });
		await added(target, 3, 2);
		const next = png(5, 5);
		expect(await rejection(target.add(next, limits, { decode }))).toEqual({
			code: 'store-full',
			detail: { limit: size * 2 - 1, actual: size + next.length }
		});
		expect(target.count).toBe(1);
		expect(target.totalBytes).toBe(size);
	});

	it('still returns a duplicate when the store is full, and frees room on delete', async () => {
		const size = png(3, 2).length;
		const target = store({ maxTotalBytes: size });
		const hash = await added(target, 3, 2);
		expect((await target.add(png(3, 2), limits, { decode }))!.sha256).toBe(hash);
		expect(target.delete(hash)).toBe(true);
		expect(target.totalBytes).toBe(0);
		await added(target, 3, 2);
		expect(target.count).toBe(1);
	});
});

describe('ImageStore stale adds (request owner)', () => {
	it('a newer add of the same key makes the pending one stale: it resolves null and keeps nothing', async () => {
		const target = store();
		const gate = gatedDecoder();
		const first = target.add(png(3, 2), limits, { decode: gate.decode, key: 'k' });
		await gate.opened();
		expect(target.busy('k')).toBe(true);
		const second = target.add(png(4, 4), limits, { decode, key: 'k' });
		const kept = await second;
		expect(target.busy('k')).toBe(false);
		gate.gates[0].resolve();
		expect(await first).toBeNull();
		expect(target.count).toBe(1);
		expect(target.has(kept!.sha256)).toBe(true);
	});

	it('a stale add does not report its failure', async () => {
		const target = store();
		const gate = gatedDecoder();
		const first = target.add(png(3, 2), limits, { decode: gate.decode, key: 'k' });
		await gate.opened();
		target.cancel('k');
		expect(target.busy('k')).toBe(false);
		gate.gates[0].reject();
		expect(await first).toBeNull();
		expect(target.count).toBe(0);
	});

	it('cancel affects only its key; adds without a key are independent', async () => {
		const target = store();
		const gate = gatedDecoder();
		const keyed = target.add(png(3, 2), limits, { decode: gate.decode, key: 'a' });
		await gate.opened();
		const anonymous1 = target.add(png(4, 4), limits, { decode });
		const anonymous2 = target.add(png(5, 5), limits, { decode });
		target.cancel('b');
		expect(target.busy('a')).toBe(true);
		gate.gates[0].resolve();
		expect(await keyed).not.toBeNull();
		expect(await anonymous1).not.toBeNull();
		expect(await anonymous2).not.toBeNull();
		expect(target.count).toBe(3);
	});

	it('dispose while an add is pending: it resolves null (even when it fails) and keeps nothing', async () => {
		const target = store();
		const gate = gatedDecoder();
		const ok = target.add(png(3, 2), limits, { decode: gate.decode });
		const failing = target.add(png(4, 4), limits, { decode: gate.decode });
		await gate.opened();
		for (let i = 0; i < 20 && gate.gates.length < 2; i++) await Promise.resolve();
		target.dispose();
		gate.gates[0].resolve();
		gate.gates[1].reject();
		expect(await ok).toBeNull();
		expect(await failing).toBeNull();
		expect(target.count).toBe(0);
		expect(target.totalBytes).toBe(0);
	});

	it('add after dispose rejects with store-disposed', async () => {
		const target = store();
		target.dispose();
		expect(await rejection(target.add(png(3, 2), limits, { decode }))).toEqual({
			code: 'store-disposed',
			detail: {}
		});
	});
});

describe('ImageStore lookups', () => {
	it('metadata and blob of an unknown hash throw unknown-asset with the hash', () => {
		const target = store();
		expect(caught(() => target.metadata('nope'))).toEqual({
			code: 'unknown-asset',
			detail: { hash: 'nope' }
		});
		expect(caught(() => target.blob('nope')).code).toBe('unknown-asset');
		expect(target.has('nope')).toBe(false);
	});

	it('looks hashes up as map keys, not object properties', () => {
		const target = store();
		for (const hash of ['constructor', '__proto__', 'toString'])
			expect(caught(() => target.metadata(hash)).code).toBe('unknown-asset');
	});
});

describe('ImageStore object URLs', () => {
	it('shares one URL per original and revokes it on the last release', async () => {
		const u = urls();
		const target = store({ objectUrls: u.objectUrls });
		const hash = await added(target);
		const a = target.acquireUrl(hash);
		const b = target.acquireUrl(hash);
		expect(a.url).toBe(b.url);
		expect(u.objectUrls.create).toHaveBeenCalledTimes(1);
		expect(u.objectUrls.create).toHaveBeenCalledWith(target.blob(hash));
		a.release();
		expect(u.revoked).toEqual([]);
		b.release();
		expect(u.revoked).toEqual([a.url]);
	});

	it('a second release of the same lease does nothing (no early revoke)', async () => {
		const u = urls();
		const target = store({ objectUrls: u.objectUrls });
		const hash = await added(target);
		const a = target.acquireUrl(hash);
		const b = target.acquireUrl(hash);
		a.release();
		a.release();
		expect(u.revoked).toEqual([]);
		b.release();
		b.release();
		expect(u.revoked).toEqual([b.url]);
	});

	it('makes a new URL after the old one was revoked', async () => {
		const u = urls();
		const target = store({ objectUrls: u.objectUrls });
		const hash = await added(target);
		const first = target.acquireUrl(hash);
		first.release();
		const second = target.acquireUrl(hash);
		expect(second.url).not.toBe(first.url);
		expect(u.created).toHaveLength(2);
	});

	it('a failing create counts no lease', async () => {
		const target = store({
			objectUrls: {
				create: () => {
					throw new Error('no URL');
				},
				revoke: () => {}
			}
		});
		const hash = await added(target);
		expect(() => target.acquireUrl(hash)).toThrow('no URL');
		expect(target.delete(hash)).toBe(true);
	});

	it('a nested acquireUrl of the same original from create is refused: one URL, revoked on the last release', async () => {
		let hash = '';
		const inner: unknown[] = [];
		const created: string[] = [];
		const revoked: string[] = [];
		const target: ImageStore = store({
			objectUrls: {
				create: () => {
					if (created.length === 0) inner.push(caught(() => target.acquireUrl(hash)));
					const url = `blob:test/${created.length + 1}`;
					created.push(url);
					return url;
				},
				revoke: (url) => void revoked.push(url)
			}
		});
		hash = await added(target);
		const lease = target.acquireUrl(hash);
		expect(inner).toEqual([{ code: 'url-pending', detail: { hash } }]);
		expect(created).toEqual(['blob:test/1']);
		lease.release();
		expect(revoked).toEqual(['blob:test/1']);
		expect(target.delete(hash)).toBe(true);
	});

	it.each(['delete', 'collect', 'dispose'] as const)(
		'%s called from create does not drop the original being leased',
		async (call) => {
			let hash = '';
			const target: ImageStore = store({
				objectUrls: {
					create: () => {
						if (call === 'delete') expect(target.delete(hash)).toBe(false);
						else if (call === 'collect') expect(target.collect([])).toBe(0);
						else target.dispose();
						return 'blob:test/1';
					},
					revoke: () => {}
				}
			});
			hash = await added(target);
			const lease = target.acquireUrl(hash);
			expect(lease.url).toBe('blob:test/1');
			expect(await bytesOf(target.blob(hash))).toEqual([...png(3, 2)]);
			lease.release();
			expect(target.has(hash)).toBe(call === 'dispose' ? false : true);
		}
	);

	it('a create that disposes and then throws leaves nothing held', async () => {
		let hash = '';
		const target: ImageStore = store({
			objectUrls: {
				create: () => {
					target.dispose();
					throw new Error('no URL');
				},
				revoke: () => {}
			}
		});
		hash = await added(target);
		expect(() => target.acquireUrl(hash)).toThrow('no URL');
		expect(target.has(hash)).toBe(false);
	});

	it('the store is settled before revoke runs (revoke may call back in)', async () => {
		let hash = '';
		const seen: unknown[] = [];
		const target: ImageStore = store({
			objectUrls: {
				create: () => 'blob:test/1',
				revoke: () => {
					seen.push(target.delete(hash));
				}
			}
		});
		hash = await added(target);
		target.acquireUrl(hash).release();
		expect(seen).toEqual([true]);
		expect(target.has(hash)).toBe(false);
	});

	it('acquireUrl of an unknown hash throws unknown-asset; after dispose store-disposed', async () => {
		const target = store();
		const hash = await added(target);
		expect(caught(() => target.acquireUrl('nope')).code).toBe('unknown-asset');
		const release = target.pin([hash]);
		target.dispose();
		expect(caught(() => target.acquireUrl(hash)).code).toBe('store-disposed');
		release();
	});
});

describe('ImageStore pin / collect / delete', () => {
	it('collect drops what is not retained, not pinned and has no URL lease', async () => {
		const target = store();
		const a = await added(target, 3, 2);
		const b = await added(target, 4, 4);
		const c = await added(target, 5, 5);
		const d = await added(target, 6, 6);
		const release = target.pin([b]);
		const lease = target.acquireUrl(c);
		expect(target.collect([a])).toBe(1);
		expect([a, b, c, d].map((h) => target.has(h))).toEqual([true, true, true, false]);
		release();
		lease.release();
		expect(target.collect(new Set([a]))).toBe(2);
		expect(target.count).toBe(1);
		expect(target.totalBytes).toBe(target.metadata(a).byteLength);
	});

	it('delete refuses a pinned or leased original and answers false for an unknown one', async () => {
		const target = store();
		const a = await added(target, 3, 2);
		const release = target.pin([a]);
		expect(target.delete(a)).toBe(false);
		release();
		const lease = target.acquireUrl(a);
		expect(target.delete(a)).toBe(false);
		lease.release();
		expect(target.delete(a)).toBe(true);
		expect(target.delete(a)).toBe(false);
	});

	it('counts pins: one release keeps the other pin; a second call of a release does nothing', async () => {
		const target = store();
		const a = await added(target);
		const first = target.pin([a]);
		const second = target.pin([a]);
		first();
		first();
		expect(target.collect([])).toBe(0);
		second();
		expect(target.collect([])).toBe(1);
	});

	it('pins a hash given twice once', async () => {
		const target = store();
		const a = await added(target);
		target.pin([a, a])();
		expect(target.collect([])).toBe(1);
	});

	it('checks every hash before pinning any', async () => {
		const target = store();
		const a = await added(target);
		expect(caught(() => target.pin([a, 'nope']))).toEqual({
			code: 'unknown-asset',
			detail: { hash: 'nope' }
		});
		// eslint-disable-next-line no-sparse-arrays
		const sparse = [a, , a] as string[];
		expect(caught(() => target.pin(sparse)).code).toBe('unknown-asset');
		expect(target.collect([])).toBe(1);
	});

	it('pin of nothing returns a release that does nothing', () => {
		const target = store();
		expect(() => target.pin([])()).not.toThrow();
	});
});

describe('ImageStore dispose', () => {
	it('drops what nothing holds; a pinned original stays readable until its last release', async () => {
		const target = store();
		const a = await added(target, 3, 2);
		const b = await added(target, 4, 4);
		const release = target.pin([b]);
		target.dispose();
		expect(target.disposed).toBe(true);
		expect(target.has(a)).toBe(false);
		expect(target.has(b)).toBe(true);
		expect(await bytesOf(target.blob(b))).toEqual([...png(4, 4)]);
		expect(target.totalBytes).toBe(target.metadata(b).byteLength);
		release();
		expect(target.has(b)).toBe(false);
		expect(target.count).toBe(0);
		expect(target.totalBytes).toBe(0);
	});

	it('a URL lease open across dispose keeps its original; the last release revokes and drops it', async () => {
		const u = urls();
		const target = store({ objectUrls: u.objectUrls });
		const a = await added(target);
		const lease = target.acquireUrl(a);
		const release = target.pin([a]);
		target.dispose();
		lease.release();
		expect(u.revoked).toEqual([lease.url]);
		expect(target.has(a)).toBe(true);
		release();
		expect(target.has(a)).toBe(false);
	});

	it('pin, acquireUrl and importFrom after dispose throw store-disposed; collect, delete, cancel and dispose do nothing', async () => {
		const source = store();
		const a = await added(source);
		const target = store();
		target.dispose();
		expect(caught(() => target.pin([a])).code).toBe('store-disposed');
		expect(caught(() => target.importFrom(source, a)).code).toBe('store-disposed');
		expect(target.collect([])).toBe(0);
		expect(target.delete(a)).toBe(false);
		expect(() => target.cancel('k')).not.toThrow();
		expect(() => target.dispose()).not.toThrow();
		expect(target.busy('k')).toBe(false);
	});
});

describe('ImageStore importFrom', () => {
	it('shares the same immutable Blob and metadata, de-duplicated', async () => {
		const source = store();
		const target = store();
		const a = await added(source);
		const meta = target.importFrom(source, a);
		expect(meta).toBe(source.metadata(a));
		expect(target.blob(a)).toBe(source.blob(a));
		expect(target.importFrom(source, a)).toBe(meta);
		expect(target.importFrom(target, a)).toBe(meta);
		expect(target.count).toBe(1);
	});

	it('keeps the copy when the source drops or disposes', async () => {
		const source = store();
		const target = store();
		const a = await added(source);
		target.importFrom(source, a);
		source.dispose();
		expect(target.has(a)).toBe(true);
	});

	it('reads a pinned original of a disposed source', async () => {
		const source = store();
		const a = await added(source);
		const release = source.pin([a]);
		source.dispose();
		const target = store();
		expect(target.importFrom(source, a).sha256).toBe(a);
		release();
	});

	it('throws unknown-asset, store-full, and a TypeError for something that is not a store', async () => {
		const source = store();
		const a = await added(source);
		const target = store({ maxTotalBytes: 1 });
		expect(caught(() => target.importFrom(source, 'nope'))).toEqual({
			code: 'unknown-asset',
			detail: { hash: 'nope' }
		});
		expect(caught(() => target.importFrom(source, a)).code).toBe('store-full');
		expect(target.count).toBe(0);
		expect(() => target.importFrom({} as ImageStore, a)).toThrow(TypeError);
	});
});

describe('ImageStore errors', () => {
	it('every store failure is an ImageAssetError', async () => {
		const target = store();
		const errors: unknown[] = [];
		for (const fn of [
			() => target.metadata('x'),
			() => target.pin(['x']),
			() => target.acquireUrl('x')
		])
			try {
				fn();
			} catch (e) {
				errors.push(e);
			}
		expect(errors).toHaveLength(3);
		for (const e of errors) expect(e).toBeInstanceOf(ImageAssetError);
	});
});
