import type { RendererErrorReport, RendererErrorSurface } from '@brigadir/core';
const reloadMark = 'brigadir:chunk-reload',
	reloadWindow = 30_000;
export type Crash = { error: unknown; componentStack: string };
const message = (error: unknown) =>
	error instanceof Error ? `${error.name}: ${error.message}` : String(error);
/** Chromium and Vite word a chunk the build no longer has in these ways (spec/architecture-and-platform#crash-recovery). */
export function isChunkLoadError(error: unknown) {
	return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(
		message(error)
	);
}
export function crashReport(
	kind: RendererErrorReport['kind'],
	surface: RendererErrorSurface,
	crash: Crash
): RendererErrorReport {
	const stack = crash.error instanceof Error ? (crash.error.stack ?? '') : '';
	return {
		kind,
		surface,
		message: message(crash.error).slice(0, 4000),
		stack: stack.slice(0, 20000),
		componentStack: crash.componentStack.slice(0, 20000),
	};
}
export function reportCrash(report: RendererErrorReport) {
	return window.brigadir.reportRendererError(report).catch(() => {});
}
/** The text «Copy the details» puts on the clipboard. */
export function crashDetails(surface: RendererErrorSurface, crash: Crash) {
	const report = crashReport('boundary', surface, crash);
	return [
		`Brigadir · ${surface} · ${new Date().toISOString()}`,
		location.hash ? `Route: ${location.hash}` : '',
		report.message,
		report.stack.replace(`${report.message}\n`, ''),
		report.componentStack ? `Components:${report.componentStack}` : '',
	]
		.filter(Boolean)
		.join('\n\n');
}
/**
 * spec/architecture-and-platform#crash-recovery: a missing chunk means the files under the window changed. One reload in 30 s brings the window back on
 * the files that are there; a second one in a row would loop, so the boundary shows its screen instead.
 */
export function reloadForMissingChunk(surface: RendererErrorSurface, crash: Crash) {
	if (!isChunkLoadError(crash.error)) return false;
	try {
		if (Date.now() - (Number(sessionStorage.getItem(reloadMark)) || 0) < reloadWindow) return false;
		sessionStorage.setItem(reloadMark, String(Date.now()));
	} catch {
		return false;
	}
	void Promise.race([
		reportCrash(crashReport('chunk-reload', surface, crash)),
		new Promise((resolve) => setTimeout(resolve, 500)),
	]).then(() => window.brigadir.reloadWindow());
	return true;
}
/** Vite announces a failed dynamic import before `lazy()` throws it: reload there, before any boundary shows. */
export function installChunkRecovery() {
	window.addEventListener('vite:preloadError', (event) => {
		if (
			reloadForMissingChunk('window', {
				error: (event as Event & { payload?: unknown }).payload,
				componentStack: '',
			})
		)
			event.preventDefault();
	});
}
