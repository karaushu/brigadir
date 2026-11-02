// Stand-in for a project's Prettier in tests (spec/editor-code-intelligence#format-on-save): the same async API surface, trivial rules.
const { readFileSync, existsSync } = require('node:fs');
const { dirname, join, relative } = require('node:path');
module.exports = {
  version: '9.9.9',
  async getFileInfo(file, options = {}) {
    const ignored = options.ignorePath && existsSync(options.ignorePath) && readFileSync(options.ignorePath, 'utf8').split('\n').filter(Boolean).some(line => relative(dirname(options.ignorePath), file) === line.trim());
    return { ignored: Boolean(ignored), inferredParser: /\.(js|ts)$/.test(file) ? 'babel' : null };
  },
  async resolveConfig(file, options = {}) {
    const path = join(dirname(file), '.prettierrc'); const own = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    // The real one maps `indent_style` / `indent_size` of a neighbouring .editorconfig to `useTabs` / `tabWidth`, below its own config.
    const editor = join(dirname(file), '.editorconfig'); if (!options.editorconfig || !existsSync(editor)) return own;
    const text = readFileSync(editor, 'utf8'), mapped = {};
    if (/indent_style\s*=\s*tab/.test(text)) mapped.useTabs = true; else if (/indent_style\s*=\s*space/.test(text)) mapped.useTabs = false;
    const size = /indent_size\s*=\s*(\d+)/.exec(text); if (size) mapped.tabWidth = Number(size[1]);
    return { ...mapped, ...own };
  },
  async format(text, options) {
    if (text.includes('HANG')) return new Promise(() => {});
    if (text.includes('SYNTAX')) { const error = new SyntaxError('Unexpected token'); error.loc = { start: { line: 2, column: 1 } }; throw error; }
    if (options.endOfLine !== 'lf') throw new Error('endOfLine must be lf');
    const quote = options.singleQuote ? "'" : '"';
    return text.replace(/["']/g, quote).replace(/ {2,}/g, ' ');
  },
};
