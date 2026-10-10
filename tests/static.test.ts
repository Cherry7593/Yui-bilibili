import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Store } from '../server/store.js';
import { Scheduler } from '../server/scheduler.js';
import { createApp, type ApplicationBilibili } from '../server/app.js';
test('static SPA entry, deep links and assets keep serving while the loopback guard stays enforced', async () => {
  const directory = await mkdtemp(join(tmpdir(),'yui-static-')); const cwd = process.cwd();
  await mkdir(join(directory,'dist/assets'),{ recursive:true });
  await writeFile(join(directory,'dist/index.html'),'<html><body><main>Local SPA fixture</main></body></html>');
  await writeFile(join(directory,'dist/assets/app.css'),'body { color: #111; }');
  const store = new Store(':memory:');
  const bili: ApplicationBilibili = {
    async checkLogin() { throw new Error('Static test never checks Bilibili'); }, async search() { throw new Error('Not used'); }, async comments() { throw new Error('Not used'); },
    async post() { throw new Error('Static test never writes to Bilibili'); }, async tools() { throw new Error('Not used'); }, async qrStart() { throw new Error('Not used'); }, async qrCheck() { throw new Error('Not used'); }, async resetSession() { throw new Error('Not used'); },
  };
  const scheduler = new Scheduler(store,bili); let app: FastifyInstance | undefined;
  try {
    // Node's test-file process isolation contains this cwd change; static roots resolve once.
    process.chdir(directory); app = await createApp(store,bili,scheduler,join(directory,'credential.json'),false); process.chdir(cwd);
    const entry = await app.inject({ method:'GET',url:'/' });
    assert.equal(entry.statusCode,200); assert.match(String(entry.headers['content-type']),/text\/html/);
    const deep = await app.inject({ method:'GET',url:'/topics' });
    assert.equal(deep.statusCode,200); assert.equal(deep.body,entry.body);
    const asset = await app.inject({ method:'GET',url:'/assets/app.css' });
    assert.equal(asset.statusCode,200); assert.match(String(asset.headers['content-type']),/text\/css/);
    const denied = await app.inject({ method:'GET',url:'/assets/app.css',headers:{ host:'external.invalid' } });
    assert.equal(denied.statusCode,403);
    const missing = await app.inject({ method:'GET',url:'/api/nonexistent' }); assert.equal(missing.statusCode,404);
  } finally { process.chdir(cwd); await app?.close(); await scheduler.close(); store.close(); await rm(directory,{ recursive:true }); }
});
