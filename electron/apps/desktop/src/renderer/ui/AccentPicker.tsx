import { accentColors, t, type AccentColor, type Locale, type MessageKey } from '@brigadir/core';
import { useRef, type CSSProperties } from 'react';
import styles from './AccentPicker.module.css';
export const accentNames: Record<AccentColor, MessageKey> = {
	system: 'Follow system',
	blue: 'Blue',
	indigo: 'Indigo',
	purple: 'Purple',
	pink: 'Pink',
	teal: 'Teal',
	yellow: 'Yellow',
	graphite: 'Graphite',
};
const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
/**
 * spec/appearance#accent: colour swatches behave as one radio group: a single Tab stop, arrows, Home and End move the choice. One look for
 * every colour choice (rule 17): the accent, the project icon's colour (spec/appearance#evolution-redesign).
 */
export function SwatchPicker<T extends string>({
	label,
	values,
	value,
	onChange,
	name,
	color,
	...data
}: {
	label: string;
	values: readonly T[];
	value: T;
	onChange(value: T): void;
	name(value: T): string;
	/** The swatch's CSS colour; none — the swatch is drawn by its `data-swatch` rule (the accent's own). */ color?(
		value: T
	): string;
} & { [key: `data-${string}`]: string | undefined }) {
	const group = useRef<HTMLDivElement>(null);
	function move(key: string) {
		const index = values.indexOf(value),
			next =
				key === 'Home'
					? 0
					: key === 'End'
						? values.length - 1
						: (index + (key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1) + values.length) %
							values.length;
		group.current?.querySelectorAll<HTMLButtonElement>('[role=radio]')[next]?.focus();
		onChange(values[next]!);
	}
	return (
		<div {...data} ref={group} role="radiogroup" aria-label={label} className={styles.group}>
			{values.map((item) => {
				const text = name(item);
				return (
					<button
						key={item}
						type="button"
						role="radio"
						aria-checked={value === item}
						aria-label={text}
						title={text}
						tabIndex={value === item ? 0 : -1}
						data-swatch={item}
						className={styles.swatch}
						style={color ? ({ '--swatch': color(item) } as CSSProperties) : undefined}
						onClick={() => {
							if (item !== value) onChange(item);
						}}
						onKeyDown={(event) => {
							if (!keys.includes(event.key)) return;
							event.preventDefault();
							move(event.key);
						}}
					/>
				);
			})}
		</div>
	);
}
export function AccentPicker({
	locale,
	value,
	onChange,
}: {
	locale: Locale;
	value: AccentColor;
	onChange(value: AccentColor): void;
}) {
	return (
		<SwatchPicker
			label={t(locale, 'Accent')}
			values={accentColors}
			value={value}
			onChange={onChange}
			name={(color) => t(locale, accentNames[color])}
		/>
	);
}
