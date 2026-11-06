/**
 * SHA-256 as a lowercase hex string (ADR-0020 §4, shared-primitives-upstream-plan D11).
 *
 * `crypto.subtle` exists only in a secure context (HTTPS or localhost), and banto's LAN
 * serving is plain HTTP (ADR-0003), so the hash falls back to a pure TS SHA-256 when it is
 * missing. Both give the same value, so de-duplication does not depend on how the app is
 * served. The hash is a de-duplication key only, not an integrity or authentication check
 * (ADR-0020 "帰結"). Written here instead of adding a dependency (conventions §3); tested
 * against the NIST examples and against node's WebCrypto.
 */

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/** Processes the 64-byte blocks of `data` from `start`, `blocks` of them, into `h`. */
function compress(h: Uint32Array, w: Uint32Array, data: Uint8Array, start: number, blocks: number) {
	let h0 = h[0],
		h1 = h[1],
		h2 = h[2],
		h3 = h[3],
		h4 = h[4],
		h5 = h[5],
		h6 = h[6],
		h7 = h[7];
	for (let b = 0, p = start; b < blocks; b++, p += 64) {
		for (let i = 0; i < 16; i++) {
			const j = p + i * 4;
			w[i] = (data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3];
		}
		for (let i = 16; i < 64; i++) {
			const x = w[i - 15];
			const y = w[i - 2];
			const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
			const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
			w[i] = w[i - 16] + s0 + w[i - 7] + s1;
		}
		let a = h0,
			bb = h1,
			c = h2,
			d = h3,
			e = h4,
			f = h5,
			g = h6,
			hh = h7;
		for (let i = 0; i < 64; i++) {
			const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
			const ch = (e & f) ^ (~e & g);
			const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
			const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
			const maj = (a & bb) ^ (a & c) ^ (bb & c);
			const t2 = (S0 + maj) | 0;
			hh = g;
			g = f;
			f = e;
			e = (d + t1) | 0;
			d = c;
			c = bb;
			bb = a;
			a = (t1 + t2) | 0;
		}
		h0 = (h0 + a) | 0;
		h1 = (h1 + bb) | 0;
		h2 = (h2 + c) | 0;
		h3 = (h3 + d) | 0;
		h4 = (h4 + e) | 0;
		h5 = (h5 + f) | 0;
		h6 = (h6 + g) | 0;
		h7 = (h7 + hh) | 0;
	}
	h[0] = h0;
	h[1] = h1;
	h[2] = h2;
	h[3] = h3;
	h[4] = h4;
	h[5] = h5;
	h[6] = h6;
	h[7] = h7;
}

function toHex(words: Uint32Array | Uint8Array, bytesPerItem: 1 | 4): string {
	let out = '';
	for (let i = 0; i < words.length; i++)
		out += (words[i] >>> 0).toString(16).padStart(bytesPerItem * 2, '0');
	return out;
}

/**
 * The pure TS SHA-256 (FIPS 180-4). Synchronous; reads `data` in place and copies only the
 * last partial block. Exported for the tests; the public entry is `sha256Hex`.
 */
export function sha256HexFallback(data: Uint8Array): string {
	const h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
	]);
	const w = new Uint32Array(64);
	const full = Math.floor(data.length / 64);
	compress(h, w, data, 0, full);

	// Padding: 0x80, zeros, then the bit length as a 64-bit big-endian integer.
	const rest = data.length - full * 64;
	const tail = new Uint8Array(rest < 56 ? 64 : 128);
	tail.set(data.subarray(full * 64));
	tail[rest] = 0x80;
	const bits = data.length * 8;
	const high = Math.floor(bits / 0x100000000);
	const low = bits >>> 0;
	const end = tail.length;
	tail[end - 8] = high >>> 24;
	tail[end - 7] = high >>> 16;
	tail[end - 6] = high >>> 8;
	tail[end - 5] = high;
	tail[end - 4] = low >>> 24;
	tail[end - 3] = low >>> 16;
	tail[end - 2] = low >>> 8;
	tail[end - 1] = low;
	compress(h, w, tail, 0, end / 64);
	return toHex(h, 4);
}

/**
 * SHA-256 of the bytes as 64 lowercase hex digits (ADR-0020 §4, D11). Uses
 * `globalThis.crypto.subtle` when it exists (secure context) and the pure TS SHA-256
 * otherwise (plain HTTP on the LAN, ADR-0003), also when `subtle.digest` rejects. Both give
 * the same value.
 */
export async function sha256Hex(input: Uint8Array | ArrayBuffer): Promise<string> {
	const data = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
	if (!(data instanceof Uint8Array))
		throw new TypeError('sha256Hex input must be a Uint8Array or an ArrayBuffer');
	const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
	if (subtle !== undefined && typeof subtle.digest === 'function') {
		try {
			const digest = await subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>);
			return toHex(new Uint8Array(digest), 1);
		} catch {
			// Fall through to the pure TS hash: same value.
		}
	}
	return sha256HexFallback(data);
}
