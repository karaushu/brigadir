import type { ReactNode } from 'react';
import { Choice } from './Controls';
import { Glyph } from './Glyph';
import s from './OptionCard.module.css';

type Glyphs = Parameters<typeof Glyph>[0]['name'];
/**
 * A choice as a card: a radio, a sign and a name, the consequence under it. The whole card is
 * the label (rule 15: it hovers as a whole); chosen — the accent ring on a soft accent. The review's Verdict (spec/appearance#evolution-redesign).
 */
export function OptionCard({
	name,
	checked,
	disabled = false,
	glyph,
	title,
	description,
	onChange,
	radio = true,
	children,
}: {
	name: string;
	checked: boolean;
	disabled?: boolean;
	glyph: Glyphs;
	title: string;
	description: string;
	onChange(): void;
	/** false — the radio mark is not drawn; the card is still one radio of its group (the role guide, spec/crew-templates-and-editor#library-list). */
	radio?: boolean;
	/** A line under the description: a meter, a hint. */
	children?: ReactNode;
}) {
	return (
		<label
			className={s.card}
			data-checked={checked || undefined}
			data-disabled={disabled || undefined}
			data-option-card>
			<span className={s.radio} data-size="s" data-hidden={!radio || undefined}>
				<Choice
					type="radio"
					label={title}
					name={name}
					checked={checked}
					disabled={disabled}
					onChange={onChange}
				/>
			</span>
			<span className={s.copy}>
				<b>
					<Glyph name={glyph} size={13} />
					{title}
				</b>
				<small>{description}</small>
				{children && <span className={s.meta}>{children}</span>}
			</span>
		</label>
	);
}
