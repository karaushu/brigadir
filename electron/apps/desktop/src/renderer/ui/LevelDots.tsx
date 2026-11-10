import s from './LevelDots.module.css';
/**
 * A level among a few as dots: `filled` of `count` are solid, the rest outlined; dots from `warnFrom` on fill amber
 * (spec/crew-templates-and-editor#library-list). A picture beside its text: the accessible name is `label`.
 */
export function LevelDots({
	count,
	filled,
	warnFrom,
	label,
}: {
	count: number;
	filled: number;
	warnFrom?: number;
	label: string;
}) {
	return (
		<span className={s.dots} role="img" aria-label={label} data-level-dots={`${filled}/${count}`}>
			{Array.from({ length: count }, (_, index) => (
				<i
					key={index}
					data-filled={index < filled || undefined}
					data-warn={(warnFrom !== undefined && index >= warnFrom && index < filled) || undefined}
				/>
			))}
		</span>
	);
}
