import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { connectDevice, freePorts, launch, machine } from './remote-fixture';

/**
 * Security review: what a page of the machine's browser or the machine
 * itself may not do to a device that streams it.
 */
function inPage(app: ElectronApplication, url: string, script: string) {
	return app.evaluate(
		({ webContents }, { url, script }) => {
			const web = webContents.getAllWebContents().find((item) => item.getURL().startsWith(url));
			return web ? web.executeJavaScript(script) : null;
		},
		{ url, script }
	);
}
/** The device's clipboard without the system one: what it was given. */
async function fakeClipboard(app: ElectronApplication) {
	await app.evaluate(({ clipboard }) => {
		const written: string[] = ((globalThis as any).deviceWritten = []);
		(clipboard as any).writeText = (value: string) => written.push(value);
	});
	return () => app.evaluate(() => (globalThis as any).deviceWritten as string[]);
}
/** The machine's main still answers: a native dialog's `runModal` would hold it. */
async function answers(app: ElectronApplication) {
	return Promise.race([
		app.evaluate(() => true),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 5000)),
	]);
}
const pagePage = (
	frame: string
) => `<!doctype html><meta charset="utf-8"><title>Hostile page</title>
<style>html,body{margin:0;height:100%;background:rgb(200,30,30)}iframe{width:300px;height:100px;border:0}</style>
<iframe id="frame" src="${frame}"></iframe>
<script>
window.frameAsk = () => document.getElementById('frame').contentWindow.postMessage('ask', '*');
// The page tries to hand its dialogs back to Electron: the script's state is not the page's to change.
window.flip = () => {
  try { window[Symbol.for('brigadir.agent')].set({ dialogs: false, clipboard: false, pickers: false, next: null, buffer: '', ask: null }); } catch {}
  alert('After the flip');
};
// A page that does not stop asking.
window.flood = () => {
  for (let i = 0; i < 5; i++) alert('Flood ' + i);
  document.title = 'flooded ' + confirm('Still there?');
};
</script>`;
const framePage = `<!doctype html><meta charset="utf-8"><body style="background:white">frame
<script>addEventListener('message', () => alert('Hello from the frame'));</script>`;

// A page cannot open Electron's own dialog on the machine (a `runModal` that stops its main) — neither by switching
// the page script off nor from a cross-site frame; the device answers both.
test('a page of a streamed tab cannot get past the device for its dialogs, nor flood it with them @area:browser @serial', async ({}, info) => {
	test.setTimeout(180_000);
	const server = createServer((request, response) => {
		response.setHeader('Content-Type', 'text/html');
		const port = (server.address() as { port: number }).port;
		response.end(request.url === '/frame' ? framePage : pagePage(`http://localhost:${port}/frame`));
	});
	await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
	const port0 = (server.address() as { port: number }).port;
	const url = `http://127.0.0.1:${port0}/`;
	const port = await freePorts();
	const studio = await machine('studio', true, 'Remote fixture task'),
		thinkpad = await machine('ThinkPad', true, null);
	const work = await launch(studio, port),
		device = await launch(thinkpad, port + 10);
	try {
		const { remote } = await connectDevice(work, device, port);
		await remote.getByRole('button', { name: /Remote fixture task/ }).click();
		await remote.evaluate(() => window.brigadir.dispatchWorkspaceAction('browser'));
		const panel = remote.getByRole('region', { name: 'Browser', exact: true });
		const address = panel.getByRole('textbox', { name: 'Address' });
		await address.fill(url);
		await address.press('Enter');
		await expect(panel.locator('canvas[data-browser-screen]')).toBeVisible();
		await expect
			.poll(() => inPage(work, url, 'document.title'), { timeout: 15_000 })
			.toBe('Hostile page');
		const pageDialog = (type: string) => remote.locator(`dialog[data-remote-page="${type}"]`);
		await expectDialog(remote, work, url, 'setTimeout(() => frameAsk(), 300); true', {
			text: 'Hello from the frame',
			// The frame's own site names the dialog, not the page around it.
			site: `localhost:${port0}`,
		});
		await expectDialog(remote, work, url, 'setTimeout(() => flip(), 0); true', {
			text: 'After the flip',
			site: `127.0.0.1:${port0}`,
		});
		await expect(pageDialog('alert')).toBeHidden();
		// Print and the file system pickers would be windows of the machine too: refused while the device streams.
		void inPage(
			work,
			url,
			`setTimeout(async () => { print(); const picked = await showOpenFilePicker().then(() => 'opened', (error) => error.name); document.title = 'printed ' + picked; }, 0); true`
		);
		await expect.poll(() => inPage(work, url, 'document.title')).toBe('printed NotAllowedError');
		expect(await answers(work)).toBe(true);

		// The device's clipboard takes the page's copy only right after the person's click or key here — a pointer
		// passing over the page is not one, and an event the machine sends on its own is not either.
		const written = await fakeClipboard(device);
		const canvas = panel.locator('canvas[data-browser-screen]'),
			box = (await canvas.boundingBox())!;
		// The stream's own key and tab, from a frame the page draws now.
		const streamed = remote.evaluate(
			() =>
				new Promise<{ key: unknown; tab: string }>((resolve) => {
					const off = window.brigadir.onBrowserScreen((event) => {
						off();
						resolve({ key: event.key, tab: event.tab });
					});
				})
		);
		await inPage(work, url, `document.body.style.background = 'rgb(30,60,200)'; true`);
		const target = await streamed;
		await remote.mouse.move(box.x + 400, box.y + 300);
		await remote.mouse.move(box.x + 420, box.y + 320);
		await inPage(
			work,
			url,
			`__brigadirAgent(JSON.stringify({ kind: 'copy', text: 'hovered' })); true`
		);
		// What the device's main hands the window for a machine's `browser:screen` event, as is.
		await device.evaluate(({ BrowserWindow }, target) => {
			const window = BrowserWindow.getAllWindows().find((item) =>
				item.getTitle().startsWith('studio')
			)!;
			window.webContents.send('browser:screen', {
				...target,
				kind: 'copy',
				text: 'from the machine',
			});
		}, target);
		await new Promise((resolve) => setTimeout(resolve, 1000));
		expect(await written()).toEqual([]);
		await remote.mouse.click(box.x + 400, box.y + 300);
		await inPage(
			work,
			url,
			`__brigadirAgent(JSON.stringify({ kind: 'copy', text: 'clicked' })); true`
		);
		await expect.poll(written).toEqual(['clicked']);

		// From the second dialog in a row the device offers «Don't show more dialogs from this page»; ticked, the
		// page's alerts close and its confirm cancels by themselves until the page navigates.
		const reload = async () => {
			await inPage(work, url, 'location.reload(); true').catch(() => null);
			await expect
				.poll(() => inPage(work, url, 'document.readyState + document.title'))
				.toBe('completeHostile page');
		};
		await reload();
		void inPage(work, url, 'setTimeout(() => flood(), 0); true');
		const alertDialog = pageDialog('alert'),
			tick = alertDialog.getByRole('checkbox', { name: "Don't show more dialogs from this page" });
		await expect(alertDialog).toContainText('Flood 0');
		await expect(tick).toHaveCount(0);
		await alertDialog.getByRole('button', { name: 'OK', exact: true }).click();
		await expect(alertDialog).toContainText('Flood 1');
		await tick.check();
		for (const theme of ['dark', 'light'] as const) {
			await device.evaluate(({ nativeTheme }, theme) => {
				nativeTheme.themeSource = theme;
			}, theme);
			await expect(remote.locator('html')).toHaveAttribute('data-theme', theme);
			await alertDialog.screenshot({
				animations: 'disabled',
				path: info.outputPath(`page-alert-mute-${theme}.png`),
			});
		}
		await alertDialog.getByRole('button', { name: 'OK', exact: true }).click();
		await expect.poll(() => inPage(work, url, 'document.title')).toBe('flooded false');
		await expect(alertDialog).toBeHidden();
		await expect(pageDialog('confirm')).toBeHidden();
		expect(await answers(work)).toBe(true);
		// A new document asks again, without the tick.
		await reload();
		void inPage(work, url, `setTimeout(() => alert('After the reload'), 0); true`);
		await expect(alertDialog).toContainText('After the reload');
		await expect(tick).toHaveCount(0);
		await alertDialog.getByRole('button', { name: 'OK', exact: true }).click();
		await expect(alertDialog).toBeHidden();
	} finally {
		await device.close();
		await work.close();
		server.close();
	}
});
async function expectDialog(
	remote: Page,
	work: ElectronApplication,
	url: string,
	script: string,
	expected: { text: string; site: string }
) {
	void inPage(work, url, script);
	const dialog = remote.locator('dialog[data-remote-page="alert"]');
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText(expected.text);
	await expect(dialog).toContainText(expected.site);
	expect(await answers(work)).toBe(true);
	await dialog.getByRole('button', { name: 'OK', exact: true }).click();
	await expect(dialog).toBeHidden();
}
