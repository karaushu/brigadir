import { type Page } from '@playwright/test';
/**
 * Use the actual inspector action. It lives in the panel; a new task opens without the panel (spec/task-window-workspace#layout-switch), so the
 * panel opens on Changes for the click and goes back to the tab and the visibility it had.
 */
export async function refreshChanges(page: Page) {
	const button = page.getByRole('button', {
		name: 'Create snapshot and refresh changes',
		exact: true,
	});
	if (await button.isVisible()) {
		await button.click();
		return;
	}
	const panel = page.locator('[data-switch="panel"]');
	await panel.waitFor();
	const hidden = (await panel.getAttribute('aria-checked')) !== 'true';
	if (hidden) await panel.click();
	const selected = page.locator('[data-panel-tab][aria-selected="true"]');
	await selected.waitFor();
	const previous = await selected.getAttribute('data-panel-tab');
	await page.locator('[data-panel-tab=changes]').click();
	await button.click();
	if (previous && previous !== 'changes')
		await page.locator(`[data-panel-tab=${previous}]`).click();
	if (hidden) await panel.click();
}
