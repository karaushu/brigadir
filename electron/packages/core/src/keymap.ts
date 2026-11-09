import { menuCommands } from './menu';
import { commandModule, defaultModules, type AppModules } from './modules';
import { isRecord } from './workspace';
import type { MessageKey } from './messages';
/** spec/settings-modules-and-onboarding#settings-keys: a preset gives every menu command its shortcut, overrides replace one (null = none). */
export const keymapPresets = ['brigadir', 'vscode', 'intellij'] as const;
export type KeymapPreset = (typeof keymapPresets)[number];
export type KeymapSettings = { preset: KeymapPreset; overrides: Record<string, string | null> };
export const defaultKeymap: KeymapSettings = { preset: 'brigadir', overrides: {} };
type MenuCommand = (typeof menuCommands)[number];
/** VS Code and IntelliJ replace only the commands they have an equivalent for; the rest keep Brigadir's keys.
 *  No preset may conflict with itself (keymap.test.ts). */
const presetKeys: Record<KeymapPreset, Record<string, string | null>> = {
	brigadir: {},
	vscode: {
		'quick-open': 'CmdOrCtrl+P',
		'quick-open-alias': null,
		'sidebar-filter': null,
		'editor-definition': 'F12',
		'editor-references': 'Shift+F12',
		'editor-problem-next': 'F8',
		'editor-problem-previous': 'Shift+F8',
		diff: 'Ctrl+Shift+G',
		terminal: 'Ctrl+`',
		'terminal-new': 'Ctrl+Shift+`',
		'sidebar-toggle': 'CmdOrCtrl+B',
		'format-bold': null,
	},
	intellij: {
		'quick-open': 'CmdOrCtrl+Shift+O',
		'editor-format': 'CmdOrCtrl+Alt+L',
		'editor-replace': 'CmdOrCtrl+R',
		diff: 'CmdOrCtrl+0',
		'font-reset': null,
		terminal: 'Alt+F12',
	},
};
/** Shortcuts nobody can take: macOS keeps the first ones, the rest are fixed app items outside core/menu.ts. */
export const reservedAccelerators: Readonly<
	Record<string, { owner: 'macOS' | 'app'; name: string }>
> = {
	'CmdOrCtrl+Space': { owner: 'macOS', name: 'Spotlight' },
	'CmdOrCtrl+Tab': { owner: 'macOS', name: 'App Switcher' },
	'CmdOrCtrl+Q': { owner: 'macOS', name: 'Quit' },
	'CmdOrCtrl+H': { owner: 'macOS', name: 'Hide' },
	'CmdOrCtrl+M': { owner: 'macOS', name: 'Minimize' },
	'Shift+CmdOrCtrl+3': { owner: 'macOS', name: 'Screenshot' },
	'Shift+CmdOrCtrl+4': { owner: 'macOS', name: 'Screenshot' },
	'CmdOrCtrl+,': { owner: 'app', name: 'Settings…' },
	'Shift+CmdOrCtrl+1': { owner: 'app', name: 'Workspace' },
	'Shift+CmdOrCtrl+2': { owner: 'app', name: 'Kit' },
	'Alt+Shift+CmdOrCtrl+I': { owner: 'app', name: 'Toggle Developer Tools' },
};
/** spec/architecture-and-platform#window-frame: shortcuts Windows, GNOME, KDE or the app's fixed items keep on a PC. One table for Windows and Linux:
 *  a default never lands on a key one of the desktops owns. */
export const pcReservedAccelerators: Readonly<
	Record<string, { owner: 'system' | 'app'; name: MessageKey }>
> = {
	'Alt+F4': { owner: 'system', name: 'Close the window' },
	'Alt+Tab': { owner: 'system', name: 'Window switcher' },
	'Alt+Space': { owner: 'system', name: 'Window menu' },
	'Ctrl+Escape': { owner: 'system', name: 'Start menu' },
	'Ctrl+Shift+Escape': { owner: 'system', name: 'Task Manager' },
	'Ctrl+Alt+Delete': { owner: 'system', name: 'Security screen' },
	'Ctrl+Alt+Backspace': { owner: 'system', name: 'Security screen' },
	'Ctrl+Alt+T': { owner: 'system', name: 'Terminal' },
	'Ctrl+Alt+L': { owner: 'system', name: 'Lock screen' },
	'Ctrl+Shift+U': { owner: 'system', name: 'Unicode input' },
	...Object.fromEntries(
		['Left', 'Right', 'Up', 'Down'].flatMap((key) => [
			[`Ctrl+Alt+${key}`, { owner: 'system', name: 'Workspaces' }],
			[`Ctrl+Alt+Shift+${key}`, { owner: 'system', name: 'Workspaces' }],
		])
	),
	F10: { owner: 'app', name: 'Application menu' },
	F11: { owner: 'app', name: 'Toggle full screen' },
	'Ctrl+Q': { owner: 'app', name: 'Quit' },
	'Ctrl+M': { owner: 'app', name: 'Minimize' },
	'Ctrl+,': { owner: 'app', name: 'Settings…' },
	'Ctrl+Shift+1': { owner: 'app', name: 'Workspace' },
	'Ctrl+Shift+2': { owner: 'app', name: 'Kit' },
	'Ctrl+Alt+Shift+I': { owner: 'app', name: 'Toggle Developer Tools' },
	'Ctrl+Z': { owner: 'app', name: 'Undo' },
	'Ctrl+Shift+Z': { owner: 'app', name: 'Redo' },
	'Ctrl+Y': { owner: 'app', name: 'Redo' },
	'Ctrl+X': { owner: 'app', name: 'Cut' },
	'Ctrl+C': { owner: 'app', name: 'Copy' },
	'Ctrl+V': { owner: 'app', name: 'Paste' },
	'Ctrl+A': { owner: 'app', name: 'Select all' },
};
/** Where shortcuts are read and shown: macOS keeps ⌘⌥⇧⌃, Windows and Linux get Ctrl/Alt/Shift (spec/architecture-and-platform#window-frame). */
export type ShortcutPlatform = 'darwin' | 'win32' | 'linux';
let platform: ShortcutPlatform = 'darwin';
/** Set once per process: main at start, the renderer from the preload's platform (or the dev override). */
export function setShortcutPlatform(value: ShortcutPlatform) {
	if (value !== platform) {
		platform = value;
		pcCache.clear();
	}
}
export function shortcutPlatform(): ShortcutPlatform {
	return platform;
}
const isPc = () => platform !== 'darwin';
export function isKeymapSettings(value: unknown): value is KeymapSettings {
	if (
		!isRecord(value) ||
		Object.keys(value).length !== 2 ||
		!keymapPresets.includes(value.preset as KeymapPreset) ||
		!isRecord(value.overrides)
	)
		return false;
	const ids = new Set(menuCommands.map((command) => command.id));
	return Object.entries(value.overrides).every(
		([id, key]) => ids.has(id) && (key === null || (typeof key === 'string' && isAccelerator(key)))
	);
}
const modifiers = ['Ctrl', 'Alt', 'Shift', 'CmdOrCtrl', 'Command'] as const;
const namedKeys = new Set([
	'Space',
	'Tab',
	'Enter',
	'Backspace',
	'Delete',
	'Escape',
	'Up',
	'Down',
	'Left',
	'Right',
	'PageUp',
	'PageDown',
	'Plus',
	'-',
	'`',
	',',
	'.',
	'/',
	'[',
	']',
	';',
	"'",
	'\\',
	'=',
]);
/** An Electron accelerator in our canonical order: modifiers (Ctrl, Alt, Shift, CmdOrCtrl), then one key. */
export function isAccelerator(value: string): boolean {
	const parts = value.split('+').filter(Boolean);
	if (value.endsWith('++')) parts.push('+');
	const key = parts.pop();
	if (!key) return false;
	if (
		!parts.every((part) => (modifiers as readonly string[]).includes(part)) ||
		new Set(parts).size !== parts.length
	)
		return false;
	return /^[A-Z0-9]$/.test(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key) || namedKeys.has(key);
}
const order = ['Ctrl', 'Alt', 'Shift', 'CmdOrCtrl'];
/** One spelling per shortcut: `Command` is `CmdOrCtrl` on macOS, modifiers in ⌃⌥⇧⌘ order. */
export function normalizeAccelerator(accelerator: string): string {
	const parts = accelerator.split('+');
	if (accelerator.endsWith('++')) {
		parts.pop();
		parts[parts.length - 1] = 'Plus';
	}
	const key = parts.pop() ?? '';
	return [
		...parts
			.map((part) => (part === 'Command' ? 'CmdOrCtrl' : part))
			.sort((a, b) => order.indexOf(a) - order.indexOf(b)),
		key,
	].join('+');
}
/** The shortcut a command has now: override, then preset, then Brigadir's own key from core/menu.ts. */
export function commandAccelerator(
	command: MenuCommand,
	keymap: KeymapSettings
): string | undefined {
	if (command.id in keymap.overrides) {
		const key = keymap.overrides[command.id];
		return key ? pcSpelling(normalizeAccelerator(key)) : undefined;
	}
	if (isPc()) return pcDefaults(keymap.preset).get(command.id);
	return macDefault(command, keymap.preset);
}
function macDefault(command: MenuCommand, preset: KeymapPreset) {
	const keys = presetKeys[preset],
		key = command.id in keys ? keys[command.id] : command.accelerator;
	return key ? normalizeAccelerator(key) : undefined;
}
/** An override is recorded on the machine it acts on; on a PC only `CmdOrCtrl` is spelled as the Ctrl it means there. */
function pcSpelling(accelerator: string) {
	if (!isPc()) return accelerator;
	const parts = accelerator.split('+'),
		key = parts.pop()!;
	return join(
		parts.map((part) => (part === 'CmdOrCtrl' || part === 'Command' ? 'Ctrl' : part)),
		key
	);
}
/** spec/architecture-and-platform#window-frame: keys whose straight Ctrl/Alt reading lands on a desktop's own shortcut take the Windows convention. */
const pcKeys: Record<string, string> = {
	'document-next': 'Ctrl+PageDown',
	'document-previous': 'Ctrl+PageUp',
	'turn-next': 'Alt+PageDown',
	'turn-previous': 'Alt+PageUp',
	// Ctrl+Shift+U is IBus Unicode input on GNOME and KDE and Ctrl+Shift+T reopens a closed tab (spec/editor#reopen-closed-tab): Turns keeps U
	// with Alt+Shift, like the Archive window's Alt+Shift+A.
	turns: 'Alt+Shift+U',
	'editor-change-next': 'Alt+F5',
	'editor-change-previous': 'Alt+Shift+F5',
	'editor-location-previous': 'Alt+Left',
	'editor-location-next': 'Alt+Right',
	// spec/search-menus-and-commands#search-tabs: ⌥⇧⌘F reads Ctrl+Alt+Shift+F, the PC fallback of Find and replace (Ctrl+Shift+F is Find in Files there too);
	// the task filter takes T, for tasks.
	'sidebar-filter': 'Ctrl+Alt+Shift+T',
	// spec/tasks#archive: ⌃⌘A and ⌥⌘A both read Ctrl+Alt+A (AltGr) and fall back to the same keys as ⇧⌘A Find Action; the task
	// takes Ctrl+Alt+Shift+A, the Archive window Alt+Shift+A.
	'archive-task': 'Ctrl+Alt+Shift+A',
	archive: 'Alt+Shift+A',
	// spec/sidebar#section-rail: the sections are Alt+1…4 on Windows and Linux.
	notes: 'Alt+3',
	// spec/editor#editor-groups: ⌥⇥ reads Alt+Tab, the desktop's window switcher; Ctrl+F6 is the Windows key for the next pane of a window.
	'editor-group-next': 'Ctrl+F6',
	'editor-group-previous': 'Ctrl+Shift+F6',
	// spec/task-window-workspace#work-area: ⇧⌘I is Tools; DevTools of the page takes the browsers' own F12 (its ⌥⌘I reads AltGr on a PC).
	'browser-inspect': 'F12',
	// spec/search-menus-and-commands#menu-structure: the find panel steps with F3 / Shift+F3, as Windows editors and VS Code do (Ctrl+G is Go to line there).
	'editor-find-next': 'F3',
	'editor-find-previous': 'Shift+F3',
	// spec/task-window#files-delete: Ctrl+Backspace deletes a word on a PC; Explorer and the IDEs delete a file with Delete.
	'file-delete': 'Delete',
	// spec/sidebar#section-rail: ⌃⌘1… beside ⌘ read Alt+1… (Ctrl+Alt+digit is AltGr, Ctrl+Shift+1/2 switch Workspace and Kit).
	'section-tasks': 'Alt+1',
	'section-prs': 'Alt+2',
	schedules: 'Alt+4',
};
const printable = (key: string) =>
	/^[A-Z0-9]$/.test(key) ||
	['-', '=', ',', '.', '/', '[', ']', ';', "'", '\\', '`', 'Plus'].includes(key);
/** Ctrl+Alt is AltGr in Ukrainian, Polish and most European layouts: Ctrl+Alt+letter types a letter there. */
export function altGrUnsafe(accelerator: string) {
	const parts = accelerator.split('+'),
		key = parts.pop()!;
	return (
		parts.includes('Ctrl') && parts.includes('Alt') && !parts.includes('Shift') && printable(key)
	);
}
const join = (mods: Iterable<string>, key: string) =>
	normalizeAccelerator([...new Set(mods), key].join('+'));
/** The ways a macOS shortcut can read on a PC, best first: ⌘ → Ctrl, ⌥ → Alt, ⇧ stays; ⌃ is Ctrl without ⌘ in the
 *  chord (Alt if that Ctrl is taken) and Alt beside ⌘; a Ctrl+Alt chord on a typing key moves to Ctrl+Shift, then
 *  Ctrl+Alt+Shift. */
export function pcCandidates(mac: string): string[] {
	const parts = normalizeAccelerator(mac).split('+'),
		key = parts.pop()!;
	const cmd = parts.includes('CmdOrCtrl') || parts.includes('Command'),
		ctrl = parts.includes('Ctrl'),
		alt = parts.includes('Alt'),
		shift = parts.includes('Shift');
	const mods: string[] = [
		...(cmd || ctrl ? ['Ctrl'] : []),
		...(alt || (ctrl && cmd) ? ['Alt'] : []),
		...(shift ? ['Shift'] : []),
	];
	const out = [join(mods, key)];
	if (ctrl && !cmd && !alt)
		out.push(
			join(
				mods.map((mod) => (mod === 'Ctrl' ? 'Alt' : mod)),
				key
			)
		);
	if (out[0]!.startsWith('Ctrl+Alt+') && !shift)
		out.push(join(['Ctrl', 'Shift'], key), join(['Ctrl', 'Alt', 'Shift'], key));
	return [...new Set(out)];
}
const pcCache = new Map<KeymapPreset, Map<string, string | undefined>>();
/** Every command's PC default for a preset, conflict-free: ⌘ chords take their straight reading first, the rest
 *  try their candidates in menu order and skip a reserved key, an AltGr chord or one a command in reach holds. */
function pcDefaults(preset: KeymapPreset) {
	const cached = pcCache.get(preset);
	if (cached) return cached;
	const result = new Map<string, string | undefined>(),
		keys = presetKeys[preset];
	const taken = (key: string, command: MenuCommand) =>
		menuCommands.some(
			(other) => other.id !== command.id && result.get(other.id) === key && clash(other, command)
		);
	const usable = (key: string, command: MenuCommand) =>
		!pcReservedAccelerators[key] && !altGrUnsafe(key) && !taken(key, command);
	const pending: { command: MenuCommand; candidates: string[]; cmd: boolean }[] = [];
	for (const command of menuCommands) {
		const mac = macDefault(command, preset);
		if (!mac) continue;
		const fixed = command.id in keys ? undefined : pcKeys[command.id];
		pending.push({
			command,
			candidates: fixed ? [fixed] : pcCandidates(mac),
			cmd: /CmdOrCtrl|Command/.test(mac),
		});
	}
	pending.sort((a, b) => Number(b.cmd) - Number(a.cmd));
	const later: typeof pending = [];
	for (const item of pending) {
		if (usable(item.candidates[0]!, item.command)) result.set(item.command.id, item.candidates[0]);
		else later.push(item);
	}
	for (const item of later)
		result.set(
			item.command.id,
			item.candidates.slice(1).find((key) => usable(key, item.command))
		);
	pcCache.set(preset, result);
	return result;
}
export type ShortcutScope =
	| 'global'
	| 'composer'
	| 'chat'
	| 'editor'
	| 'diff'
	| 'console'
	| 'browser'
	| 'simulator'
	| 'pullRequests'
	| 'files';
/** Where a shortcut acts. Two commands conflict only in the same scope or when one of them is global. */
export function shortcutScope(command: MenuCommand): ShortcutScope {
	if (command.channel === 'editor') return command.group === 'Navigate' ? 'global' : 'editor';
	if (command.when === 'pullRequests') return 'pullRequests';
	if (command.when === 'fileTree') return 'files';
	if (command.when === 'composerFormat') return 'composer';
	if (command.group === 'Diff') return 'diff';
	if (command.group === 'Browser') return 'browser';
	if (command.group === 'Simulator') return 'simulator';
	if (command.group === 'Console') return 'console';
	if (
		[
			'activity',
			'turnRail',
			'find',
			'composerMode',
			'composerQueue',
			'review',
			'permission',
		].includes(command.when)
	)
		return 'chat';
	return 'global';
}
/** spec/composer-steering-queue-and-ghost#steering-hold: the focused composer (Add to queue) and a review, permission card or question (Submit) never act at once. */
/** spec/composer#formatting: Ask the agent acts only outside a text field, the composer's formatting only inside one. */
const exclusive = (a: MenuCommand, b: MenuCommand) =>
	(a.when === 'composerFormat' && b.when === 'askAgent') ||
	(b.when === 'composerFormat' && a.when === 'askAgent') ||
	(a.when === 'composerQueue' && ['review', 'permission'].includes(b.when)) ||
	(b.when === 'composerQueue' && ['review', 'permission'].includes(a.when));
const clash = (a: MenuCommand, b: MenuCommand) => {
	if (exclusive(a, b)) return false;
	const x = shortcutScope(a),
		y = shortcutScope(b);
	return x === y || x === 'global' || y === 'global';
};
export type ShortcutConflict =
	| { kind: 'command'; commandId: string }
	| { kind: 'reserved'; owner: 'macOS' | 'system' | 'app'; name: string };
/** What would stop `accelerator` from being given to `commandId` in this keymap. */
/** spec/settings-modules-and-onboarding#modules: a module switched off has no menu items, so its commands hold no shortcut. */
export function keymapCommands(modules: AppModules = defaultModules) {
	return menuCommands.filter((command) => {
		const module = commandModule(command.id);
		return !module || modules[module];
	});
}
export function shortcutConflict(
	keymap: KeymapSettings,
	commandId: string,
	shortcut: string,
	modules: AppModules = defaultModules
): ShortcutConflict | null {
	const accelerator = normalizeAccelerator(shortcut);
	const reserved = isPc()
		? pcReservedAccelerators[pcSpelling(accelerator)]
		: reservedAccelerators[accelerator];
	if (reserved) return { kind: 'reserved', ...reserved };
	const command = menuCommands.find((item) => item.id === commandId);
	if (!command) return null;
	const wanted = pcSpelling(accelerator),
		other = keymapCommands(modules).find(
			(item) =>
				item.id !== commandId && commandAccelerator(item, keymap) === wanted && clash(item, command)
		);
	return other ? { kind: 'command', commandId: other.id } : null;
}
/** Every pair of commands that share a shortcut where both act; empty for each shipped preset. */
export function keymapConflicts(
	keymap: KeymapSettings,
	modules: AppModules = defaultModules
): [string, string][] {
	const found: [string, string][] = [],
		commands = keymapCommands(modules);
	commands.forEach((a, index) => {
		const key = commandAccelerator(a, keymap);
		if (!key) return;
		for (const b of commands.slice(index + 1))
			if (commandAccelerator(b, keymap) === key && clash(a, b)) found.push([a.id, b.id]);
	});
	return found;
}
/** Give `commandId` a shortcut; with `replace`, the command that had it loses its shortcut. */
export function assignShortcut(
	keymap: KeymapSettings,
	commandId: string,
	accelerator: string | null,
	replace = false,
	modules: AppModules = defaultModules
): KeymapSettings {
	const overrides = {
		...keymap.overrides,
		[commandId]: accelerator && normalizeAccelerator(accelerator),
	};
	const conflict = accelerator ? shortcutConflict(keymap, commandId, accelerator, modules) : null;
	if (conflict?.kind === 'reserved') throw new Error('The shortcut is reserved');
	if (conflict && !replace) throw new Error('The shortcut is taken');
	if (conflict?.kind === 'command') overrides[conflict.commandId] = null;
	return { ...keymap, overrides };
}
const keyNames: Record<string, string> = {
	ArrowUp: 'Up',
	ArrowDown: 'Down',
	ArrowLeft: 'Left',
	ArrowRight: 'Right',
	' ': 'Space',
	Enter: 'Enter',
	Backspace: 'Backspace',
	Delete: 'Delete',
	Tab: 'Tab',
	'+': 'Plus',
};
/** A pressed key as an accelerator; null for a bare modifier, and for a plain key without a modifier except F-keys. */
export function acceleratorFromKey(event: {
	key: string;
	code?: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}): string | null {
	if (['Meta', 'Control', 'Alt', 'Shift', 'CapsLock'].includes(event.key)) return null;
	// On a PC Meta is the Windows or Super key: the desktop's, never one of ours (spec/architecture-and-platform#window-frame).
	if (isPc() && event.metaKey) return null;
	const code = event.code ?? '';
	const key =
		keyNames[event.key] ??
		(/^Key[A-Z]$/.test(code)
			? code.slice(3)
			: /^Digit\d$/.test(code)
				? code.slice(5)
				: event.key.length === 1
					? event.key.toUpperCase()
					: event.key);
	const parts = [
		...(event.ctrlKey ? ['Ctrl'] : []),
		...(event.altKey ? ['Alt'] : []),
		...(event.shiftKey ? ['Shift'] : []),
		...(event.metaKey ? ['CmdOrCtrl'] : []),
	];
	if (!parts.length && !/^F\d+$/.test(key)) return null;
	const accelerator = [...parts, key].join('+');
	return isAccelerator(accelerator) ? normalizeAccelerator(accelerator) : null;
}
const symbols: Record<string, string> = {
	Ctrl: '⌃',
	Alt: '⌥',
	Shift: '⇧',
	CmdOrCtrl: '⌘',
	Command: '⌘',
	Up: '↑',
	Down: '↓',
	Left: '←',
	Right: '→',
	PageUp: '⇞',
	PageDown: '⇟',
	Enter: '↩',
	Backspace: '⌫',
	Delete: '⌦',
	Escape: '⎋',
	Tab: '⇥',
	Space: 'Space',
	Plus: '+',
};
/** `CmdOrCtrl+Shift+K` → `⇧⌘K`, in the macOS menu order ⌃⌥⇧⌘. */
export function formatAccelerator(accelerator: string): string {
	const parts = normalizeAccelerator(accelerator).split('+');
	const key = parts.pop() ?? '';
	if (isPc())
		return [
			...parts.map((part) => (part === 'CmdOrCtrl' || part === 'Command' ? 'Ctrl' : part)),
			pcNames[key] ?? key,
		].join('+');
	return parts.map((part) => symbols[part] ?? part).join('') + (symbols[key] ?? key);
}
/** A menu command's shortcut as this platform shows it, from the keymap (`⌥⌘R` on macOS, `Ctrl+Shift+R` on a PC);
 *  undefined when the keymap leaves it without one. Every label of a command's key in the UI reads it from here. */
export function commandShortcut(
	id: string,
	keymap: KeymapSettings = defaultKeymap
): string | undefined {
	const command = menuCommands.find((item) => item.id === id),
		key = command && commandAccelerator(command, keymap);
	return key ? formatAccelerator(key) : undefined;
}
/** A translated text that names a bare key by its macOS glyph (`↩ send now`): Windows and Linux read the key's name,
 *  `Enter send now`, as `formatAccelerator` spells it; arrows stay arrows. */
export function withPlatformKeys(text: string): string {
	if (!isPc()) return text;
	return text.replace(/[↩⇥⎋⌫⌦]/g, (glyph) => formatAccelerator(bareKeys[glyph]!));
}
const bareKeys: Record<string, string> = {
	'↩': 'Enter',
	'⇥': 'Tab',
	'⎋': 'Escape',
	'⌫': 'Backspace',
	'⌦': 'Delete',
};
/** `Archive · ⌃⌘A` for a tooltip; the bare label when the command has no shortcut. */
export function withShortcut(label: string, shortcut: string | undefined): string {
	return shortcut ? `${label} · ${shortcut}` : label;
}
/** Windows and Linux spell a shortcut in words, as their menus do: `Ctrl+Shift+K`, `Alt+PgDn` (spec/architecture-and-platform#window-frame). */
const pcNames: Record<string, string> = {
	Escape: 'Esc',
	Delete: 'Del',
	PageUp: 'PgUp',
	PageDown: 'PgDn',
	Plus: '+',
	Up: '↑',
	Down: '↓',
	Left: '←',
	Right: '→',
};
/** Sections of the shortcut list (spec/settings-modules-and-onboarding#intro), by what the command acts on, not by its menu. */
export const keymapSections = [
	'General',
	'Chat',
	'Editor',
	'Changes',
	'Console',
	'Browser',
	'Simulator',
	'View',
] as const;
export type KeymapSection = (typeof keymapSections)[number];
const sectionOf: Record<string, KeymapSection> = {
	'markdown-preview': 'Editor',
	notifications: 'General',
	'needs-next': 'General',
	'needs-previous': 'General',
	cancel: 'General',
	'document-next': 'Editor',
	'document-previous': 'Editor',
	diff: 'Changes',
	files: 'Changes',
	browser: 'Browser',
	simulator: 'Simulator',
	terminal: 'Console',
	turns: 'Chat',
	'pull-requests': 'Chat',
	'pull-requests-refresh': 'Chat',
	'reopen-tab': 'Editor',
	'close-tab': 'Editor',
	composer: 'Chat',
	'composer-mode': 'Chat',
	'composer-queue': 'Chat',
	'format-bold': 'Chat',
	'format-italic': 'Chat',
	'format-code': 'Chat',
	'format-link': 'Chat',
	'review-send': 'Chat',
	'review-send-go': 'Chat',
	'permission-deny': 'Chat',
};
export function keymapSection(command: MenuCommand): KeymapSection {
	const own = sectionOf[command.id];
	if (own) return own;
	if (command.channel === 'editor') return command.group === 'File' ? 'Editor' : 'Editor';
	if (command.group === 'File') return 'General';
	if (command.group === 'Navigate') return 'Chat';
	if (command.group === 'Diff') return 'Changes';
	if (command.group === 'Browser' || command.group === 'Simulator' || command.group === 'Console')
		return command.group;
	return 'View';
}
/** The same shortcut for CodeMirror's keymap: `Shift+CmdOrCtrl+S` → `Shift-Mod-s`. */
export function codeMirrorKey(accelerator: string): string {
	const names: Record<string, string> = {
		CmdOrCtrl: 'Mod',
		Command: 'Mod',
		Ctrl: 'Ctrl',
		Alt: 'Alt',
		Shift: 'Shift',
		Up: 'ArrowUp',
		Down: 'ArrowDown',
		Left: 'ArrowLeft',
		Right: 'ArrowRight',
		Plus: '+',
		Space: 'Space',
	};
	const parts = normalizeAccelerator(accelerator).split('+');
	const key = parts.pop() ?? '';
	return [
		...parts.map((part) => names[part] ?? part),
		names[key] ?? (key.length === 1 ? key.toLowerCase() : key),
	].join('-');
}
/** Whether a keydown in the renderer is this shortcut; `⌘=` also counts as `⌘+`, as on every Mac keyboard. */
export function matchesAccelerator(
	event: {
		key: string;
		code?: string;
		metaKey: boolean;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
	},
	accelerator: string | undefined
): boolean {
	if (!accelerator) return false;
	const pressed = acceleratorFromKey(event),
		wanted = normalizeAccelerator(accelerator);
	if (pressed === wanted) return true;
	return (
		wanted.endsWith('+Plus') &&
		(event.key === '=' || event.key === '+') &&
		pressed !== null &&
		pressed.replace(/\+(=|Plus)$/, '').replace(/^Shift\+/, '') ===
			wanted.replace(/\+Plus$/, '').replace(/^Shift\+/, '')
	);
}
