import { describe, expect, it } from 'vitest';
import {
	CPaceParty,
	calculateGenerator,
	generatorString,
	intermediateKey,
	scalarFromLittleEndian,
	scalarMultVfy,
	share,
	transcriptIr,
} from './cpace';
import { ristretto255 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';

const hex = (text: string) => Uint8Array.from(Buffer.from(text.replace(/\s+/g, ''), 'hex'));
const toHex = (data: Uint8Array) => Buffer.from(data).toString('hex');
const ascii = (text: string) => new TextEncoder().encode(text);
// draft-irtf-cfrg-cpace-21, appendix B.3: CPACE-RISTR255-SHA512.
const PRS = ascii('Password');
const CI = hex('0b415f696e69746961746f720b425f726573706f6e646572');
const sid = hex('7e4b4791d6a8ef019b936c79fb7f2c57');
const ADa = ascii('ADa');
const ADb = ascii('ADb');
const ya = scalarFromLittleEndian(
	hex('da3d23700a9e5699258aef94dc060dfda5ebb61f02a5ea77fad53f4ff0976d08')
);
const yb = scalarFromLittleEndian(
	hex('d2316b454718c35362d83d69df6320f38578ed5984651435e2949762d900b80d')
);
describe('CPace draft vectors (B.3)', () => {
	it('builds the generator string, its hash and the generator', () => {
		const text = generatorString(PRS, CI, sid);
		expect(text.length).toBe(170);
		expect(toHex(text)).toBe(
			'11435061636552697374726574746f3235350850617373776f726464' +
				'00'.repeat(100) +
				'180b415f696e69746961746f720b425f726573706f6e646572107e4b4791d6a8ef019b936c79fb7f2c57'
		);
		expect(toHex(sha512(text))).toBe(
			'da6d3ddc8802fca9058755ffd3ebde08a9c2c74945901a258482a288b6663af06bf645c93cd1c51512307199c80e84908916d983b34af77205f90851a657ee27'
		);
		expect(toHex(calculateGenerator(PRS, CI, sid).toBytes())).toBe(
			'222b6b195fe84b1652badb6f6a3ae3d24341e7306967f0b8115b40d5698c7e56'
		);
	});
	it('computes both shares, K and the initiator-responder ISK', () => {
		const g = calculateGenerator(PRS, CI, sid);
		const Ya = share(g, ya),
			Yb = share(g, yb);
		expect(toHex(Ya)).toBe('d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b9157');
		expect(toHex(Yb)).toBe('3ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f7258');
		const K = scalarMultVfy(ya, Yb);
		expect(toHex(K)).toBe('80b69a8a76457ab6a4d7f887a4bf6b55a2f80ac19c333f917a05fc9887c8b40f');
		expect(toHex(scalarMultVfy(yb, Ya))).toBe(toHex(K));
		expect(toHex(transcriptIr(Ya, ADa, Yb, ADb))).toBe(
			'20d6bac480f2c386c394efc7c47adb9925dcd2630b64f240c50f8d0eec482b915703414461203ea7e0b19560d7c0b0f5734f63b955286dfa8232b5ebe63324e2d9e7433f725803414462'
		);
		const isk =
			'b69effbf61b51d56401c0f65601abe428de8206feaaf0e32198896dcae7b35cd2b38950a39dfd5d4a79164614c2984f7daa460b588c1e80c3fa2068af7900447';
		expect(toHex(intermediateKey(sid, K, Ya, ADa, Yb, ADb))).toBe(isk);
		const a = new CPaceParty('initiator', { prs: PRS, ci: CI, sid }, ADa, ya);
		const b = new CPaceParty('responder', { prs: PRS, ci: CI, sid }, ADb, yb);
		expect(toHex(a.finish(b.share, ADb))).toBe(isk);
		expect(toHex(b.finish(a.share, ADa))).toBe(isk);
	});
	it('aborts on the identity and on a share that does not decode', () => {
		expect(() => scalarMultVfy(ya, ristretto255.Point.ZERO.toBytes())).toThrow();
		expect(() => scalarMultVfy(ya, new Uint8Array(32).fill(0xff))).toThrow();
	});
});
describe('CPace key confirmation', () => {
	const run = (codeA: string, codeB: string, ci = ascii('ci')) => {
		const sid = Uint8Array.from({ length: 16 }, (_, index) => index);
		const a = new CPaceParty('initiator', { prs: ascii(codeA), ci, sid }, ascii('laptop'));
		const b = new CPaceParty('responder', { prs: ascii(codeB), ci, sid }, ascii('studio'));
		b.finish(a.share, a.ad);
		a.finish(b.share, b.ad);
		return { a, b };
	};
	it('confirms both ways with the same code', () => {
		const { a, b } = run('5YCPYZKR', '5YCPYZKR');
		expect(a.verify(b.tag())).toBe(true);
		expect(b.verify(a.tag())).toBe(true);
		// A tag is bound to its sender: B's tag is not A's.
		expect(a.verify(a.tag())).toBe(false);
	});
	it('fails with one character off', () => {
		const { a, b } = run('5YCPYZKR', '5YCPYZKS');
		expect(a.verify(b.tag())).toBe(false);
		expect(b.verify(a.tag())).toBe(false);
	});
	it('fails when the channel identifier differs (another TLS certificate in the middle)', () => {
		const sid = new Uint8Array(16);
		const a = new CPaceParty(
			'initiator',
			{ prs: ascii('CODE1234'), ci: ascii('one'), sid },
			ascii('a')
		);
		const b = new CPaceParty(
			'responder',
			{ prs: ascii('CODE1234'), ci: ascii('two'), sid },
			ascii('b')
		);
		b.finish(a.share, a.ad);
		a.finish(b.share, b.ad);
		expect(b.verify(a.tag())).toBe(false);
	});
});
