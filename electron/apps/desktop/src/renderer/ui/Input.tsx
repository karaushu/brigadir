import type { ComponentProps, ReactNode } from 'react';
import styles from './Input.module.css';

/** spec/appearance#control-scale: `size` is the control size (s | m | l | xl), not the HTML character count. A standalone field takes L; in a row of buttons it takes the row's size. */
type FieldSize = 's' | 'm' | 'l' | 'xl';

export function TextInput({
	embedded = false,
	size,
	className = '',
	tail,
	lead,
	...props
}: Omit<ComponentProps<'input'>, 'size'> & {
	embedded?: boolean;
	size?: FieldSize;
	/** A quiet note at the field's end (spec/remote-access-and-mobile#module-and-settings: «12 characters»). Pass '' rather than nothing while it is empty: a field that
	 * gains a tail is another element and loses the caret. */ tail?: ReactNode;
	/** A tag before the text inside the field (spec/remote-access-and-mobile#browser-from-device: the machine of a browser page); the field keeps one frame round both. */
	lead?: ReactNode;
}) {
	if (lead !== undefined)
		return (
			<span
				data-size={size}
				className={`${styles.control} ${styles.singleLine} ${styles.frame} ${styles.leaded} ${className}`}>
				{lead}
				<input {...props} className={`${styles.control} ${styles.embedded}`} />
			</span>
		);
	if (tail !== undefined)
		return (
			<span data-size={size} className={`${styles.tailed} ${className}`}>
				<input {...props} className={`${styles.control} ${styles.singleLine}`} />
				<span className={styles.tail}>{tail}</span>
			</span>
		);
	return (
		<input
			{...props}
			data-size={size}
			className={`${styles.control} ${styles.singleLine} ${embedded ? styles.embedded : ''} ${className}`}
		/>
	);
}

export function TextArea({
	embedded = false,
	size,
	className = '',
	...props
}: ComponentProps<'textarea'> & { embedded?: boolean; size?: FieldSize }) {
	return (
		<textarea
			{...props}
			data-size={size}
			className={`${styles.control} ${styles.multiline} ${embedded ? styles.embedded : ''} ${className}`}
		/>
	);
}
