process.umask(0o077);
import { resolve } from 'node:path';
import { Store } from './store.js';
import { McpBilibili } from './bilibili.js';
import { Scheduler } from './scheduler.js';
import { createApp } from './app.js';
const directory = resolve(process.env.DATA_DIR ?? 'data');
const credentialFile = resolve(directory,'config/bili_credential.json');
const store = new Store(resolve(directory,'patrol.sqlite'));
const bili = new McpBilibili(process.env.PYTHON ?? '.venv/bin/python',credentialFile);
const scheduler = new Scheduler(store,bili);
const app = await createApp(store,bili,scheduler,credentialFile,process.env.BILIBILI_WRITES_ENABLED === 'true');
const port = Number(process.env.PORT ?? 3217);
if ([3000,8010,8787,8080,25566,5432].includes(port)) throw new Error('该端口不允许用于本项目');
const host = process.env.HOST ?? '127.0.0.1';
await app.listen({ port, host });
scheduler.startTimer();
console.log(`Yui Comment ready: http://${host}:${port}; scheduler Paused`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await scheduler.close(); await app.close(); await bili.close(); store.close();
}
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
