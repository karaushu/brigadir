import { useRef, useEffect } from 'react';
import styles from './ResizeHandle.module.css';
export function ResizeHandle({
	label,
	value,
	min,
	max,
	axis = 'x',
	edge = 'start',
	onChange,
	onCommit,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	axis?: 'x' | 'y';
	edge?: 'start' | 'end';
	onChange(value: number): void;
	onCommit(): void;
}) {
	const drag = useRef<{ position: number; value: number } | null>(null);
	const clamp = (next: number) => Math.max(min, Math.min(max, next));
	useEffect(
		() => () => {
			if (drag.current) delete document.body.dataset.resizing;
		},
		[]
	);
	return (
		<div
			className={styles.handle}
			role="separator"
			tabIndex={0}
			aria-label={label}
			aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
			aria-valuemin={min}
			aria-valuemax={max}
			aria-valuenow={value}
			onPointerDown={(event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				event.currentTarget.setPointerCapture(event.pointerId);
				document.body.dataset.resizing = 'true';
				drag.current = { position: axis === 'x' ? event.clientX : event.clientY, value };
			}}
			onPointerMove={(event) => {
				if (drag.current)
					onChange(
						clamp(
							drag.current.value +
								(edge === 'start' ? 1 : -1) *
									(drag.current.position - (axis === 'x' ? event.clientX : event.clientY))
						)
					);
			}}
			onPointerUp={(event) => {
				if (!drag.current) return;
				drag.current = null;
				delete document.body.dataset.resizing;
				event.currentTarget.releasePointerCapture(event.pointerId);
				onCommit();
			}}
			onLostPointerCapture={() => {
				if (drag.current) {
					drag.current = null;
					delete document.body.dataset.resizing;
					onCommit();
				}
			}}
			onKeyDown={(event) => {
				const minus = axis === 'x' ? 'ArrowRight' : 'ArrowDown',
					plus = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
				if (![minus, plus, 'Home', 'End'].includes(event.key)) return;
				event.preventDefault();
				onChange(
					event.key === 'Home'
						? min
						: event.key === 'End'
							? max
							: clamp(value + (edge === 'start' ? 1 : -1) * (event.key === plus ? 20 : -20))
				);
				onCommit();
			}}
		/>
	);
}
