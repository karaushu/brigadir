import { Parser, Language, type Node } from '@vscode/tree-sitter-wasm';
import { join } from 'node:path';
import {
	syntaxLanguage,
	syntaxLimit,
	type SyntaxKind,
	type SyntaxSnapshot,
	type SyntaxSymbol,
	type SyntaxToken,
} from '@brigadir/core';
const words = new Set(
	'async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of private protected public readonly return set static super switch this throw true try type typeof undefined var void while with yield def elif except False True None and as assert del global is lambda nonlocal not or pass raise async await fn pub impl mod mut use struct trait match loop move ref unsafe dyn crate self Self package func defer go range select chan map var fallthrough end module require unless until begin rescue ensure puts echo fi then done esac include namespace using return public protected internal abstract override virtual sealed final'.split(
		' '
	)
);
/** spec/editor-code-intelligence#font-styles: literals and receivers that tree-sitter gives named nodes of their own (JS/TS `this`, `null`…, Python `None`, `True`, `False`). */
const namedKeywords = new Set(['this', 'super', 'true', 'false', 'null', 'undefined', 'none']);
/** spec/editor-code-intelligence#font-styles: a method name in a TS/JS class or interface is a function, not a property. */
const methodNodes = new Set(['method_definition', 'method_signature', 'abstract_method_signature']);
const styleLanguages = new Set(['css', 'scss']);
/** spec/editor-code-intelligence#css-scss: CSS and SCSS nodes. Other grammars reuse some of these names (PowerShell `variable`), so only style
 *  sheets read them: at-rules, `!important`, tag selectors and `&` are keywords, `url()`/`var()` and mixins functions. */
const styleKinds: Record<string, SyntaxKind> = {
	at_keyword: 'keyword',
	important: 'keyword',
	tag_name: 'keyword',
	nesting_selector: 'keyword',
	function_name: 'function',
	feature_name: 'property',
	variable: 'property',
	placeholder: 'property',
	keyframes_name: 'type',
};
function kind(node: Node, language: string): SyntaxKind | null {
	const type = node.type;
	if (/comment/.test(type)) return 'comment';
	if (styleLanguages.has(language)) {
		// `a::before`: the grammar names the pseudo-element a tag; it is a selector part, as `:hover` is.
		if (
			type === 'tag_name' &&
			node.parent?.type === 'pseudo_element_selector' &&
			node.parent.namedChildren[0]?.id !== node.id
		)
			return 'property';
		if (node.isNamed ? styleKinds[type] : type.startsWith('@'))
			return styleKinds[type] ?? 'keyword';
		if (
			type === 'identifier' &&
			(node.parent?.type === 'include_statement' || node.parent?.type === 'mixin_statement') &&
			node.parent.namedChildren[0]?.id === node.id
		)
			return 'function';
	}
	// JSON: an object's key is a property, its value a string.
	if (
		language === 'json' &&
		type === 'string' &&
		node.parent?.type === 'pair' &&
		node.parent.childForFieldName('key')?.id === node.id
	)
		return 'property';
	if (
		[
			'string',
			'string_literal',
			'template_string',
			'string_value',
			'raw_string',
			'concatenated_string',
		].includes(type)
	)
		return 'string';
	if (
		[
			'number',
			'integer',
			'float',
			'integer_value',
			'float_value',
			'color_value',
			'integer_literal',
			'float_literal',
		].includes(type)
	)
		return 'number';
	if (['type_identifier', 'predefined_type'].includes(type)) return 'type';
	if (
		type === 'property_identifier' &&
		node.parent &&
		methodNodes.has(node.parent.type) &&
		node.parent.childForFieldName('name')?.id === node.id
	)
		return 'function';
	if (
		['property_identifier', 'property_name', 'attribute_name', 'class_name', 'id_name'].includes(
			type
		)
	)
		return 'property';
	if (type === 'identifier' && node.parent) {
		const parent = node.parent;
		const name = parent.childForFieldName('name');
		if (name?.id === node.id && /function|method/.test(parent.type)) return 'function';
		if (name?.id === node.id && /class|interface|enum/.test(parent.type)) return 'type';
		if (parent.type === 'call_expression' && parent.childForFieldName('function')?.id === node.id)
			return 'function';
		// spec/editor-code-intelligence#font-styles: a Python call is `call`, not `call_expression`: `f()` and the attribute of `obj.f()` are functions.
		if (parent.type === 'call' && parent.childForFieldName('function')?.id === node.id)
			return 'function';
		if (
			parent.type === 'attribute' &&
			parent.childForFieldName('attribute')?.id === node.id &&
			parent.parent?.type === 'call' &&
			parent.parent.childForFieldName('function')?.id === parent.id
		)
			return 'function';
	}
	if (node.isNamed && namedKeywords.has(type)) return 'keyword';
	if (!node.isNamed && words.has(type)) return 'keyword';
	return null;
}
function declaration(node: Node): string | null {
	if (
		[
			'function_declaration',
			'generator_function_declaration',
			'method_definition',
			'class_declaration',
			'interface_declaration',
			'type_alias_declaration',
			'enum_declaration',
			'function_definition',
			'class_definition',
			'function_item',
			'struct_item',
			'enum_item',
			'trait_item',
			'impl_item',
			'method_declaration',
			'class_specifier',
			'struct_specifier',
			'function_definition',
			'method',
			'singleton_method',
			'mixin_statement',
			'function_statement',
		].includes(node.type)
	)
		return node.childForFieldName('name')?.text ?? null;
	if (
		node.type === 'variable_declarator' &&
		['arrow_function', 'function_expression', 'generator_function'].includes(
			node.childForFieldName('value')?.type ?? ''
		)
	)
		return node.childForFieldName('name')?.text ?? null;
	if (node.type === 'rule_set')
		return node.namedChildren.find((n) => n?.type === 'selectors')?.text.slice(0, 160) ?? null;
	return null;
}
let runtime: Promise<void> | null = null;
const grammars = new Map<string, Promise<Language>>();
/** The runtime and each grammar load once per worker (perf review SYN-01); a failed load is retried by the next request. */
function load(assets: string, language: string): Promise<Language> {
	runtime ??= Parser.init({ locateFile: () => join(assets, 'tree-sitter.wasm') }).catch((error) => {
		runtime = null;
		throw error;
	});
	let grammar = grammars.get(language);
	if (!grammar) {
		grammar = runtime.then(() => Language.load(join(assets, `tree-sitter-${language}.wasm`)));
		grammars.set(language, grammar);
		grammar.catch(() => {
			if (grammars.get(language) === grammar) grammars.delete(language);
		});
	}
	return grammar;
}
/** Past these a file shows plain text (perf review SYN-02). The walk is bounded by time, not by node count: 200k nodes
 *  ended a 12k-line JS file with 21k tokens after a 190 ms walk. 150k tokens are ~5 MB structured-cloned and ~25 ms of
 *  editor decorations; 2 s of walk after a parse capped at 2 s keeps a request well inside the pool's 10 s. */
const tokenLimit = 150_000,
	symbolLimit = 20_000;
export async function analyze(path: string, text: string, assets: string): Promise<SyntaxSnapshot> {
	const language = syntaxLanguage(path);
	const empty = (status: SyntaxSnapshot['status']): SyntaxSnapshot => ({
		status,
		language,
		tokens: [],
		symbols: [],
	});
	if (!language) return empty('plain');
	if (Buffer.byteLength(text) > syntaxLimit || text.split('\n').length > 50000)
		return empty('large');
	const grammar = await load(assets, language);
	const parser = new Parser();
	parser.setLanguage(grammar);
	const started = Date.now();
	const tree = parser.parse(text, undefined, {
		progressCallback: () => Date.now() - started > 2000,
	});
	if (!tree) {
		parser.delete();
		return empty('large');
	}
	const tokens: SyntaxToken[] = [];
	const symbols: SyntaxSymbol[] = [];
	const cursor = tree.walk();
	let count = 0;
	const deadline = Date.now() + 2000;
	try {
		for (;;) {
			const node = cursor.currentNode;
			if (
				tokens.length > tokenLimit ||
				symbols.length > symbolLimit ||
				((++count & 4095) === 0 && Date.now() > deadline)
			)
				return empty('large');
			const name = declaration(node);
			if (name) {
				const parents: string[] = [];
				for (
					let parent = node.parent, depth = 0;
					parent && depth < 64;
					parent = parent.parent, depth++
				) {
					const name = declaration(parent);
					if (name) parents.unshift(name);
				}
				symbols.push({
					from: node.startIndex,
					to: node.endIndex,
					start: node.startPosition.row + 1,
					end: node.endPosition.row + 1,
					path: [...parents, name].join(' > '),
				});
			}
			const token = kind(node, language);
			if (token && node.endIndex > node.startIndex)
				tokens.push({ from: node.startIndex, to: node.endIndex, kind: token });
			if (!token && cursor.gotoFirstChild()) continue;
			while (!cursor.gotoNextSibling()) {
				if (!cursor.gotoParent()) return { status: 'ready', language, tokens, symbols };
			}
		}
	} finally {
		cursor.delete();
		tree.delete();
		parser.delete();
	}
}
const declarationType =
	/(?:declaration|definition|declarator|_item|_spec|_specifier|signature|assignment)$/;
const declarationNodes = new Set([
	'method',
	'singleton_method',
	'class',
	'module',
	'function',
	'mixin_statement',
	'function_statement',
]);
/** Name node of a declaration. Broader than symbol_path, which anchors review comments and stays as is. */
function declaredName(node: Node): Node | null {
	if (!node.isNamed || node.type === 'import_specifier' || node.type === 'export_specifier')
		return null;
	const name = node.childForFieldName('name');
	if (name && (declarationType.test(node.type) || declarationNodes.has(node.type))) return name;
	// spec/editor-code-intelligence#css-scss, spec/editor-code-intelligence#hyphenated-words: an SCSS variable (`$name: …`) and a custom property (`--name: …`) are declarations of a name.
	if (node.type === 'declaration') {
		const property = node.namedChildren[0];
		if (property?.type === 'property_name' && /^(?:\$|--)/.test(property.text)) return property;
	}
	if (node.type.endsWith('assignment')) {
		const left = node.childForFieldName('left');
		if (left && /identifier|variable_name/.test(left.type)) return left;
	}
	if (node.type.endsWith('declarator')) {
		const inner = node.childForFieldName('declarator');
		if (inner && /identifier/.test(inner.type)) return inner;
	}
	return null;
}
/** Declarations named `name` in each text, for the code-intelligence fallback (spec/editor-code-intelligence#fallback-mode). Offsets are UTF-16. */
export async function declarations(
	language: string,
	texts: string[],
	name: string,
	assets: string
): Promise<{ index: number; from: number }[]> {
	const grammar = await load(assets, language);
	const parser = new Parser();
	parser.setLanguage(grammar);
	const found: { index: number; from: number }[] = [];
	try {
		for (const [index, text] of texts.entries()) {
			if (Buffer.byteLength(text) > syntaxLimit) continue;
			const started = Date.now();
			const tree = parser.parse(text, undefined, {
				progressCallback: () => Date.now() - started > 2000,
			});
			if (!tree) continue;
			const cursor = tree.walk();
			let count = 0;
			try {
				walk: for (;;) {
					const node = cursor.currentNode;
					if (++count > 400000) break;
					const declared = declaredName(node);
					if (declared && declared.text === name) found.push({ index, from: declared.startIndex });
					if (cursor.gotoFirstChild()) continue;
					while (!cursor.gotoNextSibling()) {
						if (!cursor.gotoParent()) break walk;
					}
				}
			} finally {
				cursor.delete();
				tree.delete();
			}
		}
	} finally {
		parser.delete();
	}
	return found;
}
