import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
	autoHireGates,
	builtinAgentTemplates,
	crewPalette,
	templateLookup,
	type AgentTask,
	type AutoHire,
	type AutoHirePart,
	type ProviderCatalog,
	type SessionCommand,
} from '@brigadir/core';
import { HireCard, HireSummary } from './HireCard';
import { ModelQuestion } from './ui/SessionInputs';
import {
	canHire,
	catalogModels,
	hireDecision,
	hireEdited,
	modelAnswer,
	partEdits,
	refusedNumbers,
} from './hire-card';
import { workerRowState } from './worker-row';
const roles = crewPalette(
	builtinAgentTemplates,
	{ lookup: templateLookup(builtinAgentTemplates), defaultProvider: 'claude' },
	[]
).templates;
const part = (n: number, patch: Partial<AutoHirePart> = {}): AutoHirePart => ({
	id: `p${n}`,
	title: `Part ${n}`,
	role: 'developer',
	roleName: 'Developer',
	prompt: `Do part ${n}.`,
	zone: [`apps/part${n}/**`],
	scopes: [],
	budget: { minutes: 40, tokens: 400_000 },
	estimate: { files: 3, lines: 200 },
	...patch,
});
// Parts 3 and 4: one overlaps part 1, one is too small (the board «host refused a part»).
const hire: AutoHire = {
	id: 'hire',
	summary: '',
	parts: autoHireGates(
		[
			part(1, { zone: ['packages/types/**'] }),
			part(2, { budget: { minutes: 50, tokens: 500_000 } }),
			part(3, { zone: ['packages/types/src/client.ts'], budget: { minutes: 15, tokens: 150_000 } }),
			part(4, { estimate: { files: 1, lines: 12 }, budget: { minutes: 10, tokens: 80_000 } }),
		],
		[]
	),
};
const task: AgentTask = {
	id: 'lead',
	projectId: 'p',
	title: 'Client details',
	status: 'needs-you',
	provider: 'claude',
	auto: { roles, budget: { minutes: 40, tokens: 400_000 } },
};
const text = (html: string) => html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ');
describe('the hire card (spec/chat-turns-plans-and-questions#hire-card)', () => {
	it('sums the hireable parts, words the refused ones and hires the rest', () => {
		const sent: SessionCommand[] = [];
		const html = renderToStaticMarkup(
			<HireCard
				hire={hire}
				task={task}
				revision={0}
				locale="en"
				disabled={false}
				send={(command) => sent.push(command)}
			/>
		);
		const words = text(html);
		expect(words).toContain('Claude wants to hire 4 workers');
		expect(words).toContain('1h 30m · 900k tokens');
		expect(words).toContain('Not independent: part 1 writes packages/types/src/client.ts too.');
		expect(words).toContain('Too small for a worker: about 12 lines in one file.');
		expect(words).toContain('Parts 3 and 4 stay with Claude.');
		expect(words).toContain('Hire 2');
		expect(words).toContain('Do it yourself');
		expect(html).toContain('packages/types/**');
		expect(html.match(/data-refused="true"/g)).toHaveLength(2);
		expect(html).not.toContain('>edited<');
	});
	it('says `Hire` when every part passes', () => {
		const clean = { ...hire, parts: hire.parts.slice(0, 2) };
		const words = text(
			renderToStaticMarkup(
				<HireCard
					hire={clean}
					task={task}
					revision={0}
					locale="uk"
					disabled={false}
					send={() => {}}
				/>
			)
		);
		expect(words).toContain('Claude хоче найняти 2 воркерів');
		expect(words).toContain('2 частини для 2 воркерів');
		expect(words).toMatch(/Найняти\s*$/m);
	});
	it('sends null parts unless the person edited, and every part when they did', () => {
		expect(hireDecision(hire, hire.parts, true)).toEqual({
			id: 'hire',
			approved: true,
			parts: null,
		});
		const edited = hire.parts.map((item, index) =>
			index === 0 ? { ...item, role: 'senior-developer', roleName: 'Senior developer' } : item
		);
		expect(partEdits(hire.parts[0]!, edited[0]!)).toEqual({
			title: false,
			role: true,
			budget: false,
			prompt: false,
		});
		expect(hireEdited(hire, edited)).toBe(true);
		expect(hireDecision(hire, edited, true).parts).toHaveLength(4);
		expect(hireDecision(hire, edited, false)).toEqual({ id: 'hire', approved: false, parts: null });
		expect(refusedNumbers(hire.parts)).toEqual([3, 4]);
		expect(canHire(hire.parts)).toBe(true);
		expect(canHire(hire.parts.slice(2))).toBe(false);
		expect(canHire([{ ...hire.parts[0]!, title: ' ' }])).toBe(false);
	});
	it('folds into `Hired {n} workers` or `Not hired · {agent} does it itself`', () => {
		const hired = renderToStaticMarkup(
			<HireSummary
				hire={hire}
				parts={null}
				approved
				hired={[
					{ partId: 'p1', taskId: 't1', name: 'Developer', role: 'Developer' },
					{ partId: 'p2', taskId: 't2', name: 'Developer 2', role: 'Developer' },
				]}
				at="2026-11-13T14:02:00.000Z"
				task={task}
				locale="en"
				open={false}
				onToggle={() => {}}
			/>
		);
		expect(text(hired)).toContain('Hired 2 workers');
		expect(hired).toContain('data-hire-summary="hire"');
		const declined = text(
			renderToStaticMarkup(
				<HireSummary
					hire={hire}
					parts={null}
					approved={false}
					hired={[]}
					at="2026-11-13T14:03:00.000Z"
					task={task}
					locale="en"
					open={false}
					onToggle={() => {}}
				/>
			)
		);
		expect(declined).toContain('Not hired');
		expect(declined).toContain('4 parts');
		expect(declined).toContain('Claude does it itself');
	});
});
const catalog: ProviderCatalog = {
	provider: 'codex',
	modes: [],
	options: [
		{
			kind: 'select',
			id: 'model',
			name: 'Model',
			category: 'model',
			value: 'gpt-6-astra',
			choices: [
				{ value: 'gpt-6-astra', name: 'GPT-6 Astra' },
				{ value: 'gpt-6-luna', name: 'GPT-6 Luna' },
			],
		},
		{
			kind: 'select',
			id: 'reasoning_effort',
			name: 'Effort',
			category: 'thought_level',
			value: 'medium',
			choices: [
				{ value: 'medium', name: 'Medium' },
				{ value: 'high', name: 'High' },
			],
		},
	],
} as unknown as ProviderCatalog;
describe('the model question card (spec/chat-turns-plans-and-questions#model-card)', () => {
	it('answers with the catalog ids and names, and the role name to save', () => {
		const [astra] = catalogModels({ codex: catalog }, ['claude', 'codex']);
		expect(astra).toEqual({ provider: 'codex', value: 'gpt-6-astra', name: 'GPT-6 Astra' });
		expect(modelAnswer(catalog, astra!, 'high', ' Vision developer ')).toEqual({
			provider: 'codex',
			model: { id: 'model', value: 'gpt-6-astra', name: 'GPT-6 Astra' },
			effort: { id: 'reasoning_effort', value: 'high', name: 'High' },
			saveAs: 'Vision developer',
		});
		expect(modelAnswer(catalog, astra!, null, null)).toEqual({
			provider: 'codex',
			model: { id: 'model', value: 'gpt-6-astra', name: 'GPT-6 Astra' },
			effort: null,
		});
	});
	const card = (groups: Parameters<typeof ModelQuestion>[0]['groups']) =>
		text(
			renderToStaticMarkup(
				<ModelQuestion
					title="Claude asks for another model"
					part="Details screen"
					reason="No role fits: the part works from Figma screenshots."
					groups={groups}
					selected={null}
					onSelect={() => {}}
					efforts={null}
					effort={null}
					onEffort={() => {}}
					saveAs={null}
					onSaveAs={() => {}}
					keepLabel="Keep Developer"
					onKeep={() => {}}
					onUse={() => {}}
					onSettings={() => {}}
					disabled={false}
					locale="en"
				/>
			)
		);
	it('shows loading, the models, and with none only `Keep` and `Settings…`', () => {
		expect(card(null)).toContain('Loading models…');
		const listed = card([
			{
				label: 'Codex',
				rows: [{ key: 'codex:astra', name: 'GPT-6 Astra', note: 'the model of this task' }],
			},
		]);
		expect(listed).toContain('GPT-6 Astra');
		expect(listed).toContain('Use this model');
		expect(listed).toContain('Save as role');
		// A group carries its provider's glyph (spec/chat-turns-plans-and-questions#model-card).
		const html = renderToStaticMarkup(
			<ModelQuestion
				title="t"
				part="p"
				reason="r"
				groups={[
					{ label: 'Codex', glyph: 'openai', rows: [{ key: 'codex:astra', name: 'GPT-6 Astra' }] },
				]}
				selected={null}
				onSelect={() => {}}
				efforts={null}
				effort={null}
				onEffort={() => {}}
				saveAs={null}
				onSaveAs={() => {}}
				keepLabel="Keep Developer"
				onKeep={() => {}}
				onUse={() => {}}
				onSettings={() => {}}
				disabled={false}
				locale="en"
			/>
		);
		expect(html).toMatch(/data-glyph="openai"[^]*Codex/);
		const none = card([{ label: 'Codex', rows: [] }]);
		expect(none).toContain('No other models.');
		expect(none).toContain('Settings…');
		expect(none).not.toContain('Use this model');
		// With nothing else to choose, `Keep {role}` is the primary answer.
		expect(html.match(/<button[^>]*>Keep Developer/)?.[0]).not.toContain(
			'data-appearance="primary"'
		);
		const noneHtml = renderToStaticMarkup(
			<ModelQuestion
				title="t"
				reason="r"
				groups={[{ label: 'Codex', rows: [] }]}
				selected={null}
				onSelect={() => {}}
				efforts={null}
				effort={null}
				onEffort={() => {}}
				saveAs={null}
				onSaveAs={() => {}}
				keepLabel="Keep Developer"
				onKeep={() => {}}
				onUse={() => {}}
				onSettings={() => {}}
				disabled={false}
				locale="en"
			/>
		);
		expect(noneHtml.match(/<button[^>]*>Keep Developer/)?.[0]).toContain(
			'data-appearance="primary"'
		);
		// A provider whose catalog loads waits in its place; the others are listed, and the answer waits.
		const partial = renderToStaticMarkup(
			<ModelQuestion
				title="t"
				reason="r"
				groups={[
					{ label: 'Claude', rows: [{ key: 'claude:opus', name: 'Opus 5.5' }] },
					{ label: 'Codex', rows: null },
				]}
				selected="claude:opus"
				onSelect={() => {}}
				efforts={null}
				effort={null}
				onEffort={() => {}}
				saveAs={null}
				onSaveAs={() => {}}
				keepLabel="Keep Developer"
				onKeep={() => {}}
				onUse={() => {}}
				onSettings={() => {}}
				disabled={false}
				locale="en"
			/>
		);
		expect(text(partial)).toMatch(/Opus 5\.5[^]*Codex[^]*Loading models…[^]*Save as role/);
		expect(partial.match(/<button[^>]*>Use this model/)?.[0]).toContain('disabled');
		// It is the question family's card (rule 17).
		expect(partial).toContain('data-model-question');
		// Two waiting questions in one chat keep their own radio groups.
		const two = renderToStaticMarkup(
			<>
				{[1, 2].map((n) => (
					<ModelQuestion
						key={n}
						title="t"
						reason="r"
						groups={[{ label: 'Claude', rows: [{ key: 'claude:opus', name: 'Opus 5.5' }] }]}
						selected="claude:opus"
						onSelect={() => {}}
						efforts={null}
						effort={null}
						onEffort={() => {}}
						saveAs={null}
						onSaveAs={() => {}}
						keepLabel="Keep Developer"
						onKeep={() => {}}
						onUse={() => {}}
						onSettings={() => {}}
						disabled={false}
						locale="en"
					/>
				))}
			</>
		);
		expect(
			new Set(
				[...two.matchAll(/type="radio"[^>]*name="([^"]+)"|name="([^"]+)"[^>]*type="radio"/g)].map(
					(m) => m[1] ?? m[2]
				)
			).size
		).toBe(2);
	});
});
describe('a worker row of an Auto crew (spec/sidebar#crew-card)', () => {
	const worker: AgentTask = {
		id: 'w',
		projectId: 'p',
		title: 'API endpoints',
		status: 'completed',
		changeSummary: { additions: 148, deletions: 6 },
	};
	it('is quiet with its own counts once dismissed, and amber over its budget', () => {
		expect(workerRowState({ task: worker, dismissed: true })).toEqual({
			quiet: true,
			overBudget: false,
			counts: { additions: 148, deletions: 6 },
		});
		expect(
			workerRowState({
				task: { ...worker, status: 'needs-you', overBudget: true },
				dismissed: false,
			})
		).toEqual({ quiet: false, overBudget: true, counts: null });
		// A dismissed worker that changed nothing shows no counts.
		const { changeSummary: _summary, ...unchanged } = worker;
		expect(workerRowState({ task: unchanged, dismissed: true }).counts).toBeNull();
	});
});
