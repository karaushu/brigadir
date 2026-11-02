import { expect, it } from 'vitest';
import { CodeIntel } from './intel';
import { styleReference, styleClassOffsets } from './style-definition';

it('follows an imported SCSS member to its selector, including an unsaved stylesheet', async () => {
	const text =
		"import styles from './styles.module.scss';\nconst node = <div className={styles.disclaimer}/>;";
	const intel = new CodeIntel({
		typescript: null,
		node: process.execPath,
		onProblems() {},
		fallback: {
			files: async () => [],
			declarations: async () => [],
			read: async () => '\n.disclaimer { color: red; }',
		},
	});
	try {
		await intel.open('task', '/project/index.tsx', '/project', text, false);
		const result = await intel.definition(
			'task',
			'/project/index.tsx',
			0,
			text.indexOf('disclaimer')
		);
		expect(result).toMatchObject({
			source: 'stylesheet',
			locations: [
				{ absolute: '/project/styles.module.scss', line: 1, character: 1, byName: false },
			],
		});
		await intel.open(
			'task',
			'/project/styles.module.scss',
			'/project',
			'\n\n.disclaimer { color: blue; }',
			false
		);
		expect(
			(await intel.definition('task', '/project/index.tsx', 0, text.indexOf('disclaimer')))
				.locations[0]?.line
		).toBe(2);
	} finally {
		await intel.dispose();
	}
});
it('handles renamed imports and bracket access without following shadowed objects or comments', () => {
	const text =
		"import css from './styles.scss'; const a = css['foo-bar']; function f(css: any) { return css.nope; } // css.fake";
	expect(styleReference('/p/a.ts', text, text.indexOf('foo-bar'))).toEqual({
		path: './styles.scss',
		name: 'foo-bar',
	});
	expect(styleReference('/p/a.ts', text, text.indexOf('nope'))).toBeNull();
	expect(styleReference('/p/a.ts', text, text.indexOf('fake'))).toBeNull();
});
it('finds nested literal selectors and excludes comments, strings and longer names', () => {
	const text =
		'// .foo {}\n/* .foo {} */\n.outer { content: ".foo {}";\n .foo:hover, .foo-bar { color: red; } }';
	expect(styleClassOffsets(text, 'foo')).toEqual([text.indexOf('.foo:hover') + 1]);
});
