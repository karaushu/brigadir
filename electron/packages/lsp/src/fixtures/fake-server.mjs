// Minimal language server for tests: behavior is chosen by FAKE_MODE.
let buffer = Buffer.alloc(0); const mode = process.env.FAKE_MODE ?? 'normal'; const docs = new Map();
const send = message => { const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message })); process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`); process.stdout.write(body); };
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
    const size = Number(/Content-Length: (\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + size) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString()); buffer = buffer.subarray(end + 4 + size);
    handle(message);
  }
});
function handle({ id, method, params }) {
  if (method === 'initialize') { if (mode === 'no-start') return; send({ id, result: { capabilities: { textDocumentSync: 2, definitionProvider: true, hoverProvider: true, completionProvider: { triggerCharacters: ['.'] } } } }); return; }
  if (method === 'textDocument/didOpen') { docs.set(params.textDocument.uri, params.textDocument.text); send({ method: 'textDocument/publishDiagnostics', params: { uri: params.textDocument.uri, version: 0, diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 2, message: 'fake warning', source: 'fake' }] } }); return; }
  if (method === 'textDocument/didChange') { let text = docs.get(params.textDocument.uri) ?? ''; for (const change of params.contentChanges) { if (!change.range) { text = change.text; continue; } const lines = text.split('\n'); const at = p => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character; text = text.slice(0, at(change.range.start)) + change.text + text.slice(at(change.range.end)); } docs.set(params.textDocument.uri, text); return; }
  if (method === 'textDocument/hover') { if (mode === 'crash') process.exit(3); send({ id, result: { contents: { kind: 'markdown', value: 'text: ' + JSON.stringify(docs.get(params.textDocument.uri)) } } }); return; }
  if (method === 'textDocument/completion') { if (mode === 'slow') return; send({ id, result: [{ label: 'alpha', kind: 3 }, { label: 'beta', kind: 6 }] }); return; }
  if (method === 'textDocument/definition') { send({ id, result: { uri: params.textDocument.uri, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } } }); return; }
  if (method === 'shutdown') { send({ id, result: null }); return; }
  if (method === 'exit') process.exit(0);
  if (method === '$/cancelRequest') { process.stderr.write(`cancel ${params.id}\n`); return; }
  if (id !== undefined) send({ id, result: null });
}
