import { Glyph } from './Glyph';
import s from './MachineGlyph.module.css';

/**
 * spec/remote-access-and-mobile#networking, spec/remote-access-and-mobile#remote-button: a paired computer's glyph with what is known of it — a green dot (answers, its window open), a
 * grey one (does not answer), a turning mark (checking). `tile` is the 28 px plate of a list row (Settings ▸ Remote, the
 * list «Connect»); bare, it is the 14 px icon of a menu row (the «Remote» chip's popover).
 */
export function MachineGlyph({
	reach,
	glyph = 'machine',
	tile = false,
	dashed = false,
}: {
	reach?: 'on' | 'off' | 'check' | undefined;
	glyph?: 'machine' | 'laptop' | 'plus' | 'search';
	tile?: boolean;
	/** The plate of «no machines yet» and «New machine…». */ dashed?: boolean;
}) {
	return (
		<span
			className={s.glyph}
			data-tile={tile || undefined}
			data-dashed={dashed || undefined}
			data-reach={reach}
			aria-hidden="true">
			<Glyph name={glyph} size={14} />
			{reach === 'check' ? (
				<span className={s.spin}>
					<Glyph name="agent-spinner" size={tile ? 12 : 10} />
				</span>
			) : (
				reach && <span className={s.dot} data-dot={reach} />
			)}
		</span>
	);
}
