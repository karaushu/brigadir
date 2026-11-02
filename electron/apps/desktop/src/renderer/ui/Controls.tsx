import { Glyph } from './Glyph';
import { ClearField } from './ClearField';
import { usePresence } from './use-presence';
import { TextInput } from './Input';
import { BranchName } from './BranchName';
import {
	createContext,
	useCallback,
	Fragment,
	useContext,
	useEffect,
	useLayoutEffect,
	useId,
	useRef,
	useState,
	type ButtonHTMLAttributes,
	type CSSProperties,
	type InputHTMLAttributes,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
	type Ref,
} from 'react';
import type { AgentTask } from '@brigadir/core';
import s from './Controls.module.css';
import notice from './NoticeChip.module.css';

/** spec/appearance#control-scale: one size scale for every control. A control with no `size` takes the size of its group (`data-size` on an ancestor) and falls back to M. */
export type ControlSize = 's' | 'm' | 'l' | 'xl';
export type Appearance = 'primary' | 'neutral' | 'warning' | 'danger';
export type Variant = 'solid' | 'soft' | 'ghost' | 'outline';
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
	ref?: Ref<HTMLButtonElement>;
	size?: ControlSize;
	appearance?: Appearance;
	/** Default: `solid` for primary, `soft` for the rest; `outline` is a 1 px edge that fills on hover (spec/tasks#archive-window). */ variant?: Variant;
	/** spec/tasks#worktree-preparation, spec/appearance#component-details: a disclosure (a turning chevron that shows a block below, «Setup log», «Details»)
	 *  keeps its rest look when open, soft or ghost; `aria-expanded` alone draws the selected state of a button that opens
	 *  a menu or popup. */ disclosure?: boolean;
	/** spec/appearance#component-details: a button that opens a popover keeps a neutral look while open, not the selected `--accent-soft` — a
	 *  ghost one (the quota rings) its hover `--tint`, a soft one (the sheet's When rule) its rest `--tint`. */ opensPopover?: boolean;
};
export function Button({
	size,
	appearance = 'neutral',
	variant,
	disclosure,
	opensPopover,
	className = '',
	...props
}: ButtonProps) {
	return (
		<button
			type="button"
			{...props}
			className={`${s.button} ${className}`}
			data-size={size}
			data-appearance={appearance}
			data-variant={variant ?? (appearance === 'primary' ? 'solid' : 'soft')}
			data-disclosure={disclosure || undefined}
			data-opens-popover={opensPopover || undefined}
		/>
	);
}
/** A choice with its consequence on a second line, XL and full width (rule 17): the merge's conflict exits, spec/git#main-tree-branches's dirty step. */
export function ChoiceButton({
	title,
	description,
	className = '',
	...props
}: Omit<ButtonProps, 'children' | 'size'> & { title: ReactNode; description?: ReactNode }) {
	return (
		<Button {...props} size="xl" className={`${s.choiceButton} ${className}`}>
			<strong>{title}</strong>
			{description && <small>{description}</small>}
		</Button>
	);
}
export function IconButton({
	label,
	hint,
	shape = 'square',
	variant = 'ghost',
	className = '',
	dot,
	dotAt = 'top',
	lost = false,
	children,
	onClick,
	...props
}: Omit<ButtonProps, 'aria-label'> & {
	label: string;
	/** spec/remote-access-and-mobile#remote-button: the link is being restored — an amber spinner on an amber plate in place of the glyph, no dot, no
	 *  action. `aria-disabled`, not `disabled`, so the hint still shows on hover. */ lost?: boolean;
	/** Where the dot sits: over the glyph's top-right (a filter) or its bottom-right (a state: Remote, spec/appearance#evolution-redesign). */
	dotAt?: 'top' | 'bottom';
	/** Tooltip in place of the label, e.g. with its shortcut; the accessible name stays the label. */ hint?: string;
	/** Square h × h; `auto` only where the design has a chevron or a caption next to the glyph. */ shape?:
		'square' | 'auto';
	/** spec/sidebar#status-filter: a dot over the glyph's top-right corner in this colour (a CSS colour); `null` keeps the slot so it fades out. */ dot?:
		string | null;
}) {
	// The dot keeps its last colour while it fades out.
	const shown = useRef(dot);
	if (dot) shown.current = dot;
	return (
		<Button
			{...props}
			variant={variant}
			aria-label={label}
			title={hint ?? label}
			data-shape={shape}
			data-dot={dot === undefined ? undefined : !lost && dot !== null}
			data-dot-at={dot === undefined || dotAt === 'top' ? undefined : dotAt}
			data-lost={lost || undefined}
			aria-disabled={lost || props['aria-disabled']}
			aria-busy={lost || props['aria-busy']}
			onClick={lost ? undefined : onClick}
			className={`${s.iconButton} ${className}`}>
			{lost ? <Glyph name="agent-spinner" size={16} /> : children}
			{dot !== undefined && (
				<span
					className={s.dot}
					aria-hidden="true"
					style={shown.current ? ({ '--dot': shown.current } as CSSProperties) : undefined}
				/>
			)}
		</Button>
	);
}
/**
 * One control in two parts: the main action and a second button beside it — a chevron for a menu of other ways, or a glyph
 * for a variant of the same action. One capsule with a 1 px line between the parts:
 * hover and press light the whole capsule, the focus ring goes round it. The chevron's menu goes in `menu`, anchored to the capsule.
 */
export function SplitButton({
	size,
	appearance = 'neutral',
	variant,
	className = '',
	second,
	menu,
	rootRef,
	...props
}: ButtonProps & {
	rootRef?: Ref<HTMLSpanElement>;
	menu?: ReactNode;
	/** None: a lone button, e.g. an agent that offers one way. */ second?:
		| undefined
		| {
				label: string;
				hint?: string;
				onClick(): void;
				ref?: Ref<HTMLButtonElement>;
				disabled?: boolean;
				/** A glyph in place of the chevron; the part is then a square. */ icon?: ReactNode;
				/** spec/appearance#evolution-redesign: what the part shows before its chevron (the Helper agent's glyph and model); still a menu. */ content?: ReactNode;
				/** The chevron's menu is open. */ expanded?: boolean;
		  };
}) {
	const look = variant ?? (appearance === 'primary' ? 'solid' : 'soft');
	return (
		<span
			ref={rootRef}
			className={`${s.split} ${className}`}
			data-size={size}
			data-appearance={appearance}>
			<Button
				{...props}
				appearance={appearance}
				variant={look}
				className={second ? s.splitMain : undefined}
			/>
			{second && (
				<Button
					{...(second.ref ? { ref: second.ref } : {})}
					appearance={appearance}
					variant={look}
					className={s.splitSecond}
					data-icon={second.icon ? true : undefined}
					disabled={second.disabled ?? props.disabled}
					aria-label={second.label}
					title={second.hint ?? second.label}
					{...(second.icon
						? {}
						: { 'aria-haspopup': 'menu' as const, 'aria-expanded': second.expanded ?? false })}
					data-content={second.content ? true : undefined}
					onClick={second.onClick}>
					{second.content}
					{/* The agent part's chevron is the capsule's 8 px one. */}
					{second.icon ?? <Glyph name="chevron-down" size={second.content ? 8 : 10} />}
				</Button>
			)}
			{menu}
		</span>
	);
}
export function Switch({
	label,
	checked,
	onChange,
	disabled = false,
	size,
}: {
	label: string;
	checked: boolean;
	onChange(value: boolean): void;
	disabled?: boolean;
	size?: ControlSize;
}) {
	return (
		<button
			type="button"
			role="switch"
			title={label}
			aria-label={label}
			aria-checked={checked}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={s.toggle}
			data-size={size}>
			<span className={s.track} />
		</button>
	);
}
/** spec/search-menus-and-commands#search-modal: the switch's look without its button, in a row that is itself the button (a setting in Search Everywhere). */
export function SwitchMark({ checked, label }: { checked: boolean; label: string }) {
	return <span className={s.track} data-size="s" data-on={checked} role="img" aria-label={label} />;
}
type Option = {
	value: string;
	label: string;
	icon?: ReactNode;
	/** The label's own face, as a font list shows each font in itself (spec/settings-modules-and-onboarding#intro). */ labelStyle?: CSSProperties;
	/** Right-aligned secondary text in the list, like a count (LaunchCrew B). */ tail?: string;
	/** Second line under the label in the open list; the accessible name stays the label (spec/settings-modules-and-onboarding#intro). */ description?: string;
	/** Shown but not selectable, e.g. an unavailable repo (spec/git#merge). */ disabled?: boolean;
	/** Tooltip in place of the label, e.g. what a click on the chosen segment does (spec/task-window#layout-overview); the accessible name stays the label. */ hint?: string;
	/** Key of the group the option belongs to in a Popup with `groups` (spec/composer-steering-queue-and-ghost#ghost-headless). */ group?: string;
	/** spec/pull-requests-and-ci#from-into: the label is a git ref — mono 11.5, and a long one gives way in the middle (`BranchName`). */ branch?: boolean;
	/** Segments: a shorter label the host's container query swaps in when the row is narrow (spec/pull-requests-and-ci#pr-panel). */ short?: string;
	/** Segments: what follows the label — a count, a dot (the phone's «Tasks N | PR N ●», spec/remote-access-and-mobile#phone-pr-list); the name stays the label. */ badge?: ReactNode;
	/** spec/task-window-workspace#tool-tab-look.1: a running thing — a green dot on the option's icon (a booted simulator). */ live?: boolean;
	/** Popup: a second checked row besides the value — the effort beside the model (spec/appearance#evolution-redesign). */ checked?: boolean;
	/**
	 * spec/task-window-workspace#tool-tab-look: the row's own action — a 24 px icon button at its end in place of the tail, with its own hover over
	 * the row's. It runs without choosing the row; the keyboard reaches it with → or Tab from the active row.
	 */
	action?: { label: string; icon: ReactNode; run(): void };
};
/** spec/composer-steering-queue-and-ghost#ghost-headless: Settings popups mark the chosen option with ✓ and give the closed button a hover; the dialog provides it. */
export const PopupMarks = createContext(false);
export type PopupGroup = {
	label: string;
	icon?: ReactNode;
	/** Dim text after the label, e.g. «· off». */ note?: string;
};
export function Segments({
	label,
	options,
	value,
	onChange,
	tabs = false,
	iconOnly = false,
	tablist = false,
	deselectable = false,
	disabled = false,
	className,
	size,
	stretch = false,
	underline = false,
	optionAttribute,
	controls,
	keepFocus = false,
	rootRef,
}: {
	size?: ControlSize;
	/** spec/projects-and-board#pr-mode: tabs with an accent line under the chosen one, as tall as their row (Tasks · Pull requests on the project screen). */ underline?: boolean;
	/** spec/task-window#panel: the capsule fills its row and the segments share it evenly (the panel's Files · Changes · PR). */ stretch?: boolean;
	/** Each segment carries `data-<optionAttribute>="<value>"` — a stable hook for the host and the tests (`data-panel-tab`). */ optionAttribute?: string;
	/** Every segment off, e.g. a preview a large file cannot have (spec/editor#markdown-views). */ disabled?: boolean;
	className?: string | undefined;
	iconOnly?: boolean;
	label: string;
	options: Option[];
	value: string;
	onChange(value: string): void;
	tabs?: boolean;
	/** Tabs, not radios: when a radio with the same name already picks the surface (Diff / History, spec/git#merge). */ tablist?: boolean;
	/** A click on the chosen segment lets it go (the toolbar panels, spec/task-window#layout-overview); the press fades it. */ deselectable?: boolean;
	/** With `tablist`: the id of the panel the tabs switch (`aria-controls`), e.g. the `@` menu's listbox (spec/composer#mentions). */ controls?: string;
	/**
	 * Focus stays where it is — in the text the `@` and `/` menus serve (spec/composer#mentions): no segment takes focus (`tabIndex=-1`),
	 * the pointer picks on press, the host's own keys (`Tab` / `⇧Tab`) switch the segments.
	 */
	keepFocus?: boolean;
	/** The capsule itself — a scrolling strip's hook (`useTabStrip`, the `@` menu's tabs under edge fades). */ rootRef?: Ref<HTMLDivElement>;
}) {
	const root = useRef<HTMLDivElement | null>(null);
	const attach = useCallback(
		(node: HTMLDivElement | null) => {
			root.current = node;
			if (typeof rootRef === 'function') rootRef(node);
			else if (rootRef) rootRef.current = node;
		},
		[rootRef]
	);
	const shown = useRef<string | null>(null),
		settle = useRef<ReturnType<typeof setTimeout>>(undefined);
	const optionKey = options.map((option) => `${option.value}:${option.label}`).join('|');
	useEffect(() => () => clearTimeout(settle.current), []);
	useLayoutEffect(() => {
		const group = root.current!;
		// spec/appearance#segments: at rest the chosen segment paints itself (`--segment-on` + its shadow); the indicator is drawn only while it
		// slides to another segment. A transformed layer at rest draws the same token differently from group to group, and an
		// indicator measured before its group has a size shows nothing at all.
		const before = shown.current,
			wasSelected = group.dataset.selected === 'true';
		shown.current = value;
		const update = () => {
			const active = group.querySelector<HTMLButtonElement>(
				'button[aria-checked="true"],button[aria-selected="true"]'
			);
			group.dataset.selected = String(!!active);
			// Edges snapped to whole pixels from the fractional box: offsetLeft and offsetWidth round each on its own, so a flex
			// segment's right edge could drift a pixel; a fractional edge on a transformed layer smears (spec/composer#capsule-squeeze).
			if (active) {
				const box = group.getBoundingClientRect(),
					own = active.getBoundingClientRect(),
					scale = box.width && group.offsetWidth ? box.width / group.offsetWidth : 1,
					// A strip that scrolls sideways (`keepFocus` tabs) moves its segments, not its box: the indicator lies in the content.
					left = Math.round((own.left - box.left) / scale - group.clientLeft + group.scrollLeft),
					right = Math.round((own.right - box.left) / scale - group.clientLeft + group.scrollLeft);
				group.style.setProperty('--segment-x', `${left}px`);
				group.style.setProperty('--segment-width', `${right - left}px`);
				group.style.setProperty('--segment-height', `${Math.round(own.height / scale)}px`);
			}
		};
		update();
		if (
			before !== null &&
			before !== value &&
			wasSelected &&
			group.dataset.selected === 'true' &&
			group.dataset.motionReady === 'true'
		) {
			const indicator = group.querySelector<HTMLElement>(`.${s.segmentIndicator}`),
				travel = indicator
					? Math.max(
							0,
							...getComputedStyle(indicator)
								.transitionDuration.split(',')
								.map((item) => parseFloat(item) || 0)
						)
					: 0;
			clearTimeout(settle.current);
			if (travel > 0) {
				group.dataset.moving = 'true';
				settle.current = setTimeout(
					() => {
						delete group.dataset.moving;
					},
					travel * 1000 + 40
				);
			} else delete group.dataset.moving;
		}
		const observer = new ResizeObserver(update);
		observer.observe(group);
		for (const button of group.querySelectorAll('button')) observer.observe(button);
		// A web font that arrives late changes the labels' widths without always resizing the group first.
		document.fonts?.addEventListener('loadingdone', update);
		const frame = requestAnimationFrame(() => {
			group.dataset.motionReady = 'true';
		});
		return () => {
			observer.disconnect();
			document.fonts?.removeEventListener('loadingdone', update);
			cancelAnimationFrame(frame);
		};
	}, [value, optionKey, tabs, iconOnly]);
	return (
		<div
			ref={attach}
			className={className ? `${s.segments} ${className}` : s.segments}
			data-size={size}
			data-disabled={disabled || undefined}
			data-tabs={tabs}
			data-stretch={stretch || undefined}
			data-underline={underline || undefined}
			data-icon-only={iconOnly}
			data-deselectable={deselectable || undefined}
			role={tablist ? 'tablist' : 'radiogroup'}
			aria-label={label}>
			{options.map((option, index) => (
				<button
					type="button"
					key={option.value}
					role={tablist ? 'tab' : 'radio'}
					aria-label={option.label}
					{...(optionAttribute ? { [`data-${optionAttribute}`]: option.value } : {})}
					title={option.hint ?? (iconOnly ? option.label : undefined)}
					{...(tablist
						? { 'aria-selected': option.value === value, 'aria-controls': controls }
						: { 'aria-checked': option.value === value })}
					tabIndex={
						!keepFocus &&
						(option.value === value ||
							(index === 0 && !options.some((item) => item.value === value)))
							? 0
							: -1
					}
					disabled={disabled || option.disabled || undefined}
					{...(keepFocus
						? {
								onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
									event.preventDefault();
									onChange(option.value);
								},
							}
						: { onClick: () => onChange(option.value) })}
					onKeyDown={(event) => {
						if (keepFocus) return;
						const direction =
							event.key === 'ArrowRight' || event.key === 'ArrowDown'
								? 1
								: event.key === 'ArrowLeft' || event.key === 'ArrowUp'
									? -1
									: 0;
						if (!direction && event.key !== 'Home' && event.key !== 'End') return;
						event.preventDefault();
						const next =
							event.key === 'Home'
								? 0
								: event.key === 'End'
									? options.length - 1
									: (index + direction + options.length) % options.length;
						onChange(options[next]!.value);
						event.currentTarget.parentElement
							?.querySelectorAll<HTMLButtonElement>('button')
							[next]?.focus();
					}}>
					{option.icon}
					{!iconOnly &&
						(option.short ? (
							<>
								<span data-segment-full>{option.label}</span>
								<span data-segment-short>{option.short}</span>
							</>
						) : (
							option.label
						))}
					{/* spec/remote-access-and-mobile#remote-button: a count after the label, «Connect to another · 3». */}
					{option.tail && !iconOnly && <span className={s.segmentTail}>{option.tail}</span>}
					{option.badge}
				</button>
			))}
			<span aria-hidden="true" className={s.segmentIndicator} />
		</div>
	);
}
/** spec/task-window-workspace#layout-switch: independent switches in one capsule (Segments' look, rule 17) — each turns its own thing on and off; the state
 *  is shown by the glyph alone (the Layout glyphs fill their column), the capsule never lifts a segment. Every switch turns
 *  off: none refuses, so no hint has to say why. `menu` — the ▾ at the end. */
export type SwitchOption = {
	value: string;
	label: string;
	icon: ReactNode;
	checked: boolean;
	hint?: string;
	/** A count beside the glyph (a hidden work area's tabs, spec/task-window-workspace#layout-switch). */ tail?: ReactNode;
	/** spec/task-window-workspace#two-columns: the glyph shows the state and opens the capsule's ▾ menu instead of switching (two columns' Layout). */
	opensMenu?: boolean;
};
export function Switches({
	label,
	options,
	onToggle,
	menu,
	size,
	rootRef,
}: {
	label: string;
	options: SwitchOption[];
	onToggle(value: string): void;
	menu?: {
		label: string;
		hint?: string;
		expanded: boolean;
		onClick(): void;
		ref?: Ref<HTMLButtonElement>;
	};
	size?: ControlSize;
	/** The capsule itself — the menu's anchor when a glyph opens it too (`opensMenu`). */ rootRef?: Ref<HTMLDivElement>;
}) {
	return (
		<div
			ref={rootRef}
			className={s.switches}
			role="group"
			aria-label={label}
			data-size={size}
			data-switches>
			{options.map((option) => (
				<button
					key={option.value}
					type="button"
					{...(option.opensMenu && menu
						? { 'aria-haspopup': 'menu' as const, 'aria-expanded': menu.expanded }
						: { role: 'switch', 'aria-checked': option.checked })}
					aria-label={option.label}
					data-switch={option.value}
					title={option.hint ?? option.label}
					onClick={() => (option.opensMenu && menu ? menu.onClick() : onToggle(option.value))}>
					{option.icon}
					{option.tail !== undefined && <span className={s.switchTail}>{option.tail}</span>}
				</button>
			))}
			{menu && (
				<button
					ref={menu.ref}
					type="button"
					data-menu
					// spec/task-window-workspace#layout-switch: the ▾ is 18 wide inside the capsule, under spec/appearance#control-scale's 24, on purpose.
					data-allow-small
					aria-label={menu.label}
					title={menu.hint ?? menu.label}
					aria-haspopup="menu"
					aria-expanded={menu.expanded}
					onClick={menu.onClick}>
					<Chevron />
				</button>
			)}
		</div>
	);
}
/** Nearest ancestor that clips or scrolls, so the list opens where it has room instead of scrolling the sheet. */
function clippingBox(node: HTMLElement, axis: 'overflowX' | 'overflowY' = 'overflowY') {
	for (let parent = node.parentElement; parent; parent = parent.parentElement) {
		const style = getComputedStyle(parent);
		if (/(auto|scroll|hidden|clip)/.test(style[axis]) || parent.tagName === 'DIALOG')
			return parent.getBoundingClientRect();
	}
	return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}
export function Popup({
	size,
	label,
	options,
	value,
	onChange,
	chip = false,
	ghost = false,
	fit = false,
	chevron = !chip,
	icon,
	disabled = false,
	displayValue,
	align = 'start',
	search,
	groups,
	menuWidth,
}: {
	size?: ControlSize;
	/** The list's width when it is wider than the 200 px default (the Helper agent's grouped list is 260). */
	menuWidth?: number;
	/** spec/composer-steering-queue-and-ghost#ghost-headless: headers over runs of options with the same `group`, a line between runs. */ groups?: Record<
		string,
		PopupGroup
	>;
	label: string;
	options: Option[];
	value: string;
	onChange(value: string): void;
	chip?: boolean;
	/** spec/appearance#evolution-redesign: a trigger without its own fill — the strip's colour at rest, `tint` on hover and
	 *  while its list is open, no ring; the text keeps `fg` and the chevron stays. */ ghost?: boolean;
	/** spec/pull-requests-and-ci#ci-segment: the trigger is as wide as its text — a filter in a row of filters, not a field. */
	fit?: boolean;
	/** A chip hides the chevron unless asked (spec/chat-turns-plans-and-questions#plan-row agent chip). */ chevron?: boolean;
	icon?: ReactNode;
	disabled?: boolean;
	/** What the closed trigger shows instead of the option's label — text, or a node such as `BranchName`. */ displayValue?: ReactNode;
	/** `end` opens the list right-aligned so it stays inside a right-hand inspector. */ align?:
		'start' | 'end';
	/** A filter field on top of a long list (branches). */ search?: {
		placeholder: string;
		empty: string;
		/** The label of the field's × (spec/appearance#clear-field). */ clear: string;
	};
}) {
	const marks = useContext(PopupMarks);
	const [open, setOpen] = useState(false);
	const present = usePresence(open);
	const [active, setActive] = useState(0);
	const [query, setQuery] = useState('');
	const [place, setPlace] = useState<{ side: 'bottom' | 'top'; maxHeight: number }>({
		side: 'bottom',
		maxHeight: 280,
	});
	const [edge, setEdge] = useState(align);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const field = useRef<HTMLInputElement>(null);
	const id = useId();
	const needle = query.trim().toLocaleLowerCase();
	const shown =
		search && needle
			? options.filter((option) =>
					`${option.value} ${typeof option.label === 'string' ? option.label : ''}`
						.toLocaleLowerCase()
						.includes(needle)
				)
			: options;
	useEffect(() => {
		if (disabled || !options.length) setOpen(false);
	}, [disabled, options.length]);
	useEffect(() => {
		if (!open) return;
		(search ? field.current : list.current)?.focus();
		const close = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener('pointerdown', close);
		return () => document.removeEventListener('pointerdown', close);
	}, [open]);
	useEffect(() => {
		if (!open) return;
		const menu = list.current,
			option = menu?.querySelectorAll<HTMLElement>('[role=option]')[active],
			header = search ? (menu?.querySelector<HTMLElement>('label')?.offsetHeight ?? 0) : 0;
		if (!menu || !option) return;
		if (option.offsetTop - header < menu.scrollTop) menu.scrollTop = option.offsetTop - header;
		else if (option.offsetTop + option.offsetHeight > menu.scrollTop + menu.clientHeight)
			menu.scrollTop = option.offsetTop + option.offsetHeight - menu.clientHeight;
	}, [active, open, query]);
	// A list wider than the room on its side flips to the other edge of the trigger, so a narrow panel never cuts it.
	useLayoutEffect(() => {
		if (!open || !list.current || !root.current) return;
		const box = root.current.getBoundingClientRect(),
			clip = clippingBox(root.current, 'overflowX'),
			width = list.current.offsetWidth;
		const toRight = clip.right - box.left - 8,
			toLeft = box.right - clip.left - 8;
		setEdge(
			align === 'start'
				? width > toRight && toLeft > toRight
					? 'end'
					: 'start'
				: width > toLeft && toRight > toLeft
					? 'start'
					: 'end'
		);
	}, [open, align]);
	function finish(index?: number) {
		if (index !== undefined && shown[index]?.disabled) return;
		if (index !== undefined && shown[index]) onChange(shown[index].value);
		setOpen(false);
		trigger.current?.focus();
	}
	function show() {
		if (disabled || !options.length) return;
		setQuery('');
		setActive(
			Math.max(
				0,
				options.findIndex((option) => option.value === value)
			)
		);
		// Open towards the side with room and cap the height there; the list scrolls itself, never the surface around it.
		const box = trigger.current!.getBoundingClientRect(),
			clip = clippingBox(root.current!),
			below = clip.bottom - box.bottom - 10,
			above = box.top - clip.top - 10;
		const side = (chip ? !(above >= 200 || above >= below) : below >= 200 || below >= above)
			? 'bottom'
			: 'top';
		setPlace({
			side,
			maxHeight: Math.max(96, Math.min(chip ? 280 : 300, side === 'bottom' ? below : above)),
		});
		setOpen(true);
	}
	const optionRow = (option: Option, index: number) => (
		<div
			role="option"
			key={option.value}
			id={`${id}-${index}`}
			aria-selected={value === option.value || option.checked === true}
			aria-disabled={option.disabled || undefined}
			data-active={index === active}
			onPointerMove={() => setActive(index)}
			onClick={() => finish(index)}
			aria-label={
				typeof option.label !== 'string'
					? undefined
					: option.description
						? option.label
						: // A git ref splits into flex parts (`BranchName`), and the browser names it from them with spaces
							// between: `stag ing`. The option is named by the whole ref and its tail, as it reads.
							option.branch
							? [option.label, option.tail].filter(Boolean).join(' ')
							: undefined
			}
			aria-description={
				[groups && option.group ? groups[option.group]?.label : undefined, option.description]
					.filter(Boolean)
					.join(' · ') || undefined
			}>
			{marks && (
				<span className={s.mark} aria-hidden="true">
					{(value === option.value || option.checked) && (
						<svg width="10" height="10" viewBox="0 0 10 10" fill="none">
							<path
								d="M1.8 5.2 4 7.4 8.2 2.8"
								stroke="currentColor"
								strokeWidth="1.5"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					)}
				</span>
			)}
			{option.live ? (
				<span className={s.optionLive}>
					{option.icon}
					<i aria-hidden="true" />
				</span>
			) : (
				option.icon
			)}
			{option.description ? (
				<span className={s.optionText}>
					{option.branch ? (
						<span className={s.optionLabel} data-branch>
							<BranchName name={option.label} />
						</span>
					) : (
						<span>{option.label}</span>
					)}
					<small className={s.optionDescription}>{option.description}</small>
				</span>
			) : option.branch ? (
				<span className={s.optionLabel} data-branch style={option.labelStyle}>
					<BranchName name={option.label} />
				</span>
			) : option.labelStyle ? (
				<span style={option.labelStyle}>{option.label}</span>
			) : (
				option.label
			)}
			{option.action ? (
				<button
					type="button"
					tabIndex={-1}
					className={s.optionAction}
					data-option-action
					aria-label={option.action.label}
					title={option.action.label}
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						option.action!.run();
						list.current?.focus();
					}}
					onKeyDown={(event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.stopPropagation();
							return;
						}
						if (event.key === 'ArrowLeft' || (event.key === 'Tab' && event.shiftKey)) {
							event.preventDefault();
							event.stopPropagation();
							list.current?.focus();
						}
					}}>
					{option.action.icon}
				</button>
			) : (
				option.tail && <small className={s.optionTail}>{option.tail}</small>
			)}
		</div>
	);
	const optionRows = groups
		? shown.map((option, index) => {
				const head =
					option.group !== undefined && (index === 0 || shown[index - 1]!.group !== option.group)
						? groups[option.group]
						: undefined;
				return (
					<Fragment key={option.value}>
						{head && index > 0 && <span className={s.menuSep} aria-hidden="true" />}
						{head && (
							<div className={s.menuHead} aria-hidden="true">
								{head.icon}
								<span>{head.label}</span>
								{head.note && <small>{head.note}</small>}
							</div>
						)}
						{optionRow(option, index)}
					</Fragment>
				);
			})
		: shown.map(optionRow);
	return (
		<div
			ref={root}
			className={s.popupRoot}
			data-size={size ?? (chip ? 's' : undefined)}
			data-chip={chip}
			data-ghost={ghost || undefined}
			data-fit={fit || undefined}
			data-marks={marks || undefined}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
			}}>
			<button
				ref={trigger}
				type="button"
				className={s.popup}
				disabled={disabled || !options.length}
				aria-label={label}
				title={label}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={id}
				onClick={() => (open ? setOpen(false) : show())}
				onKeyDown={(event) => {
					if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
						event.preventDefault();
						show();
					}
				}}>
				<span>
					{icon ?? options.find((option) => option.value === value)?.icon}
					{/* spec/task-window#panel: the value stays on one line; a long one ends in «…» (a branch gives way in the middle). */}
					<span className={s.popupText}>
						{displayValue ?? options.find((option) => option.value === value)?.label}
					</span>
				</span>
				{chevron && <Chevron />}
			</button>
			{present && (
				<div
					data-open={open}
					inert={!open}
					aria-hidden={!open}
					ref={list}
					tabIndex={-1}
					{...(search
						? {}
						: {
								id,
								role: 'listbox',
								'aria-label': label,
								'aria-activedescendant': `${id}-${active}`,
							})}
					className={s.menu}
					data-align={edge}
					data-side={place.side}
					data-search={Boolean(search)}
					style={{ maxHeight: place.maxHeight, ...(menuWidth ? { width: menuWidth } : {}) }}
					onKeyDown={(event) => {
						const typing = event.target instanceof HTMLInputElement;
						const onAction = (event.target as HTMLElement).hasAttribute('data-option-action');
						// spec/task-window-workspace#tool-tab-look.1: → or Tab from the active row goes to its own button; ↑/↓ come back to the list.
						if (
							!typing &&
							!onAction &&
							(event.key === 'ArrowRight' || (event.key === 'Tab' && !event.shiftKey)) &&
							shown[active]?.action
						) {
							const button = list.current
								?.querySelectorAll<HTMLElement>('[role=option]')
								[active]?.querySelector<HTMLElement>('[data-option-action]');
							if (button) {
								event.preventDefault();
								button.focus();
								return;
							}
						}
						if (onAction && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
							list.current?.focus();
						if (event.key === 'Escape') {
							event.preventDefault();
							event.stopPropagation();
							finish();
						} else if (event.key === 'Enter' || (event.key === ' ' && !typing)) {
							event.preventDefault();
							finish(shown.length ? active : undefined);
						} else if (
							['ArrowDown', 'ArrowUp'].includes(event.key) ||
							(['Home', 'End'].includes(event.key) && !typing)
						) {
							event.preventDefault();
							if (shown.length)
								setActive(
									event.key === 'Home'
										? 0
										: event.key === 'End'
											? shown.length - 1
											: (active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) %
												shown.length
								);
						}
					}}>
					{search ? (
						<>
							<label className={s.menuSearch}>
								<Glyph name="search" size={12} />
								<input
									ref={field}
									role="combobox"
									aria-label={search.placeholder}
									aria-expanded="true"
									aria-controls={id}
									aria-activedescendant={shown.length ? `${id}-${active}` : undefined}
									placeholder={search.placeholder}
									value={query}
									onChange={(event) => {
										setQuery(event.target.value);
										setActive(0);
									}}
								/>
								<ClearField
									label={search.clear}
									value={query}
									onClear={() => {
										setQuery('');
										setActive(0);
									}}
								/>
							</label>
							<section id={id} role="listbox" aria-label={label}>
								{optionRows}
							</section>
							{!shown.length && <p className={s.menuEmpty}>{search.empty}</p>}
						</>
					) : (
						optionRows
					)}
				</div>
			)}
		</div>
	);
}
/** Typed digits stay a draft until Enter or blur, so a partial "1" of "16" is never clamped and saved; arrows and buttons apply at once. */
export function Stepper({
	size,
	label,
	value,
	min = 1,
	max = 99,
	step = 1,
	disabled = false,
	onChange,
	increaseLabel,
	decreaseLabel,
	automaticLabel,
}: {
	size?: ControlSize;
	label: string;
	value: number;
	min?: number;
	max?: number;
	step?: number;
	disabled?: boolean;
	onChange(value: number): void;
	increaseLabel: string;
	decreaseLabel: string;
	automaticLabel?: string;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const decimals = step < 1 ? 1 : 0,
		automatic = automaticLabel !== undefined && value === min;
	const commit = (n: number) => {
		setDraft(null);
		const next = Math.round(Math.min(max, Math.max(min, n)) * 10 ** decimals) / 10 ** decimals;
		if (next !== value) onChange(next);
	};
	// spec/settings-modules-and-onboarding#settings-window: a fractional step is a text field in the interface's language («1.0» in English, «1,0» in
	// Ukrainian); a number field would take the separator from the OS region and show «1,0» in an English window.
	const fractional = decimals > 0,
		shown = fractional
			? new Intl.NumberFormat(
					(typeof document === 'undefined' ? '' : document.documentElement.lang) || 'en',
					{
						// spec/appearance#chat-text-size: a half step reads as a size — «18», «13.5»; a finer step keeps its digit («1.0»).
						minimumFractionDigits: Number.isInteger(step * 2) ? 0 : decimals,
						maximumFractionDigits: decimals,
						useGrouping: false,
					}
				).format(value)
			: value.toFixed(decimals);
	const typed = () => {
		const text = draft?.trim().replace(',', '.') ?? '';
		return text && Number.isFinite(Number(text)) ? Number(text) : null;
	};
	return (
		<div
			className={s.stepper}
			data-size={size}
			data-disabled={disabled}
			data-automatic={automaticLabel !== undefined || undefined}>
			<TextInput
				embedded
				type={automaticLabel || fractional ? 'text' : 'number'}
				role="spinbutton"
				inputMode={decimals ? 'decimal' : 'numeric'}
				aria-label={label}
				disabled={disabled}
				value={draft ?? (automatic ? automaticLabel : shown)}
				min={min}
				max={max}
				step={step}
				aria-valuemin={min}
				aria-valuemax={max}
				aria-valuenow={value}
				aria-valuetext={automatic ? automaticLabel : undefined}
				onKeyDown={(event) => {
					if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
						event.preventDefault();
						commit((typed() ?? value) + (event.key === 'ArrowUp' ? step : -step));
					}
					if (event.key === 'Enter') {
						event.preventDefault();
						const n = typed();
						if (n === null) setDraft(null);
						else commit(n);
					}
					if (event.key === 'Escape' && draft !== null) {
						event.stopPropagation();
						event.preventDefault();
						setDraft(null);
					}
				}}
				onChange={(event) => setDraft(event.target.value)}
				onBlur={() => {
					const n = typed();
					if (n === null) setDraft(null);
					else commit(n);
				}}
			/>
			<span>
				<button
					type="button"
					aria-label={decreaseLabel}
					disabled={disabled || value <= min}
					onClick={() => commit(value - step)}>
					−
				</button>
				<button
					type="button"
					aria-label={increaseLabel}
					disabled={disabled || value >= max}
					onClick={() => commit(value + step)}>
					+
				</button>
			</span>
		</div>
	);
}
export function Choice({
	type,
	label,
	size,
	...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> & {
	type: 'checkbox' | 'radio';
	label: string;
	size?: ControlSize;
}) {
	return <input {...props} type={type} aria-label={label} className={s.choice} data-size={size} />;
}
export function Field({
	label,
	error,
	size,
	...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & {
	label: string;
	error?: string;
	size?: ControlSize;
}) {
	const id = useId();
	return (
		<label className={s.field} data-size={size} data-invalid={Boolean(error)}>
			<span>{label}</span>
			<TextInput
				embedded
				{...props}
				aria-invalid={Boolean(error)}
				aria-describedby={error ? id : undefined}
			/>
			{error && (
				<span id={id} className={s.fieldError}>
					{error}
				</span>
			)}
		</label>
	);
}
export function Chip({
	children,
	tone = 'normal',
	square = false,
	fresh = false,
	className = '',
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
	/** spec/appearance#component-details (rule 17): `warning` is the one amber pill — NoticeChip's look, its styles. */ tone?:
		'normal' | 'selected' | 'warning';
	/** spec/crew-templates-and-editor#editor-inspector: a chip that is only a glyph (the «+» of a chip row) is square. */ square?: boolean;
	/** spec/tasks#worktree-preparation: a chip just added carries an accent ring;
	 * the caller drops it after ~2 s and the ring fades. */ fresh?: boolean;
}) {
	return (
		<button
			type="button"
			{...props}
			className={`${tone === 'warning' ? notice.chip : s.chip} ${className}`}
			data-size="s"
			data-tone={tone}
			data-square={square || undefined}
			data-fresh={fresh || undefined}>
			{children}
		</button>
	);
}
export function Chevron({ right = false }: { right?: boolean }) {
	return (
		<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
			<path
				d={right ? 'M3.6 2 6.6 5 3.6 8' : 'M2 3.6 5 6.6 8 3.6'}
				fill="none"
				stroke="currentColor"
				strokeWidth="1.6"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}
/** spec/sidebar#done-rows: `completed` is the quiet tick (no circle, `--fg3`); `done` stays the green check in a circle (spec/sidebar#state-icons).
 * spec/agents-and-providers#sign-in-recovery: `signIn` — a failure on the agent's sign-in shows the amber key, not the red error. */
export function StatusIcon({
	status,
	label,
	question = false,
	signIn = false,
	size = 16,
}: {
	question?: boolean;
	signIn?: boolean;
	status: AgentTask['status'];
	label: string;
	size?: number;
}) {
	return (
		<span
			className={s.status}
			style={size === 16 ? undefined : ({ '--status-size': `${size}px` } as CSSProperties)}
			data-status={status}
			data-sign-in={(signIn && status === 'failed') || undefined}
			role="img"
			aria-label={label}>
			<Glyph
				size={size}
				name={
					signIn && status === 'failed'
						? 'agent-key'
						: status === 'rate-limited'
							? 'agent-hourglass'
							: status === 'working' || status === 'preparing'
								? 'agent-run'
								: status === 'needs-you'
									? question
										? 'agent-question'
										: 'agent-permission'
									: status === 'failed'
										? 'agent-failed'
										: status === 'interrupted'
											? 'agent-stopped'
											: status === 'backlog'
												? 'agent-backlog'
												: status === 'queued'
													? 'agent-queued'
													: status === 'completed'
														? 'agent-completed'
														: 'agent-idle'
				}
			/>
		</span>
	);
}
/** The status glyph alone, for rows that draw it in their own colour (spec/tasks#archive archive rows). */
export function StatusGlyph({
	status,
	size = 16,
	question = false,
	signIn = false,
}: {
	status: AgentTask['status'];
	size?: number;
	question?: boolean;
	signIn?: boolean;
}) {
	return (
		<Glyph
			size={size}
			name={
				signIn && status === 'failed'
					? 'agent-key'
					: status === 'rate-limited'
						? 'agent-hourglass'
						: status === 'working' || status === 'preparing'
							? 'agent-run'
							: status === 'needs-you'
								? question
									? 'agent-question'
									: 'agent-permission'
								: status === 'failed'
									? 'agent-failed'
									: status === 'interrupted'
										? 'agent-stopped'
										: status === 'backlog'
											? 'agent-backlog'
											: status === 'queued'
												? 'agent-queued'
												: status === 'completed'
													? 'agent-completed'
													: 'agent-idle'
			}
		/>
	);
}
export function Badge({ children, warning = false }: { children: ReactNode; warning?: boolean }) {
	return (
		<span className={s.badge} data-warning={warning}>
			{children}
		</span>
	);
}
export function Tag({ children }: { children: ReactNode }) {
	return <span className={s.tag}>{children}</span>;
}
