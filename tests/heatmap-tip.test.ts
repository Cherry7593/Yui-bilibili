import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { dayIndex } from '../server/model.js';

type TipProps = { day: number; comment: number; reply: number; metric: 'all' | 'comment' | 'reply' };
// web/main.tsx mounts the app on import, so run the real HeatTip with just the two helpers it uses.
function heatTip() {
  const source = ts.createSourceFile('main.tsx', readFileSync(new URL('../web/main.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const wanted = new Set(['weekdayNames', 'calendar', 'HeatTip']);
  const parts = source.statements.filter(node => (ts.isFunctionDeclaration(node) && wanted.has(node.name?.text ?? ''))
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && wanted.has(declaration.name.text))));
  assert.equal(parts.length, 3);
  const code = ts.transpileModule(parts.map(node => node.getText(source)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const HeatTip = new Function('React', `${code}\nreturn HeatTip;`)(React) as (props: TipProps) => React.ReactElement;
  return (props: TipProps) => renderToStaticMarkup(HeatTip(props));
}
// 2026-10-16 is a Friday in Asia/Shanghai.
const friday = dayIndex(Date.parse('2026-10-16T12:00:00+08:00'));

test('heatmap tooltip: date and weekday, the selected metric in bold, then the comment / reply split', () => {
  const tip = heatTip();
  const html = tip({ day: friday, comment: 2, reply: 18, metric: 'all' });
  assert.match(html, />2026-10-16 周五</);
  assert.match(html, /<strong>20 条互动<\/strong>/);
  assert.match(html, />评论 2 · 回复 18</);
  assert.match(tip({ day: friday, comment: 2, reply: 18, metric: 'comment' }), /<strong>2 条评论<\/strong>/);
  assert.match(tip({ day: friday, comment: 2, reply: 18, metric: 'reply' }), /<strong>18 条回复<\/strong>/);
});

test('heatmap tooltip: a day without sends shows only the date and 无互动', () => {
  const html = heatTip()({ day: friday - 1, comment: 0, reply: 0, metric: 'reply' });
  assert.match(html, />2026-10-15 周四</);
  assert.match(html, />无互动</);
  assert.equal(html.includes('条'), false);
});
