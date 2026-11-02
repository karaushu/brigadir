import { beforeEach, expect, it } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { timesCount } from '@brigadir/core';
import {
	TOAST_DURATION,
	ToastRegion,
	dismissToast,
	notify,
	resolveToast,
	showToast,
	toastError,
	toastWarning,
	useToasts,
} from './Toast';
const region = (expanded = false) =>
	renderToStaticMarkup(
		<ToastRegion
			locale="en"
			toasts={useToasts.getState().toasts}
			expanded={expanded}
			bottom={30}
			close={() => {}}
		/>
	);

beforeEach(() => useToasts.setState({ toasts: [], expanded: false, anchored: 0 }));

it('folds the same failure into one toast with a count and a fresh timer (spec/notifications-slack-notes-and-schedules#message-classes)', () => {
	toastError('Could not open Button.tsx.');
	useToasts.setState((state) => ({
		toasts: state.toasts.map((toast) => ({ ...toast, remaining: 1200 })),
	}));
	toastError('Could not open Button.tsx.');
	const [toast] = useToasts.getState().toasts;
	expect(useToasts.getState().toasts).toHaveLength(1);
	expect(toast).toMatchObject({ kind: 'error', count: 2, remaining: TOAST_DURATION.error });
	showToast('Review sent to PR #412');
	expect(useToasts.getState().toasts.map((item) => item.kind)).toEqual(['error', 'success']);
});

it('times each kind: success 4 s, info 6 s, warning 8 s, error 10 s', () => {
	expect(TOAST_DURATION).toEqual({ success: 4000, info: 6000, warning: 8000, error: 10000 });
});

it('keeps the newest twenty and drops a dismissed toast', () => {
	for (let index = 0; index < 25; index++) notify('info', `Notice ${index}`);
	const toasts = useToasts.getState().toasts;
	expect(toasts).toHaveLength(20);
	expect(toasts[0]!.text).toBe('Notice 5');
	dismissToast(toasts[0]!.id);
	expect(useToasts.getState().toasts[0]!.text).toBe('Notice 6');
});

it('shows three, hides the rest under «N more», bolds the file and gives errors role=alert', () => {
	showToast('Review sent to PR #412');
	notify('info', 'The task «Gate AI chat flag» started', { action: { label: 'Open', run() {} } });
	notify('warning', 'Could not check repo locks.');
	toastError('Could not open Button.tsx.', { bold: 'Button.tsx' });
	const html = region();
	expect(html).toContain('aria-label="Notifications"');
	expect(html).toContain('>1 more<');
	expect(html.match(/data-toast-id=/g)).toHaveLength(3);
	expect(html).not.toContain('Review sent to PR #412');
	expect(html).toContain('Could not open <strong>Button.tsx</strong>.');
	expect(html.match(/role="alert"/g)).toHaveLength(2);
	expect(html.match(/role="status"/g)).toHaveLength(1);
	expect(html).toContain('aria-keyshortcuts="Escape"');
});

it('shows five when expanded', () => {
	for (let index = 0; index < 7; index++) notify('info', `Notice ${index}`);
	const html = region(true);
	expect(html.match(/data-toast-id=/g)).toHaveLength(5);
	expect(html).not.toContain('more<');
});

/** The pill over the stack, found in ToastRegion's element tree (it has no hooks, so it can be called directly). */
function pill(expanded: boolean) {
	const find = (node: ReactNode): ReactElement<{ onClick(): void; children: ReactNode }> | null => {
		if (!isValidElement<{ children?: ReactNode; 'aria-expanded'?: boolean }>(node)) {
			if (Array.isArray(node))
				for (const child of node) {
					const found = find(child);
					if (found) return found;
				}
			return null;
		}
		if (node.type === 'button' && node.props['aria-expanded'] !== undefined)
			return node as ReactElement<{ onClick(): void; children: ReactNode }>;
		return find(node.props.children);
	};
	return find(
		ToastRegion({
			locale: 'en',
			toasts: useToasts.getState().toasts,
			expanded,
			bottom: 30,
			close() {},
		})
	);
}

it('turns «N more» into «Show less» once expanded and folds the stack back to three (spec/notifications-slack-notes-and-schedules#notice-chips)', () => {
	for (let index = 0; index < 5; index++) notify('info', `Notice ${index}`);
	pill(false)!.props.onClick();
	expect(useToasts.getState().expanded).toBe(true);
	const html = region(true);
	expect(html.match(/data-toast-id=/g)).toHaveLength(5);
	expect(html).toContain('aria-expanded="true"');
	expect(html).toContain('>Show less<');
	pill(true)!.props.onClick();
	expect(useToasts.getState().expanded).toBe(false);
	expect(region(false).match(/data-toast-id=/g)).toHaveLength(3);
	expect(region(false)).toContain('>2 more<');
	expect(renderToStaticMarkup(<>{pill(false)}</>)).toContain('aria-expanded="false"');
});

it('names the duplicate count with four Ukrainian forms', () => {
	expect([1, 2, 5, 11, 21, 22, 25].map((count) => timesCount('uk', count))).toEqual([
		'1 раз',
		'2 рази',
		'5 разів',
		'11 разів',
		'21 раз',
		'22 рази',
		'25 разів',
	]);
	expect(timesCount('en', 3)).toBe('3 times');
});

it('takes back a background warning once the read works again', () => {
	toastWarning('Could not check repo locks.');
	toastError('Could not open Button.tsx.');
	resolveToast('Could not check repo locks.');
	expect(useToasts.getState().toasts.map((toast) => toast.text)).toEqual([
		'Could not open Button.tsx.',
	]);
});
