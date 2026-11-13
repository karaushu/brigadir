import { Fragment, type ReactNode } from 'react';
import s from './StepTrack.module.css';

export type TrackStep = {
	id: string;
	/** The step's state glyph (12 px). */
	glyph: ReactNode;
	/** The step's name and state, the tooltip and the accessible name. */
	title: string;
	tone?: 'green' | 'amber' | 'muted' | undefined;
	/** The step the row speaks about: the `--tint2` fill. */
	current?: boolean;
	disabled?: boolean;
};
/**
 * spec/reviews#strip: a row's steps — 20-px glyph steps joined by thin connectors that stay readable on the row's green and amber fills. A
 * click picks a step; a disabled step is drawn but takes no click.
 */
export function StepTrack({
	label,
	steps,
	onPick,
}: {
	label: string;
	steps: readonly TrackStep[];
	onPick(id: string): void;
}) {
	return (
		<span className={s.track} role="group" aria-label={label}>
			{steps.map((step, index) => (
				<Fragment key={step.id}>
					{index > 0 && <i aria-hidden="true" />}
					<button
						type="button"
						className={s.step}
						title={step.title}
						aria-label={step.title}
						aria-current={step.current ? 'step' : undefined}
						data-tone={step.tone}
						data-step={step.id}
						disabled={step.disabled}
						onClick={() => onPick(step.id)}>
						{step.glyph}
					</button>
				</Fragment>
			))}
		</span>
	);
}
