import { describe, expect, it } from 'vitest';
import {
	addBasket,
	applyProposal,
	basketLabels,
	basketOf,
	commitPlan,
	dropCommitted,
	fileKey,
	initialBaskets,
	takeOut,
	moveFiles,
	reconcileBaskets,
	removeBasket,
	type BasketScope,
	type CommitBasket,
} from './commit-baskets';
import { isCommitBasketPlans } from './commits';
const A = 'aaaaaaaaaaaaaaaa',
	B = 'bbbbbbbbbbbbbbbb';
const ids = () => {
	let n = 0;
	return () => `id-${++n}`;
};
const scopes: BasketScope[] = [
	{ id: A, name: 'kit', files: ['k1.ts', 'k2.ts'] },
	{ id: B, name: 'business', files: ['a.ts', 'b.json', 'c.json'] },
];
describe('commit baskets (spec/git#commit-dialog)', () => {
	it('opens with one basket per repo; the first takes the strip message', () => {
		const baskets = initialBaskets(scopes, 'Task title', ids());
		expect(baskets).toEqual([
			{ id: 'id-1', scopeId: A, message: 'Task title', files: ['k1.ts', 'k2.ts'] },
			{ id: 'id-2', scopeId: B, message: '', files: ['a.ts', 'b.json', 'c.json'] },
		]);
		expect([...basketLabels(baskets).values()]).toEqual(['C1', 'C2']);
		expect(basketOf(baskets, B, 'b.json')?.id).toBe('id-2');
	});
	it('moves files within a repo, refuses another repo and makes a new basket after the repo’s last', () => {
		const next = ids();
		let baskets = initialBaskets(scopes, 'm', next);
		const moved = moveFiles(
			baskets,
			[
				{ scopeId: B, path: 'b.json' },
				{ scopeId: B, path: 'c.json' },
				{ scopeId: A, path: 'k1.ts' },
			],
			{ newIn: B },
			next
		);
		expect(moved).toMatchObject({ moved: 2, refused: 1, target: 'id-3' });
		baskets = moved.baskets;
		expect(baskets.map((basket) => [basket.id, basket.files])).toEqual([
			['id-1', ['k1.ts', 'k2.ts']],
			['id-2', ['a.ts']],
			['id-3', ['b.json', 'c.json']],
		]);
		// Back into C2: the order of C2's files is kept, then the moved ones.
		baskets = moveFiles(baskets, [{ scopeId: B, path: 'c.json' }], 'id-2', next).baskets;
		expect(baskets[1]!.files).toEqual(['a.ts', 'c.json']);
		expect(baskets[2]!.files).toEqual(['b.json']);
		// A file of kit cannot go into business.
		const refused = moveFiles(baskets, [{ scopeId: A, path: 'k2.ts' }], 'id-2', next);
		expect(refused).toMatchObject({ moved: 0, refused: 1 });
		expect(refused.baskets).toBe(baskets);
	});
	it('keeps an empty basket out of the plan, removes only an empty one and asks for missing messages', () => {
		const next = ids();
		let baskets = addBasket(initialBaskets(scopes, 'm', next), A, next);
		expect(baskets.map((basket) => basket.id)).toEqual(['id-1', 'id-3', 'id-2']);
		const plan = commitPlan(baskets);
		expect(plan.plan.map((basket) => basket.id)).toEqual(['id-1', 'id-2']);
		expect(plan.skipped.map((basket) => basket.id)).toEqual(['id-3']);
		expect(plan.missing.map((basket) => basket.id)).toEqual(['id-2']);
		expect(removeBasket(baskets, 'id-1')).toBe(baskets);
		baskets = removeBasket(baskets, 'id-3');
		expect(baskets.map((basket) => basket.id)).toEqual(['id-1', 'id-2']);
	});
	it('reconciles with a new preview: gone files leave, new ones join the repo’s first basket, gone repos go', () => {
		const next = ids();
		const baskets: CommitBasket[] = [
			{ id: 'x', scopeId: B, message: 'one', files: ['a.ts'] },
			{ id: 'y', scopeId: B, message: 'two', files: ['b.json', 'c.json'] },
			{ id: 'z', scopeId: A, message: 'kit', files: ['k1.ts'] },
		];
		const result = reconcileBaskets(
			baskets,
			[
				{ id: A, name: 'kit', files: [] },
				{ id: B, name: 'business', files: ['b.json', 'd.ts', 'a.ts'] },
			],
			next
		);
		expect(result).toEqual([
			{ id: 'x', scopeId: B, message: 'one', files: ['a.ts', 'd.ts'] },
			{ id: 'y', scopeId: B, message: 'two', files: ['b.json'] },
		]);
		expect(
			reconcileBaskets(result, [{ id: B, name: 'b', files: ['a.ts', 'd.ts', 'b.json'] }])
		).toBe(result);
		// A repo whose baskets all went gets a fresh one.
		expect(reconcileBaskets([], scopes, next).map((basket) => basket.files)).toEqual([
			['k1.ts', 'k2.ts'],
			['a.ts', 'b.json', 'c.json'],
		]);
		expect(dropCommitted(result, new Set(['x'])).map((basket) => basket.id)).toEqual(['y']);
	});
	it('applies the agent’s proposal per repo: unknown and repeated paths ignored, leftovers to its last basket', () => {
		const next = ids();
		const mine = initialBaskets(scopes, 'm', next);
		const result = applyProposal(
			mine,
			scopes,
			[
				{ scopeId: B, message: ' Add a ', reason: 'API', files: ['a.ts', 'nope.ts', 'k1.ts'] },
				{ scopeId: B, message: 'Labels', reason: '', files: ['b.json', 'a.ts'] },
				{ scopeId: 'cccccccccccccccc', message: 'x', reason: '', files: ['a.ts'] },
			],
			next
		);
		expect(result).toEqual([
			mine[0],
			{ id: 'id-3', scopeId: B, message: 'Add a', reason: 'API', files: ['a.ts'] },
			{ id: 'id-4', scopeId: B, message: 'Labels', files: ['b.json', 'c.json'] },
		]);
		expect(applyProposal(mine, scopes, [], next)).toBe(mine);
		// Moving a file drops the agent's reason of both baskets.
		const moved = moveFiles(result, [{ scopeId: B, path: 'c.json' }], 'id-3').baskets;
		expect(moved[1]!.reason).toBeUndefined();
	});
	it('takes a file out of every basket and keeps it out on the next preview until moved back', () => {
		const next = ids();
		let baskets = takeOut(initialBaskets(scopes, 'm', next), [{ scopeId: B, path: 'b.json' }]);
		expect(baskets[1]!.files).toEqual(['a.ts', 'c.json']);
		const aside = new Set([fileKey(B, 'b.json')]);
		expect(reconcileBaskets(baskets, scopes, next, aside)).toBe(baskets);
		expect(reconcileBaskets(baskets, scopes, next)[1]!.files).toEqual(['a.ts', 'c.json', 'b.json']);
		baskets = moveFiles(baskets, [{ scopeId: B, path: 'b.json' }], baskets[1]!.id).baskets;
		expect(baskets[1]!.files).toEqual(['a.ts', 'c.json', 'b.json']);
	});
	it('validates the plan main receives', () => {
		const plan = [{ id: 'b1-1', scopeId: A, message: 'Msg', files: ['a.ts'] }];
		expect(isCommitBasketPlans(plan)).toBe(true);
		expect(isCommitBasketPlans([{ ...plan[0], message: ' ' }])).toBe(false);
		expect(isCommitBasketPlans([{ ...plan[0], files: ['../x'] }])).toBe(false);
		expect(isCommitBasketPlans([{ ...plan[0], files: [] }])).toBe(false);
		expect(isCommitBasketPlans([plan[0], plan[0]])).toBe(false);
		expect(isCommitBasketPlans([])).toBe(false);
	});
});
