import { expect, it } from 'vitest';
import { planChanges } from '@brigadir/diff';
import { planBlockHtml } from './PlanChanges';

it('marks changed words inside the rendered Markdown (spec/chat-turns-plans-and-questions#plan-revisions)', () => {
	const [, changed] = planChanges(
		'# T\n\n1. Update `expo` and `router`',
		'# T\n\n1. Update `expo` to 57 and `router`'
	);
	const html = planBlockHtml(changed!);
	expect(html).toContain('data-change="changed"');
	expect(html).toContain('<code>expo</code> <ins>to 57</ins> and');
	expect(html).not.toMatch(/[-]/);
});

it('keeps a removed block whole and a nested item indented', () => {
	const changes = planChanges('# T\n\n- a\n  - nested old', '# T\n\n- a');
	const removed = changes.find((change) => change.change === 'removed')!;
	expect(planBlockHtml(removed)).toMatch(
		/data-change="removed".*padding-left: 20px.*<li>nested old<\/li>/s
	);
});
