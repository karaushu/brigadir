/**
 * The phone's «loading» state (spec/remote-access-and-mobile#phone-chat, spec/appearance#loading): until the machine answers, a screen shows skeleton rows where its
 * content will lie, not an empty list that looks like no data and not a word in the middle. A long network read adds a
 * small ring and its name under the rows. Nothing shows for the first 150 ms; `role="status"` for VoiceOver.
 */
import { useEffect, useState } from 'react';
import { t, type Locale } from '@brigadir/core';
import s from './Loading.module.css';

const widths = [
	[70, 44],
	[56, 58],
	[82, 36],
	[64, 44],
];

/** The ring alone, for a slot that already says what loads (an attachment on its way). */
export function Spinner() {
	return <i className={s.ring} aria-hidden="true" />;
}
export function Loading({
	locale,
	label,
	rows = 4,
}: {
	locale: Locale;
	label?: string;
	rows?: number;
}) {
	const [shown, setShown] = useState(false);
	useEffect(() => {
		const timer = setTimeout(() => setShown(true), 150);
		return () => clearTimeout(timer);
	}, []);
	return (
		<div
			className={s.loading}
			role="status"
			aria-label={label ?? t(locale, 'Loading…')}
			data-loading>
			{shown && (
				<>
					{Array.from({ length: rows }, (_, index) => (
						<div key={index} className={s.row} aria-hidden="true">
							{widths[index % widths.length]!.map((width, bar) => (
								<i key={bar} style={{ width: `${width}%` }} />
							))}
						</div>
					))}
					{label && (
						<div className={s.status} aria-hidden="true">
							<Spinner />
							<span>{label}</span>
						</div>
					)}
				</>
			)}
		</div>
	);
}
