import { isRecord } from './workspace';
/**
 * spec/browser-and-simulator#browser-ui-act: what an agent's `browser_ui` and `browser_act` ask of the task browser. The host validates the MCP arguments
 * with zod; main re-checks them here. The tree is the accessibility tree of the page, one element a line, like
 * `simulator_ui` (spec/browser-and-simulator#simulator); a target is a `ref` from it, a CSS selector, an accessible name or a point.
 */
export const browserActions = [
	'click',
	'hover',
	'type',
	'key',
	'scroll',
	'select',
	'back',
	'forward',
	'reload',
	// spec/browser-and-simulator#background: the answer to the page's next dialog, the task clipboard, and a paste from it.
	'dialog',
	'clipboard',
	'paste',
	// spec/browser-and-simulator#notifications: the agent answers the page's notification question for its domain.
	'notifications',
] as const;
export type BrowserAction = (typeof browserActions)[number];
export type BrowserActRequest = {
	action: BrowserAction;
	ref?: string;
	selector?: string;
	label?: string;
	x?: number;
	y?: number;
	text?: string;
	clear?: boolean;
	submit?: boolean;
	key?: string;
	count?: 1 | 2;
	dx?: number;
	dy?: number;
	value?: string;
	/** `dialog`: OK (true) or Cancel (false) for the page's next alert, confirm or prompt. */
	accept?: boolean;
	/** `notifications`: allow, block or ask again, for the domain of the page. */
	permission?: 'granted' | 'denied' | 'default';
};
/** `@e123` or `e123`: the backend node id of the element in the current document. */
export const browserRefPattern = /^@?e[0-9]{1,12}$/;
export function browserRef(value: string) {
	return Number(value.replace(/^@?e/, ''));
}
const text = (value: unknown, max: number) =>
	typeof value === 'string' && value.length > 0 && value.length <= max;
const point = (value: unknown) =>
	value === undefined ||
	(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 20_000);
const delta = (value: unknown) =>
	value === undefined ||
	(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 100_000);
export function isBrowserActRequest(value: unknown): value is BrowserActRequest {
	if (!isRecord(value) || !browserActions.includes(value.action as BrowserAction)) return false;
	return (
		(value.ref === undefined ||
			(typeof value.ref === 'string' && browserRefPattern.test(value.ref))) &&
		(value.selector === undefined || text(value.selector, 500)) &&
		(value.label === undefined || text(value.label, 500)) &&
		point(value.x) &&
		point(value.y) &&
		delta(value.dx) &&
		delta(value.dy) &&
		(value.text === undefined || (typeof value.text === 'string' && value.text.length <= 10_000)) &&
		(value.key === undefined || text(value.key, 40)) &&
		(value.value === undefined || text(value.value, 1000)) &&
		(value.count === undefined || value.count === 1 || value.count === 2) &&
		(value.clear === undefined || typeof value.clear === 'boolean') &&
		(value.submit === undefined || typeof value.submit === 'boolean') &&
		(value.accept === undefined || typeof value.accept === 'boolean') &&
		(value.action !== 'dialog' || typeof value.accept === 'boolean') &&
		(value.permission === undefined ||
			value.permission === 'granted' ||
			value.permission === 'denied' ||
			value.permission === 'default') &&
		(value.action !== 'notifications' || value.permission !== undefined) &&
		(value.action !== 'paste' || (typeof value.text === 'string' && value.text.length > 0))
	);
}
export function hasBrowserTarget(request: BrowserActRequest) {
	return (
		request.ref !== undefined ||
		request.selector !== undefined ||
		request.label !== undefined ||
		(request.x !== undefined && request.y !== undefined)
	);
}

/** A CDP key event: `Enter`, `a`, `Meta+A`, `Shift+Tab`. Modifiers are the CDP bit mask: Alt 1, Control 2, Meta 4, Shift 8. */
export type BrowserKey = {
	key: string;
	code: string;
	keyCode: number;
	modifiers: number;
	text?: string;
	commands?: string[];
};
const named: Record<string, [string, number, string?]> = {
	Enter: ['Enter', 13, '\r'],
	Tab: ['Tab', 9],
	Escape: ['Escape', 27],
	Backspace: ['Backspace', 8],
	Delete: ['Delete', 46],
	Space: ['Space', 32, ' '],
	ArrowUp: ['ArrowUp', 38],
	ArrowDown: ['ArrowDown', 40],
	ArrowLeft: ['ArrowLeft', 37],
	ArrowRight: ['ArrowRight', 39],
	Home: ['Home', 36],
	End: ['End', 35],
	PageUp: ['PageUp', 33],
	PageDown: ['PageDown', 34],
};
const aliases: Record<string, string> = {
	esc: 'Escape',
	return: 'Enter',
	del: 'Delete',
	up: 'ArrowUp',
	down: 'ArrowDown',
	left: 'ArrowLeft',
	right: 'ArrowRight',
	' ': 'Space',
	spacebar: 'Space',
};
const modifierBits: Record<string, number> = {
	alt: 1,
	option: 1,
	control: 2,
	ctrl: 2,
	meta: 4,
	cmd: 4,
	command: 4,
	shift: 8,
};
/** macOS editing shortcuts reach a page through CDP only as editor commands. */
const metaCommands: Record<string, string> = {
	a: 'selectAll',
	c: 'copy',
	v: 'paste',
	x: 'cut',
	z: 'undo',
};
export function browserKey(spec: string): BrowserKey | null {
	const parts = spec === '+' ? ['+'] : spec.split('+').map((part) => part.trim());
	if (parts.some((part) => !part)) return null;
	let modifiers = 0;
	for (const part of parts.slice(0, -1)) {
		const bit = modifierBits[part.toLowerCase()];
		if (!bit) return null;
		modifiers |= bit;
	}
	const last = parts.at(-1)!,
		name =
			aliases[last.toLowerCase()] ??
			Object.keys(named).find((key) => key.toLowerCase() === last.toLowerCase()) ??
			(/^f([1-9]|1[0-2])$/i.test(last) ? last.toUpperCase() : null);
	if (name && named[name]) {
		const [code, keyCode, typed] = named[name];
		return {
			key: name === 'Space' ? ' ' : name,
			code,
			keyCode,
			modifiers,
			...(typed && !(modifiers & 7) ? { text: typed } : {}),
		};
	}
	if (name) return { key: name, code: name, keyCode: 111 + Number(name.slice(1)), modifiers };
	if ([...last].length !== 1) return null;
	const char = modifiers & 8 ? last.toUpperCase() : modifiers & 7 ? last.toLowerCase() : last,
		lower = last.toLowerCase(),
		letter = /^[a-z]$/.test(lower),
		digit = /^[0-9]$/.test(last);
	const code = letter ? `Key${lower.toUpperCase()}` : digit ? `Digit${last}` : '',
		keyCode = letter ? lower.toUpperCase().charCodeAt(0) : digit ? last.charCodeAt(0) : 0;
	const command = modifiers === 4 ? metaCommands[lower] : undefined;
	return {
		key: char,
		code,
		keyCode,
		modifiers,
		...(modifiers & 7 ? {} : { text: char }),
		...(command ? { commands: [command] } : {}),
	};
}

/** One element of the tree: role and accessible name as the page gives them, the box in CSS px of the viewport. */
export type BrowserElement = {
	ref: number;
	role: string;
	name: string;
	value?: string;
	states: string[];
	box: [number, number, number, number] | null;
};
export type BrowserViewport = {
	width: number;
	height: number;
	scrollX: number;
	scrollY: number;
	pageWidth: number;
	pageHeight: number;
};
/** Roles worth a line: what can be clicked or filled, and what names a part of the page. Text is `browser_read`'s. */
export const browserUiRoles = new Set([
	'button',
	'link',
	'textbox',
	'searchbox',
	'combobox',
	'checkbox',
	'radio',
	'switch',
	'tab',
	'menuitem',
	'menuitemcheckbox',
	'menuitemradio',
	'option',
	'slider',
	'spinbutton',
	'listbox',
	'treeitem',
	'heading',
	'img',
	'image',
	'dialog',
	'alertdialog',
	'alert',
	'status',
	'ListBoxOption',
	'PopUpButton',
	'MenuListPopup',
	'MenuListOption',
]);
/** A CDP `Accessibility.getFullAXTree` node, reduced to what the tree uses. */
export type AxNode = {
	ignored?: boolean;
	role?: { value?: unknown };
	name?: { value?: unknown };
	value?: { value?: unknown };
	properties?: { name: string; value?: { value?: unknown } }[];
	backendDOMNodeId?: number;
};
const shown = [
	'focused',
	'disabled',
	'checked',
	'pressed',
	'expanded',
	'selected',
	'required',
	'invalid',
];
export function browserElements(nodes: AxNode[]): Omit<BrowserElement, 'box'>[] {
	const elements: Omit<BrowserElement, 'box'>[] = [];
	for (const node of nodes) {
		if (node.ignored || node.backendDOMNodeId === undefined) continue;
		const role = String(node.role?.value ?? ''),
			name = String(node.name?.value ?? '')
				.replace(/\s+/g, ' ')
				.trim(),
			props = new Map((node.properties ?? []).map((item) => [item.name, item.value?.value]));
		const focusable = props.get('focusable') === true;
		if (
			!browserUiRoles.has(role) &&
			!(focusable && name && role !== 'RootWebArea' && role !== 'WebArea')
		)
			continue;
		if ((role === 'img' || role === 'image' || role === 'heading') && !name) continue;
		const states = shown
			.filter((state) => {
				const value = props.get(state);
				return state === 'checked' || state === 'pressed'
					? value === 'true' || value === true || value === 'mixed'
					: state === 'invalid'
						? value !== undefined && value !== 'false' && value !== false
						: value === true;
			})
			.map((state) => (state === 'checked' && props.get(state) === 'mixed' ? 'mixed' : state));
		const raw = node.value?.value,
			value = raw === undefined || raw === null || raw === '' ? undefined : String(raw);
		elements.push({
			ref: node.backendDOMNodeId,
			role: browserUiRoles.has(role) ? role : 'clickable',
			name: name.length > 120 ? `${name.slice(0, 119)}…` : name,
			...(value !== undefined
				? { value: value.length > 200 ? `${value.slice(0, 199)}…` : value }
				: {}),
			states,
		});
	}
	return elements;
}
/** One element a line: `button "Save" @e42 120,340 80×32 focused`, in CSS px of the viewport; 150 lines and 32 KiB at most (spec/architecture-and-platform#perf-agent-responses). */
export function formatBrowserUi(
	viewport: BrowserViewport,
	elements: BrowserElement[],
	total: number,
	offset = 0
) {
	const head = `Viewport ${Math.round(viewport.width)}×${Math.round(viewport.height)} px, scrolled ${Math.round(viewport.scrollX)},${Math.round(viewport.scrollY)} of ${Math.round(viewport.pageWidth)}×${Math.round(viewport.pageHeight)} · ${total} elements`;
	const lines = [head];
	let size = head.length,
		count = 0;
	for (const element of elements) {
		const box = element.box?.map(Math.round) as [number, number, number, number] | undefined;
		const off =
			!box || box[2] <= 0 || box[3] <= 0
				? 'hidden'
				: box[0] + box[2] <= 0 ||
					  box[1] + box[3] <= 0 ||
					  box[0] >= viewport.width ||
					  box[1] >= viewport.height
					? 'offscreen'
					: null;
		const line = `${element.role}${element.name ? ` ${JSON.stringify(element.name)}` : ''}${element.value !== undefined ? ` = ${JSON.stringify(element.value)}` : ''} @e${element.ref}${box && off !== 'hidden' ? ` ${box[0]},${box[1]} ${box[2]}×${box[3]}` : ''}${[...element.states, ...(off ? [off] : [])].map((state) => ` ${state}`).join('')}`;
		if (size + line.length + 1 > 32 * 1024) break;
		lines.push(line);
		size += line.length + 1;
		count++;
	}
	const rest = total - offset - count;
	if (rest > 0) lines.push(`… ${rest} more: call again with offset ${offset + count}`);
	return lines.join('\n');
}
/** The exact accessible name first, then one that contains the text; controls before headings and images. */
export function findBrowserElement<T extends Omit<BrowserElement, 'box'>>(
	elements: T[],
	label: string
): T | null {
	const wanted = label.replace(/\s+/g, ' ').trim().toLocaleLowerCase(),
		rank = (element: T) =>
			['heading', 'img', 'image', 'status', 'alert', 'dialog', 'alertdialog'].includes(element.role)
				? 1
				: 0;
	const sorted = [...elements].sort((a, b) => rank(a) - rank(b));
	return (
		sorted.find((element) => element.name.toLocaleLowerCase() === wanted) ??
		sorted.find((element) => element.name.toLocaleLowerCase().includes(wanted)) ??
		null
	);
}
/** spec/browser-and-simulator#browser-ui-act: a field the agent never fills — passwords, one-time codes and payment cards. */
export function sensitiveField(field: {
	tag: string;
	type?: string | null;
	autocomplete?: string | null;
}) {
	const type = (field.type ?? '').toLowerCase(),
		auto = (field.autocomplete ?? '').toLowerCase().split(/\s+/);
	return (
		(field.tag.toLowerCase() === 'input' && type === 'password') ||
		auto.some(
			(token) =>
				token === 'current-password' ||
				token === 'new-password' ||
				token === 'one-time-code' ||
				token.startsWith('cc-')
		)
	);
}
/** The ring's label (spec/browser-and-simulator#browser-ui-act, the look of spec/browser-and-simulator#simulator): `click · Save`. */
export function browserActLabel(request: BrowserActRequest, name: string | null) {
	const target =
		name ??
		request.label ??
		request.selector ??
		(request.ref ? request.ref.replace(/^@?/, '@') : null);
	const verb = request.action === 'click' && request.count === 2 ? 'double-click' : request.action;
	return target ? `${verb} · ${target.length > 40 ? `${target.slice(0, 39)}…` : target}` : verb;
}
