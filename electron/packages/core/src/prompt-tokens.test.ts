import { describe, expect, it } from 'vitest';
import {
	attachmentLines,
	attachmentMention,
	attachmentToken,
	modelToken,
	promptAttachmentIds,
	promptDisplayText,
	promptParts,
	promptSequence,
	taskSummaryText,
	taskToken,
} from './prompt-tokens';
import type { EventRecord } from './session';

const a = '11111111-1111-4111-8111-111111111111',
	b = '22222222-2222-4222-8222-222222222222';
describe('spec/composer#mentions: згадки токенами в тексті композера', () => {
	it('розбирає токени по місцях і лишає невідоме текстом', () => {
		const text = `Fix ${attachmentToken(a)} and ${taskToken('split-kit')}, ask ${modelToken('claude', 'claude-sonnet-5')}. @[att:nope] stays`;
		expect(
			promptParts(text).map((part) => (part.kind === 'text' ? part.text : part.token.kind))
		).toEqual(['Fix ', 'attachment', ' and ', 'task', ', ask ', 'model', '. @[att:nope] stays']);
	});
	it('текст одразу після пігулки не стає частиною токена', () => {
		expect(
			promptParts(`${modelToken('codex', 'gpt-5.5')}then`).map((part) =>
				part.kind === 'text' ? part.text : part.token
			)
		).toEqual([{ kind: 'model', provider: 'codex', model: 'gpt-5.5' }, 'then']);
	});
	it('ідентифікатори вкладень — у порядку тексту, кожен раз', () => {
		expect(
			promptAttachmentIds(`${attachmentToken(b)} x ${attachmentToken(a)} ${attachmentToken(b)}`)
		).toEqual([b, a]);
	});
	it('показує назви замість токенів: рейка, черга, пошук, копіювання', () => {
		const attachments = [
			{ id: a, kind: 'text' as const, name: 'kit/src/Button.tsx' },
			{ id: b, kind: 'text' as const, name: 'Task summary · Split kit exports' },
		];
		expect(
			promptDisplayText(
				`Fix ${attachmentToken(a)} after ${attachmentToken(b)} with ${modelToken('claude', 'sonnet')}`,
				attachments
			)
		).toBe('Fix @Button.tsx after @Split kit exports with @sonnet');
		expect(
			promptDisplayText(`Ask ${taskToken('t1')}`, [], [{ id: 't1', title: 'Gate AI chat flag' }])
		).toBe('Ask @Gate AI chat flag');
	});
	it('блоки йдуть у порядку тексту, модель — текстом, решта вкладень — після тексту', () => {
		const text = `Fix the ring in ${attachmentToken(a)} and run a subagent with ${modelToken('claude', 'claude-sonnet-5')}. Safari: ${attachmentToken(b)}`;
		expect(promptSequence(text, [a, b, '33333333-3333-4333-8333-333333333333'])).toEqual([
			{ kind: 'text', text: 'Fix the ring in ' },
			{ kind: 'attachment', id: a },
			{ kind: 'text', text: ' and run a subagent with `claude-sonnet-5` (Claude). Safari: ' },
			{ kind: 'attachment', id: b },
			{ kind: 'attachment', id: '33333333-3333-4333-8333-333333333333' },
		]);
		expect(promptSequence('plain text', [a])).toEqual([
			{ kind: 'text', text: 'plain text' },
			{ kind: 'attachment', id: a },
		]);
		expect(promptSequence(`${attachmentToken(a)} `, [])).toEqual([]);
	});
	it('пігулка знає, що в неї: файл, діапазон, задача, зображення', () => {
		expect(attachmentMention({ kind: 'text', name: 'kit/src/Button.tsx:12-34' })).toEqual({
			kind: 'file',
			label: 'Button.tsx:12-34',
		});
		expect(attachmentMention({ kind: 'text', name: 'Task summary · Split' })).toEqual({
			kind: 'task',
			label: 'Split',
		});
		expect(attachmentMention({ kind: 'text', name: 'VibePreview/' })).toEqual({
			kind: 'folder',
			label: 'VibePreview',
		});
		expect(attachmentMention({ kind: 'text', name: 'Selected code' })).toEqual({
			kind: 'text',
			label: 'Selected code',
		});
		expect(attachmentMention({ kind: 'image', name: 'Pasted image' }).kind).toBe('image');
	});
	it('пігулка рядків називає файл і рядки (spec/chat#code-pills)', () => {
		expect(attachmentLines({ kind: 'text', name: 'kit/src/Button.tsx:12-34' })).toEqual({
			path: 'kit/src/Button.tsx',
			start: 12,
			end: 34,
			side: 'new',
		});
		expect(attachmentLines({ kind: 'text', name: 'screens/Progress.tsx:61-68 · old' })).toEqual({
			path: 'screens/Progress.tsx',
			start: 61,
			end: 68,
			side: 'old',
		});
		expect(attachmentLines({ kind: 'text', name: 'my file.ts:7' })).toMatchObject({
			start: 7,
			end: 7,
		});
		expect(attachmentLines({ kind: 'text', name: 'kit/src/Button.tsx' })).toBeNull();
		expect(attachmentLines({ kind: 'text', name: 'Task summary · a:1' })).toBeNull();
		expect(attachmentLines({ kind: 'image', name: 'shot.png:1' })).toBeNull();
	});
	it('підсумок задачі: назва, стан, перший запит, остання відповідь, диф', () => {
		const records = [
			{ seq: 1, at: '', event: { kind: 'turn.started', text: 'Split the exports' } },
			{
				seq: 2,
				at: '',
				event: {
					kind: 'message.delta',
					role: 'assistant',
					content: { kind: 'text', text: 'First answer' },
				},
			},
			{ seq: 3, at: '', event: { kind: 'turn.started', text: 'Go on' } },
			{
				seq: 4,
				at: '',
				event: {
					kind: 'message.delta',
					role: 'assistant',
					content: { kind: 'text', text: 'Moved Icon* to kit/src/icons.' },
				},
			},
		] as unknown as EventRecord[];
		const text = taskSummaryText(
			{
				title: 'Split kit exports',
				status: 'working',
				provider: 'claude',
				taskTree: { branch: 'feat/split', worktree: true },
			},
			records,
			'"kit/src/index.ts" | +3 -1 (modified)'
		);
		expect(text).toContain('Task: Split kit exports');
		expect(text).toContain('State: working · agent: Claude · branch: feat/split');
		expect(text).toContain('Original request:\nSplit the exports');
		expect(text).toContain('Latest agent answer:\nMoved Icon* to kit/src/icons.');
		expect(text).not.toContain('First answer');
		expect(text).toContain('"kit/src/index.ts" | +3 -1 (modified)');
	});
});
