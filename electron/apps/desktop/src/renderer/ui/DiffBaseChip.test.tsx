import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffBaseChip } from './DiffBaseChip';
const noop = () => {};
it('names the base with its icon and points to Settings (spec/diff-and-review#changes-header)', () => {
	const task = renderToStaticMarkup(
		<DiffBaseChip locale="uk" base="task" range={null} onSettings={noop} onAllChanges={noop} />
	);
	expect(task).toContain('data-glyph="base-task"');
	expect(task).toContain('aria-label="База змін: Старт задачі"');
	expect(task).toContain('Змінити: Налаштування ▸ Редактор');
	const head = renderToStaticMarkup(
		<DiffBaseChip locale="en" base="head" range={null} onSettings={noop} onAllChanges={noop} />
	);
	expect(head).toContain('data-glyph="base-head"');
	expect(head).toContain('>Last commit<');
});
it('shows a chosen range instead of the base, with a way back to all changes (spec/diff-and-review#changes-header)', () => {
	const html = renderToStaticMarkup(
		<DiffBaseChip
			locale="uk"
			base="head"
			range={{ base: 3, current: 5 }}
			onSettings={noop}
			onAllChanges={noop}
		/>
	);
	expect(html).toContain('Знімки #3–#5');
	expect(html).toContain('data-glyph="history"');
	expect(html).not.toContain('base-head');
	expect(html).toContain('aria-label="Показати всі зміни"');
	expect(html.startsWith('<span')).toBe(true);
});
