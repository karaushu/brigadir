import { useId, useRef } from 'react';
import { formatTokenCount, t, type Locale } from '@brigadir/core';
import { Button, IconButton } from './ui/Controls';
import { Glyph } from './ui/Glyph';
import { Popover, useHoverPopover } from './ui/Popover';
import styles from './ContextMeter.module.css';

export function ContextMeter(props: {
	used: number;
	capacity: number;
	locale: Locale;
	onRelay?: () => void;
	/** spec/composer#agent-capsule: the agent announced /compact and is free — the popover offers `Compact` beside the new task. */
	onCompact?: (() => void) | undefined;
}) {
	if (
		props.capacity <= 0 ||
		props.used < 0 ||
		!Number.isFinite(props.used) ||
		!Number.isFinite(props.capacity)
	)
		return null;
	return <ContextIndicator {...props} />;
}
function ContextIndicator({
	used,
	capacity,
	locale,
	onRelay,
	onCompact,
}: {
	used: number;
	capacity: number;
	locale: Locale;
	onRelay?: () => void;
	onCompact?: (() => void) | undefined;
}) {
	const hover = useHoverPopover(),
		button = useRef<HTMLButtonElement>(null),
		id = useId();
	const ratio = used / capacity,
		fill = Math.min(1, ratio),
		percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
			ratio
		);
	const label = `${t(locale, 'Context')}: ${percent}`;
	const tone = ratio > 0.9 ? 'danger' : ratio > 0.7 ? 'warning' : 'normal';
	return (
		<>
			<IconButton
				ref={button}
				shape="auto"
				label={label}
				hint=""
				className={styles.chip}
				data-tone={tone}
				aria-haspopup="dialog"
				aria-expanded={hover.open}
				aria-controls={hover.open ? id : undefined}
				{...hover.trigger}>
				{/* spec/composer#agent-capsule, canvas 3.9: a 13 px ring, its track --tint2, the used part in the tone's colour. */}
				<svg aria-hidden="true" width="13" height="13" viewBox="0 0 16 16" fill="none">
					<circle cx="8" cy="8" r="6" className={styles.track} strokeWidth="2" />
					<circle
						cx="8"
						cy="8"
						r="6"
						stroke="currentColor"
						strokeWidth="2"
						pathLength="100"
						strokeDasharray={`${fill * 100} 100`}
						transform="rotate(-90 8 8)"
					/>
				</svg>
				<span data-context-percent>{percent}</span>
			</IconButton>
			<Popover
				id={id}
				open={hover.open}
				onClose={hover.close}
				anchor={button}
				side="top"
				width={286}
				label={t(locale, 'Context')}
				locale={locale}
				className={styles.popover}
				data-tone={tone}
				data-context-popover
				title={
					<>
						{t(locale, 'Context')}
						<span className={styles.tokens} data-context-tokens>
							{formatTokenCount(used)} / {formatTokenCount(capacity)} {t(locale, 'tokens')}
						</span>
					</>
				}
				headerExtra={
					<span className={styles.percent} data-context-share>
						{percent}
					</span>
				}
				{...hover.popover}>
				<div className={styles.content}>
					<div
						className={styles.progress}
						role="progressbar"
						aria-label={t(locale, 'Context')}
						aria-valuemin={0}
						aria-valuemax={capacity}
						aria-valuenow={Math.min(used, capacity)}
						aria-valuetext={percent}>
						<div style={{ width: `${fill * 100}%` }} />
					</div>
					{(onCompact || onRelay) && (
						<div className={styles.actions} data-size="s">
							{onCompact && (
								<Button
									title={t(
										locale,
										'Sends /compact: the agent summarises the conversation and frees context'
									)}
									onClick={() => {
										hover.close();
										onCompact();
									}}>
									<Glyph name="collapse-all" size={12} />
									{t(locale, 'Compact (conversation)')}
								</Button>
							)}
							{onRelay && (
								<Button
									onClick={() => {
										hover.close();
										onRelay();
									}}>
									{t(locale, 'Continue in a new task')}
								</Button>
							)}
						</div>
					)}
					<p className={styles.detail}>
						{t(locale, 'The agent reports total context usage without a breakdown.')}
					</p>
				</div>
			</Popover>
		</>
	);
}
