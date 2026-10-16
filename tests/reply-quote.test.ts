import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { recentCommentSchema, type Activity, type RecentComment } from '../server/model.js';

type Lists = { RecentComments: (props: { rows: RecentComment[] }) => React.ReactElement; ActivityTable: (props: { rows: Activity[] }) => React.ReactElement };
// web/main.tsx mounts the app on import, so run the real list components with just the helpers they use.
function lists() {
  const source = ts.createSourceFile('main.tsx', readFileSync(new URL('../web/main.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const wanted = new Set(['labels', 'compact', 'commentUrl', 'RecentComments', 'ActivityTable']);
  const parts = source.statements.filter(node => (ts.isFunctionDeclaration(node) && wanted.has(node.name?.text ?? ''))
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && wanted.has(declaration.name.text))));
  assert.equal(parts.length, 5);
  const code = ts.transpileModule(parts.map(node => node.getText(source)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const { RecentComments, ActivityTable } = new Function('React', `${code}\nreturn { RecentComments, ActivityTable };`)(React) as Lists;
  return {
    recent: (rows: RecentComment[]) => renderToStaticMarkup(React.createElement(RecentComments, { rows })),
    activity: (rows: Activity[]) => renderToStaticMarkup(React.createElement(ActivityTable, { rows })),
  };
}
const time = Date.parse('2026-10-16T12:00:00+08:00');
const reply: RecentComment = { id: 1, time, action: 'reply', bvid: 'BV1000000001', title: '测试视频', author: '测试UP', topic: '任意兴趣', keyword: '关键词一', content: '我们发出的回复', target: '高赞用户', targetLikes: 300, targetContent: '被回复的原评论', cover: null, rpid: 290501715345, stats: { view: 100 }, statsAt: 'discover' };
const sent: Activity = { id: 1, time, topicId: 1, topic: '任意兴趣', keyword: '关键词一', bvid: 'BV1000000001', title: '测试视频', author: '测试UP', action: 'reply', content: '我们发出的回复', target: '高赞用户', targetLikes: 300, targetContent: '被回复的原评论', result: '成功', error: '' };

test('a recent reply quotes the replied comment above what was sent', () => {
  const html = lists().recent([reply]);
  const quote = html.indexOf('<blockquote class="comment-quote" title="被回复的原评论">被回复的原评论</blockquote>');
  assert.notEqual(quote, -1);
  assert.ok(html.indexOf('@高赞用户 · 300 赞') < quote);
  assert.ok(quote < html.indexOf('<p class="comment-content">我们发出的回复</p>'));
});

test('video comments, replies saved before the text was kept and servers that predate it show no quote', () => {
  // A server started before the text was kept sends no such key.
  const fromOlderServer: Partial<RecentComment> = { ...reply, id: 4 }; delete fromOlderServer.targetContent;
  const html = lists().recent([{ ...reply, id: 2, action: 'comment', target: '', targetLikes: null, targetContent: null, rpid: null }, { ...reply, id: 3, targetContent: null }, recentCommentSchema.parse(fromOlderServer)]);
  assert.match(html, /直接评论视频/); assert.equal(html.split('@高赞用户 · 300 赞').length, 3);
  assert.equal(html.includes('blockquote'), false);
});

test('Activity shows the replied comment as text under its target; rows without it have none', () => {
  const { activity } = lists();
  const html = activity([{ ...sent, targetContent: '原评论 <b>不是标签</b>' }]);
  assert.match(html, /→ @高赞用户（300 赞）<\/small><small class="activity-quote">原评论 &lt;b&gt;不是标签&lt;\/b&gt;<\/small>/);
  // Rows logged before the text was kept have no such key at all.
  const older: Activity = { ...sent }; delete older.targetContent;
  assert.equal(activity([older, { ...sent, id: 2, action: 'comment', target: '', targetLikes: undefined, targetContent: undefined }]).includes('activity-quote'), false);
});
