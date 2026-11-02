import { useEffect, useId, useRef, useState } from 'react';
import { withPlatformKeys, formatAccelerator, t, type Locale } from '@brigadir/core';
import { Button } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { MenuItem, MenuPopover } from './ui/Popover';
import styles from './ComposerSend.module.css';

const LONG_PRESS_MS = 500;
type Props = {
	locale: Locale;
	busy: boolean;
	/** spec/composer-steering-queue-and-ghost#steering-hold: ↩ goes into the running turn, ⌘↩ to the queue. */ steers: boolean;
	filled: boolean;
	stopDisabled: boolean;
	sendDisabled: boolean;
	stopShortcut: string | undefined;
	queueShortcut: string | undefined;
	onStop(): void;
	onSendNow(): void;
	onQueue(): void;
};
/** The island's right end (spec/composer#island, spec/composer-steering-queue-and-ghost#steering-hold): Stop while the agent works, Send once there is something to send; while a turn runs
 *  with steering Stop steps back to secondary and Send's right click or long press offers «Send now» and «To the queue». */
export function ComposerSend({
	locale,
	busy,
	steers,
	filled,
	stopDisabled,
	sendDisabled,
	stopShortcut,
	queueShortcut,
	onStop,
	onSendNow,
	onQueue,
}: Props) {
	const [open, setOpen] = useState<false | 'keyboard' | 'pointer'>(false),
		id = useId();
	const sendButton = useRef<HTMLButtonElement>(null);
	const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; opened: boolean }>({
		timer: null,
		opened: false,
	});
	const offered = busy && steers && filled && !sendDisabled;
	const queueKey = queueShortcut ? formatAccelerator(queueShortcut) : '';
	const items = [
		{
			label: t(locale, 'Send now'),
			detail: t(locale, 'The agent sees it at its next step'),
			key: formatAccelerator('Enter'),
			icon: 'send-now' as const,
			run: onSendNow,
		},
		{
			label: t(locale, 'To the queue'),
			detail: t(locale, 'Waits until the agent finishes'),
			key: queueKey,
			icon: 'clock' as const,
			run: onQueue,
		},
	];
	function show(keyboard: boolean) {
		if (offered) setOpen(keyboard ? 'keyboard' : 'pointer');
	}
	useEffect(() => {
		if (!offered) setOpen(false);
	}, [offered]);
	const clearPress = () => {
		if (press.current.timer) clearTimeout(press.current.timer);
		press.current.timer = null;
	};
	useEffect(() => clearPress, []);
	const stopTitle = stopShortcut
		? `${t(locale, 'Stop')} · ${formatAccelerator(stopShortcut)}`
		: t(locale, 'Stop');
	const sendTitle = busy
		? steers
			? withPlatformKeys(t(locale, 'Send now · ↩ · To the queue · {queue}')).replace(
					'{queue}',
					queueKey
				)
			: t(locale, 'Add to queue')
		: t(locale, 'Send');
	return (
		<span className={styles.send}>
			{busy && (
				<Button
					size="m"
					className={styles.button}
					appearance={filled ? 'neutral' : 'primary'}
					aria-label={t(locale, 'Stop')}
					title={stopTitle}
					disabled={stopDisabled}
					onClick={onStop}>
					<Glyph name="stop" size={11} />
				</Button>
			)}
			{(!busy || filled) && (
				<Button
					ref={sendButton}
					size="m"
					className={styles.button}
					aria-label={t(locale, busy && !steers ? 'Add to queue' : 'Send')}
					title={sendTitle}
					appearance="primary"
					type="submit"
					disabled={sendDisabled}
					aria-haspopup={offered ? 'menu' : undefined}
					aria-expanded={offered ? !!open : undefined}
					aria-controls={open ? id : undefined}
					onContextMenu={(event) => {
						if (!offered) return;
						event.preventDefault();
						show(false);
					}}
					onKeyDown={(event) => {
						if (
							offered &&
							(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
						) {
							event.preventDefault();
							show(true);
						}
					}}
					onPointerDown={(event) => {
						press.current.opened = false;
						if (event.button !== 0 || !offered) return;
						clearPress();
						press.current.timer = setTimeout(() => {
							press.current.timer = null;
							press.current.opened = true;
							show(false);
						}, LONG_PRESS_MS);
					}}
					onPointerUp={clearPress}
					onPointerLeave={clearPress}
					onPointerCancel={clearPress}
					onClick={(event) => {
						if (press.current.opened) {
							press.current.opened = false;
							event.preventDefault();
						}
					}}>
					<Glyph name="send" size={13} />
				</Button>
			)}
			{offered && (
				<MenuPopover
					id={id}
					open={!!open}
					onClose={() => setOpen(false)}
					anchor={sendButton}
					side="top"
					align="end"
					width={318}
					label={t(locale, 'Send')}
					locale={locale}
					initialFocus={open === 'pointer' ? (popover) => popover : undefined}>
					{items.map((item, index) => (
						<MenuItem
							key={item.icon}
							icon={<Glyph name={item.icon} size={14} />}
							description={item.detail}
							kbd={item.key || undefined}
							keyshortcuts={
								index === 0
									? 'Enter'
									: queueShortcut
										? queueShortcut.replace('CmdOrCtrl', 'Meta')
										: undefined
							}
							onSelect={item.run}>
							{item.label}
						</MenuItem>
					))}
				</MenuPopover>
			)}
		</span>
	);
}
