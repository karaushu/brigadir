import { expect, it } from 'vitest';
import { planBlocks, planChangeView, planChanges, planWords } from './plan-diff';

const rev1 = `# Upgrade to Expo 57

The app is on Expo 55.

## Steps

1. Update \`expo\` and \`expo-router\`
2. Bump React to 19
3. Run the checkout e2e test

## Verification

- \`pnpm typecheck\`
- Checkout e2e on iOS and Android
`;
const rev2 = `# Upgrade to Expo 57

The app is on Expo 55.

## Steps

1. Update \`expo\` to 57.0.3 and \`expo-router\` to 5.1
2. Bump React to 19
3. Run the checkout e2e test on iOS

## Rollback

- Revert the PR

## Verification

- \`pnpm typecheck\`
- Checkout e2e on iOS
`;

it('splits a plan into blocks: headings, items with their depth, whole tables and code blocks', () => {
	const blocks = planBlocks(
		'# T\n\nText\nmore\n\n- a\n  - b\n    still b\n\n| x |\n| - |\n| 1 |\n\n```ts\nconst a = 1;\n\n```\n> quote'
	);
	expect(blocks.map((b) => [b.kind, b.depth, b.lines])).toEqual([
		['heading', 0, 1],
		['paragraph', 0, 2],
		['item', 0, 1],
		['item', 1, 2],
		['table', 0, 3],
		['code', 0, 4],
		['quote', 0, 1],
	]);
	expect(blocks[3]!.text).toBe('- b\n  still b');
});

it('marks changed, added and removed blocks (spec/chat-turns-plans-and-questions#plan-revisions)', () => {
	const changes = planChanges(rev1, rev2).map((c) => [c.change, c.block.text]);
	expect(changes).toContainEqual([
		'changed',
		'1. Update `expo` to 57.0.3 and `expo-router` to 5.1',
	]);
	expect(changes).toContainEqual(['added', '## Rollback']);
	expect(changes).toContainEqual(['changed', '- Checkout e2e on iOS']);
	expect(changes.filter(([c]) => c === 'removed')).toEqual([]);
});

it('keeps a code span whole in the word diff', () => {
	expect(planWords('Use `a b`', 'Use `a c` now')).toEqual([
		{ text: 'Use ', change: 'same' },
		{ text: '`a b`', change: 'removed' },
		{ text: '`a c` now', change: 'added' },
	]);
});

it('shows a rewritten block as removed, then added', () => {
	const changes = planChanges(
		'# T\n\nClient notes and client card',
		'# T\n\nThree tasks instead of one'
	);
	expect(changes.map((c) => c.change)).toEqual(['same', 'removed', 'added']);
});

it('folds unchanged sections and counts lines', () => {
	const view = planChangeView(rev1, rev2);
	expect(view.parts[0]).toMatchObject({
		kind: 'block',
		item: { change: 'same', block: { kind: 'heading' } },
	});
	expect(view.parts[1]).toMatchObject({ kind: 'fold', names: [null], lines: 1 });
	expect(view).toMatchObject({ additions: 5, deletions: 3, sections: 3, rewritten: false });
});

it('folds a long unchanged run inside a changed section', () => {
	const before = [
		'# T',
		'',
		'## S',
		'',
		...Array.from({ length: 8 }, (_, i) => `${i + 1}. Step ${i + 1}`),
	].join('\n');
	const after = before.replace('8. Step 8', '8. Step eight');
	const view = planChangeView(before, after);
	expect(view.parts.map((p) => (p.kind === 'fold' ? `fold ${p.lines}` : p.item.change))).toEqual([
		'same',
		'same',
		'fold 6',
		'same',
		'changed',
	]);
});

it('calls a plan rewritten when more than half of the lines changed', () => {
	expect(planChangeView('# A\n\n- one\n- two', '# B\n\n- three\n- four').rewritten).toBe(true);
	expect(planChangeView(rev1, rev1)).toMatchObject({ additions: 0, deletions: 0, sections: 0 });
});
