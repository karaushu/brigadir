import { t, type Locale } from '@brigadir/core';
import { Glyph } from './Glyph';
import styles from './ClearField.module.css';
/**
 * spec/appearance#clear-field: the × at the end of a search or filter field, shown while the field has text. It clears the field and leaves
 * the caret in it; the field's own Escape keeps working. It sits inside the field's frame, next to its input.
 */
export function ClearField({
	value,
	onClear,
	...name
}: { value: string; onClear(): void } & ({ locale: Locale } | { label: string })) {
	if (!value) return null;
	const label = 'label' in name ? name.label : t(name.locale, 'Clear the field');
	return (
		<button
			type="button"
			className={styles.clear}
			aria-label={label}
			title={label}
			// The field keeps focus, so a panel search that closes on blur stays open.
			onMouseDown={(event) => event.preventDefault()}
			onClick={(event) => {
				event.preventDefault();
				event.stopPropagation();
				const field = event.currentTarget.parentElement?.querySelector('input');
				onClear();
				field?.focus({ preventScroll: true });
			}}>
			<Glyph name="close" size={10} />
		</button>
	);
}
