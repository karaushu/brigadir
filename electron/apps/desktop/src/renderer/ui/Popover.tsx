import {
	createContext,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type CSSProperties,
	type FocusEvent as ReactFocusEvent,
	type KeyboardEvent as ReactKeyboardEvent,
	type ReactNode,
	type RefObject,
} from 'react';
import type { Locale } from '@brigadir/core';
import { Glyph } from './Glyph';
import { PopupClose } from './PopupClose';
import { usePresence } from './use-presence';
import { focusLost, whenEnabled } from './keep-focus';
import s from './Popover.module.css';

/**
 * spec/appearance#popover-shell: one popover and one menu for the whole app (rule 17). A popover floats in the top layer next to its anchor,
 * opens towards the side with room, carries a header with its name and `Esc` (rule 14), and closes the same way
 * everywhere: Esc first (capture, before a dialog under it), a press outside, Tab out of a menu, or the scroll of the
 * surface under it. Focus comes back to the anchor unless the person clicked elsewhere or a row handed it on.
 */
export type DismissReason = 'escape' | 'outside' | 'select' | 'tab' | 'scroll' | 'close';
const stack: symbol[] = [];

/** Esc, a press outside the anchor and the popover, and a scroll under it close the topmost open popover. */
export function useDismiss({
	open,
	refs,
	onClose,
	scroll: onScroll = true,
	focusOut = false,
}: {
	open: boolean;
	refs: readonly RefObject<HTMLElement | null>[];
	onClose(reason: DismissReason): void;
	scroll?: boolean;
	/** Focus moving outside closes it too (a hover popover). */ focusOut?: boolean;
}) {
	const latest = useRef(onClose);
	latest.current = onClose;
	useEffect(() => {
		if (!open) return;
		const id = Symbol('popover');
		stack.push(id);
		const inside = (target: EventTarget | null) =>
			target instanceof Node && refs.some((ref) => ref.current?.contains(target));
		// A list control open inside the popover (a `Popup`) closes itself on Esc first. Only one within it: a popover
		// rendered inside a list (the «+» menu in the Templates list) still closes on Esc.
		const nested = (target: EventTarget | null) => {
			const list =
				target instanceof Element ? target.closest('[role=listbox],[role=combobox]') : null;
			return (
				!!list &&
				refs.some((ref) => !!ref.current && ref.current !== list && ref.current.contains(list))
			);
		};
		const key = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || stack.at(-1) !== id || nested(event.target)) return;
			event.preventDefault();
			event.stopPropagation();
			latest.current('escape');
		};
		const press = (event: PointerEvent) => {
			if (stack.at(-1) === id && !inside(event.target)) latest.current('outside');
		};
		const scroll = (event: Event) => {
			if (onScroll && stack.at(-1) === id && !inside(event.target)) latest.current('scroll');
		};
		const focus = (event: FocusEvent) => {
			if (focusOut && !inside(event.target)) latest.current('outside');
		};
		document.addEventListener('keydown', key, true);
		document.addEventListener('pointerdown', press, true);
		addEventListener('scroll', scroll, true);
		document.addEventListener('focusin', focus);
		return () => {
			stack.splice(stack.indexOf(id), 1);
			document.removeEventListener('keydown', key, true);
			document.removeEventListener('pointerdown', press, true);
			removeEventListener('scroll', scroll, true);
			document.removeEventListener('focusin', focus);
		};
	}, [open]);
}

type Place = {
	top: number;
	left: number;
	maxHeight: number;
	side: 'top' | 'bottom' | 'right';
	arrow: number;
};
const EDGE = 8;
/** Below or above the anchor, whichever has room, aligned to its start or end edge and kept 8 px inside the window.
 *  spec/sidebar#section-rail: `right` — beside the anchor (the sections rail): its top (`start`) or bottom (`end`) on the anchor's. */
function place(
	anchor: DOMRect,
	size: { width: number; height: number },
	side: 'top' | 'bottom' | 'right',
	align: 'start' | 'end',
	GAP: number
): Place {
	if (side === 'right') {
		const height = Math.min(size.height, innerHeight - 2 * EDGE),
			top = Math.max(
				EDGE,
				Math.min(
					align === 'start' ? anchor.top : anchor.bottom - height,
					innerHeight - height - EDGE
				)
			);
		const arrow = Math.max(12, Math.min(height - 22, anchor.top + anchor.height / 2 - top - 5));
		return {
			side,
			left: Math.min(anchor.right + GAP, innerWidth - size.width - EDGE),
			top,
			maxHeight: innerHeight - 2 * EDGE,
			arrow,
		};
	}
	const below = innerHeight - anchor.bottom - GAP - EDGE,
		above = anchor.top - GAP - EDGE;
	const chosen =
		side === 'bottom'
			? size.height <= below || below >= above
				? 'bottom'
				: 'top'
			: size.height <= above || above >= below
				? 'top'
				: 'bottom';
	const room = chosen === 'bottom' ? below : above,
		height = Math.min(size.height, room);
	const left = Math.max(
		EDGE,
		Math.min(
			align === 'start' ? anchor.left : anchor.right - size.width,
			innerWidth - size.width - EDGE
		)
	);
	// The arrow points at the anchor's middle, kept off the rounded corners.
	const arrow = Math.max(12, Math.min(size.width - 22, anchor.left + anchor.width / 2 - left - 5));
	return {
		side: chosen,
		left,
		top: chosen === 'bottom' ? anchor.bottom + GAP : anchor.top - GAP - height,
		maxHeight: Math.max(96, room),
		arrow,
	};
}

/** The header of every popover: its name and `Esc`, one row of the popover's size (rule 16). */
export function PopupHeader({
	title,
	note,
	heading,
	size = 's',
	locale,
	close,
	children,
}: {
	title: ReactNode;
	locale: Locale;
	close(): void;
	children?: ReactNode;
	/** A dim second part after the name: the base of a worktree. */ note?: ReactNode;
	/** Controls in place of the name (the capsule view of the agent menu); the row then takes their size. */ heading?: ReactNode;
	size?: 's' | 'm' | undefined;
}) {
	return (
		<header className={s.header} data-size={size}>
			{heading ?? <h2>{title}</h2>}
			{note && <span className={s.note}>{note}</span>}
			{children}
			<PopupClose locale={locale} close={close} />
		</header>
	);
}

export type PopoverProps = {
	open: boolean;
	onClose(reason: DismissReason): void;
	anchor: RefObject<HTMLElement | null>;
	label: string;
	locale: Locale;
	/** The name in the header; the label when absent. */ title?: ReactNode;
	/** Extra controls in the header, before `Esc`. */ headerExtra?: ReactNode;
	/** A dim note after the name in the header. */ note?: ReactNode;
	/** Controls in place of the name; `headerSize` M when they are M controls (rule 16). */ heading?: ReactNode;
	headerSize?: 's' | 'm' | undefined;
	/** Where focus goes back on close; the anchor when absent (a popover placed by a wider block than its trigger). */ returnFocus?:
		RefObject<HTMLElement | null> | undefined;
	side?: 'top' | 'bottom' | 'right';
	align?: 'start' | 'end';
	width?: number | undefined;
	size?: 's' | 'm' | 'l';
	className?: string | undefined;
	/** The element that gets focus on open; the popover itself when absent. */ initialFocus?:
		((popover: HTMLElement) => HTMLElement | null | undefined) | undefined;
	/** False: the popover opens without taking focus (a notice that opens by itself). */ focusOnOpen?: boolean;
	/** A scroll under the popover closes it; by default a menu closes and a dialog popover follows its anchor. */ closeOnScroll?: boolean;
	/** A nub pointing at the anchor (hover popovers: context, limits). */ arrow?: boolean;
	/** Focus moving outside closes it (a hover popover). */ closeOnFocusOut?: boolean;
	onPointerEnter?(): void;
	onPointerLeave?(): void;
	/** Visible: the body does not scroll, so a list control inside (a `Popup`) can open past the popover's edge. */ overflow?:
		'auto' | 'visible';
	role?: 'dialog' | 'menu';
	id?: string;
	children: ReactNode;
	onKeyDown?(event: ReactKeyboardEvent<HTMLDivElement>): void;
} & { [key: `data-${string}`]: string | boolean | undefined };

/** The shell: top layer, placement, motion in and out, the header and the dismissal. */
export function Popover({
	open,
	onClose,
	anchor,
	label,
	locale,
	title,
	headerExtra,
	note,
	heading,
	headerSize,
	returnFocus,
	side = 'bottom',
	align = 'start',
	width,
	size = 'm',
	className = '',
	initialFocus,
	role = 'dialog',
	id,
	focusOnOpen = true,
	closeOnScroll,
	overflow = 'auto',
	arrow = false,
	closeOnFocusOut = false,
	onPointerEnter,
	onPointerLeave,
	children,
	onKeyDown,
	...data
}: PopoverProps) {
	const present = usePresence(open),
		root = useRef<HTMLDivElement>(null),
		[at, setAt] = useState<Place | null>(null),
		handed = useRef(false);
	const close = (reason: DismissReason) => {
		onClose(reason);
		// Focus goes back to the anchor after Esc, a choice or the header's Esc, unless the choice moved it on (a field it
		// opened, a confirm row); a press elsewhere keeps its own focus.
		if (reason !== 'outside' && reason !== 'tab' && reason !== 'scroll' && !handed.current)
			requestAnimationFrame(() => {
				const active = document.activeElement,
					lost = !active || active === document.body || !!root.current?.contains(active);
				const target = (returnFocus ?? anchor).current;
				if (!lost || !target?.isConnected) return;
				// A pending save disabled the trigger (Settings' fieldset, spec/settings-modules-and-onboarding#module-settings-popup): focus waits for it, if still lost.
				if (target.matches(':disabled'))
					whenEnabled(target, () => {
						if (focusLost(document)) target.focus({ preventScroll: true });
					});
				else target.focus({ preventScroll: true });
			});
		handed.current = false;
	};
	const scrollCloses = closeOnScroll ?? role === 'menu';
	useDismiss({
		open,
		refs: [root, anchor],
		onClose: close,
		scroll: scrollCloses,
		focusOut: closeOnFocusOut,
	});
	useLayoutEffect(() => {
		const element = root.current;
		if (!present || !element) return;
		if (!element.matches(':popover-open')) element.showPopover();
		const measure = () => {
			const box = anchor.current?.getBoundingClientRect();
			if (box)
				setAt(
					place(
						box,
						{ width: element.offsetWidth, height: element.scrollHeight },
						side,
						align,
						arrow ? 12 : 6
					)
				);
		};
		// A dialog popover that stays open on scroll follows its anchor.
		const follow = (event: Event) => {
			if (!scrollCloses && !(event.target instanceof Node && element.contains(event.target)))
				measure();
		};
		// A sheet sliding in moves the anchor without resizing it: settle again when its motion ends.
		const observer = new ResizeObserver(measure);
		if (anchor.current) observer.observe(anchor.current);
		observer.observe(element);
		measure();
		addEventListener('resize', measure);
		addEventListener('scroll', follow, true);
		document.addEventListener('transitionend', measure, true);
		document.addEventListener('animationend', measure, true);
		return () => {
			observer.disconnect();
			removeEventListener('resize', measure);
			removeEventListener('scroll', follow, true);
			document.removeEventListener('transitionend', measure, true);
			document.removeEventListener('animationend', measure, true);
		};
	}, [present, side, align]);
	// Focus once the popover is placed: a hidden one (still measuring) cannot take it.
	const focused = useRef(false);
	useEffect(() => {
		if (!open) {
			focused.current = false;
			return;
		}
		if (focused.current || !at || !root.current) return;
		focused.current = true;
		if (!focusOnOpen) return;
		(initialFocus?.(root.current) ?? root.current).focus({ preventScroll: true });
	}, [open, at]);
	return present ? (
		<PopoverContext.Provider
			value={{
				close,
				hand: () => {
					handed.current = true;
				},
			}}>
			<div
				{...data}
				ref={root}
				id={id}
				popover="manual"
				role={role}
				aria-label={label}
				tabIndex={-1}
				data-size={size}
				data-overflow={overflow}
				data-open={open}
				data-side={at?.side ?? side}
				inert={!open}
				className={`${s.popover} ${className}`}
				style={
					{
						top: at?.top,
						left: at?.left,
						maxHeight: at?.maxHeight,
						width,
						visibility: at ? undefined : 'hidden',
						'--arrow-left': `${at?.arrow ?? 0}px`,
						'--arrow-top': `${at?.arrow ?? 0}px`,
					} as CSSProperties
				}
				data-arrow={arrow || undefined}
				onKeyDown={onKeyDown}
				onPointerEnter={onPointerEnter}
				onPointerLeave={onPointerLeave}>
				<PopupHeader
					title={title ?? label}
					note={note}
					heading={heading}
					size={headerSize}
					locale={locale}
					close={() => close('close')}>
					{headerExtra}
				</PopupHeader>
				<div className={s.body}>{children}</div>
			</div>
		</PopoverContext.Provider>
	) : null;
}
/**
 * spec/appearance#bundled-fonts: the shell drawn in place and always open — the kit's specimens of menus and popovers. The same header,
 * body, rows and nub as `Popover`, without the top layer, placement, motion or dismissal.
 */
export function PopoverFrame({
	label,
	locale,
	title,
	note,
	heading,
	headerSize,
	size = 'm',
	width,
	arrow,
	children,
}: {
	label: string;
	locale: Locale;
	title?: ReactNode;
	note?: ReactNode;
	heading?: ReactNode;
	headerSize?: 's' | 'm' | undefined;
	size?: 's' | 'm' | 'l';
	width?: number | undefined;
	/** A nub on this edge, 10 px from the start. */ arrow?: 'top' | 'bottom' | undefined;
	children: ReactNode;
}) {
	return (
		// A specimen, not a dialog: a group, so the page's real dialogs stay the only ones.
		<div
			role="group"
			aria-label={label}
			data-size={size}
			data-static
			data-open
			data-side={arrow === 'bottom' ? 'top' : 'bottom'}
			data-arrow={arrow ? true : undefined}
			className={s.popover}
			style={{ width, '--arrow-left': arrow ? '10px' : undefined } as CSSProperties}>
			<PopupHeader
				title={title ?? label}
				note={note}
				heading={heading}
				size={headerSize}
				locale={locale}
				close={() => {}}
			/>
			<div className={s.body}>{children}</div>
		</div>
	);
}
/**
 * A popover that previews on hover or keyboard focus and stays when clicked (context, subscription limits): the pointer
 * may cross to it, it closes 120 ms after leaving unless pinned, and focus coming back after Esc does not reopen it.
 */
export function useHoverPopover({
	delay = 0,
	canPreview,
}: {
	delay?: number;
	canPreview?: () => boolean;
} = {}) {
	const [mode, setMode] = useState<'preview' | 'pinned' | null>(null),
		[pending, setPending] = useState(false),
		timer = useRef<ReturnType<typeof setTimeout> | null>(null),
		allowed = useRef(canPreview),
		closedAt = useRef(0);
	allowed.current = canPreview;
	const cancel = () => {
		if (timer.current !== null) {
			clearTimeout(timer.current);
			timer.current = null;
		}
		setPending(false);
	};
	const preview = () => {
		cancel();
		if (allowed.current && !allowed.current()) return;
		const show = () => {
			timer.current = null;
			setPending(false);
			if (!allowed.current || allowed.current()) setMode((value) => value ?? 'preview');
		};
		if (delay > 0 && mode === null) {
			setPending(true);
			timer.current = setTimeout(show, delay);
		} else show();
	};
	const leave = () => {
		cancel();
		timer.current = setTimeout(() => setMode((value) => (value === 'preview' ? null : value)), 120);
	};
	const close = () => {
		cancel();
		closedAt.current = Date.now();
		setMode(null);
	};
	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
		},
		[]
	);
	// A delayed preview must not appear after the person scrolls, clicks or dismisses it before it opens.
	useEffect(() => {
		if (!pending) return;
		const key = (event: KeyboardEvent) => {
			if (event.key === 'Escape') close();
		};
		addEventListener('scroll', cancel, true);
		addEventListener('resize', cancel);
		document.addEventListener('pointerdown', cancel, true);
		document.addEventListener('keydown', key, true);
		return () => {
			removeEventListener('scroll', cancel, true);
			removeEventListener('resize', cancel);
			document.removeEventListener('pointerdown', cancel, true);
			document.removeEventListener('keydown', key, true);
		};
	}, [pending]);
	return {
		mode,
		open: mode !== null,
		close,
		trigger: {
			onPointerEnter: preview,
			onPointerLeave: leave,
			onBlur: () => {
				if (pending) cancel();
			},
			onClick: () => {
				cancel();
				setMode((value) => (value === 'pinned' ? null : 'pinned'));
			},
			onFocus: (event: ReactFocusEvent<HTMLElement>) => {
				if (Date.now() - closedAt.current > 200 && event.currentTarget.matches(':focus-visible'))
					preview();
			},
		},
		popover: {
			onPointerEnter: cancel,
			onPointerLeave: leave,
			focusOnOpen: false,
			closeOnFocusOut: true,
			arrow: true,
		},
	};
}
const PopoverContext = createContext<{ close(reason: DismissReason): void; hand(): void }>({
	close() {},
	hand() {},
});
/** Rows and footers inside a popover close it or hand focus on through this. */
export function usePopover() {
	return useContext(PopoverContext);
}

const ITEM = '[role^=menuitem]:not(:disabled)';
/** A menu: the popover with `role=menu`, ↑/↓ that wrap, Home/End, Tab out; the first row focused on open, or the checked one in a choice. */
export function MenuPopover({
	children,
	focus = 'first',
	...props
}: Omit<PopoverProps, 'role' | 'onKeyDown'> & { focus?: 'first' | 'checked' }) {
	const [keyboard, setKeyboard] = useState(false);
	return (
		<Popover
			{...props}
			role="menu"
			className={`${s.menu} ${props.className ?? ''}`}
			initialFocus={
				props.initialFocus ??
				((popover) =>
					(focus === 'checked'
						? popover.querySelector<HTMLElement>(`${ITEM}[aria-checked=true]`)
						: null) ?? popover.querySelector<HTMLElement>(ITEM))
			}
			onKeyDown={(event) => {
				const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEM)],
					index = items.indexOf(document.activeElement as HTMLElement);
				if (event.key === 'Tab') {
					props.onClose('tab');
					return;
				}
				const next =
					event.key === 'Home'
						? 0
						: event.key === 'End'
							? items.length - 1
							: event.key === 'ArrowDown'
								? (index + 1) % items.length
								: event.key === 'ArrowUp'
									? (index - 1 + items.length) % items.length
									: null;
				if (next === null || !items.length) return;
				event.preventDefault();
				setKeyboard(true);
				items[next]?.focus({ preventScroll: true });
			}}>
			<div
				className={s.items}
				data-keyboard={keyboard || undefined}
				onPointerMove={() => {
					if (keyboard) setKeyboard(false);
				}}>
				{children}
			</div>
		</Popover>
	);
}

/**
 * The menu's rows inside another popover (spec/git#main-tree-branches branch picker: a search field over them): the same rows, hover and
 * ↑/↓ that wrap; ↑ from the first row goes back to `before` (the field).
 */
export function MenuList({
	label,
	before,
	children,
}: {
	label: string;
	before?: RefObject<HTMLElement | null>;
	children: ReactNode;
}) {
	const [keyboard, setKeyboard] = useState(false);
	return (
		<div
			role="menu"
			aria-label={label}
			className={s.items}
			data-keyboard={keyboard || undefined}
			onPointerMove={() => {
				if (keyboard) setKeyboard(false);
			}}
			onKeyDown={(event) => {
				const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEM)],
					index = items.indexOf(document.activeElement as HTMLElement);
				if (event.key === 'ArrowUp' && index === 0 && before?.current) {
					event.preventDefault();
					before.current.focus({ preventScroll: true });
					return;
				}
				const next =
					event.key === 'Home'
						? 0
						: event.key === 'End'
							? items.length - 1
							: event.key === 'ArrowDown'
								? (index + 1) % items.length
								: event.key === 'ArrowUp'
									? (index - 1 + items.length) % items.length
									: null;
				if (next === null || !items.length) return;
				event.preventDefault();
				setKeyboard(true);
				items[next]?.focus({ preventScroll: true });
			}}>
			{children}
		</div>
	);
}
/** One row of a menu: an action, or a check / radio with the tick on the left, a second line, a shortcut or a count. */
export function MenuItem({
	icon,
	kind = 'action',
	checked = false,
	description,
	kbd,
	tail,
	disabled = false,
	reason,
	danger = false,
	hands = false,
	keepOpen = false,
	keyshortcuts,
	title,
	onSelect,
	children,
	...rest
}: {
	icon?: ReactNode;
	kind?: 'action' | 'check' | 'radio';
	checked?: boolean;
	description?: ReactNode;
	kbd?: string | undefined;
	tail?: ReactNode;
	disabled?: boolean;
	/** Why the row is off, under it (spec/editor-code-intelligence#definition-and-usages scope menu). */ reason?:
		string | undefined;
	danger?: boolean;
	/** The row opens its own surface, so focus does not go back to the anchor. */ hands?: boolean;
	keepOpen?: boolean;
	keyshortcuts?: string | undefined;
	title?: string | undefined;
	onSelect(): void;
	children: ReactNode;
} & Record<`data-${string}`, string | boolean | undefined>) {
	const { close, hand } = usePopover();
	const role =
		kind === 'check' ? 'menuitemcheckbox' : kind === 'radio' ? 'menuitemradio' : 'menuitem';
	return (
		<>
			<button
				{...rest}
				type="button"
				role={role}
				title={title}
				aria-keyshortcuts={keyshortcuts}
				aria-checked={kind === 'action' ? undefined : checked}
				disabled={disabled}
				tabIndex={-1}
				className={s.item}
				data-danger={danger || undefined}
				onPointerMove={(event) => {
					if (document.activeElement !== event.currentTarget)
						event.currentTarget.focus({ preventScroll: true });
				}}
				onClick={() => {
					if (hands) hand();
					if (!keepOpen) close('select');
					onSelect();
				}}>
				<span className={s.tick} aria-hidden="true">
					{checked && <Glyph name="tick" size={11} />}
				</span>
				{icon && <span className={s.icon}>{icon}</span>}
				<span className={s.label}>
					{children}
					{description && <small>{description}</small>}
				</span>
				{tail !== undefined && <span className={s.tail}>{tail}</span>}
				{kbd && <kbd className={s.kbd}>{kbd}</kbd>}
			</button>
			{reason && <p className={s.reason}>{reason}</p>}
		</>
	);
}
/** A status line among a menu's rows: the row's icon, text and second line, without an action (keyboard skips it). */
export function MenuInfo({
	icon,
	description,
	children,
}: {
	icon?: ReactNode;
	description?: ReactNode;
	children: ReactNode;
}) {
	return (
		<div role="presentation" className={s.item} data-info>
			<span className={s.tick} aria-hidden="true" />
			{icon && <span className={s.icon}>{icon}</span>}
			<span className={s.label}>
				{children}
				{description && <small>{description}</small>}
			</span>
		</div>
	);
}
export function MenuSection({ children }: { children: ReactNode }) {
	return (
		<div role="presentation" className={s.section}>
			{children}
		</div>
	);
}
export function MenuSeparator() {
	return <div role="separator" className={s.separator} />;
}
