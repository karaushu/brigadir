/**
 * spec/remote-access-and-mobile#transport-and-protocol: CPace, cipher suite CPACE-RISTR255-SHA512, initiator-responder setting, exactly as
 * draft-irtf-cfrg-cpace-21 writes it (spec/diff-and-review#review-comments lv_cat, spec/chat#row-engine ISK, spec/editor#editor-principles generator_string, spec/editor#editor-principles ristretto255), on the group,
 * hash-to-group and hash of `@noble/curves` and `@noble/hashes`. Explicit key confirmation follows the draft's spec/agents-and-providers#auth.
 * The draft's test vectors (appendix B.3) are in `cpace.test.ts`.
 *
 * spec/remote-access-and-mobile#phone-network: the same module runs in a phone's browser (`@brigadir/remote/web`), so nothing here is Node's: the
 * randomness is `crypto.getRandomValues` through `@noble/hashes`, the tags are compared without an early exit.
 */
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { randomBytes } from '@noble/hashes/utils.js';

type Point = InstanceType<typeof ristretto255.Point>;
const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
const DSI = bytes('CPaceRistretto255');
const DSI_ISK = bytes('CPaceRistretto255_ISK');
/** SHA-512's input block (H.s_in_bytes). */
const sInBytes = 128;
const order = ristretto255.Point.Fn.ORDER;

/** LEB128, the length prefix of spec/diff-and-review#review-comments. */
export function leb128(n: number): Uint8Array {
	const out: number[] = [];
	do {
		let byte = n & 0x7f;
		n >>>= 7;
		if (n) byte |= 0x80;
		out.push(byte);
	} while (n);
	return Uint8Array.from(out);
}
function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}
export const prependLen = (data: Uint8Array) => concat(leb128(data.length), data);
export const lvCat = (...parts: Uint8Array[]) => concat(...parts.map(prependLen));

/** spec/editor#editor-principles: generator_string(DSI, PRS, CI, sid, s_in_bytes). */
export function generatorString(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
	const zpad = Math.max(0, sInBytes - prependLen(prs).length - prependLen(DSI).length - 1);
	return lvCat(DSI, prs, new Uint8Array(zpad), ci, sid);
}
/** spec/editor#editor-principles: the generator is the one-way map of RFC 9496 over the 64-byte hash of the generator string. */
export function calculateGenerator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Point {
	return ristretto255_hasher.deriveToCurve!(sha512(generatorString(prs, ci, sid)));
}
/** Uniform between 1 and order − 1 (spec/editor#editor-principles's alternative to bit clearing); 64 bytes leave a 2^-260 bias. */
export function sampleScalar(): bigint {
	let value = 0n;
	for (const byte of randomBytes(64)) value = (value << 8n) | BigInt(byte);
	return (value % (order - 1n)) + 1n;
}
export function scalarFromLittleEndian(data: Uint8Array): bigint {
	let value = 0n;
	for (let index = data.length - 1; index >= 0; index--)
		value = (value << 8n) | BigInt(data[index]!);
	return value;
}
/** spec/chat#row-engine: Y = encode(y · g). */
export function share(generator: Point, scalar: bigint): Uint8Array {
	return generator.multiply(scalar).toBytes();
}
/** spec/editor#editor-principles scalar_mult_vfy: a peer share that does not decode, or a product that is the identity, aborts. */
export function scalarMultVfy(scalar: bigint, peer: Uint8Array): Uint8Array {
	const point = ristretto255.Point.fromBytes(peer);
	const product = point.multiply(scalar);
	if (product.equals(ristretto255.Point.ZERO)) throw new Error('CPace: identity');
	return product.toBytes();
}
/** spec/diff-and-review#review-comments transcript_ir. */
export function transcriptIr(
	ya: Uint8Array,
	adA: Uint8Array,
	yb: Uint8Array,
	adB: Uint8Array
): Uint8Array {
	return concat(lvCat(ya, adA), lvCat(yb, adB));
}
/** spec/chat#row-engine: ISK = H.hash(lv_cat(DSI_ISK, sid, K) || transcript_ir(Ya, ADa, Yb, ADb)). */
export function intermediateKey(
	sid: Uint8Array,
	k: Uint8Array,
	ya: Uint8Array,
	adA: Uint8Array,
	yb: Uint8Array,
	adB: Uint8Array
): Uint8Array {
	return sha512(concat(lvCat(DSI_ISK, sid, k), transcriptIr(ya, adA, yb, adB)));
}
/** spec/agents-and-providers#auth: mac_key = H.hash(b"CPaceMac" || sid || ISK); a party's tag is MAC(mac_key, lv_cat(its share, its AD)). */
export function confirmationTag(
	isk: Uint8Array,
	sid: Uint8Array,
	ownShare: Uint8Array,
	ownAD: Uint8Array
): Uint8Array {
	const macKey = sha512(concat(bytes('CPaceMac'), sid, isk));
	return hmac(sha512, macKey, lvCat(ownShare, ownAD));
}
/** Constant time for equal lengths (a tag's length is public): every byte is looked at, whatever differs first. */
export function sameTag(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let index = 0; index < a.length; index++) diff |= a[index]! ^ b[index]!;
	return diff === 0;
}

/** One side of a run. A (initiator) sends first; B (responder) answers; then both confirm. */
export class CPaceParty {
	readonly share: Uint8Array;
	private readonly scalar: bigint;
	private isk: Uint8Array | null = null;
	constructor(
		readonly role: 'initiator' | 'responder',
		private readonly input: { prs: Uint8Array; ci: Uint8Array; sid: Uint8Array },
		readonly ad: Uint8Array,
		scalar: bigint = sampleScalar()
	) {
		this.scalar = scalar;
		this.share = share(calculateGenerator(input.prs, input.ci, input.sid), scalar);
	}
	/** The ISK from the peer's share and AD; throws on an invalid share. */
	finish(peerShare: Uint8Array, peerAD: Uint8Array): Uint8Array {
		const k = scalarMultVfy(this.scalar, peerShare);
		this.isk =
			this.role === 'initiator'
				? intermediateKey(this.input.sid, k, this.share, this.ad, peerShare, peerAD)
				: intermediateKey(this.input.sid, k, peerShare, peerAD, this.share, this.ad);
		this.peer = { share: peerShare, ad: peerAD };
		return this.isk;
	}
	private peer: { share: Uint8Array; ad: Uint8Array } | null = null;
	/** This party's tag (spec/agents-and-providers#auth). */
	tag(): Uint8Array {
		if (!this.isk) throw new Error('CPace: not finished');
		return confirmationTag(this.isk, this.input.sid, this.share, this.ad);
	}
	/** Checks the peer's tag in constant time. */
	verify(peerTag: Uint8Array): boolean {
		if (!this.isk || !this.peer) return false;
		return sameTag(
			confirmationTag(this.isk, this.input.sid, this.peer.share, this.peer.ad),
			peerTag
		);
	}
}
