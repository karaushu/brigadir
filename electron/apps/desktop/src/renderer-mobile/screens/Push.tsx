/** spec/remote-access-and-mobile#phone-app: the offer of notifications above «Чекають тебе», once, after the first sign-in from the Home Screen. */
import { useState } from 'react';
import { t, type Locale } from '@brigadir/core';
import { Button } from '../../renderer/ui/Controls';
import { useConnection } from '../context';
import { pushOfferable, turnPushOn } from '../push';
import { Icon } from '../ui/Icon';
import s from './Screen.module.css';

const dismissedKey = 'brigadir.push-offer';
const dismissed = () => {
	try {
		return localStorage.getItem(dismissedKey) === 'no';
	} catch {
		return false;
	}
};
export function PushCard({ locale }: { locale: Locale }) {
	const connection = useConnection();
	const [open, setOpen] = useState(() => pushOfferable(connection) && !dismissed());
	if (!open) return null;
	const close = () => {
		setOpen(false);
		try {
			localStorage.setItem(dismissedKey, 'no');
		} catch {
			// Storage blocked: the card comes back next time.
		}
	};
	return (
		<section
			className={s.push}
			data-push-offer
			aria-label={t(locale, 'Notifications on this phone')}>
			<div className={s.pushHead}>
				<Icon name="bell" size={22} className={s.pushIcon} />
				<span className={s.pushText}>
					<b>{t(locale, 'Notifications on this phone')}</b>
					<small>
						{t(
							locale,
							'When an agent is waiting for you: a question, a permission or a plan. A notification shows only the task title and type.'
						)}
					</small>
				</span>
			</div>
			<div className={s.pair} data-size="l">
				<Button onClick={close}>{t(locale, 'Not now')}</Button>
				<Button
					appearance="primary"
					onClick={() => void turnPushOn(connection).finally(() => setOpen(false))}>
					{t(locale, 'Turn on')}
				</Button>
			</div>
		</section>
	);
}
