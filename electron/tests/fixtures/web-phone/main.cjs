// spec/remote-access-and-mobile#phone-network, spec/remote-access-and-mobile#phone-app: «the phone» of tests/remote-web*.spec.ts — a hidden Chromium window at the machine's web listener,
// as wide as the phone it plays (BRIGADIR_PHONE_SIZE, default iPhone 390×844) with its user agent (BRIGADIR_PHONE_UA). No
// Chromium of Playwright on this computer, so Electron is the browser; it never takes the dock or the focus.
const { app, BrowserWindow } = require('electron');
if (process.platform === 'darwin') app.setActivationPolicy('accessory');
app.whenReady().then(() => {
	const [width, height] = (process.env.BRIGADIR_PHONE_SIZE || '390x844').split('x').map(Number);
	const window = new BrowserWindow({
		show: false,
		width,
		height,
		useContentSize: true,
		webPreferences: { partition: 'phone', sandbox: true, contextIsolation: true },
	});
	if (process.env.BRIGADIR_PHONE_UA) window.webContents.setUserAgent(process.env.BRIGADIR_PHONE_UA);
	window.loadURL(process.env.BRIGADIR_PHONE_URL).catch(() => {});
});
app.on('window-all-closed', () => app.quit());
