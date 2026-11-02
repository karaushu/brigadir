import { useEffect, useState } from 'react';
import { t, type Locale } from '@brigadir/core';
import { Glyph } from './Glyph';
import styles from './AppMenuButton.module.css';

/** spec/architecture-and-platform#window-frame: ☰ opens the app menu on Windows and Linux; it shows open also when F10 or a lone Alt opened it. */
export function AppMenuButton({ locale }: { locale: Locale }) {
	const [open, setOpen] = useState(false);
	useEffect(() => window.brigadir.onAppMenu(setOpen), []);
	const label = t(locale, 'Application menu');
	return (
		<button
			type="button"
			data-app-menu
			className={styles.button}
			aria-label={label}
			title={`${label} · Alt`}
			aria-haspopup="menu"
			aria-expanded={open}
			onClick={(event) => {
				const box = event.currentTarget.getBoundingClientRect();
				void window.brigadir
					.openAppMenu(Math.round(box.left), Math.round(box.bottom + 4))
					.catch(() => {});
			}}>
			<Glyph name="app-menu" size={15} />
		</button>
	);
}
