import type { ReactNode } from 'react';
import s from './Tag.module.css';

/**
 * spec/appearance#one-look-one-component: a state tag — 10 px text on a 4-px-radius fill — of a review's finding and a design review's row
 * (rule 17). `tone` picks the colour; `quiet` is a closed state that reads below the others.
 */
export type TagTone = 'neutral' | 'quiet' | 'accent' | 'green' | 'amber' | 'red';
export function Tag({ tone = 'neutral', children }: { tone?: TagTone; children: ReactNode }) {
	return (
		<span className={s.tag} data-tag={tone}>
			{children}
		</span>
	);
}
