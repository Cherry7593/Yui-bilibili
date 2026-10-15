import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { createApp, type ApplicationBilibili } from '../server/app.js';
import { Scheduler } from '../server/scheduler.js';
import { Store } from '../server/store.js';
import { dayIndex, overviewDays, overviewSchema } from '../server/model.js';
// 2026-10-16 00:00 Asia/Shanghai.
const midnight = Date.parse('2026-10-15T16:00:00Z');
function log(store: Store, time: number, action: string) {
  store.log({ time, topicId: null, topic: '系统', keyword: '', bvid: '', title: '', author: '', action, content: '', target: '', result: '', error: '' });
}
test('overview totals cover all history; daily sends split at Asia/Shanghai midnight inside the heatmap window', () => {
  const store = new Store(':memory:');
  const today = dayIndex(midnight);
  const firstShown = (today - overviewDays + 1) * 86400000 - 8 * 3600000;
  log(store, midnight - 1, 'comment'); log(store, midnight, 'reply'); log(store, midnight + 3600000, 'reply');
  log(store, firstShown, 'comment'); log(store, firstShown - 1, 'comment');
  for (const action of ['discover', 'skip', 'error', 'search', 'judge', 'queue']) log(store, midnight, action);
  const overview = overviewSchema.parse(store.overview(midnight + 7200000));
  assert.equal(overview.day, today);
  assert.deepEqual(overview.totals, { discover: 1, comment: 3, reply: 2, skip: 1, error: 1 });
  assert.deepEqual(overview.daily, [{ day: today - overviewDays + 1, comment: 1, reply: 0 }, { day: today - 1, comment: 1, reply: 0 }, { day: today, comment: 0, reply: 2 }]);
  store.close();
});
test('an empty database has zero totals and no heatmap days', () => {
  const store = new Store(':memory:');
  assert.deepEqual(store.overview(midnight), { day: dayIndex(midnight), totals: { discover: 0, comment: 0, reply: 0, skip: 0, error: 0 }, daily: [] });
  store.close();
});
test('the state API carries the overview next to today counts without touching Bilibili', async t => {
  const store = new Store(':memory:');
  const unexpected = async () => { throw new Error('The overview must not call Bilibili'); };
  const bili: ApplicationBilibili = { checkLogin: unexpected, search: unexpected, comments: unexpected, post: unexpected, tools: unexpected, qrStart: unexpected, qrCheck: unexpected, resetSession: unexpected };
  const scheduler = new Scheduler(store, bili);
  const app = await createApp(store, bili, scheduler, 'unused.json', false);
  t.after(async () => { await app.close(); store.close(); });
  log(store, Date.now(), 'reply'); log(store, Date.now() - 400 * 86400000, 'comment');
  const response = await app.inject({ method: 'GET', url: '/api/state' });
  assert.equal(response.statusCode, 200);
  const body = z.object({ today: z.record(z.number()), overview: overviewSchema }).parse(response.json());
  assert.deepEqual(body.overview.totals, { discover: 0, comment: 1, reply: 1, skip: 0, error: 0 });
  assert.equal(body.today.reply, 1); assert.equal(body.today.comment, 0);
  assert.deepEqual(body.overview.daily, [{ day: body.overview.day, comment: 0, reply: 1 }]);
});
