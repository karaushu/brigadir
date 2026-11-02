/** spec/architecture-and-platform#crash-recovery: a renderer error a boundary caught, or a reload it caused, as main writes it to `logs/renderer.jsonl`. */
export type RendererErrorSurface =
	| 'window'
	| 'task'
	| 'project'
	| 'chat'
	| 'documents'
	| 'panel'
	| 'console'
	| 'browser'
	| 'simulator';
export type RendererErrorReport = {
	kind: 'boundary' | 'chunk-reload';
	surface: RendererErrorSurface;
	message: string;
	stack: string;
	componentStack: string;
};
const surfaces: readonly string[] = [
	'window',
	'task',
	'project',
	'chat',
	'documents',
	'panel',
	'console',
	'browser',
	'simulator',
];
const text = (value: unknown, limit: number) => typeof value === 'string' && value.length <= limit;
export function isRendererErrorReport(value: unknown): value is RendererErrorReport {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const report = value as Record<string, unknown>;
	return (
		Object.keys(report).length === 5 &&
		(report.kind === 'boundary' || report.kind === 'chunk-reload') &&
		typeof report.surface === 'string' &&
		surfaces.includes(report.surface) &&
		text(report.message, 4000) &&
		text(report.stack, 20000) &&
		text(report.componentStack, 20000)
	);
}
