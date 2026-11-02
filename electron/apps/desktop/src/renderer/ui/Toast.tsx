import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type HTMLAttributes,
	type ReactNode,
	type Ref,
} from 'react';
import { create } from 'zustand';
import { t, timesCount, type Locale } from '@brigadir/core';
import { Button } from './Controls';
import { Glyph } from './Glyph';
import { PopupClose } from './PopupClose';
import s from './Toast.module.css';

/** spec/notifications-slack-notes-and-schedules#message-classes: class T toasts — a passing failure of the person's action or of a background read, a summary of an action.
 *  A stack of up to 3 + «N more», duplicates «×N», time while visible, paused on hover, focus and an inactive window; Esc closes the focused toast. */
export type ToastKind = 'success' | 'info' | 'warning' | 'error';
export type ToastAction = { label: string; run(): void };
export type ToastOptions = {
	action?: ToastAction | undefined;
	/** Part of the text set in bold, e.g. the file name. */ bold?: string | undefined;
	/** Same key — one toast with ×N. Defaults to kind + text. */ key?: string | undefined;
	/** False: the notification center hears about it elsewhere (a CI run main writes itself, spec/notifications-slack-notes-and-schedules#notification-center). */ log?: false;
};
/** spec/notifications-slack-notes-and-schedules#notification-center: every toast also goes to the notification center, which installs this. */
export type ToastLogger = (toast: {
	kind: ToastKind;
	text: string;
	action: ToastAction | undefined;
	key: string;
}) => void;
let logger: ToastLogger | null = null;
export function setToastLogger(next: ToastLogger | null) {
	logger = next;
}
export type Toast = {
	id: number;
	kind: ToastKind;
	text: string;
	bold?: string | undefined;
	action?: ToastAction | undefined;
	key: string;
	count: number;
	remaining: number;
};
export const TOAST_DURATION: Record<ToastKind, number> = {
	success: 4000,
	info: 6000,
	warning: 8000,
	error: 10000,
};
const VISIBLE = 3,
	EXPANDED = 5,
	KEPT = 20;
type State = {
	toasts: Toast[];
	expanded: boolean;
	/** Hosts that sit over a task; the window's fallback host yields to them. */ anchored: number;
	/** Hosts on a surface over the whole window (spec/remote-access-and-mobile#module-and-settings, the remote cover); every other host yields to them. */ over: number;
};
export const useToasts = create<State>(() => ({
	toasts: [],
	expanded: false,
	anchored: 0,
	over: 0,
}));
let next = 0;

export function notify(kind: ToastKind, text: string, options: ToastOptions = {}) {
	const key = options.key ?? `${kind}:${text}`;
	if (logger && options.log !== false) logger({ kind, text, action: options.action, key });
	useToasts.setState((state) => {
		const same = state.toasts.find((toast) => toast.key === key);
		if (same)
			return {
				toasts: state.toasts.map((toast) =>
					toast === same
						? {
								...toast,
								text,
								bold: options.bold,
								action: options.action,
								count: toast.count + 1,
								remaining: TOAST_DURATION[kind],
							}
						: toast
				),
			};
		return {
			toasts: [
				...state.toasts,
				{
					id: ++next,
					kind,
					text,
					bold: options.bold,
					action: options.action,
					key,
					count: 1,
					remaining: TOAST_DURATION[kind],
				},
			].slice(-KEPT),
		};
	});
}
/** A short summary of the person's own action (PRDone, ProjectCStarted). */
export function showToast(text: string, action?: ToastAction) {
	notify('success', text, { action });
}
export function toastError(text: string, options?: ToastOptions) {
	notify('error', text, options);
}
export function toastWarning(text: string, options?: ToastOptions) {
	notify('warning', text, options);
}
/** A background read that works again takes back its warning (spec/notifications-slack-notes-and-schedules#message-classes: the toast is for a failure, not for a past one). */
export function resolveToast(text: string, kind: ToastKind = 'warning') {
	useToasts.setState((state) => {
		const toasts = state.toasts.filter((toast) => toast.key !== `${kind}:${text}`);
		return toasts.length === state.toasts.length
			? state
			: { toasts, expanded: state.expanded && toasts.length > VISIBLE };
	});
}
export function dismissToast(id: number) {
	useToasts.setState((state) => {
		const toasts = state.toasts.filter((toast) => toast.id !== id);
		return { toasts, expanded: state.expanded && toasts.length > VISIBLE };
	});
}
/** Time passes only while the person can see the toast: the window has focus and is shown (spec/notifications-slack-notes-and-schedules#message-classes). */
/** A modal dialog covers the toasts (top layer), so they wait under it too. */
function windowActive() {
	return (
		document.visibilityState === 'visible' &&
		document.hasFocus() &&
		!document.querySelector('dialog:modal')
	);
}

const GLYPH = {
	success: 'toast-success',
	info: 'toast-info',
	warning: 'toast-warning',
	error: 'toast-error',
} as const;
function body(toast: Toast): ReactNode {
	const at = toast.bold ? toast.text.indexOf(toast.bold) : -1;
	return at < 0 ? (
		toast.text
	) : (
		<>
			{toast.text.slice(0, at)}
			<strong>{toast.bold}</strong>
			{toast.text.slice(at + toast.bold!.length)}
		</>
	);
}

/** The toast region. `anchored` hosts sit over a task's main area and keep clear of `[data-toast-avoid]` (composer, its queue,
 *  review footer) inside their positioned parent; the window's fallback host shows only when no task host is mounted. */
export function ToastHost({
	locale,
	anchored = false,
	over = false,
	bottom = 30,
}: {
	locale: Locale;
	anchored?: boolean;
	/** On a surface over the whole window (the remote cover): the only host shown while it is mounted. */ over?: boolean;
	bottom?: number;
}) {
	const { toasts, expanded } = useToasts();
	const taken = useToasts((state) => state.anchored > 0),
		covered = useToasts((state) => state.over > 0);
	const region = useRef<HTMLElement>(null),
		returnTo = useRef<HTMLElement | null>(null),
		hovered = useRef(false),
		focused = useRef(false);
	const [offset, setOffset] = useState(bottom);
	const shown = over || (!covered && (anchored || !taken));
	useEffect(() => {
		if (!anchored) return;
		useToasts.setState((state) => ({ anchored: state.anchored + 1 }));
		return () => useToasts.setState((state) => ({ anchored: state.anchored - 1 }));
	}, [anchored]);
	useEffect(() => {
		if (!over) return;
		useToasts.setState((state) => ({ over: state.over + 1 }));
		return () => useToasts.setState((state) => ({ over: state.over - 1 }));
	}, [over]);
	const place = () => {
		const host = region.current,
			parent = host?.offsetParent as HTMLElement | null;
		if (!host || !parent) return;
		const floor = parent.getBoundingClientRect().bottom;
		let lift = bottom;
		for (const element of parent.querySelectorAll<HTMLElement>('[data-toast-avoid]')) {
			const rect = element.getBoundingClientRect();
			if (rect.height > 0) lift = Math.max(lift, Math.round(floor - rect.top + 10));
		}
		setOffset((value) => (value === lift ? value : lift));
	};
	useLayoutEffect(() => {
		if (shown && toasts.length) place();
	}, [shown, toasts.length, bottom]);
	useEffect(() => {
		if (!shown || !toasts.length) return;
		let last = performance.now();
		const timer = setInterval(() => {
			const now = performance.now(),
				elapsed = now - last;
			last = now;
			place();
			if (hovered.current || focused.current || !windowActive()) return;
			useToasts.setState((state) => {
				const toasts = state.toasts
					.map((toast) => ({ ...toast, remaining: toast.remaining - elapsed }))
					.filter((toast) => toast.remaining > 0);
				return { toasts, expanded: state.expanded && toasts.length > VISIBLE };
			});
		}, 200);
		return () => clearInterval(timer);
	}, [shown, toasts.length > 0]);
	if (!shown || !toasts.length) return null;
	const close = (toast: Toast, restore: boolean) => {
		const inside = region.current
			?.querySelector(`[data-toast-id="${toast.id}"]`)
			?.contains(document.activeElement);
		dismissToast(toast.id);
		if (restore || inside) {
			const target = returnTo.current;
			if (target?.isConnected) target.focus();
			else (document.querySelector('main') as HTMLElement | null)?.focus();
			focused.current = false;
		}
	};
	return (
		<ToastRegion
			ref={region}
			locale={locale}
			toasts={toasts}
			expanded={expanded}
			bottom={offset}
			close={close}
			onMouseEnter={() => {
				hovered.current = true;
			}}
			onMouseLeave={() => {
				hovered.current = false;
			}}
			onFocus={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null))
					returnTo.current = event.relatedTarget as HTMLElement | null;
				focused.current = true;
			}}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget as Node | null))
					focused.current = false;
			}}
		/>
	);
}

type RegionProps = {
	ref?: Ref<HTMLElement>;
	locale: Locale;
	toasts: readonly Toast[];
	expanded: boolean;
	bottom: number;
	close(toast: Toast, restore: boolean): void;
} & Pick<HTMLAttributes<HTMLElement>, 'onMouseEnter' | 'onMouseLeave' | 'onFocus' | 'onBlur'>;
/** The drawn region: the newest three (five when expanded), «N more» above them — «Show less» when expanded. */
export function ToastRegion({
	ref,
	locale,
	toasts,
	expanded,
	bottom,
	close,
	...events
}: RegionProps) {
	const limit = expanded ? EXPANDED : VISIBLE,
		visible = toasts.slice(-limit),
		hidden = toasts.length - visible.length;
	return (
		<section
			ref={ref}
			className={s.region}
			style={{ bottom }}
			aria-label={t(locale, 'Notifications (toasts)')}
			data-toast-region
			{...events}>
			{/* spec/notifications-slack-notes-and-schedules#notice-chips: once expanded the pill is «Show less» and folds the stack back to three. */}
			{(expanded || hidden > 0) && (
				<button
					type="button"
					className={s.more}
					aria-expanded={expanded}
					onClick={() => useToasts.setState({ expanded: !expanded })}>
					{expanded ? t(locale, 'Show less') : t(locale, '{n} more').replace('{n}', String(hidden))}
				</button>
			)}
			<div className={s.stack}>
				{visible.map((toast) => (
					<div
						key={toast.id}
						data-toast-id={toast.id}
						data-kind={toast.kind}
						className={s.toast}
						role={toast.kind === 'warning' || toast.kind === 'error' ? 'alert' : 'status'}
						onKeyDown={(event) => {
							if (event.key !== 'Escape') return;
							event.preventDefault();
							event.stopPropagation();
							close(toast, true);
						}}>
						<Glyph name={GLYPH[toast.kind]} size={14} />
						<span className={s.text}>{body(toast)}</span>
						{toast.count > 1 && (
							<span className={s.count} aria-label={timesCount(locale, toast.count)}>
								×{toast.count}
							</span>
						)}
						{toast.action && (
							<Button
								size="s"
								appearance="primary"
								variant="ghost"
								className={s.action}
								onClick={() => {
									const action = toast.action!;
									close(toast, false);
									action.run();
								}}>
								{toast.action.label}
							</Button>
						)}
						<PopupClose locale={locale} close={() => close(toast, false)} />
					</div>
				))}
			</div>
		</section>
	);
}
