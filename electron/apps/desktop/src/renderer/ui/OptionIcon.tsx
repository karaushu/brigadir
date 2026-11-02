import type { ReactNode } from 'react';
import type { AgentOptionKind } from '@brigadir/core';
import { EffortIcon } from './EffortIcon';
import { Glyph } from './Glyph';
type Choice = { value: string; name: string };
/** spec/agents-and-providers#catalog: the picture of one provider choice. A presentational map by the word in the value —
 *  it draws, it never adds behaviour or invents modes (rule 7, like the provider glyphs of spec/agents-and-providers#transport). Unknown mode: a monogram. */
export function OptionIcon({
	kind,
	choice,
	choices,
	size = 12,
}: {
	kind: AgentOptionKind;
	choice: Choice;
	choices: readonly Choice[];
	size?: number;
}): ReactNode {
	if (kind === 'effort') return <EffortIcon value={choice.value} levels={choices} size={size} />;
	const word = `${choice.value} ${choice.name}`.toLowerCase();
	// Fast-forward: two filled arrows when on, one outlined arrow when off, in the icons' colour.
	if (kind === 'fast') {
		const off = /\b(off|false)\b/.test(word);
		return (
			<svg
				data-option-icon={off ? 'fast-off' : 'fast'}
				aria-hidden="true"
				width={size}
				height={size}
				viewBox="0 0 16 16"
				style={{ flex: 'none' }}>
				{off ? (
					<path
						d="M5 3.6 11 8l-6 4.4z"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinejoin="round"
					/>
				) : (
					<path d="M1.8 3.6 7.6 8l-5.8 4.4zM8.4 3.6 14.2 8l-5.8 4.4z" fill="currentColor" />
				)}
			</svg>
		);
	}
	if (/plan/.test(word))
		return (
			<span data-option-icon="plan" style={{ display: 'inline-flex' }}>
				<Glyph name="list" size={size} />
			</span>
		);
	if (kind !== 'mode')
		return (
			<span data-option-icon="other" style={{ display: 'inline-flex' }}>
				<Glyph name="console" size={size} />
			</span>
		);
	if (/bypass|full/.test(word)) return <ModeGlyph name="unlocked" size={size} />;
	if (/accept|edit/.test(word))
		return (
			<span data-option-icon="edit" style={{ display: 'inline-flex' }}>
				<Glyph name="edit" size={size} />
			</span>
		);
	if (/auto|agent/.test(word)) return <ModeGlyph name="auto" size={size} />;
	if (/default|manual|ask|read/.test(word)) return <ModeGlyph name="ask" size={size} />;
	return (
		<span
			data-option-icon="monogram"
			aria-hidden="true"
			style={{
				display: 'inline-grid',
				placeItems: 'center',
				width: size,
				height: size,
				fontSize: size * 0.6,
				fontWeight: 700,
				flex: 'none',
			}}>
			{choice.name
				.split(/[\s_-]+/)
				.filter(Boolean)
				.slice(0, 2)
				.map((part) => part[0])
				.join('')
				.toLocaleUpperCase()}
		</span>
	);
}
/** Drawn in the kit's geometry (16 px, stroke 1.3): a question in a circle, a bolt, an open padlock. */
function ModeGlyph({ name, size }: { name: 'ask' | 'auto' | 'unlocked'; size: number }) {
	return (
		<svg
			data-option-icon={name}
			aria-hidden="true"
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.3"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={{ flex: 'none' }}>
			{name === 'ask' ? (
				<>
					<circle cx="8" cy="8" r="6.2" />
					<path d="M6.2 6.3a1.85 1.85 0 1 1 2.5 1.75c-.45.18-.7.5-.7.95v.4" />
					<circle cx="8" cy="11.5" r=".55" fill="currentColor" stroke="none" />
				</>
			) : name === 'auto' ? (
				<path d="M9.2 1.8 3.6 9.2h4l-.8 5 5.6-7.4h-4l.8-5z" />
			) : (
				<>
					<rect x="3.4" y="7.2" width="9.2" height="6.4" rx="1.6" />
					<path d="M5.6 7.2V5a2.4 2.4 0 0 1 4.6-.9" />
				</>
			)}
		</svg>
	);
}
/** Popup options of any provider select, each row with its picture. */
export function optionChoices(
	kind: AgentOptionKind,
	choices: readonly (Choice & { group?: string | null })[],
	size = 12
) {
	return choices.map((choice) => ({
		value: choice.value,
		label: choice.group ? `${choice.group} · ${choice.name}` : choice.name,
		icon: <OptionIcon kind={kind} choice={choice} choices={choices} size={size} />,
	}));
}
