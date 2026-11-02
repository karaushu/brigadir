import type { Page } from '@playwright/test';
/**
 * Waits for the page to stop moving instead of sleeping: two frames, then every finite CSS/Web animation has finished
 * (repeated, because one animation often starts the next). Use before a screenshot or a geometry read after a
 * transition; never to wait for something that should NOT happen (that is a legitimate fixed pause).
 */
export async function settle(page: Page) {
	await page.evaluate(async () => {
		const frames = () =>
			new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
		await frames();
		for (let round = 0; round < 20; round++) {
			const running = document
				.getAnimations()
				.filter(
					(animation) =>
						animation.playState === 'running' &&
						animation.effect?.getComputedTiming().iterations !== Infinity
				);
			if (!running.length) return;
			await Promise.all(running.map((animation) => animation.finished.catch(() => {})));
			await frames();
		}
	});
}
