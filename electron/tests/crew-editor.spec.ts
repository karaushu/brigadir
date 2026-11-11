import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const desktop = resolve('apps/desktop'),
	executablePath = createRequire(join(desktop, 'package.json'))('electron') as string;
/** The crew editor from «Set up…» (CrewTree, CrewAddAgent) and the Templates library tab (SettingsTemplates). */
test('builds a crew in the editor, saves it as a template and manages the library @area:tasks', async ({}, info) => {
	test.setTimeout(180_000);
	const root = await mkdtemp(join(tmpdir(), 'brigadir-crew-editor-')),
		repo = join(root, 'repo');
	await mkdir(repo);
	const project = join(root, 'data/projects/project');
	await mkdir(project, { recursive: true });
	await writeFile(
		join(project, 'project.json'),
		JSON.stringify({ schemaVersion: 1, project: { id: 'project', name: 'repo', path: repo } })
	);
	const env = Object.fromEntries(
		Object.entries(process.env).filter(
			(e): e is [string, string] => typeof e[1] === 'string' && e[0] !== 'ELECTRON_RUN_AS_NODE'
		)
	);
	const app = await electron.launch({
		executablePath,
		args: [desktop, `--user-data-dir=${join(root, 'profile')}`],
		env: { ...env, BRIGADIR_DATA_DIR: join(root, 'data') },
	});
	try {
		const page = await app.firstWindow(),
			errors: string[] = [];
		page.on('pageerror', (e) => errors.push(e.message));
		await page.emulateMedia({ reducedMotion: 'no-preference' });
		await page.getByRole('button', { name: 'New task · repo' }).click();
		const sheet = page.getByRole('dialog');
		await sheet.getByRole('radio', { name: 'Brigadir' }).click();
		await sheet.getByRole('button', { name: 'Crew', exact: true }).click();
		await sheet
			.getByRole('listbox', { name: 'Crew' })
			.getByRole('option', { name: /^Crew \d/ })
			.click();
		await sheet.getByRole('button', { name: 'Set up…' }).click();
		const editor = page.getByRole('dialog', { name: 'Crew' });
		await expect(editor).toBeVisible();
		// CrewTree: root + one developer selected, inspector shows its fields.
		await expect(editor.locator('[data-crew-node]')).toHaveCount(4);
		await expect(editor.locator('[data-crew-summary]')).toContainText('3 agents');
		await expect(editor.locator('svg path[stroke="var(--amber)"]')).toHaveCount(2);
		const inspector = editor.locator('[data-crew-inspector]');
		await expect(inspector.getByRole('textbox', { name: 'Name' })).toHaveValue('Developer 1');
		// CrewAddAgent: «+ Agent» opens the template popup; picking Reviewer adds a selected node with the name focused.
		await editor.locator('[data-crew-add-slot]').click();
		const menu = editor.getByRole('menu', { name: 'Agent templates' });
		await expect(menu.getByRole('menuitem')).toHaveCount(9);
		await menu.getByRole('menuitem', { name: /^Reviewer/ }).click();
		await expect(editor.locator('[data-crew-node]')).toHaveCount(5);
		await expect(
			editor.locator('[data-crew-node][data-selected="true"][data-role="reviewer"]')
		).toHaveCount(1);
		await expect(inspector.getByRole('textbox', { name: 'Name' })).toBeFocused();
		await inspector.getByRole('textbox', { name: 'Name' }).fill('Designer');
		await expect(
			editor.locator('[data-crew-node][data-role="reviewer"]').filter({ hasText: 'Designer' })
		).toHaveCount(1);
		// spec/crew-templates-and-editor#roster: the specialty is one line the foreman reads; the root has none.
		await inspector
			.getByRole('textbox', { name: 'Specialty' })
			.fill('Checks screens against the design');
		// A check edge from the inspector: Developer checked by Designer draws the amber dashed path.
		await editor.locator('[data-crew-node]').nth(1).click();
		await inspector.getByRole('button', { name: 'Checked by · +' }).click();
		await editor
			.getByRole('menu', { name: 'Checked by' })
			.getByRole('menuitem', { name: 'Designer' })
			.click();
		await expect(inspector.getByRole('button', { name: 'Remove check · Designer' })).toBeVisible();
		await expect(editor.locator('svg path[stroke="var(--amber)"]')).toHaveCount(3);
		// The line carries its own remove handle; removing and re-adding by drag shows the dashed preview first.
		await editor
			.getByRole('button', { name: 'Remove check · Designer → Developer 1' })
			.click({ force: true });
		await expect(editor.locator('svg path[stroke="var(--amber)"]')).toHaveCount(2);
		const reviewerNode = editor
				.locator('[data-crew-node][data-role="reviewer"]')
				.filter({ hasText: 'Designer' }),
			developerNode = editor.locator('[data-crew-node]').nth(1);
		await reviewerNode.dispatchEvent('dragstart', {
			dataTransfer: await page.evaluateHandle(() => new DataTransfer()),
		});
		await developerNode.dispatchEvent('dragover', {
			dataTransfer: await page.evaluateHandle(() => new DataTransfer()),
		});
		await expect(editor.locator('[data-crew-edge-preview]')).toHaveCount(1);
		await developerNode.dispatchEvent('drop', {
			dataTransfer: await page.evaluateHandle(() => new DataTransfer()),
		});
		await reviewerNode.dispatchEvent('dragend', {
			dataTransfer: await page.evaluateHandle(() => new DataTransfer()),
		});
		await expect(editor.locator('[data-crew-edge-preview]')).toHaveCount(0);
		await expect(editor.locator('svg path[stroke="var(--amber)"]')).toHaveCount(3);
		// «+» under Developer adds a subordinate: Developer becomes a lead with the Foreman template and loses its check edge.
		await editor.locator('[data-crew-node]').nth(1).hover();
		await editor.locator('[data-crew-add-child]').click();
		await editor
			.getByRole('menu', { name: 'Agent templates' })
			.getByRole('menuitem', { name: /^Developer/ })
			.click();
		await expect(editor.locator('[data-crew-node]')).toHaveCount(6);
		await editor.locator('[data-crew-node]').nth(1).click();
		await expect(inspector.getByText('has subordinates', { exact: true })).toBeVisible();
		await expect(inspector.getByRole('button', { name: 'Agent templates' })).toBeDisabled();
		await expect(editor.locator('svg path[stroke="var(--amber)"]')).toHaveCount(1);
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await editor.screenshot({
				animations: 'disabled',
				path: info.outputPath(`crew-editor-${theme}.png`),
			});
		}
		// Removing the last subordinate restores the leaf draft.
		await editor.locator('[data-crew-node]').nth(2).click();
		await expect(inspector.getByRole('textbox', { name: 'Name' })).toHaveValue('Developer');
		await inspector.getByRole('button', { name: 'Remove agent' }).click();
		await expect(editor.locator('[data-crew-node]')).toHaveCount(5);
		await editor.locator('[data-crew-node]').nth(1).click();
		await expect(inspector.getByRole('button', { name: 'Agent templates' })).toBeEnabled();
		await expect(inspector.getByRole('button', { name: 'Agent templates' })).toContainText(
			'Developer'
		);
		// Save as crew template, then Done: the sheet shows the one-off crew and the library has the new template.
		await editor.getByRole('textbox', { name: 'Crew · Name' }).fill('Front + Design');
		await editor.getByRole('button', { name: 'Save as crew template' }).click();
		await expect
			.poll(
				async () => (await readdir(join(root, 'data', 'templates', 'crews')).catch(() => [])).length
			)
			.toBe(1);
		const [crewFile] = await readdir(join(root, 'data', 'templates', 'crews'));
		const saved = JSON.parse(
			await readFile(join(root, 'data', 'templates', 'crews', crewFile!), 'utf8')
		);
		expect(
			saved.template.root.agents.find((agent: { name: string }) => agent.name === 'Designer')
				.summary
		).toBe('Checks screens against the design');
		await editor.locator('[data-crew-node][data-root="true"]').click();
		await expect(inspector.getByRole('textbox', { name: 'Specialty' })).toHaveCount(0);
		await editor.getByRole('button', { name: 'Done' }).click();
		await expect(editor).toHaveCount(0);
		await expect(sheet.locator('[data-crew-roster]')).toContainText('Designer');
		await expect(sheet.getByRole('button', { name: 'Crew', exact: true })).toContainText(
			'Front + Design'
		);
		await sheet.getByRole('button', { name: 'Cancel' }).click();
		// Settings ▸ Templates: groups, own template with the pencil, duplicate a built-in, delete the copy, import/export exist.
		await app.evaluate(({ BrowserWindow }) => {
			BrowserWindow.getAllWindows()[0]!.webContents.send('workspace:action', 'settings-templates');
		});
		const settings = page.getByRole('dialog', { name: 'Settings' });
		await expect(settings.getByRole('tab', { name: 'Templates' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		const list = settings.getByRole('listbox', { name: 'Templates' });
		await expect(list.getByRole('option')).toHaveCount(8 + 4);
		await expect(list.getByRole('option', { name: /Front \+ Design/ })).toContainText('4');
		await list.getByRole('option', { name: /^Reviewer/ }).click();
		await expect(settings.getByText('built-in', { exact: true })).toBeVisible();
		await expect(settings.getByRole('textbox', { name: 'Name' })).toBeDisabled();
		await expect(settings.getByRole('textbox', { name: 'Specialty' })).toHaveCount(0);
		await settings.getByRole('button', { name: 'Duplicate' }).click();
		await expect(list.getByRole('option')).toHaveCount(13);
		await expect(settings.getByRole('textbox', { name: 'Name' })).toHaveValue('Reviewer 2');
		await settings
			.getByRole('textbox', { name: 'Specialty' })
			.fill('Reviews screens against the design');
		await settings
			.getByRole('textbox', { name: 'Instructions' })
			.fill('Check the screens against the design.');
		await expect
			.poll(async () => {
				const files = await readdir(join(root, 'data', 'templates', 'agents')).catch(() => []);
				for (const file of files) {
					const doc = JSON.parse(
						await readFile(join(root, 'data', 'templates', 'agents', file), 'utf8')
					);
					if (doc.template.instructions === 'Check the screens against the design.')
						return doc.template.summary;
				}
				return null;
			})
			.toBe('Reviews screens against the design');
		for (const theme of ['light', 'dark'] as const) {
			await app.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
			await settings.screenshot({
				animations: 'disabled',
				path: info.outputPath(`settings-templates-${theme}.png`),
			});
		}
		// Export acts on the selected template from its header; Import creates one from the «+» menu; the 222 px footer fits.
		await expect(settings.getByRole('button', { name: 'Export…' })).toBeEnabled();
		await settings.getByRole('button', { name: 'Delete' }).click();
		await expect(list.getByRole('option')).toHaveCount(12);
		expect(
			await settings
				.locator('[data-templates] > [role=listbox] > :last-child')
				.evaluate((node) => node.scrollWidth <= node.clientWidth)
		).toBe(true);
		await settings.getByRole('button', { name: 'Create' }).click();
		await expect(settings.getByRole('menuitem', { name: 'Import…' })).toBeVisible();
		await page.keyboard.press('Escape');
		// spec/appearance#popover-shell: Esc closes the Create menu only, focus back on Create; Settings stays open.
		await expect(settings.getByRole('menu', { name: 'Create' })).toHaveCount(0);
		await expect(settings).toBeVisible();
		await expect(settings.getByRole('button', { name: 'Create' })).toBeFocused();
		expect(errors).toEqual([]);
	} finally {
		await app.close();
		await rm(root, { recursive: true, force: true });
	}
});
