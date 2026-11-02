import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installChunkRecovery } from './crash-recovery';
import { installContextAnswers } from './context-sources';
import { installDevReload } from './dev-reload';
import { sendMenuIcons } from './menu-icons';
import { useWorkspace } from './store';
import { loadBundledFonts } from './typography';
import { CrashProbe, ErrorBoundary, WindowCrash } from './ui/ErrorBoundary';
import './tokens.css';
import { setShortcutPlatform } from '@brigadir/core';
// spec/architecture-and-platform#window-frame: the frame decides the layout of the strips (traffic lights or OS buttons with ☰) and how shortcuts read.
document.documentElement.dataset.platform = window.brigadir.chromePlatform;
setShortcutPlatform(window.brigadir.chromePlatform);
// spec/architecture-and-platform#crash-recovery: without a boundary one render error unmounts the whole tree and leaves a white window.
installChunkRecovery();
// spec/architecture-and-platform#dev-reload: a code change in development reloads the window, which main's navigation guard would otherwise keep from Vite.
installDevReload();
// spec/agents-and-providers#context-tools: main asks the window what the person is looking at when a task's agent calls `editor_state` or `pr_state`.
installContextAnswers();
// spec/search-menus-and-commands#menu-glyphs: the native menus' glyphs, drawn once; a menu opened before they arrive shows its items without icons.
void sendMenuIcons().catch(() => {});
// spec/appearance#evolution-redesign: Geist and Geist Mono first, so the terminal and the diff measure their cells in them.
void loadBundledFonts().then(() =>
	createRoot(document.getElementById('root')!).render(
		<StrictMode>
			<ErrorBoundary
				surface="window"
				fallback={(crash) => (
					<WindowCrash crash={crash} locale={useWorkspace.getState().appearance.locale} />
				)}>
				<CrashProbe surface="window" />
				<App />
			</ErrorBoundary>
		</StrictMode>
	)
);
