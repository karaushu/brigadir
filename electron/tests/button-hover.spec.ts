import { expect, test, type Page } from '@playwright/test';
import { fixturePRs, launchPRFixture } from './pr-fixture';
import { repoPRs } from './repos';

/**
 * Rule 15: a hover tints a button, it never takes its fill away. The global `button:hover` in tokens.css outranks a
 * module's single class, so a `background` there turned filled buttons (the accent «Hand to the agent») see-through.
 * Every visible enabled button with a fill keeps that fill under the pointer.
 */
async function filledLoseFill(page: Page) {
	const lost: string[] = [];
	for (const button of await page.locator('button:visible:not(:disabled)').all()) {
		const fill = () => button.evaluate((element) => getComputedStyle(element).backgroundColor);
		const before = await fill().catch(() => '');
		const alpha = (value: string) => {
			const parts = value.match(/[\d.]+/g)?.map(Number) ?? [];
			return parts.length === 4 ? parts[3]! : parts.length === 3 ? 1 : 0;
		};
		if (alpha(before) < 0.5) continue;
		if (
			!(await button.hover({ timeout: 1000 }).then(
				() => true,
				() => false
			))
		)
			continue;
		await page.waitForTimeout(160);
		const after = await fill().catch(() => before);
		if (alpha(after) < alpha(before) - 0.2)
			lost.push(
				`${(await button.innerText().catch(() => '')).trim() || (await button.getAttribute('aria-label'))}: ${before} → ${after}`
			);
	}
	await page.mouse.move(1, 1);
	return lost;
}

test('filled buttons keep their fill on hover: the PR panel of my own PR and its footer (rule 15) @area:shell', async () => {
	test.setTimeout(180000);
	const prs = fixturePRs().map((pr) =>
		pr.number === 419
			? {
					...pr,
					threads: [
						{
							path: 'src/orders/csv.ts',
							line: 12,
							comments: [{ author: 'olena-p', body: 'Escape quotes in customer names.' }],
						},
					],
				}
			: pr
	);
	const { close, page, errors } = await launchPRFixture({ prs });
	try {
		await repoPRs(page, 'apps/admin');
		await page.locator('[data-pr-row="419"]').click();
		const hand = page
			.locator('[data-pr-own-footer]')
			.getByRole('button', { name: 'Hand to the agent', exact: true });
		await expect(hand).toBeEnabled();
		const fill = () => hand.evaluate((element) => getComputedStyle(element).backgroundColor);
		const rest = await fill();
		await hand.hover();
		await page.waitForTimeout(160);
		expect(await fill()).toBe(rest);
		expect(await filledLoseFill(page)).toEqual([]);
		expect(errors).toEqual([]);
	} finally {
		await close();
	}
});
