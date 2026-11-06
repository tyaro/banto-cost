import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../src/index';
import { sha256HexFallback } from '../src/sha256';

const ascii = (s: string) => new TextEncoder().encode(s);

// FIPS 180-4 examples (NIST CSRC "Example Values", SHA-256) and the classic extra vectors.
const VECTORS: [string, Uint8Array, string][] = [
	['empty', new Uint8Array(0), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
	['"abc"', ascii('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
	[
		'448 bits',
		ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
		'248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
	],
	[
		'896 bits',
		ascii(
			'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'
		),
		'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'
	],
	[
		'one million "a"',
		new Uint8Array(1_000_000).fill(0x61),
		'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'
	]
];

async function webcrypto(data: Uint8Array): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('sha256HexFallback (pure TS)', () => {
	for (const [name, data, hex] of VECTORS)
		it(`matches the NIST vector: ${name}`, () => {
			expect(sha256HexFallback(data)).toBe(hex);
		});

	it('matches WebCrypto on every length around the padding boundaries', async () => {
		let seed = 12345;
		const data = new Uint8Array(300);
		for (let i = 0; i < data.length; i++) {
			seed = (seed * 1103515245 + 12345) >>> 0;
			data[i] = seed >>> 24;
		}
		for (let n = 0; n <= data.length; n++) {
			const slice = data.subarray(0, n);
			expect(sha256HexFallback(slice), `length ${n}`).toBe(await webcrypto(slice));
		}
	});

	it('hashes a sub-view, not the whole buffer', async () => {
		const buffer = ascii('xxabcxx');
		expect(sha256HexFallback(buffer.subarray(2, 5))).toBe(VECTORS[1][2]);
	});
});

describe('sha256Hex', () => {
	it('uses crypto.subtle when it exists', async () => {
		const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');
		expect(await sha256Hex(ascii('abc'))).toBe(VECTORS[1][2]);
		expect(digest).toHaveBeenCalledTimes(1);
		digest.mockRestore();
	});

	it('falls back to the pure TS hash without crypto.subtle (plain HTTP), same value', async () => {
		const data = new Uint8Array(70_000).map((_, i) => (i * 31) & 0xff);
		const expected = await webcrypto(data);
		vi.stubGlobal('crypto', {});
		expect(await sha256Hex(data)).toBe(expected);
		vi.stubGlobal('crypto', undefined);
		expect(await sha256Hex(data.slice().buffer)).toBe(expected);
	});

	it('falls back when subtle.digest rejects', async () => {
		vi.stubGlobal('crypto', { subtle: { digest: () => Promise.reject(new Error('denied')) } });
		expect(await sha256Hex(ascii(''))).toBe(VECTORS[0][2]);
	});

	it('rejects a non-byte input with a TypeError', async () => {
		await expect(sha256Hex('abc' as unknown as Uint8Array)).rejects.toThrow(TypeError);
	});
});
