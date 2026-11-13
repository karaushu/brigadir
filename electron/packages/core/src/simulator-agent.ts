import { isRecord } from './workspace';
/**
 * spec/browser-and-simulator#simulator: what the agent's `simulator_*` tools ask of the app. The host validates the MCP arguments with zod; main
 * re-checks them here and answers in compact text, the accessibility tree first and a screenshot on request.
 */
/** `value` — what a field, switch or slider holds now, when the device says it. */
export type SimulatorElement = {
	role: string;
	label: string;
	id: string;
	frame: [number, number, number, number];
	value?: string;
};
export type SimulatorUi = { width: number; height: number; elements: SimulatorElement[] };
export const simulatorActions = [
	'tap',
	'longpress',
	'swipe',
	'type',
	'key',
	'button',
	'rotate',
] as const;
export type SimulatorAction = (typeof simulatorActions)[number];
export type SimulatorActRequest = {
	action: SimulatorAction;
	x?: number;
	y?: number;
	x2?: number;
	y2?: number;
	id?: string;
	label?: string;
	text?: string;
	key?: string;
	button?: 'home' | 'lock' | 'back';
};
/** spec/browser-and-simulator#sim-wait: exactly one of `text`, `id`, `label`; `gone` waits for it to disappear. */
export type SimulatorWaitRequest = {
	text?: string;
	id?: string;
	label?: string;
	gone?: boolean;
	timeoutMs?: number;
};
/** spec/browser-and-simulator#sim-wait: the longest and the default wait. */
export const simulatorWaitMaxMs = 30_000;
export const simulatorWaitDefaultMs = 10_000;
export type SimulatorAgentCommand =
	| { tool: 'state' }
	| { tool: 'open'; device?: string; app?: string; url?: string }
	| { tool: 'ui'; grid?: boolean; offset?: number }
	| ({ tool: 'act' } & SimulatorActRequest)
	| ({ tool: 'wait' } & SimulatorWaitRequest)
	| { tool: 'screenshot' }
	| {
			tool: 'logs';
			source?: 'js' | 'native';
			level?: 'debug' | 'log' | 'info' | 'warn' | 'error';
			grep?: string;
	  }
	| { tool: 'network'; requestId?: string; filter?: string };
const text = (value: unknown, max: number) =>
	typeof value === 'string' && value.length > 0 && value.length <= max;
const coordinate = (value: unknown) =>
	value === undefined ||
	(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000);
export function isSimulatorAgentCommand(value: unknown): value is SimulatorAgentCommand {
	if (!isRecord(value)) return false;
	switch (value.tool) {
		case 'state':
		case 'screenshot':
			return true;
		case 'open':
			return (
				(value.device === undefined || text(value.device, 128)) &&
				(value.app === undefined ||
					(typeof value.app === 'string' && /^[A-Za-z0-9._-]{1,255}$/.test(value.app))) &&
				(value.url === undefined ||
					(text(value.url, 8192) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(String(value.url))))
			);
		case 'ui':
			return (
				(value.grid === undefined || typeof value.grid === 'boolean') &&
				(value.offset === undefined ||
					(Number.isSafeInteger(value.offset) && Number(value.offset) >= 0))
			);
		case 'act':
			return (
				simulatorActions.includes(value.action as SimulatorAction) &&
				['x', 'y', 'x2', 'y2'].every((key) => coordinate(value[key])) &&
				(value.id === undefined || text(value.id, 500)) &&
				(value.label === undefined || text(value.label, 500)) &&
				(value.text === undefined || text(value.text, 10_000)) &&
				(value.key === undefined || text(value.key, 32)) &&
				(value.button === undefined || ['home', 'lock', 'back'].includes(value.button as string))
			);
		case 'wait':
			return (
				['text', 'id', 'label'].filter((key) => value[key] !== undefined).length === 1 &&
				['text', 'id', 'label'].every((key) => value[key] === undefined || text(value[key], 500)) &&
				(value.gone === undefined || typeof value.gone === 'boolean') &&
				(value.timeoutMs === undefined ||
					(Number.isSafeInteger(value.timeoutMs) &&
						Number(value.timeoutMs) >= 0 &&
						Number(value.timeoutMs) <= simulatorWaitMaxMs))
			);
		case 'logs':
			return (
				(value.source === undefined || value.source === 'js' || value.source === 'native') &&
				(value.level === undefined ||
					['debug', 'log', 'info', 'warn', 'error'].includes(value.level as string)) &&
				(value.grep === undefined || text(value.grep, 500))
			);
		case 'network':
			return (
				(value.requestId === undefined ||
					(typeof value.requestId === 'string' &&
						/^[A-Za-z0-9._-]{1,128}$/.test(value.requestId))) &&
				(value.filter === undefined || text(value.filter, 2000))
			);
		default:
			return false;
	}
}
/** UTF-8 bytes of a text, the unit of the 32 KiB bounds (core runs where `TextEncoder` and `Buffer` may be missing). */
export function utf8Length(text: string) {
	let size = 0;
	for (const char of text) {
		const code = char.codePointAt(0)!;
		size += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
	}
	return size;
}
/** `Button "Take order" = "value" #take-order 12,622 378×48`, in points. */
export function formatElement(element: SimulatorElement) {
	const [x, y, w, h] = element.frame.map(Math.round) as [number, number, number, number];
	return `${element.role || 'Element'}${element.label ? ` ${JSON.stringify(element.label)}` : ''}${element.value ? ` = ${JSON.stringify(element.value)}` : ''}${element.id ? ` #${element.id}` : ''} ${x},${y} ${w}×${h}`;
}
/**
 * One element a line, `limit` lines and 32 KiB of UTF-8 at most (spec/architecture-and-platform#perf-agent-responses); `again` names the call that
 * pages on.
 */
export function formatUi(ui: SimulatorUi, offset = 0, limit = 150, again = 'call again') {
	const lines: string[] = [
		`Screen ${Math.round(ui.width)}×${Math.round(ui.height)} pt · ${ui.elements.length} elements`,
	];
	// UTF-8 bytes; the page hint after the lines takes at most 100.
	let size = utf8Length(lines[0]!) + 100,
		shown = 0;
	for (const element of ui.elements.slice(offset, offset + limit)) {
		const line = formatElement(element),
			bytes = utf8Length(line);
		if (size + bytes + 1 > 32 * 1024) break;
		lines.push(line);
		size += bytes + 1;
		shown++;
	}
	const rest = ui.elements.length - offset - shown;
	if (rest > 0) lines.push(`… ${rest} more: ${again} with offset ${offset + shown}`);
	return lines.join('\n');
}
/** `testID` first (it becomes the accessibility identifier), then the exact label, then a label that contains the text. */
export function findElement(ui: SimulatorUi, { id, label }: { id?: string; label?: string }) {
	if (id) return ui.elements.find((element) => element.id === id) ?? null;
	if (!label) return null;
	const wanted = label.toLocaleLowerCase();
	return (
		ui.elements.find((element) => element.label.toLocaleLowerCase() === wanted) ??
		ui.elements.find((element) => element.label.toLocaleLowerCase().includes(wanted)) ??
		null
	);
}
/** The helper's tree with the empty fields it leaves out filled in; null when the answer is not a tree. */
export function simulatorUi(value: unknown): SimulatorUi | null {
	if (
		!isRecord(value) ||
		!Number.isFinite(value.width) ||
		!Number.isFinite(value.height) ||
		!Array.isArray(value.elements)
	)
		return null;
	const elements: SimulatorElement[] = [];
	for (const element of value.elements) {
		if (
			!isRecord(element) ||
			!Array.isArray(element.frame) ||
			element.frame.length !== 4 ||
			!element.frame.every(Number.isFinite)
		)
			return null;
		elements.push({
			role: typeof element.role === 'string' ? element.role : '',
			label: typeof element.label === 'string' ? element.label : '',
			id: typeof element.id === 'string' ? element.id : '',
			frame: element.frame as SimulatorElement['frame'],
			...(typeof element.value === 'string' && element.value ? { value: element.value } : {}),
		});
	}
	return { width: Number(value.width), height: Number(value.height), elements };
}
