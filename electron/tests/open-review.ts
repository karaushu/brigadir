import { expect, type Page } from '@playwright/test';
import { hideChat } from './layout';
export async function openReview(page: Page) {
	const summary = page.getByRole('button').and(page.getByTitle('Review', { exact: true }));
	if (!(await summary.isVisible())) await hideChat(page);
	await expect(summary).toBeVisible();
	await summary.click();
}
