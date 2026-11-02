import { expect, type ElectronApplication, type Page } from '@playwright/test';
/**
 * spec/appearance#evolution-redesign (spec/task-window#repo-line): the repos of a task are in its header — one chip for the main repo and «+N ▾» with the
 * «Repos k/n» popover — and are roots of the panel's Files and Changes. The sidebar has no Repos block.
 */
export function reposPopover(page: Page) {
	return page.locator('[data-repos-popover]');
}
/** Opens «+N ▾» in the task header and returns the popover. */
export async function openRepos(page: Page) {
	const popover = reposPopover(page);
	if (!(await popover.isVisible())) await page.locator('[data-repos-button]').click();
	await expect(popover).toBeVisible();
	return popover;
}
/** A repo's row in the «Repos k/n» popover. */
export async function repoRow(page: Page, scope: string) {
	return (await openRepos(page)).locator(`[data-scope="${scope}"]`);
}
/** spec/pull-requests-and-ci#repo-counter: the repo's PR counter, from the popover's row; it opens the PR tab on that repo. */
export async function repoPRs(page: Page, scope: string) {
	await (await repoRow(page, scope)).locator('[data-repo-prs]').click();
}
/** spec/task-window#repo-line: the project's main tree, from the project's menu in the sidebar (the native menu is answered here). */
export async function openMainTree(app: ElectronApplication, page: Page, project: string) {
	await app.evaluate(({ Menu }) => {
		const original = Menu.prototype.popup;
		Menu.prototype.popup = function () {
			Menu.prototype.popup = original;
			const item = this.items.find((entry) => entry.label === 'Open main tree');
			if (!item) throw new Error('Missing menu Open main tree');
			item.click();
		};
	});
	await page.locator(`aside [aria-label="${project}"]`).first().dispatchEvent('contextmenu');
	await expect(page.locator('[data-task-main]')).toBeVisible();
}
