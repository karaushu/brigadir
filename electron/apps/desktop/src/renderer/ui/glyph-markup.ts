import { isValidElement, type ReactElement, type ReactNode } from 'react';
/** SVG attributes React spells in camelCase that stay camelCase in markup. */
const camel = new Set([
	'viewBox',
	'preserveAspectRatio',
	'gradientUnits',
	'gradientTransform',
	'patternUnits',
	'patternContentUnits',
	'clipPathUnits',
	'maskUnits',
]);
const attribute = (name: string) =>
	name === 'className'
		? 'class'
		: camel.has(name) || name.includes('-')
			? name
			: name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const escape = (value: string) =>
	value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/**
 * Static markup for a hook-free icon element, so CodeMirror widgets can carry a Glyph without pulling
 * react-dom/server into the renderer bundle (perf review PKG-01). Only what Glyph produces is supported.
 */
export function glyphMarkup(node: ReactNode): string {
	if (node === null || node === undefined || typeof node === 'boolean') return '';
	if (typeof node === 'string' || typeof node === 'number') return escape(String(node));
	if (Array.isArray(node)) return node.map(glyphMarkup).join('');
	if (!isValidElement(node)) return '';
	const element = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
	if (typeof element.type === 'function')
		return glyphMarkup((element.type as (props: unknown) => ReactNode)(element.props));
	if (typeof element.type !== 'string') return glyphMarkup(element.props.children);
	const { children, ...props } = element.props;
	const attributes = Object.entries(props)
		.filter(([, value]) => value !== null && value !== undefined && value !== false)
		.map(([name, value]) => ` ${attribute(name)}="${escape(String(value))}"`)
		.join('');
	return `<${element.type}${attributes}>${glyphMarkup(children)}</${element.type}>`;
}
