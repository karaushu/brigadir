import ts from 'typescript';

/** Resolve the clicked CSS-module member through its actual import binding, including local shadowing. */
export function styleReference(file: string, text: string, offset: number) {
	const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	let target: ts.Node | undefined;
	const visit = (node: ts.Node) => {
		if (offset < node.getStart(source) || offset > node.end) return;
		target = node;
		ts.forEachChild(node, visit);
	};
	visit(source);
	if (!target) return null;
	const parent = target.parent;
	if (!parent) return null;
	let object: ts.Identifier, name: string;
	if (
		ts.isPropertyAccessExpression(parent) &&
		parent.name === target &&
		ts.isIdentifier(parent.expression)
	) {
		object = parent.expression;
		name = parent.name.text;
	} else if (
		ts.isElementAccessExpression(parent) &&
		parent.argumentExpression === target &&
		ts.isStringLiteral(target) &&
		ts.isIdentifier(parent.expression)
	) {
		object = parent.expression;
		name = target.text;
	} else return null;
	const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true };
	const host = ts.createCompilerHost(options);
	host.getSourceFile = (path) => (path === file ? source : undefined);
	host.fileExists = (path) => path === file;
	host.readFile = (path) => (path === file ? text : undefined);
	const program = ts.createProgram([file], options, host);
	const symbol = program.getTypeChecker().getSymbolAtLocation(object);
	const binding = symbol?.declarations?.[0];
	const declaration = binding && ts.isImportClause(binding) ? binding.parent : null;
	if (!declaration || !ts.isStringLiteral(declaration.moduleSpecifier)) return null;
	const path = declaration.moduleSpecifier.text;
	return /^\.{1,2}\//.test(path) && /\.(?:scss|css)$/.test(path) ? { path, name } : null;
}

/** Match literal class selectors in rule headers, never comments, strings or declaration values. */
export function styleClassOffsets(text: string, name: string): number[] {
	if (!/^-?[_a-zA-Z][\w-]*$/.test(name)) return [];
	const masked = text.replace(
		/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
		(value) => value.replace(/[^\r\n]/g, ' ')
	);
	const found: number[] = [];
	const selector = new RegExp(`\\.${name}(?![\\w-])`, 'g');
	for (const header of masked.matchAll(/[^{};]+(?=\{)/g)) {
		for (const match of header[0].matchAll(selector)) found.push(header.index + match.index + 1);
	}
	return found;
}
