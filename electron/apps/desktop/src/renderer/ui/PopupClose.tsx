import { t, type Locale } from '@brigadir/core';
import styles from './PopupClose.module.css';
/**
 * Shared popup header dismissal; the owner handles Escape and restores focus. Its height is the row's (spec/appearance#one-row-one-height), so it sets no `data-size`.
 * `touch` (spec/remote-access-and-mobile#phone, spec/remote-access-and-mobile#phone-app): the phone's × in a 44 target with a 28 tint circle, where the computer shows `Esc`.
 */
export function PopupClose({
	locale,
	close,
	touch = false,
}: {
	locale: Locale;
	close(): void;
	touch?: boolean;
}) {
	return (
		<button
			type="button"
			className={styles.close}
			data-touch={touch || undefined}
			aria-label={t(locale, 'Close')}
			aria-keyshortcuts="Escape"
			title={touch ? t(locale, 'Close') : `${t(locale, 'Close')} (Esc)`}
			onClick={close}>
			{touch ? (
				<svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none">
					<path
						d="M4 4l8 8M12 4l-8 8"
						stroke="currentColor"
						strokeWidth="1.4"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			) : (
				'Esc'
			)}
		</button>
	);
}
