/**
 * spec/remote-access-and-mobile#phone-network, spec/remote-access-and-mobile#phone-app: the phone's app, loaded by the sign-in page with the cookie its socket earned and handed that very
 * socket. The bridge of the computer's renderer (`createDesktopBridge`, spec/remote-access-and-mobile#phone) runs over it, so the renderer's shared
 * modules work unchanged; the screens are `MobileApp`.
 */
import './mobile.css';
import { createRoot } from 'react-dom/client';
import { createDesktopBridge, type Locale } from '@brigadir/core';
import type { Connection } from './connection';
import { MobileApp } from './MobileApp';
import { adoptScriptStyles } from './adopted-styles';
import { startRouter } from './router';
import { useMobile } from './store';

/** Mounts the app into `root`; the returned function takes it down (the machine said goodbye, the person signed out). */
export function mount(root: HTMLElement, connection: Connection, locale: Locale): () => void {
	window.brigadir = createDesktopBridge(connection, {
		pathForFile: () => {
			throw new Error('Files of this phone have no path on the machine.');
		},
		testCrash: null,
		testAttentionMs: null,
		chromePlatform: 'darwin',
		remoteMachine: null,
	});
	// xterm's `<style>` and `style=` through the CSSOM: the strict CSP stays, no violation (spec/remote-access-and-mobile#outbox).
	const restoreStyles = adoptScriptStyles();
	const html = document.documentElement;
	html.dataset.touch = '';
	html.dataset.platform = /Android/.test(navigator.userAgent) ? 'android' : 'ios';
	useMobile.setState({
		locale,
		machine: connection.welcome.machine,
		device: connection.welcome.device,
	});
	root.dataset.state = 'app';
	const host = document.createElement('div');
	host.className = 'mobile-root';
	host.style.height = '100%';
	root.replaceChildren(host);
	startRouter();
	const app = createRoot(host);
	app.render(<MobileApp connection={connection} locale={locale} />);
	return () => {
		app.unmount();
		restoreStyles();
		delete html.dataset.touch;
	};
}
