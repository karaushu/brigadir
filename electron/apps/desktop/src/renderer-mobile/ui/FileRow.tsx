/**
 * spec/remote-access-and-mobile#phone-task-tools: a file or a folder in the phone's lists — the change list and the file
 * tree are one row: a lead (the change mark or the icon), the name and a second line, a tail, a chevron. The whole
 * row is the button (rule 15): pressed covers it all.
 */
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import s from './FileRow.module.css';

export function FileRow({
	lead,
	title,
	sub,
	tail,
	chevron = false,
	onClick,
	data,
}: {
	lead: ReactNode;
	title: string;
	sub?: ReactNode;
	tail?: ReactNode;
	chevron?: boolean;
	onClick(): void;
	data?: Record<string, string>;
}) {
	const attributes = Object.fromEntries(
		Object.entries(data ?? {}).map(([key, value]) => [`data-${key}`, value])
	);
	return (
		<button type="button" className={s.row} onClick={onClick} {...attributes}>
			{lead}
			<span className={s.two}>
				<b className="ell">{title}</b>
				{sub !== undefined && <small className="ell">{sub}</small>}
			</span>
			{tail}
			{chevron && <Icon name="chevr" className={s.chevron} />}
		</button>
	);
}
/** The change mark: `M` amber, `A` green, `D` red, the rest in --fg2. */
export function ChangeMark({ mark }: { mark: string }) {
	return (
		<span className={`mono ${s.mark}`} data-mark={mark}>
			{mark}
		</span>
	);
}
