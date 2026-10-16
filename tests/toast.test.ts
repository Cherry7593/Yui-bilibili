import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

type Toast = { id: number; kind: 'success' | 'error'; message: string; key?: string; leaving?: boolean };
type Dismiss = (gone: (toast: Toast) => boolean) => void;
type ToastItemProps = { toast: Toast; onDismiss: Dismiss };
interface ElementProps {
  children?: React.ReactNode;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onFocus?: () => void;
  onBlur?: (event: { currentTarget: { contains(node: unknown): boolean }; relatedTarget: unknown }) => void;
}
type Element = React.ReactElement<ElementProps>;
type Hooks = { useState: unknown; useEffect: unknown; useRef: unknown };
// web/main.tsx mounts the app on import, so run the real toast pieces on their own with the given hooks.
function load(hooks: Hooks) {
  const source = ts.createSourceFile('main.tsx', readFileSync(new URL('../web/main.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const wanted = new Set(['pushToast', 'toastIcons', 'ToastItem']);
  const parts = source.statements.filter(node => (ts.isFunctionDeclaration(node) && wanted.has(node.name?.text ?? ''))
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && wanted.has(declaration.name.text))));
  assert.equal(parts.length, 3);
  const code = ts.transpileModule(parts.map(node => node.getText(source)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  return new Function('React', 'useState', 'useEffect', 'useRef', `${code}\nreturn { pushToast, ToastItem };`)(React, hooks.useState, hooks.useEffect, hooks.useRef) as {
    pushToast: (list: Toast[], toast: Toast) => Toast[];
    ToastItem: (props: ToastItemProps) => Element;
  };
}
const toasts = () => load(React);
const render = (toast: Toast) => renderToStaticMarkup(React.createElement(toasts().ToastItem, { toast, onDismiss: () => {} }));
function elements(node: React.ReactNode): Element[] {
  const result: Element[] = [];
  React.Children.forEach(node, child => {
    if (React.isValidElement<ElementProps>(child)) result.push(child, ...elements(child.props.children));
  });
  return result;
}
// Minimal hook runtime: a state change re-renders at once and effects re-run only when their dependencies change, so
// mocked timers can drive the real countdown without a DOM.
function mount(toast: Toast, onDismiss: Dismiss) {
  const slots: unknown[] = []; const refs: { current: unknown }[] = [];
  const effects: { deps: unknown[]; cleanup?: () => void }[] = []; const queued: (() => void)[] = [];
  let state = 0; let ref = 0; let effect = 0; let tree: Element | undefined;
  const useState = (initial: unknown) => {
    const slot = state++;
    if (!(slot in slots)) slots[slot] = initial;
    return [slots[slot], (next: unknown) => { slots[slot] = next; draw(); }];
  };
  const useRef = (initial: unknown) => (refs[ref++] ??= { current: initial });
  const useEffect = (run: () => void | (() => void), deps: unknown[]) => {
    const index = effect++; const previous = effects[index];
    if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    queued.push(() => { previous?.cleanup?.(); const cleanup = run(); effects[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined }; });
  };
  const { ToastItem } = load({ useState, useEffect, useRef });
  function draw() {
    state = ref = effect = 0; tree = ToastItem({ toast, onDismiss });
    for (const run of queued.splice(0)) run();
  }
  draw();
  const root = () => { assert.ok(tree); return tree; };
  return { root, close: () => elements(root()).find(node => node.type === 'button') };
}
function dismissals() {
  const calls: ((toast: Toast) => boolean)[] = [];
  return { calls, onDismiss: (gone: (toast: Toast) => boolean) => { calls.push(gone); } };
}
const success: Toast = { id: 7, kind: 'success', message: '已保存' };

test('toasts stack up to three, newest last, dropping the oldest', () => {
  const { pushToast } = toasts();
  let list: Toast[] = [];
  for (const id of [1, 2, 3, 4]) list = pushToast(list, { id, kind: 'success', message: '已保存' });
  assert.deepEqual(list.map(t => t.id), [2, 3, 4]);
});

test('a keyed toast is updated in place, so a connection lost across polls never stacks', () => {
  const { pushToast } = toasts();
  const lost = pushToast([{ id: 1, kind: 'success', message: '已保存' }], { id: 2, kind: 'error', message: '无法连接服务', key: 'connection' });
  const again = pushToast(lost, { id: 3, kind: 'error', message: '无法连接服务', key: 'connection' });
  assert.deepEqual(again, lost);
  // A failure keyed like one that is already closing is shown as a new toast instead of reviving it.
  const closing: Toast = { id: 4, kind: 'error', message: '上一次失败', key: 'action', leaving: true };
  assert.deepEqual(pushToast([closing], { id: 5, kind: 'error', message: '这一次失败', key: 'action' }).map(t => [t.id, t.message]), [[4, '上一次失败'], [5, '这一次失败']]);
});

test('a toast shows its icon, message and a labelled close button', () => {
  const html = render({ id: 1, kind: 'error', message: '真实写操作未启用' });
  assert.match(html, /^<div class="toast error">/);
  assert.match(html, /<span>真实写操作未启用<\/span><button type="button" aria-label="关闭通知">/);
  assert.equal(html.match(/aria-hidden="true"/g)?.length, 2);
  assert.match(render({ id: 2, kind: 'success', message: '已保存', leaving: true }), /^<div class="toast success leaving">/);
});

test('a success toast closes itself after 4 seconds; errors and leaving toasts never time out', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const saved = dismissals(); mount(success, saved.onDismiss);
  t.mock.timers.tick(3999); assert.equal(saved.calls.length, 0);
  t.mock.timers.tick(1); assert.equal(saved.calls.length, 1);
  // The dismissal targets this toast only.
  assert.equal(saved.calls[0](success), true); assert.equal(saved.calls[0]({ ...success, id: 8 }), false);
  for (const toast of [{ id: 9, kind: 'error', message: '真实写操作未启用' }, { ...success, leaving: true }] as const) {
    const quiet = dismissals(); mount(toast, quiet.onDismiss);
    t.mock.timers.tick(60000); assert.equal(quiet.calls.length, 0);
  }
});

test('the close button dismisses at once, including an error toast', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const failed = dismissals(); const item = mount({ id: 9, kind: 'error', message: '真实写操作未启用' }, failed.onDismiss);
  item.close()?.props.onClick?.();
  assert.equal(failed.calls.length, 1); assert.equal(failed.calls[0]({ id: 9, kind: 'error', message: '' }), true);
});

test('hovering pauses the countdown, which resumes with the time that was left', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const saved = dismissals(); const item = mount(success, saved.onDismiss);
  t.mock.timers.tick(1000); item.root().props.onMouseEnter?.();
  t.mock.timers.tick(10000); assert.equal(saved.calls.length, 0);
  item.root().props.onMouseLeave?.();
  t.mock.timers.tick(2999); assert.equal(saved.calls.length, 0);
  t.mock.timers.tick(1); assert.equal(saved.calls.length, 1);
});

test('keyboard focus inside the toast pauses the countdown until focus leaves it', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const saved = dismissals(); const item = mount(success, saved.onDismiss);
  t.mock.timers.tick(500); item.root().props.onFocus?.();
  t.mock.timers.tick(10000); assert.equal(saved.calls.length, 0);
  // Focus moving between elements of the same toast keeps it paused.
  item.root().props.onBlur?.({ currentTarget: { contains: () => true }, relatedTarget: {} });
  t.mock.timers.tick(10000); assert.equal(saved.calls.length, 0);
  item.root().props.onBlur?.({ currentTarget: { contains: () => false }, relatedTarget: null });
  t.mock.timers.tick(3499); assert.equal(saved.calls.length, 0);
  t.mock.timers.tick(1); assert.equal(saved.calls.length, 1);
});
