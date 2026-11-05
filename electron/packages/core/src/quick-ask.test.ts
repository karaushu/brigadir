import { describe, expect, it } from 'vitest';
import {
	isQuickAskRequest,
	quickAskChangedLabel,
	quickAskDiffText,
	quickAskPrompt,
	quickAskSelection,
	quickAskSuggestions,
	quickAskToolPaths,
	quickAskWrites,
	quickCodePrompt,
	quickSlackAllows,
	slackCommandChangesState,
	quickSlackFollowUpPrompt,
} from './quick-ask';
import { isSessionCommand } from './session';
import { isSessionEvent } from './event-validation';
import { menuCommands, menuCommandEnabled, emptyMenuContext } from './menu';
import { defaultKeymap, keymapConflicts } from './keymap';
import { t } from './messages';

const file = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join('\n');
describe('quick question (spec/composer-steering-queue-and-ghost#quick-question)', () => {
	it('takes the selection and ±30 lines around it, clamped to the file', () => {
		const middle = quickAskSelection('src/a.ts', 'new', file, 40, 42);
		expect(middle).toMatchObject({
			path: 'src/a.ts',
			start: 40,
			end: 42,
			side: 'new',
			text: 'line 40\nline 41\nline 42',
			around: { start: 10 },
		});
		expect(middle.around.text.split('\n')).toHaveLength(63);
		const top = quickAskSelection('src/a.ts', 'old', file, 2, 3);
		expect(top.around.start).toBe(1);
		expect(top.around.text.split('\n').at(-1)).toBe('line 33');
		const bottom = quickAskSelection('src/a.ts', 'new', file, 99, 140);
		expect(bottom).toMatchObject({ start: 99, end: 100 });
		expect(bottom.around.text.split('\n').at(-1)).toBe('line 100');
	});
	it('writes the prompt in English with the answer language, the rules and, without a fork, the task context', () => {
		const selection = quickAskSelection('src/a.ts', 'new', file, 40, 42);
		const forked = quickAskPrompt({
			selection,
			question: 'Навіщо тут це?',
			language: 'uk',
			readOnly: false,
		});
		expect(forked).toMatch(/^Quick question about selected code\./);
		expect(forked).toContain('Answer briefly in Ukrainian');
		expect(forked).toContain('Change files only when the question asks for a change');
		expect(forked).toContain('replace <first line>-<last line>');
		expect(forked).toContain('   40 | line 40');
		expect(forked).toContain('Question: Навіщо тут це?');
		expect(forked).not.toContain("The task's first request");
		const fresh = quickAskPrompt({
			selection,
			question: 'Why?',
			language: 'en',
			readOnly: true,
			context: { title: 'Fix focus', prompt: 'x'.repeat(5000), diff: '+a' },
		});
		expect(fresh).toContain('Answer briefly in English');
		expect(fresh).toContain('Do not change any files');
		expect(fresh).toContain('Task: Fix focus');
		expect(fresh).toContain('[… cut at 4000 characters]');
		expect(fresh).toContain('```diff\n+a\n```');
		expect(
			quickAskPrompt({
				selection,
				question: 'And this?',
				language: 'en',
				readOnly: false,
				followUp: true,
			})
		).toBe('Quick question (follow-up, same lines src/a.ts:40-42): And this?');
		expect(
			quickAskPrompt({
				selection: quickAskSelection('src/a.ts', 'old', file, 1, 1),
				question: 'q',
				language: 'en',
				readOnly: false,
			})
		).toContain('the old side of the task diff');
	});
	it('reads ```replace a-b blocks and ignores other code', () => {
		const answer =
			'Shorter:\n\n```replace 16-16\ndata-loading={loading || undefined}\n```\n\n```ts\nconst other = 1;\n```\n\n~~~replace 3–5\na\nb\n~~~\n```replace 9-2\nx\n```';
		expect(quickAskSuggestions(answer)).toEqual([
			{ start: 16, end: 16, text: 'data-loading={loading || undefined}' },
			{ start: 3, end: 5, text: 'a\nb' },
		]);
		expect(quickAskSuggestions('```replace 7\nsingle\n```')).toEqual([
			{ start: 7, end: 7, text: 'single' },
		]);
		expect(quickAskSuggestions('```replace 4-4\nunfinished')).toEqual([]);
	});
	it('names the files of write tools inside the project', () => {
		expect(quickAskWrites({ category: 'edit' })).toBe(true);
		expect(quickAskWrites({ category: 'read' })).toBe(false);
		expect(quickAskWrites({ category: 'move' })).toBe(true);
		expect(
			quickAskToolPaths(
				{
					locations: [
						{ path: '/p/src/a.ts', line: 3 },
						{ path: '/elsewhere/b.ts', line: null },
					],
					content: [{ kind: 'diff', path: '/p/src/c.ts', before: null, after: '' }],
				},
				'/p'
			).sort()
		).toEqual(['src/a.ts', 'src/c.ts']);
		expect(
			quickAskToolPaths(
				{
					locations: [
						{ path: 'src/rel.ts', line: null },
						{ path: '../up.ts', line: null },
					],
				},
				'/p'
			)
		).toEqual(['src/rel.ts']);
	});
	it('shows a compact diff with context', () => {
		const lines = [
			...Array.from({ length: 6 }, (_, i) => ({
				kind: 'context' as const,
				text: `c${i}`,
				newLine: i + 1,
			})),
			{ kind: 'removed' as const, text: 'old', newLine: null },
			{ kind: 'added' as const, text: 'new', newLine: 7 },
			{ kind: 'context' as const, text: 'tail', newLine: 8 },
		];
		expect(quickAskDiffText(lines)).toBe('@@ near line 5 @@\n c4\n c5\n-old\n+new\n tail');
	});
	it('labels the log row with four plural forms', () => {
		expect(quickAskChangedLabel('uk', 1)).toBe('Швидке питання змінило 1 файл');
		expect(quickAskChangedLabel('uk', 3)).toBe('Швидке питання змінило 3 файли');
		expect(quickAskChangedLabel('uk', 5)).toBe('Швидке питання змінило 5 файлів');
		expect(quickAskChangedLabel('uk', 21)).toBe('Швидке питання змінило 21 файл');
		expect(quickAskChangedLabel('en', 2)).toBe('The quick question changed 2 files');
	});
	it('validates the IPC request, the host command and the journal event', () => {
		const selection = quickAskSelection('src/a.ts', 'new', file, 1, 2),
			id = '0b5f3a52-6f0e-4b8e-9a35-1c9f0e7d2a10';
		expect(isQuickAskRequest({ id, selection, question: 'Why?', language: 'uk' })).toBe(true);
		const request = { id, selection, question: 'Why?', language: 'en' };
		expect(isQuickAskRequest({ ...request, provider: 'codex', model: 'other' })).toBe(true);
		for (const choice of [
			{ provider: 'unknown' },
			{ model: '' },
			{ model: 12 },
			{ model: 'x'.repeat(1001) },
		])
			expect(isQuickAskRequest({ ...request, ...choice })).toBe(false);
		expect(
			isQuickAskRequest({
				id,
				selection: { ...selection, scopeId: '0123456789abcdef' },
				question: 'Why?',
				language: 'en',
			})
		).toBe(true);
		expect(
			isQuickAskRequest({
				id,
				selection: { ...selection, path: '/etc/passwd' },
				question: 'Why?',
				language: 'uk',
			})
		).toBe(false);
		expect(
			isQuickAskRequest({
				id,
				selection: { ...selection, path: '../x' },
				question: 'Why?',
				language: 'uk',
			})
		).toBe(false);
		expect(
			isQuickAskRequest({
				id,
				selection: { ...selection, start: 5, end: 2 },
				question: 'Why?',
				language: 'uk',
			})
		).toBe(false);
		expect(isQuickAskRequest({ id, selection, question: ' ', language: 'uk' })).toBe(false);
		expect(isQuickAskRequest({ id: 'x', selection, question: 'Why?', language: 'uk' })).toBe(false);
		expect(isSessionCommand({ kind: 'quickAsk', phase: 'before' })).toBe(true);
		expect(
			isSessionCommand({
				kind: 'quickAsk',
				phase: 'after',
				question: 'q',
				files: ['src/a.ts'],
				before: 3,
			})
		).toBe(true);
		expect(
			isSessionCommand({ kind: 'quickAsk', phase: 'after', question: 'q', files: [], before: 3 })
		).toBe(false);
		expect(
			isSessionCommand({
				kind: 'quickAsk',
				phase: 'after',
				question: 'q',
				files: ['../a'],
				before: 3,
			})
		).toBe(false);
		expect(
			isSessionEvent({
				kind: 'quick-ask.changed',
				question: 'q',
				files: ['src/a.ts'],
				before: 3,
				after: 4,
			})
		).toBe(true);
		expect(
			isSessionEvent({ kind: 'quick-ask.changed', question: 'q', files: [], before: 3, after: 4 })
		).toBe(false);
	});
	it('has ⌘I in the Editor menu, enabled only with a selection panel, without a conflict', () => {
		const command = menuCommands.find((item) => item.id === 'ask-agent')!;
		expect(command).toMatchObject({
			group: 'Editor',
			accelerator: 'CmdOrCtrl+I',
			channel: 'workspace',
		});
		expect(menuCommandEnabled(command, emptyMenuContext)).toBe(false);
		expect(menuCommandEnabled(command, { ...emptyMenuContext, askAgent: true })).toBe(true);
		// spec/composer#formatting: ⌘I is also Italic, in the composer's text, where Ask the agent never acts.
		expect(
			menuCommands.filter(
				(item) => item.accelerator === 'CmdOrCtrl+I' && item.when !== 'composerFormat'
			)
		).toHaveLength(1);
		expect(keymapConflicts(defaultKeymap)).toEqual([]);
		expect(t('uk', 'Ask the agent')).toBe('Спитати агента');
	});
});

describe('a question from Slack about the code (spec/notifications-slack-notes-and-schedules#slack)', () => {
	it('asks in English for a short answer in words, in the question’s language, with nothing changed', () => {
		const prompt = quickCodePrompt({
			question: 'як у business працює авторизація?',
			language: 'uk',
			project: 'business',
			thread: 'U1 · 2026-10-30 10:00 UTC\nlogin breaks',
		});
		expect(prompt).toContain('project business');
		expect(prompt).toContain('Answer in Ukrainian, at most 12 short lines');
		expect(prompt).toContain('Never include code, diffs');
		expect(prompt).toContain('Do not change any files');
		expect(prompt).toContain('login breaks');
		expect(prompt.endsWith('як у business працює авторизація?')).toBe(true);
	});
	it('keeps the same rules on a follow-up', () => {
		const prompt = quickSlackFollowUpPrompt({
			question: 'and where is the token checked?',
			language: 'en',
		});
		expect(prompt).toContain('Answer in English, at most 12 short lines');
		expect(prompt).toContain('Do not change any files');
		expect(prompt).toContain('and where is the token checked?');
	});
	it('takes an effort only as a short text', () => {
		const request = {
			id: '00000000-0000-4000-8000-000000000000',
			question: 'q',
			language: 'en',
			selection: {
				path: 'a.ts',
				start: 1,
				end: 1,
				side: 'new',
				text: '',
				around: { start: 1, text: '' },
			},
		};
		expect(isQuickAskRequest({ ...request, effort: 'high' })).toBe(true);
		expect(isQuickAskRequest({ ...request, effort: '' })).toBe(false);
	});
});

describe('what a Slack side agent may run (spec/notifications-slack-notes-and-schedules#slack-side-commands)', () => {
	const bash = (command: string) => ({
		category: 'execute',
		name: 'Bash',
		input: JSON.stringify({ command, description: 'x' }),
	});
	it('runs commands that read: git and gh lookups, pipes, stderr to /dev/null', () => {
		for (const command of [
			'git log --since=midnight --oneline origin/main',
			'git show --stat HEAD~1',
			'git branch -a --contains abc123',
			'git tag --list "v*"',
			'git fetch origin',
			'gh pr list --state merged --search "merged:>=2026-11-05" --json number,title,mergedAt',
			'gh run list --branch main --limit 20',
			'gh run view 123 --log-failed 2>&1 | tail -50',
			'gh api repos/choice/admin/deployments?environment=production 2>/dev/null | jq ".[0]"',
			'gh api -X GET repos/o/r/deployments/1/statuses',
			'curl -s https://api.github.com/repos/o/r',
			'rg -n "deploy" .github/workflows',
		])
			expect([command, quickSlackAllows(bash(command))]).toEqual([command, true]);
	});
	it('declines commands that change state, and edits', () => {
		for (const command of [
			'git push origin main',
			'git -C admin commit -am x',
			'git checkout -b x',
			'git tag v1.2.3',
			'git branch -D old',
			'gh pr merge 12 --squash',
			'gh workflow run deploy.yml',
			'gh run rerun 55',
			'gh release create v1',
			'gh api -X POST repos/o/r/dispatches',
			'gh api repos/o/r/issues -f title=x',
			'rm -rf dist',
			'cd x && npm install',
			"sed -i '' s/a/b/ file",
			'echo hi > notes.txt',
			'curl -X POST https://example.com/hook -d x=1',
			'sudo ls',
		])
			expect([command, quickSlackAllows(bash(command))]).toEqual([command, false]);
		expect(slackCommandChangesState('git log > /tmp/out.txt')).toBe(true);
		expect(quickSlackAllows({ category: 'edit', name: 'Edit' })).toBe(false);
		expect(quickSlackAllows({ category: 'other', name: 'mcp__brigadir__create_task' })).toBe(false);
	});
	it('reads Codex’s command array and allows plain reads and searches', () => {
		expect(
			quickSlackAllows({
				category: 'execute',
				input: JSON.stringify({ command: ['bash', '-lc', 'gh pr list --state merged'] }),
			})
		).toBe(true);
		expect(
			quickSlackAllows({
				category: 'execute',
				input: JSON.stringify({ command: ['bash', '-lc', 'git push'] }),
			})
		).toBe(false);
		expect(quickSlackAllows({ category: 'read', name: 'Read' })).toBe(true);
		expect(quickSlackAllows({ category: 'search', name: 'Grep' })).toBe(true);
	});
	it('tells the project agent to look it up itself, with today’s date', () => {
		const prompt = quickCodePrompt({
			question: 'what went to prod today?',
			language: 'en',
			project: 'admin',
			today: '2026-11-05 (Thursday), 21:14 UTC+02:00',
		});
		expect(prompt).toContain('Find the answer yourself');
		expect(prompt).toContain('gh api repos/{owner}/{repo}/deployments');
		expect(prompt).toContain('Now: 2026-11-05 (Thursday), 21:14 UTC+02:00.');
		expect(prompt).toContain('such commands are declined');
	});
});
