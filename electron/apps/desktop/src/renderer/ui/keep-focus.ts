import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * spec/settings-modules-and-onboarding#module-settings-popup: a save disables the form (`<fieldset disabled>`) and the browser drops the
 * focused control to `<body>`. The control that started the save gets focus back when the form is enabled again, unless
 * focus went somewhere on purpose meanwhile. Structural types, so the rules are tested without a DOM.
 */
type Focusable = {
	readonly isConnected: boolean;
	matches(selector: string): boolean;
	closest(selector: string): unknown;
	focus(options?: FocusOptions): void;
};
type FocusDocument = { readonly activeElement: unknown; readonly body: unknown };

/** Focus is lost: nothing, or the page itself, holds it. */
export function focusLost(doc: FocusDocument): boolean {
	return !doc.activeElement || doc.activeElement === doc.body;
}
/** A target that can take focus back: on the page, enabled and not in a closing (inert) popover. */
export function canTakeFocus(target: Focusable | null | undefined): target is Focusable {
	return (
		!!target && target.isConnected && !target.matches(':disabled') && !target.closest('[inert]')
	);
}
/** Gives focus back to `target` if it was lost; focus that moved elsewhere stays. True when `target` holds it after. */
export function restoreFocus(target: Focusable | null, doc: FocusDocument): boolean {
	if (!target) return false;
	if (doc.activeElement === target) return true;
	if (!focusLost(doc) || !canTakeFocus(target)) return false;
	target.focus({ preventScroll: true });
	return doc.activeElement === target;
}

/**
 * Keeps focus on the control that started a save while `busy` disables the form inside `container`. The last control
 * focused inside it is tracked on `focusin`, so the save's own render (which disables it) cannot lose it first.
 */
export function useKeepFocusWhileBusy(container: RefObject<HTMLElement | null>, busy: boolean) {
	const last = useRef<HTMLElement | null>(null),
		kept = useRef<HTMLElement | null>(null);
	useEffect(() => {
		const node = container.current;
		if (!node) return;
		const focus = (event: FocusEvent) => {
			if (event.target instanceof HTMLElement && event.target !== node) last.current = event.target;
		};
		node.addEventListener('focusin', focus);
		return () => node.removeEventListener('focusin', focus);
	}, []);
	useLayoutEffect(() => {
		if (busy) {
			const active = document.activeElement;
			kept.current =
				active instanceof HTMLElement &&
				container.current?.contains(active) &&
				active !== container.current
					? active
					: focusLost(document)
						? last.current
						: null;
			return;
		}
		const target = kept.current;
		kept.current = null;
		restoreFocus(target, document);
	}, [busy]);
}

/**
 * Runs `then` once `target` is enabled again (a fieldset or the control itself): a popover returning focus to a trigger
 * that a pending save disabled. Gives up when the target leaves the page or after `limit` ms.
 */
export function whenEnabled(
	target: Focusable,
	then: () => void,
	{
		root = document.documentElement,
		Observer = MutationObserver,
		limit = 30_000,
	}: {
		root?: Node;
		Observer?: new (callback: () => void) => Pick<MutationObserver, 'observe' | 'disconnect'>;
		limit?: number;
	} = {}
): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const observer = new Observer(() => {
		if (!target.isConnected) stop();
		else if (!target.matches(':disabled')) {
			stop();
			then();
		}
	});
	function stop() {
		observer.disconnect();
		clearTimeout(timer);
	}
	observer.observe(root, { attributes: true, attributeFilter: ['disabled'], subtree: true });
	timer = setTimeout(stop, limit);
	return stop;
}
