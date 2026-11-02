import type { Page } from '@playwright/test';
/**
 * spec/task-window-workspace#layout-switch: the task window's Layout switches. Tests say what they need — the chat on screen, or
 * the chat away.
 */
async function setColumn(page: Page, column: 'chat' | 'work' | 'panel', on: boolean) {
	const button = page.locator(`[data-switch="${column}"]`);
	await button.waitFor();
	if ((await button.getAttribute('aria-checked')) !== String(on)) await button.click();
}
export const showChat = (page: Page) => setColumn(page, 'chat', true);
export const hideChat = (page: Page) => setColumn(page, 'chat', false);
export const showPanel = (page: Page) => setColumn(page, 'panel', true);
export const hidePanel = (page: Page) => setColumn(page, 'panel', false);
export const showWorkArea = (page: Page) => setColumn(page, 'work', true);
export const hideWorkArea = (page: Page) => setColumn(page, 'work', false);
/**
 * spec/task-window-workspace#layout-switch: a new task opens without the panel. A test that needs a panel tab shows the panel and picks
 * the tab, as a person does with the panel switch.
 */
export async function openPanelTab(page: Page, tab: 'files' | 'changes' | 'prs') {
	await showPanel(page);
	await page.locator(`[data-panel-tab=${tab}]`).click();
}
