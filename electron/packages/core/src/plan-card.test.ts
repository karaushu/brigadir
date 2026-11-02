import { expect, it } from 'vitest';
import { builtinCrewTemplates, resolveCrew, templateLookup, builtinAgentTemplates } from './crew';
import { planDifferences, planDifferenceText, type CrewPlanPart } from './crew-runtime';
import { planPartCountLabel, planSplitLabel } from './messages';
import { planSummary } from './activity';
/** spec/chat-turns-plans-and-questions#crew-plan-card: differences in the interface language from their fields; four uk forms; plan row segments. */
const spec = resolveCrew(builtinCrewTemplates[0]!, {
	lookup: templateLookup(builtinAgentTemplates),
	defaultProvider: 'claude',
	now: '2026-09-28T10:00:00.000Z',
});
spec.root.agents[1]!.zone = ['kit/src/hooks/**'];
const part = (id: string, agent: string, files: string[] = []): CrewPlanPart => ({
	id,
	title: id,
	agent,
	prompt: 'Do it.',
	files,
	scopes: [],
});
it('says every difference in uk and en from its fields, English message stays for the agent', () => {
	const parts = [
		part('a', 'Developer 1'),
		part('b', 'Developer 1'),
		part('c', 'Developer 2', ['kit/src/theme/index.ts']),
		part('d', 'Reviewer'),
		part('e', 'Nobody'),
	];
	const d = planDifferences(spec, spec.root.id, parts),
		uk = d.map((item) => planDifferenceText('uk', item, parts)),
		en = d.map((item) => planDifferenceText('en', item, parts));
	expect(d.find((item) => item.code === 'duplicate_agent')).toMatchObject({
		partId: 'b',
		agent: 'Developer 1',
		otherPartId: 'a',
	});
	expect(uk).toContain(
		'Розробник 1 уже має частину 1. Один агент працює над однією частиною за раз.'
	);
	expect(uk).toContain('Розробник 2 володіє kit/src/hooks/**; поза зоною: kit/src/theme/index.ts.');
	expect(uk).toContain('Ревʼюер перевіряє код і не виконує частини плану.');
	expect(uk).toContain('Немає агента Nobody. Агенти бригади: Розробник 1, Розробник 2, Ревʼюер.');
	expect(en).toContain(
		'Developer 2 owns kit/src/hooks/**; outside the zone: kit/src/theme/index.ts.'
	);
	expect(d.every((item) => /^[\x20-\x7e]+$/.test(item.message))).toBe(true);
	expect(
		planDifferenceText(
			'uk',
			planDifferences(spec, spec.root.id, [part('a', 'Developer 1')]).find(
				(item) => item.code === 'idle_agent'
			)!,
			[]
		)
	).toBe('Розробник 2 без частини.');
});
it('counts parts and agents with four uk forms', () => {
	expect([1, 2, 5, 1.5].map((n) => planPartCountLabel('uk', n))).toEqual([
		'1 частина',
		'2 частини',
		'5 частин',
		'1,5 частини',
	]);
	expect(planSplitLabel('uk', 3, 3)).toBe('3 частини для 3 агентів');
	expect(planSplitLabel('uk', 1, 1)).toBe('1 частина для 1 агента');
	expect(planSplitLabel('uk', 5, 5)).toBe('5 частин для 5 агентів');
	expect(planSplitLabel('en', 1, 1)).toBe('1 part for 1 agent');
	expect(planSplitLabel('en', 3, 2)).toBe('3 parts for 2 agents');
});
it('summarises the agent plan: segments up to twelve steps, a bar above', () => {
	const entry = (status: string, text = 'x') => ({ text, priority: 'medium', status });
	expect(planSummary([entry('completed'), entry('in_progress', 'Fix'), entry('pending')])).toEqual({
		done: 1,
		total: 3,
		current: 'Fix',
		next: 'x',
		segments: true,
	});
	expect(planSummary(Array.from({ length: 12 }, () => entry('pending'))).segments).toBe(true);
	expect(planSummary(Array.from({ length: 13 }, () => entry('completed')))).toMatchObject({
		done: 13,
		current: null,
		next: null,
		segments: false,
	});
});
