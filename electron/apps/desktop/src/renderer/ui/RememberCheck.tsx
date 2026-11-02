import { Choice } from './Controls';
import styles from './RememberCheck.module.css';
/**
 * spec/appearance#evolution-redesign, canvas 6.6c/6.12/6.16 `.k6p-rm`: `Remember for <action>` at the foot of an agent menu — the capsule's popup
 * and the Agent section of «Review with an agent ▾». The whole row is the target and hovers as a menu row; checked, the
 * choice goes into Settings ▸ Agents ▸ Customize per action. A long label wraps to a second line; the box stays on the first.
 */
export function RememberCheck({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange(checked: boolean): void;
}) {
	return (
		<label className={styles.remember} data-remember>
			<Choice
				type="checkbox"
				label={label}
				checked={checked}
				onChange={(event) => onChange(event.currentTarget.checked)}
			/>
			<span>{label}</span>
		</label>
	);
}
