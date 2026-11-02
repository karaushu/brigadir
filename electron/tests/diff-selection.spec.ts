import { refreshChanges } from './refresh-changes';
import { selectCode } from './select-code';
import { openReview } from './open-review';
import { editorState, editorText, setEditorCaret } from './editor-text';
import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hideChat, hideWorkArea, openPanelTab, showChat, showWorkArea } from './layout';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
const env = Object.fromEntries(
	Object.entries(process.env).filter(
		(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
	)
);
// A git repo (no commit) with sample.ts and one done task titled `title`, opened in a fresh app.
const doneTask = async (title: string, sample: string) => {
	const root = await mkdtemp(join(tmpdir(), 'brigadir-selection-')),
		repo = join(root, 'repo'),
		data = join(root, 'data'),
		dir = join(data, 'projects/project/tasks/task');
	await mkdir(repo);
	await mkdir(dir, { recursive: true });
	await promisify(execFile)('git', ['init', '-q'], { cwd: repo });
	await writeFile(join(repo, 'sample.ts'), sample);
	await writeFile(
		join(dir, '../../project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	await writeFile(
		join(dir, 'task.json'),
		JSON.stringify({
			schemaVersion: 1,
			task: { id: 'task', projectId: 'project', title, status: 'done', provider: 'claude' },
		})
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, HOME: root, ZDOTDIR: root, BRIGADIR_DATA_DIR: data },
	});
	return { root, repo, app };
};
test('diff selection paints during the drag and keeps code stationary until release @area:diff', async ({}, info) => {
	const source = (prefix: string) =>
		Array.from({ length: 12 }, (_, i) => `export const ${prefix}${i + 1} = ${i + 1};`).join('\n');
	const { root, repo, app } = await doneTask('Live diff selection', source('before'));
	try {
		const page = await app.firstWindow();
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await page.getByRole('button', { name: /Live diff selection/ }).click();
		await refreshChanges(page);
		const key = { projectId: 'project', id: 'task' };
		await expect
			.poll(() =>
				page.evaluate(async (key) => (await window.brigadir.readChanges(key)).checkpoint, key)
			)
			.not.toBeNull();
		await writeFile(join(repo, 'sample.ts'), source('after'));
		await refreshChanges(page);
		await openPanelTab(page, 'changes');
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /sample.ts/ })
			.click();
		const diff = page.getByRole('log', { name: 'Diff', exact: true }),
			actions = diff.locator('[data-selection-actions]'),
			caption = actions.locator(':scope > span');
		const inspector = page.getByRole('complementary', { name: 'Changes', exact: true });
		// The diff mode lives in the document header, not in the changes panel.
		await expect(page.getByRole('radio', { name: 'Unified', exact: true })).toBeVisible();
		await expect(inspector.getByRole('radio', { name: 'Unified', exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Close panel', exact: true })).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Base', exact: true })).toHaveCount(0);
		const options = inspector.getByRole('button', { name: 'Diff options', exact: true });
		await expect(page.getByRole('button', { name: 'Wrap lines', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await expect(inspector.getByRole('button', { name: 'Wrap lines', exact: true })).toHaveCount(0);
		await options.click();
		await expect(inspector.getByRole('button', { name: 'Base', exact: true })).toBeVisible();
		await options.press('Escape');
		await expect(options).toBeFocused();
		await expect(inspector).toBeVisible();
		await expect(options).toHaveAttribute('aria-expanded', 'false');
		await options.click();
		const base = inspector.getByRole('button', { name: 'Base', exact: true }),
			end = inspector.getByRole('button', { name: 'End', exact: true });
		await expect(base).toHaveText(/#0\s*\d{2}\.\d{2}\.\d{4} · \d{2}:\d{2}:\d{2}/);
		await expect(end).not.toContainText(/AM|PM/);
		await base.press('ArrowDown');
		const baseList = inspector.getByRole('listbox', { name: 'Base', exact: true });
		await expect(baseList).toBeFocused();
		await baseList.press('End');
		await baseList.press('Escape');
		await expect(base).toBeFocused();
		await expect(options).toHaveAttribute('aria-expanded', 'true');
		await end.click();
		const endList = inspector.getByRole('listbox', { name: 'End', exact: true });
		await endList.press('End');
		await endList.press('Enter');
		await expect(end).toBeFocused();
		const all = inspector.getByRole('button', { name: 'All changes', exact: true });
		await expect(all).toHaveAttribute('aria-pressed', 'false');
		await all.click();
		await expect(all).toHaveAttribute('aria-pressed', 'true');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`snapshot-options-${theme}.png`),
			});
			await base.click();
			await expect(baseList.getByRole('option')).toHaveCount(2);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`snapshot-picker-${theme}.png`),
			});
			await baseList.press('Escape');
		}
		await options.click();
		const line = (side: string, n: number) =>
			diff.locator(`[data-code-line="${n}"][data-side="${side}"]`);
		const marked = (side: string) =>
			diff.locator(`[data-selected="true"] [data-code-line][data-side="${side}"]`);
		// The chat away gives the diff the full width (spec/task-window-workspace#layout-switch).
		await hideChat(page);
		// The mouse paths below measure single-row lines: wrapping (on by default, spec/editor#line-wrap) would fold them in side by side.
		const wrap = page.getByRole('button', { name: 'Wrap lines', exact: true });
		await wrap.click();
		await expect(wrap).toHaveAttribute('aria-pressed', 'false');
		for (const mode of ['Unified', 'Side by side']) {
			await page.getByRole('radio', { name: mode, exact: true }).click();
			for (const side of ['old', 'new']) {
				// Start a fresh text selection; dragging already selected text invokes native drag/drop.
				await page.evaluate(() => window.getSelection()?.removeAllRanges());
				await line(side, 3).evaluate((node) => {
					const viewport = node.closest('[role=log]')!;
					viewport.scrollTop +=
						node.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 100;
				});
				await page.evaluate(
					() =>
						new Promise<void>((resolve) =>
							requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
						)
				);
				const a = (await line(side, 3).boundingBox())!,
					b = (await line(side, 5).boundingBox())!,
					c = (await line(side, 7).boundingBox())!;
				await page.mouse.move(a.x + 8, a.y + a.height / 2);
				await page.mouse.down();
				await page.mouse.move(b.x + 80, b.y + b.height / 2, { steps: 6 });
				// spec/diff-and-review#diff-selection: a text drag shows the dragged characters natively, never whole-line marks, and never the other column.
				const selected = () => page.evaluate(() => window.getSelection()?.toString() ?? '');
				await expect.poll(selected).toContain(side === 'old' ? 'before4' : 'after4');
				await expect(marked(side)).toHaveCount(0);
				expect((await line(side, 7).boundingBox())!.y).toBe(c.y);
				await page.mouse.move(c.x + 100, c.y + c.height / 2, { steps: 6 });
				await expect.poll(selected).toContain(side === 'old' ? 'before6' : 'after6');
				// Reverse direction before mouseup, then verify the native text remains selected.
				await page.mouse.move(b.x + 80, b.y + b.height / 2, { steps: 6 });
				await expect.poll(selected).not.toContain(side === 'old' ? 'before6' : 'after6');
				const text = await selected();
				expect(text).toContain(side === 'old' ? 'before4' : 'after4');
				expect(text).not.toContain(side === 'old' ? 'after' : 'before');
				expect(text).not.toContain(`export const ${side === 'old' ? 'before' : 'after'}3 `);
				await page.mouse.up();
				// spec/appearance#evolution-redesign: the caption names the side only for the old one.
				await expect(caption).toHaveText(
					side === 'old' ? 'sample.ts · 3–5 · old' : 'sample.ts · 3–5'
				);
				// spec/diff-and-review#selection-panel: the panel floats over the lines below the selection; none of them moves.
				expect((await line(side, 7).boundingBox())!.y).toBe(c.y);
				expect(await selected()).toBe(text);
				await expect(marked(side)).toHaveCount(0);
				if (mode === 'Side by side')
					await page.screenshot({
						animations: 'disabled',
						path: info.outputPath(`text-selection-${side}.png`),
					});
			}
		}
		// spec/diff-and-review#diff-selection: ⇧+arrows in side by side keep the selection's focus in its column — → past a line's end goes to
		// the next line of the same side, ↓ to the side's next line — never into the other column.
		{
			const focus = () =>
				page.evaluate(() => {
					const selection = window.getSelection()!,
						at = selection.focusNode,
						cell = (
							at?.nodeType === Node.ELEMENT_NODE ? (at as Element) : at?.parentElement
						)?.closest<HTMLElement>('[data-code-line]');
					return cell ? `${cell.dataset.side}:${cell.dataset.codeLine}` : null;
				});
			await diff.focus();
			await selectCode(diff, 'new', 3, 3, { from: 10 });
			await expect(caption).toHaveText('sample.ts · 3');
			await page.keyboard.press('Shift+ArrowRight');
			expect(await focus()).toBe('new:4');
			await page.keyboard.press('Shift+ArrowDown');
			await page.keyboard.press('Shift+ArrowDown');
			expect(await focus()).toBe('new:6');
			// The focus stands at the start of line 6: no character of it yet (spec/diff-and-review#diff-selection); → takes its first one.
			await expect(caption).toHaveText('sample.ts · 3–5');
			await page.keyboard.press('Shift+ArrowRight');
			await expect(caption).toHaveText('sample.ts · 3–6');
			await page.keyboard.press('Shift+ArrowUp');
			expect(await focus()).toBe('new:5');
			await expect(caption).toHaveText('sample.ts · 3–5');
		}
		// A partial one-line drag keeps its native highlight after the panel appears; a later drag started in the empty
		// space right of a line's text still replaces it (spec/diff-and-review#diff-selection, reported on a real diff).
		await page.evaluate(() => window.getSelection()?.removeAllRanges());
		{
			const a = (await line('old', 3).boundingBox())!;
			await page.mouse.move(a.x + 30, a.y + a.height / 2);
			await page.mouse.down();
			await page.mouse.move(a.x + 90, a.y + a.height / 2, { steps: 5 });
			await page.mouse.up();
		}
		await expect(caption).toHaveText('sample.ts · 3 · old');
		await page.waitForTimeout(300);
		await expect(marked('old')).toHaveCount(0);
		expect((await page.evaluate(() => window.getSelection()?.toString()))?.length).toBeGreaterThan(
			0
		);
		{
			const end = (await line('old', 9).boundingBox())!,
				to = (await line('old', 7).boundingBox())!,
				x = end.x + end.width + 16;
			expect(
				await page.evaluate(
					({ x, y }) => {
						const e = document.elementFromPoint(x, y);
						return !!e?.closest('[data-kind]') && !e.closest('[data-code-line]');
					},
					{ x, y: end.y + end.height / 2 }
				)
			).toBe(true);
			await page.mouse.move(x, end.y + end.height / 2);
			await page.mouse.down();
			await page.mouse.move(to.x + 20, to.y + to.height / 2, { steps: 8 });
			await page.mouse.up();
		}
		await expect(caption).toHaveText('sample.ts · 7–9 · old');
		await expect(actions).toHaveCount(1);
		await expect(marked('old')).toHaveCount(0);
		// A double click selects the word like the editor does and never opens the editor (spec/diff-and-review#diff-selection).
		await page.evaluate(() => window.getSelection()?.removeAllRanges());
		{
			const box = (await line('old', 5).boundingBox())!;
			const at = await line('old', 5).evaluate((node) => {
				const text = node.textContent!,
					start = text.indexOf('before5'),
					range = document.createRange(),
					walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
				let offset = 0,
					n: Node | null;
				while ((n = walker.nextNode())) {
					const length = n.textContent!.length;
					if (offset + length > start) {
						range.setStart(n, start - offset + 2);
						range.setEnd(n, start - offset + 3);
						break;
					}
					offset += length;
				}
				const rect = range.getBoundingClientRect();
				return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
			});
			expect(at.y).toBeGreaterThan(box.y);
			await page.mouse.dblclick(at.x, at.y);
		}
		await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('before5');
		await expect(caption).toHaveText('sample.ts · 5 · old');
		await expect(page.getByRole('textbox', { name: 'File content' })).toHaveCount(0);
		// Esc drops the selection with its panel.
		await page.keyboard.press('Escape');
		await expect(actions).toHaveCount(0);
		expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
		// Unified: ⇧+↓ moves within one column of code.
		await page.getByRole('radio', { name: 'Unified', exact: true }).click();
		await expect(diff.locator('[data-code-line="12"][data-side="old"]')).toBeAttached();
		const lineTops = () =>
			diff
				.locator('[data-code-line]')
				.evaluateAll((lines) => lines.map((line) => line.getBoundingClientRect().top));
		const unselected = await lineTops();
		// spec/appearance#evolution-redesign: a line number selects nothing — a click, a Shift+click, a drag over the numbers.
		const number = (n: number) =>
			diff.getByRole('button', { name: `Open in editor · new:${n}`, exact: true });
		await number(3).click();
		await number(5).click({ modifiers: ['Shift'] });
		{
			const a = (await number(3).boundingBox())!,
				b = (await number(6).boundingBox())!;
			await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
			await page.mouse.down();
			await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 });
			await page.mouse.up();
		}
		await page.waitForTimeout(200);
		await expect(actions).toHaveCount(0);
		expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('');
		await expect(marked('new')).toHaveCount(0);
		// A partial selection on three lines; held Shift extends it by keyboard and sees through the panel.
		await diff.focus();
		await selectCode(diff, 'new', 3, 4, { from: 13, to: 20 });
		await expect(caption).toHaveText('sample.ts · 3–4');
		await page.keyboard.down('Shift');
		await expect(actions).toBeHidden();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.up('Shift');
		await expect(caption).toHaveText('sample.ts · 3–5');
		const quote = await page.evaluate(() => window.getSelection()?.toString() ?? '');
		expect(quote.startsWith('after3 = 3;')).toBe(true);
		await expect(marked('new')).toHaveCount(0);
		expect(await lineTops()).toEqual(unselected);
		await actions.getByRole('button', { name: 'Comment', exact: true }).click();
		const draft = diff.locator('[data-comment-draft]');
		// An open draft is a comment placed on these lines: it takes its block below them.
		await expect.poll(async () => (await lineTops()).at(-1)).toBeGreaterThan(unselected.at(-1)!);
		await expect(draft).toContainText('New comment');
		await expect(draft).toContainText('3–5');
		// The draft quotes the selected text (not whole lines) and keeps its characters painted while the field has focus.
		await expect(draft.locator('[data-code-quote] > div').first()).toHaveText('after3 = 3;');
		const painted = await page.evaluate(() =>
			[...(CSS.highlights.get('code-selection') ?? [])].map((range) => range.toString())
		);
		expect(painted).toHaveLength(3);
		expect(painted[0]).toBe('after3 = 3;');
		expect(painted[1]).toBe('export const after4 = 4;');
		expect(quote).toContain(painted[2]!);
		await draft
			.getByRole('textbox', { name: 'Comment', exact: true })
			.fill('Use the shared token for these lines.');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`diff-layout-${theme}.png`),
			});
		}
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
// Editor selection (spec/diff-and-review#selection-panel, spec/composer#mentions): the bare selection's panel floats over the code; the draft and the panel survive
// scrolling and parking; To composer makes a file pill with its range.
test('selection actions and the draft stay between their code lines through scrolling and parking @area:diff', async ({}, info) => {
	const source = Array.from(
		{ length: 160 },
		(_, i) => `export const row${String(i + 1).padStart(3, '0')} = ${i + 1};`
	).join('\n');
	const { root, repo, app } = await doneTask('Inline selection', source);
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.getByRole('button', { name: /Inline selection/ }).click();
		await refreshChanges(page);
		await expect
			.poll(() =>
				page.evaluate(
					async () =>
						(await window.brigadir.readChanges({ projectId: 'project', id: 'task' })).checkpoint
				)
			)
			.not.toBeNull();
		await openPanelTab(page, 'files');
		await page.getByRole('treeitem', { name: 'sample.ts', exact: true }).dblclick();
		const editor = page.getByRole('textbox', { name: 'File content', exact: true }),
			actions = page.locator('[data-selection-actions]'),
			draft = page.locator('[data-comment-draft]');
		await editor.focus();
		await editor.press('Meta+a');
		await editor.press('ArrowLeft');
		for (let i = 0; i < 9; i++) await editor.press('ArrowDown');
		const scroller = page.locator('[data-font-surface=editor] .cm-scroller');
		// spec/diff-and-review#selection-panel: a bare selection's panel floats over the code; no line moves while selecting.
		const lineTops = () =>
			page
				.locator('.cm-line')
				.evaluateAll((lines) => lines.slice(0, 30).map((line) => line.getBoundingClientRect().top));
		const before = await lineTops();
		// A mouse drag reaches the lines under the panel: it hides while the button is down.
		{
			const from = (await page.locator('.cm-line').filter({ hasText: 'row010' }).boundingBox())!,
				to = (await page.locator('.cm-line').filter({ hasText: 'row016' }).boundingBox())!;
			await page.mouse.move(from.x + 2, from.y + from.height / 2);
			await page.mouse.down();
			await page.mouse.move(from.x + 60, to.y + to.height / 2 - 40, { steps: 4 });
			await page.mouse.move(from.x + 60, to.y + to.height / 2, { steps: 6 });
			await expect(actions).toBeHidden();
			expect(await lineTops()).toEqual(before);
			await page.mouse.up();
			await expect(actions).toContainText('sample.ts · 10–16');
			expect(await lineTops()).toEqual(before);
		}
		await editor.press('Meta+a');
		await editor.press('ArrowLeft');
		for (let i = 0; i < 9; i++) await editor.press('ArrowDown');
		await expect(actions).toHaveCount(0);
		for (let i = 0; i < 3; i++) {
			await editor.press('Shift+ArrowDown');
			await expect(actions).toBeVisible();
			expect(await lineTops()).toEqual(before);
		}
		await expect(actions).toContainText('sample.ts · 10–12');
		await expect(page.locator('.cm-content [data-editor-selection]')).toHaveCount(1);
		await actions.getByRole('button', { name: 'Comment', exact: true }).click();
		const note = draft.getByRole('textbox', { name: 'Comment', exact: true });
		await expect(note).toBeFocused();
		// spec/appearance#evolution-redesign: the lines it anchors to and the selected code it quotes.
		await expect(draft).toContainText('10–12');
		await expect(draft.locator('[data-code-quote]')).toBeVisible();
		await note.fill('Keep this comment anchored to these three lines.');
		await expect(actions.getByRole('button', { name: 'Comment', exact: true })).toHaveAttribute(
			'aria-pressed',
			'true'
		);
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'Editor')!
				.submenu!.items.find((item) => item.label === 'Toggle comment')!
				.click()
		);
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
		await expect(note).toHaveValue('Keep this comment anchored to these three lines.');
		await scroller.evaluate((node) => {
			node.scrollTop = 2400;
		});
		await expect(actions).not.toBeVisible();
		await scroller.evaluate((node) => {
			node.scrollTop = 0;
		});
		await expect(note).toHaveValue('Keep this comment anchored to these three lines.');
		await expect(actions).toBeVisible();
		// spec/task-window-workspace#layout-switch: the work area hides with its selection actions; they come back with it.
		await showChat(page);
		await hideWorkArea(page);
		await expect(actions).toHaveCount(0);
		await showWorkArea(page);
		await expect(note).toHaveValue('Keep this comment anchored to these three lines.');
		await expect(draft.getByRole('button', { name: 'Add a comment', exact: true })).toBeEnabled();
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`editor-selection-${theme}.png`),
			});
		}
		await draft.getByRole('button', { name: 'Add a comment', exact: true }).click();
		await expect(draft).toHaveCount(0);
		await expect(actions).toHaveCount(0);
		await expect(page.getByRole('article', { name: 'File comment', exact: true })).toContainText(
			'Keep this comment anchored'
		);
		await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
		expect(await readFile(join(repo, 'sample.ts'), 'utf8')).toBe(source);
		await editor.focus();
		await editor.press('Meta+a');
		await editor.press('ArrowLeft');
		for (let i = 0; i < 3; i++) await editor.press('Shift+ArrowDown');
		await actions.getByRole('button', { name: 'To composer', exact: true }).click();
		// spec/composer#mentions: the selection goes into the composer text as a pill of the file with its range.
		const composer = page
				.locator('form')
				.filter({ has: page.getByRole('textbox', { name: 'Message', exact: true }) }),
			message = composer.getByRole('textbox', { name: 'Message', exact: true }),
			chip = message.locator('[data-mention-pill]', { hasText: 'sample.ts:1-3' });
		await expect(chip).toBeVisible();
		await expect(chip).toHaveAttribute('data-kind', 'file');
		await setEditorCaret(message, 0);
		await message.pressSequentially('Explain these lines. ');
		expect(await editorText(message)).toMatch(/^Explain these lines\. @\[att:[0-9a-f-]{36}\] $/);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await composer.screenshot({
				animations: 'disabled',
				path: info.outputPath(`selection-attachment-${theme}.png`),
			});
		}
		// spec/chat#code-pills: the pill opens its file in the editor with its lines selected, not the prompt in a sheet.
		await chip.click();
		await expect
			.poll(() => editorState(editor))
			.toMatchObject({ selected: source.split('\n').slice(0, 3).join('\n'), focused: true });
		await message.fill('Explain these lines.');
		await expect(chip).toHaveCount(0);
		await expect.poll(() => editorText(message)).toBe('Explain these lines.');
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
test('shares syntax, declaration anchors and a review batch between diff and editor @area:diff', async ({}, info) => {
	test.setTimeout(60000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-syntax-ui-'));
	const repo = join(root, 'repo');
	await mkdir(repo);
	const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo });
	await git('init', '-q');
	await git('config', 'user.name', 'Fixture');
	await git('config', 'user.email', 'fixture@localhost');
	const before = 'export function value() {\n  return 1;\n}\n';
	const after = before.replace('return 1', 'return 2');
	await writeFile(join(repo, 'value.ts'), before);
	await git('add', 'value.ts');
	await git('commit', '-qm', 'Baseline');
	const index = await readFile(join(repo, '.git/index'));
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: {
			...env,
			BRIGADIR_DATA_DIR: join(root, 'data'),
			BRIGADIR_TEST_AGENT: resolve('packages/transport/fixtures/agent.mjs'),
		},
	});
	let key: { projectId: string; id: string } | undefined;
	try {
		const page = await app.firstWindow();
		const errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await app.evaluate(({ dialog }, path) => {
			dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
		}, repo);
		await page.getByRole('button', { name: 'Add a project…' }).click();
		await page.getByRole('button', { name: 'New task · repo' }).click();
		await page.getByRole('textbox', { name: 'Message' }).fill('hello');
		await page.getByRole('button', { name: 'Start', exact: true }).click();
		await expect(page.getByRole('log')).toContainText('world');
		key = await page.evaluate(async () => {
			const t = (await window.brigadir.readWorkspace()).tasks[0]!;
			return { id: t.id, projectId: t.projectId };
		});
		await writeFile(join(repo, 'value.ts'), after);
		await refreshChanges(page);
		await openPanelTab(page, 'changes');
		await page
			.getByRole('list', { name: 'Files', exact: true })
			.getByRole('button', { name: /value.ts/ })
			.click();
		const diff = page.getByRole('log', { name: 'Diff', exact: true });
		await expect(
			diff.locator('.syntax-keyword').filter({ hasText: 'return' }).first()
		).toBeVisible();
		await expect(
			diff.locator('.syntax-number[data-changed="true"]').filter({ hasText: '2' })
		).toBeVisible();
		await selectCode(diff, 'new', 2);
		await page.getByRole('button', { name: 'To composer', exact: true }).click();
		const selectedDiff = page
			.getByRole('textbox', { name: 'Message', exact: true })
			.locator('[data-mention-pill]', { hasText: 'value.ts:2-2 · new' });
		// spec/chat#code-pills: the diff's pill opens value.ts in the editor with line 2 selected; the diff tab stays.
		await selectedDiff.click();
		await expect
			.poll(() => editorState(page.getByRole('textbox', { name: 'File content' })))
			.toMatchObject({ selected: after.split('\n')[1], focused: true });
		await page.getByRole('tab', { name: 'Diff · value.ts', exact: true }).click();
		await page.getByRole('textbox', { name: 'Message', exact: true }).fill('');
		await expect(selectedDiff).toHaveCount(0);
		await hideChat(page);
		// Returning from the composer remounts the diff; the line inside the declaration still anchors to it.
		await selectCode(diff, 'new', 2);
		await page.getByRole('button', { name: 'Comment', exact: true }).click();
		await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Diff note');
		await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
		const first = (await page.evaluate((key) => window.brigadir.readReview(key, null), key))
			.comments[0]!;
		expect(first.anchor.symbolPath).toBe('value');
		expect([first.anchor.start, first.anchor.end]).toEqual([2, 2]);
		await page.getByRole('button', { name: 'Open in editor', exact: true }).click();
		const editor = page.getByRole('textbox', { name: 'File content' });
		await expect(editor.locator('.syntax-keyword').filter({ hasText: 'return' })).toBeVisible();
		await expect(page.getByRole('tablist', { name: 'Documents' }).getByRole('tab')).toHaveCount(2);
		await page.getByRole('tab', { name: 'Diff · value.ts', exact: true }).click();
		await expect(diff).toContainText('return 2');
		await page.getByRole('tab', { name: 'value.ts', exact: true }).click();
		await expect(editor).toContainText('return 2');
		await page.getByRole('button', { name: 'Select a declaration', exact: true }).first().click();
		await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeEnabled();
		await page.getByRole('button', { name: 'Comment', exact: true }).click();
		await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Editor note');
		await showChat(page);
		await hideChat(page);
		await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toHaveValue(
			'Editor note'
		);
		await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
		await expect
			.poll(
				async () =>
					(await page.evaluate((key) => window.brigadir.readReview(key, null), key!)).comments
						.length
			)
			.toBe(2);
		const review = await page.evaluate((key) => window.brigadir.readReview(key, null), key);
		expect(review.comments[1]!.anchor.blob).toBe(first.anchor.blob);
		expect(review.comments[1]!.anchor.symbolPath).toBe('value');
		expect(await readFile(join(repo, '.git/index'))).toEqual(index);
		await expect(
			page.locator('.cm-review-note').getByText('Editor note', { exact: true })
		).toBeVisible();
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await page.screenshot({
				animations: 'disabled',
				path: info.outputPath(`syntax-editor-${theme}.png`),
			});
		}
		await page
			.getByRole('textbox', { name: 'General note', exact: true })
			.fill('General note before edit');
		await page.getByRole('button', { name: 'Add note', exact: true }).click();
		await openReview(page);
		const note = page.getByRole('article').filter({ hasText: 'General note before edit' });
		await note.getByRole('button', { name: 'Edit comment', exact: true }).click();
		await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Edited general note');
		await page
			.getByRole('dialog', { name: 'Review', exact: true })
			.getByRole('button', { name: 'Save', exact: true })
			.click();
		await expect(
			page.getByRole('article').filter({ hasText: 'Edited general note' })
		).toBeVisible();
		await page
			.getByRole('dialog', { name: 'Review', exact: true })
			.getByRole('button', { name: 'Close', exact: true })
			.click();
		await page.getByRole('button', { name: 'Send review', exact: true }).click();
		await expect
			.poll(async () =>
				(await page.evaluate((key) => window.brigadir.readReview(key, null), key!)).comments.every(
					(c) => c.sent
				)
			)
			.toBe(true);
		await expect(
			page.locator('.cm-review-note header span').filter({ hasText: 'Sent' })
		).toHaveCount(2);
		expect(
			(await page.evaluate((key) => window.brigadir.readReview(key, null), key)).notes?.[0]
		).toMatchObject({ text: 'Edited general note', version: 2, sent: true });
		await page.getByRole('button', { name: 'Select a declaration', exact: true }).first().click();
		await page.getByRole('button', { name: 'Comment', exact: true }).click();
		await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Immediate feedback');
		await page.evaluate(
			(key) => window.brigadir.sendCommand(key, { kind: 'prompt', text: 'hold' }),
			key
		);
		await page.getByRole('button', { name: 'Send to chat', exact: true }).click();
		await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toHaveCount(0);
		await expect(editor).toBeVisible();
		await expect
			.poll(
				async () =>
					(await page.evaluate((key) => window.brigadir.readSession(key), key!)).records.filter(
						(record) =>
							record.event.kind === 'prompt.queued' &&
							record.event.prompt.command.text.includes('Immediate feedback')
					).length
			)
			.toBe(1);
		await page.evaluate((key) => window.brigadir.sendCommand(key, { kind: 'cancel' }), key);
		await expect
			.poll(async () => {
				const records = (await page.evaluate((key) => window.brigadir.readSession(key), key!))
						.records,
					started = records.find(
						(record) =>
							record.event.kind === 'turn.started' &&
							record.event.text.includes('Immediate feedback')
					);
				return Boolean(
					started &&
					records.some(
						(record) => record.seq > started.seq && record.event.kind === 'turn.completed'
					)
				);
			})
			.toBe(true);
		await page.getByRole('button', { name: 'Select a declaration', exact: true }).first().click();
		await page.getByRole('button', { name: 'Comment', exact: true }).click();
		await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Menu feedback');
		await page.getByRole('textbox', { name: 'Comment', exact: true }).focus();
		await app.evaluate(({ Menu }) =>
			Menu.getApplicationMenu()!
				.items.find((item) => item.label === 'View')!
				.submenu!.items.find((item) => item.label === 'Submit')!
				.click()
		);
		await expect(page.getByRole('textbox', { name: 'Comment', exact: true })).toHaveCount(0);
		await expect(editor).toBeVisible();
		await expect
			.poll(
				async () =>
					(await page.evaluate((key) => window.brigadir.readSession(key), key!)).records.filter(
						(record) =>
							record.event.kind === 'turn.started' && record.event.text.includes('Menu feedback')
					).length
			)
			.toBe(1);
		expect(
			(await page.evaluate((key) => window.brigadir.readSession(key), key!)).records.filter(
				(record) =>
					record.event.kind === 'turn.started' && record.event.text.includes('Immediate feedback')
			)
		).toHaveLength(1);
		await editor.locator('.cm-line').first().click();
		await editor.press('Meta+a');
		await page.keyboard.insertText('export function fresh() { return "🧱"; }');
		await expect(editor.locator('.syntax-string')).toHaveText('"🧱"');
		// While the next parse is held, colors follow the typed text and no frame goes plain.
		await app.evaluate(({ ipcMain }) => {
			const handlers = (ipcMain as any)._invokeHandlers,
				original = handlers.get('files:syntax');
			handlers.set('files:syntax', async (...args: any[]) => {
				handlers.set('files:syntax', original);
				await new Promise<void>((resolve) => {
					(globalThis as any).releaseEditorSyntax = resolve;
				});
				return original(...args);
			});
		});
		await page.evaluate(() => {
			const content = document.querySelector('[data-font-surface=editor] .cm-content')!,
				probe = { least: Infinity };
			(window as any).syntaxProbe = probe;
			const count = () => {
				probe.least = Math.min(probe.least, content.querySelectorAll('.syntax-keyword').length);
			};
			count();
			new MutationObserver(count).observe(content, {
				subtree: true,
				childList: true,
				characterData: true,
			});
		});
		await page.keyboard.insertText(' const tail = 1;');
		await expect
			.poll(() => app.evaluate(() => typeof (globalThis as any).releaseEditorSyntax))
			.toBe('function');
		await expect(editor.locator('.syntax-string')).toHaveText('"🧱"');
		await page.screenshot({
			animations: 'disabled',
			path: info.outputPath('syntax-editor-typing.png'),
		});
		await app.evaluate(() => (globalThis as any).releaseEditorSyntax());
		await expect(editor.locator('.syntax-number').filter({ hasText: '1' })).toBeVisible();
		expect(await page.evaluate(() => (window as any).syntaxProbe.least)).toBeGreaterThanOrEqual(3);
		await editor.press('Meta+a');
		await expect(page.getByRole('button', { name: 'Comment', exact: true })).toBeDisabled();
		await page.getByRole('button', { name: 'To composer', exact: true }).click();
		await page
			.getByRole('textbox', { name: 'Message', exact: true })
			.locator('[data-mention-pill]', { hasText: 'value.ts:1-1' })
			.click();
		// spec/chat#code-pills: the pill of an unsaved buffer's lines takes the editor back with line 1 selected.
		await expect
			.poll(async () => {
				const state = await editorState(editor);
				return state.focused && state.selected === state.text.split('\n')[0];
			})
			.toBe(true);
		await page.getByRole('textbox', { name: 'Message', exact: true }).fill('');
		await hideChat(page);
		await page.getByRole('button', { name: 'Close file · value.ts' }).click();
		await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
		expect(await readFile(join(repo, 'value.ts'), 'utf8')).toBe(after);
		await writeFile(join(repo, 'stable.ts'), 'export const stable = true;\n');
		await refreshChanges(page);
		await openPanelTab(page, 'files');
		await page
			.getByRole('tree', { name: 'Project files' })
			.getByRole('treeitem', { name: 'stable.ts', exact: true })
			.dblclick();
		await expect(editor).toContainText('stable = true');
		await editor.press('Meta+a');
		await page.getByRole('button', { name: 'Comment', exact: true }).click();
		await page.getByRole('textbox', { name: 'Comment', exact: true }).fill('Unchanged editor note');
		await app.evaluate(({ ipcMain }) => {
			const handlers = (ipcMain as any)._invokeHandlers,
				original = handlers.get('review:editor-add');
			handlers.set('review:editor-add', async (...args: any[]) => {
				handlers.set('review:editor-add', original);
				await new Promise<void>((resolve) => {
					(globalThis as any).finishComment = resolve;
				});
				return original(...args);
			});
		});
		await page.getByRole('button', { name: 'Add a comment', exact: true }).click();
		await expect
			.poll(() => app.evaluate(() => typeof (globalThis as any).finishComment))
			.toBe('function');
		await page.getByRole('tab', { name: 'Diff · value.ts', exact: true }).click();
		const timeline = await page.evaluate((key) => window.brigadir.readTimeline(key), key);
		await openPanelTab(page, 'changes');
		await page.getByRole('button', { name: 'Diff options', exact: true }).click();
		await page.getByRole('button', { name: 'Base', exact: true }).click();
		await page
			.getByRole('listbox', { name: 'Base', exact: true })
			.getByText(`#${timeline.at(-1)!.id}`, { exact: true })
			.click();
		await expect
			.poll(() =>
				page.evaluate(async (key) => (await window.brigadir.readChanges(key)).files.length, key!)
			)
			.toBe(0);
		await openReview(page);
		await app.evaluate(() => (globalThis as any).finishComment());
		await expect(
			page.getByRole('article').filter({ hasText: 'Unchanged editor note' })
		).toBeVisible();
		await page.screenshot({ animations: 'disabled', path: info.outputPath('review-status.png') });
		await page
			.getByRole('log', { name: 'Review', exact: true })
			.getByRole('button', { name: 'stable.ts', exact: true })
			.click();
		await expect(editor).toContainText('stable = true');
		expect(errors).toEqual([]);
	} finally {
		if (key)
			await app
				.windows()[0]
				?.evaluate(
					(key) => window.brigadir.sendCommand(key, { kind: 'shutdown' }).catch(() => {}),
					key
				)
				.catch(() => {});
		await app
			.evaluate(({ dialog }) => {
				dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
			})
			.catch(() => {});
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
