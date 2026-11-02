/// <reference types="vite/client" />
import { t } from '@brigadir/core';
import { useWorkspace } from './store';
import { unkeptBuffers } from './task-state';
import { flushSurfaces } from './task-surface';
import { notify } from './ui/Toast';

/**
 * spec/architecture-and-platform#dev-reload: in development Vite reloads the page after a change no module accepts, but main forbids every navigation of the
 * window (`will-navigate`), Vite's own `location.reload()` among them. Without the reload a module loaded later (a lazy
 * panel) took the new copy of a module the rest of the window still ran the old one of, and two task stores went apart.
 * The window reloads itself after writing its surfaces and unsaved buffers, as a hot exit does (spec/task-window-workspace#restore-window); a buffer a hot
 * exit does not keep holds the reload behind a toast instead.
 */
export function installDevReload() {
	const hot = import.meta.hot;
	if (!hot) return;
	let reloading = false;
	const reload = () => {
		if (reloading) return;
		reloading = true;
		void flushSurfaces(true)
			.catch(() => {})
			.then(() => window.brigadir.reloadWindow())
			.catch(() => {
				reloading = false;
			});
	};
	hot.on('vite:beforeFullReload', () => {
		if (!unkeptBuffers()) {
			reload();
			return;
		}
		const locale = useWorkspace.getState().appearance.locale;
		notify('warning', t(locale, 'The app code changed. Save your changes and reload the window.'), {
			action: { label: t(locale, 'Reload the window'), run: reload },
			key: 'dev-reload',
		});
	});
}
