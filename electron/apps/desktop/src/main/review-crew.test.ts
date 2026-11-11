import { describe, expect, it } from 'vitest';
import {
	builtinAgentTemplates,
	builtinCrewTemplates,
	reviewCrewTemplateId,
	type CrewLibrary,
} from '@brigadir/core';
import { resolveReviewCrew, reviewCrewPrompt, reviewGuidance } from './review-crew';

const library: CrewLibrary = {
	agents: [...builtinAgentTemplates],
	crews: [...builtinCrewTemplates],
	issues: [],
	hiddenCrews: [],
};
const pr = { number: 7, title: 'Fix the cart', head: 'fix-cart', base: 'main' };

describe('a PR review by a crew (spec/pull-requests-and-ci#review-crew)', () => {
	it('resolves the built-in Review crew: the foreman leads Astra (Codex) and Opus (Claude)', () => {
		const crew = resolveReviewCrew(library, reviewCrewTemplateId, 'claude');
		expect(crew.templateId).toBe('review');
		expect(crew.root.role).toBe('foreman');
		expect(crew.root.agents.map((agent) => [agent.name, agent.role, agent.provider])).toEqual([
			['Astra', 'reviewer', 'codex'],
			['Opus', 'reviewer', 'claude'],
		]);
		expect(crew.root.agents[0]!.requestedChoices.configOptions).toMatchObject({
			model: 'gpt-6-astra',
		});
	});
	it('refuses a crew the library does not have and a foreman without agents', () => {
		expect(() => resolveReviewCrew(library, 'gone', 'claude')).toThrow('unavailable');
		const lonely: CrewLibrary = {
			...library,
			crews: [
				{
					schemaVersion: 1,
					id: 'alone',
					name: 'Alone',
					builtin: false,
					root: { id: 'root', name: 'Foreman', template: 'foreman-default' },
				},
			],
		};
		expect(() => resolveReviewCrew(lonely, 'alone', 'claude')).toThrow('no reviewers');
	});
	it('asks the foreman for one task per reviewer, findings by line and one merged draft each', () => {
		const crew = resolveReviewCrew(library, reviewCrewTemplateId, 'claude');
		const quick = reviewCrewPrompt({ pr, quick: true, repo: '.', mergeBase: 'abc123', crew });
		expect(quick).toContain('`Astra`, `Opus`');
		expect(quick).toContain('Do not call propose_plan');
		expect(quick).toContain('create_worker_task');
		expect(quick).toContain('git -C . diff abc123 refs/brigadir-v2/pr/7');
		expect(quick).toContain('`path:line — finding`');
		expect(quick).toContain('read_report');
		expect(quick).toContain('pr_comment');
		expect(quick).toContain('`— Astra, Opus`');
		const worktree = reviewCrewPrompt({ pr, quick: false, repo: 'api', mergeBase: 'abc123', crew });
		expect(worktree).toContain('git -C api diff abc123 HEAD');
		expect(worktree).not.toContain("person's branch");
	});
});

describe('review notes and instructions in the prompt (spec/pull-requests-and-ci#review-launch)', () => {
	it('puts the project notes first and the person’s text as typed after them', () => {
		const text = reviewGuidance(
			{ source: 'text', text: 'Migrations must be reversible.' },
			'Look at the race in sync.ts',
			'.',
			'abc123'
		);
		expect(text).toBe(
			'\n\nReview notes of this project:\nMigrations must be reversible.\n\nInstructions from the person for this review:\nLook at the race in sync.ts'
		);
	});
	it('sends the agent to REVIEW.md at the merge base, and adds nothing without notes', () => {
		expect(reviewGuidance({ source: 'file' }, '', 'apps/mobile', 'abc123')).toContain(
			'`git -C apps/mobile show abc123:REVIEW.md`'
		);
		expect(reviewGuidance(undefined, '   ', '.', 'abc123')).toBe('');
	});
	it('tells the foreman to pass them word for word to each reviewer', () => {
		const crew = resolveReviewCrew(library, reviewCrewTemplateId, 'claude');
		const prompt = reviewCrewPrompt({
			pr,
			quick: true,
			repo: '.',
			mergeBase: 'abc123',
			crew,
			guidance: reviewGuidance(undefined, 'Skip style.', '.', 'abc123'),
		});
		expect(prompt).toContain("Pass everything below word for word into each reviewer's brief");
		expect(prompt.endsWith('Instructions from the person for this review:\nSkip style.')).toBe(
			true
		);
		expect(
			reviewCrewPrompt({ pr, quick: true, repo: '.', mergeBase: 'abc123', crew })
		).not.toContain('word for word');
	});
});
