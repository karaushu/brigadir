import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
	builtinCrewTemplates,
	defaultCrewTemplateId,
	resolveCrew,
	templateLookup,
	type CrewPlan,
} from '@brigadir/core';
import { PlanCard } from './Crew';
const spec = resolveCrew(
	builtinCrewTemplates.find((item) => item.id === defaultCrewTemplateId)!,
	{
		lookup: templateLookup([]),
		defaultProvider: 'claude',
		now: '2026-01-01T00:00:00.000Z',
	}
);
const plan: CrewPlan = {
	id: 'plan',
	summary: 'Two **independent** parts.',
	parts: [
		{
			id: 'a',
			title: 'CSV export',
			agent: 'Developer 1',
			prompt: 'Add ordersToCsv.',
			files: ['orders/export.ts'],
			scopes: [],
		},
		{
			id: 'b',
			title: 'Export button',
			agent: 'Developer 2',
			prompt: 'Add the button.',
			files: ['orders/OrdersTable.tsx'],
			scopes: [],
		},
	],
};
it('shows the plan without a task behind it, as the intro sample does (spec/settings-modules-and-onboarding#intro-steps)', () => {
	const html = renderToStaticMarkup(
		<PlanCard
			plan={plan}
			spec={spec}
			task={null}
			revision={0}
			locale="en"
			disabled={false}
			send={() => {}}
		/>
	);
	// The summary is the chat's markdown at rest: rendered, without the file-link pass that needs a task.
	expect(html).toContain('<p>Two <strong>independent</strong> parts.</p>');
	expect(html).toContain('data-plan-summary-text');
	// The built-in crew takes both parts: the footer reads the split, nothing blocks Start.
	expect(html).toContain('2 parts for 2 agents');
	expect(html).not.toContain('differences with the crew');
});
