import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { z } from 'zod';

type Api = (path: string, method?: string, body?: unknown) => Promise<unknown>;
// web/main.tsx mounts the app on import, so run the real api() on its own against a stubbed fetch.
function api(): Api {
  const source = ts.createSourceFile('main.tsx', readFileSync(new URL('../web/main.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const wanted = new Set(['offline', 'OfflineError', 'api']);
  const parts = source.statements.filter(node => ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && wanted.has(node.name?.text ?? ''))
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && wanted.has(declaration.name.text))));
  assert.equal(parts.length, 3);
  const code = ts.transpileModule(parts.map(node => node.getText(source)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function('z', `${code}\nreturn api;`)(z) as Api;
}
const reply = (status: number, body: string) => async () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

test('a dropped connection and a non-JSON reply show Chinese messages instead of browser text', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(api()('/state'), { message: '无法连接服务，请检查后端是否运行' });
  fetch.mock.mockImplementation(reply(502, '<html>Bad Gateway</html>'));
  await assert.rejects(api()('/scheduler', 'POST', { running: true }), { message: '请求失败' });
});

test('server errors keep their own message and successful replies return the parsed body', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', reply(409, JSON.stringify({ error: '真实写操作未启用' })));
  await assert.rejects(api()('/scheduler', 'POST', { running: true }), { message: '真实写操作未启用' });
  fetch.mock.mockImplementation(reply(200, JSON.stringify({ ok: true })));
  assert.deepEqual(await api()('/limits', 'PUT', {}), { ok: true });
});
