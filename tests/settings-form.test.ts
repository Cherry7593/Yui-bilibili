import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import React from 'react';
import ts from 'typescript';
import { z } from 'zod';
import { createApp, type ApplicationBilibili } from '../server/app.js';
import { Store } from '../server/store.js';
import { Scheduler } from '../server/scheduler.js';
import { aiSettingsSchema, settingsSchema, type Settings } from '../server/model.js';

interface ElementProps {
  children?: React.ReactNode;
  type?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  onChange?: (event: { target: { value: string; checked?: boolean } }) => void;
  onSubmit?: (event: { preventDefault(): void }) => void;
  onClick?: () => void;
}
type Element = React.ReactElement<ElementProps>;
interface FormState {
  settings: Settings;
  system: { writesEnabled: boolean; version: string; node: string; uptime: number };
}
type Api = (path: string, method?: string, body?: unknown) => Promise<unknown>;
interface SettingsProps {
  state: FormState;
  refresh(): Promise<void>;
  busy: boolean;
  mutate: Api;
  notify(message: string): void;
}
function elements(node: React.ReactNode): Element[] {
  const result: Element[] = [];
  React.Children.forEach(node, child => {
    if (React.isValidElement<ElementProps>(child)) result.push(child, ...elements(child.props.children));
  });
  return result;
}
function aiForm(tree: Element): Element {
  const form = elements(tree).find(node => node.type === 'form' && elements(node).some(child => child.type === 'input' && child.props.type === 'url'));
  assert.ok(form); return form;
}
function modelInput(form: Element): Element {
  const label = elements(form).find(node => node.type === 'label' && React.Children.toArray(node.props.children)[0] === '模型名');
  assert.ok(label);
  const input = elements(label).find(node => node.type === 'input'); assert.ok(input); return input;
}
function checkButton(form: Element): Element {
  const button = elements(form).find(node => node.type === 'button' && node.props.type === 'button');
  assert.ok(button); return button;
}

// Run the actual Settings function with deterministic hooks and real React elements.
// This checks form transitions, not source text or browser layout; API calls below use the real loopback app.
function settingsHarness(state: FormState, api: Api, refresh: () => Promise<void>, signal: AbortSignal) {
  const source = ts.createSourceFile('main.tsx', readFileSync(new URL('../web/main.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'Settings');
  assert.ok(declaration);
  const code = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  const values: unknown[] = []; let cursor = 0;
  const observers = new Set<() => void>();
  const useState = (initial: unknown) => {
    const slot = cursor++;
    if (!(slot in values)) values[slot] = initial;
    return [values[slot], (next: unknown) => {
      values[slot] = typeof next === 'function' ? next(values[slot]) : next;
      for (const observe of observers) observe();
    }];
  };
  // Effects (QR polling) never run here; these tests cover the AI settings form only.
  const useEffect = () => {};
  const Component = new Function('useState', 'useEffect', 'api', 'z', 'React', 'aiSettingsSchema', `${code}\nreturn Settings;`)(useState, useEffect, api, z, React, aiSettingsSchema) as (props: SettingsProps) => Element;
  const render = () => { cursor = 0; return Component({ state, refresh, busy: false, mutate: api, notify: () => {} }); };
  const waitFor = (predicate: () => boolean) => new Promise<void>((resolve, reject) => {
    const cleanup = () => { observers.delete(observe); signal.removeEventListener('abort', abort); };
    const observe = () => {
      try { if (predicate()) { cleanup(); resolve(); } }
      catch (error) { cleanup(); reject(error); }
    };
    const abort = () => { cleanup(); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    observers.add(observe);
    if (signal.aborted) abort(); else observe();
  });
  return { render, waitFor };
}

test('Settings save normalizes model and base URL, clears password and re-enables a working connection check', { timeout: 5000 }, async t => {
  const providerRequests: { model: string }[] = [];
  const provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    providerRequests.push(z.object({ model: z.string() }).parse(JSON.parse(raw)));
    response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] }));
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/v1/`;
  const store = new Store(':memory:');
  store.saveAiConfig({ baseUrl: base, model: 'before-save', apiKey: '' });
  const unexpected = async () => { throw new Error('Settings model check must not call Bilibili'); };
  const bili: ApplicationBilibili = { checkLogin: unexpected, search: unexpected, comments: unexpected, post: unexpected, tools: unexpected, qrStart: unexpected, qrCheck: unexpected, resetSession: unexpected };
  const scheduler = new Scheduler(store, bili);
  const app = await createApp(store, bili, scheduler, 'unused.json', false);
  try {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const appAddress = app.server.address(); assert.ok(appAddress && typeof appAddress !== 'string');
    for (const port of [address.port, appAddress.port]) assert.equal([3217,3218,3000,8010,8787,8080,25566,5432].includes(port), false);
    const origin = `http://127.0.0.1:${appAddress.port}`;
    const api: Api = async (path, method = 'GET', body) => {
      const response = await fetch(`${origin}/api${path}`, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error('Local settings request failed');
      return data;
    };
    const stateSchema = z.object({ settings: settingsSchema, system: z.object({ writesEnabled: z.boolean(), version: z.string(), node: z.string(), uptime: z.number() }) });
    const state = stateSchema.parse(await api('/state'));
    const harness = settingsHarness(state, api, async () => { Object.assign(state, stateSchema.parse(await api('/state'))); }, t.signal);
    let form = aiForm(harness.render());
    modelInput(form).props.onChange!({ target: { value: 'review-model ' } });
    elements(form).find(node => node.type === 'input' && node.props.type === 'url')!.props.onChange!({ target: { value: `  ${base}  ` } });
    elements(form).find(node => node.type === 'input' && node.props.type === 'password')!.props.onChange!({ target: { value: 'FORM_TEST_SECRET_NOT_A_REAL_KEY' } });
    form = aiForm(harness.render()); assert.equal(checkButton(form).props.disabled, true);
    const saved = harness.waitFor(() => checkButton(aiForm(harness.render())).props.disabled === false);
    form.props.onSubmit!({ preventDefault() {} }); await saved;
    form = aiForm(harness.render());
    assert.equal(modelInput(form).props.value, 'review-model');
    assert.equal(elements(form).find(node => node.type === 'input' && node.props.type === 'url')!.props.value, base);
    assert.equal(elements(form).find(node => node.type === 'input' && node.props.type === 'password')!.props.value, '');
    assert.equal(state.settings.ai.model, 'review-model'); assert.equal(state.settings.ai.baseUrl, base);
    assert.equal(state.settings.ai.apiKeyConfigured, true);
    const checked = harness.waitFor(() => providerRequests.length === 1 && checkButton(aiForm(harness.render())).props.disabled === false);
    checkButton(form).props.onClick!(); await checked;
    assert.deepEqual(providerRequests, [{ model: 'review-model' }]);
    assert.deepEqual(store.activity(), []); assert.equal(store.settings().running, false);
  } finally {
    await app.close(); await scheduler.close(); store.close();
    provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
  }
});

test('AI settings inputs reject edits during an in-flight save and restore drafts correctly on success or failure', { timeout: 5000 }, async t => {
  for (const outcome of ['success', 'failure'] as const) {
    const store = new Store(':memory:');
    const original = { baseUrl: 'http://127.0.0.1:19099', model: 'before-save', apiKey: 'ORIGINAL_FAKE_KEY_NOT_REAL' };
    store.saveAiConfig(original);
    const unexpected = async () => { throw new Error('Saving AI settings must not call Bilibili'); };
    const bili: ApplicationBilibili = { checkLogin: unexpected, search: unexpected, comments: unexpected, post: unexpected, tools: unexpected, qrStart: unexpected, qrCheck: unexpected, resetSession: unexpected };
    const scheduler = new Scheduler(store, bili);
    const app = await createApp(store, bili, scheduler, 'unused.json', false);
    let releaseResponse!: () => void; let reachedResponse!: () => void;
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
    const responseReached = new Promise<void>(resolve => { reachedResponse = resolve; });
    // Gate the real HTTP response, not a guessed delay or a copy of the save implementation.
    app.addHook('onSend', async (request, _reply, payload) => {
      if (request.method === 'PUT' && request.url === '/api/ai/settings') { reachedResponse(); await responseGate; }
      return payload;
    });
    try {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address(); assert.ok(address && typeof address !== 'string');
      assert.equal([3217,3218,3000,8010,8787,8080,25566,5432].includes(address.port), false);
      const origin = `http://127.0.0.1:${address.port}`;
      const api: Api = async (path, method = 'GET', body) => {
        const response = await fetch(`${origin}/api${path}`, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        const data: unknown = await response.json();
        if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(data).error);
        return data;
      };
      const stateSchema = z.object({ settings: settingsSchema, system: z.object({ writesEnabled: z.boolean(), version: z.string(), node: z.string(), uptime: z.number() }) });
      const state = stateSchema.parse(await api('/state'));
      const harness = settingsHarness(state, api, async () => { Object.assign(state, stateSchema.parse(await api('/state'))); }, t.signal);
      const inputs = () => {
        const form = aiForm(harness.render());
        const url = elements(form).find(node => node.type === 'input' && node.props.type === 'url')!;
        const password = elements(form).find(node => node.type === 'input' && node.props.type === 'password')!;
        const clear = elements(form).find(node => node.type === 'input' && node.props.type === 'checkbox')!;
        return { url, model: modelInput(form), password, clear };
      };
      const baseDraft = outcome === 'success' ? `  ${origin}/v1/  ` : 'invalid base draft ';
      const modelDraft = 'review-model ';
      const keyDraft = 'SUBMITTED_FAKE_KEY_NOT_REAL';
      inputs().url.props.onChange!({ target: { value: baseDraft } });
      inputs().model.props.onChange!({ target: { value: modelDraft } });
      inputs().password.props.onChange!({ target: { value: keyDraft } });
      aiForm(harness.render()).props.onSubmit!({ preventDefault() {} });
      await responseReached;
      const completed = harness.waitFor(() => elements(aiForm(harness.render())).find(node => node.type === 'button' && node.props.type !== 'button')!.props.disabled === false);
      const pending = inputs();
      const locked = Object.values(pending).map(input => input.props.disabled === true);
      // Native disabled inputs reject user editing. Do not force React handlers through that boundary.
      const tryEdit = (input: Element, value: string, checked?: boolean) => {
        if (!input.props.disabled) input.props.onChange!({ target: { value, checked } });
      };
      tryEdit(pending.url, `${origin}/new-draft`);
      tryEdit(pending.model, 'new-model-draft');
      tryEdit(pending.password, 'NEW_FAKE_KEY_NOT_REAL');
      tryEdit(pending.clear, '', true);
      const whilePending = inputs();
      const retained = [whilePending.url.props.value, whilePending.model.props.value, whilePending.password.props.value, whilePending.clear.props.checked];
      releaseResponse(); await completed;
      // Run the same assertion after releasing the response so failure cannot strand the test server.
      assert.deepEqual(locked, [true, true, true, true], 'AI settings must be locked while saving');
      assert.deepEqual(retained, [baseDraft, modelDraft, keyDraft, false], 'pending edits must not mutate the submitted draft');
      const restored = inputs();
      assert.deepEqual(Object.values(restored).map(input => input.props.disabled), [false, false, false, false]);
      if (outcome === 'success') {
        assert.equal(restored.url.props.value, baseDraft.trim()); assert.equal(restored.model.props.value, modelDraft.trim());
        assert.equal(restored.password.props.value, ''); assert.equal(restored.clear.props.checked, false);
        assert.deepEqual(store.aiConfig(), { baseUrl: baseDraft.trim(), model: modelDraft.trim(), apiKey: keyDraft });
        assert.equal(checkButton(aiForm(harness.render())).props.disabled, false);
      } else {
        assert.deepEqual([restored.url.props.value, restored.model.props.value, restored.password.props.value, restored.clear.props.checked], [baseDraft, modelDraft, keyDraft, false]);
        assert.deepEqual(store.aiConfig(), original);
        assert.equal(checkButton(aiForm(harness.render())).props.disabled, true);
      }
      assert.deepEqual(store.activity(), []); assert.equal(store.settings().running, false);
    } finally {
      releaseResponse();
      await app.close(); await scheduler.close(); store.close();
    }
  }
});
