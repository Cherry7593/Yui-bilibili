import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { dayStart, limitsSchema, topicSchema, accountSchema, settingsSchema, aiConfigSchema, activitySchema, videoSchema, postReceiptSchema, type AiConfig, type Topic, type TopicConfig, type Template, type Settings, type Activity, type Video, type RecentComment } from './model.js';
const dataRow = z.object({ data: z.string() });
const countRow = z.object({ n: z.number() });
const queueSchema = z.object({ id: z.number(), bvid: z.string(), topic_id: z.number(), action: z.enum(['comment','reply']), state: z.string(), due: z.number(), video: z.string(), keyword: z.string() });
const claimedSchema = activitySchema.pick({ topicId: true, bvid: true, content: true, target: true, keyword: true }).extend({ time: z.number().nullable(), video: z.string(), config: z.string().nullable() });
const topicNameSchema = topicSchema.innerType().pick({ name: true });
export const STARTUP_PAUSE = '启动后暂停，请检查登录状态';
const recentRowSchema = z.object({ id: z.number(), action: z.enum(['comment','reply']), attempted: z.number(), content: z.string(), target: z.string(), receipt: z.string(), video: z.string(), keyword: z.string(), config: z.string().nullable() });
const entities: Record<string,string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// Search titles arrive HTML-escaped (for example &amp;); decode them for plain-text display.
function plainTitle(title: string) {
  return title.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos));/gi, (match, decimal?: string, hex?: string, name?: string) => {
    if (name) return entities[name.toLowerCase()];
    const code = decimal ? Number(decimal) : parseInt(hex ?? '', 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS topics(id INTEGER PRIMARY KEY, config TEXT NOT NULL, next_search INTEGER NOT NULL, last_run INTEGER);
      CREATE TABLE IF NOT EXISTS keywords(topic_id INTEGER REFERENCES topics(id) ON DELETE CASCADE, keyword TEXT NOT NULL, PRIMARY KEY(topic_id,keyword));
      CREATE TABLE IF NOT EXISTS templates(id INTEGER PRIMARY KEY, topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE, kind TEXT NOT NULL, text TEXT NOT NULL, enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS discoveries(bvid TEXT PRIMARY KEY, aid INTEGER NOT NULL UNIQUE, topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL, video TEXT NOT NULL, keyword TEXT NOT NULL, time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS interactions(id INTEGER PRIMARY KEY, bvid TEXT NOT NULL UNIQUE REFERENCES discoveries(bvid), topic_id INTEGER REFERENCES topics(id) ON DELETE SET NULL, action TEXT NOT NULL, state TEXT NOT NULL, due INTEGER NOT NULL, attempted INTEGER, content TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT '', receipt TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY, time INTEGER NOT NULL, topic_id INTEGER, action TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS activity_time ON activity(time);
      CREATE INDEX IF NOT EXISTS interactions_due ON interactions(state,due);
      CREATE TABLE IF NOT EXISTS app_settings(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_metadata(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
    `);
    if (!countRow.parse(this.db.prepare("SELECT count(*) AS n FROM pragma_table_info('interactions') WHERE name='target'").get()).n) this.db.exec("ALTER TABLE interactions ADD COLUMN target TEXT NOT NULL DEFAULT ''");
    if (!countRow.parse(this.db.prepare("SELECT count(*) AS n FROM pragma_table_info('interactions') WHERE name='receipt'").get()).n) this.db.exec("ALTER TABLE interactions ADD COLUMN receipt TEXT NOT NULL DEFAULT ''");
    if (!countRow.parse(this.db.prepare('SELECT count(*) AS n FROM app_settings').get()).n) this.saveSettings(settingsSchema.parse({ limits: limitsSchema.parse({}), running: false, pauseReason: '默认暂停', failures: 0, retryAt: 0, nextInteraction: 0, lastContent: '', account: { loggedIn: false, message: '未登录' } }));
    // Never resume writes after restart. A claimed request may already have reached Bilibili.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claimed = this.db.prepare("SELECT i.topic_id AS topicId,i.bvid,i.attempted AS time,i.content,i.target,d.keyword,d.video,t.config FROM interactions i JOIN discoveries d USING(bvid) LEFT JOIN topics t ON t.id=i.topic_id WHERE i.state='claimed'").all();
      this.db.prepare("UPDATE interactions SET state='uncertain' WHERE state='claimed'").run();
      for (const raw of claimed) {
        const row = claimedSchema.parse(raw); const video = videoSchema.parse(JSON.parse(row.video));
        this.log({ time: row.time ?? Date.now(), topicId: row.topicId, topic: row.config === null ? '系统' : topicNameSchema.parse(JSON.parse(row.config)).name, keyword: row.keyword, bvid: row.bvid, title: video.title, author: video.author, action: 'error', content: row.content, target: row.target, result: '发送结果不确定', error: '服务在发送结果确认前停止；不会重试此视频' });
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    const settings = this.settings();
    settings.running = false; settings.pauseReason = STARTUP_PAUSE; settings.account = { loggedIn: false, message: '登录状态待检查' };
    this.saveSettings(settings);
  }
  settings(): Settings {
    const row = dataRow.parse(this.db.prepare('SELECT data FROM app_settings WHERE id=1').get());
    const config = z.record(z.unknown()).parse(JSON.parse(row.data));
    const { baseUrl, model, apiKey } = aiConfigSchema.parse(config.ai ?? {});
    return settingsSchema.parse({ ...config, ai: { baseUrl, model, apiKeyConfigured: !!apiKey }, account: this.account() });
  }
  saveSettings(s: Settings) {
    const { account, ...config } = s;
    // Public snapshots must never overwrite or clear the private key.
    this.db.prepare('INSERT OR REPLACE INTO app_settings VALUES(1,?)').run(JSON.stringify({ ...config, ai: this.aiConfig() }));
    this.db.prepare('INSERT OR REPLACE INTO auth_metadata VALUES(1,?)').run(JSON.stringify(account));
  }
  aiConfig(): AiConfig {
    const row = this.db.prepare('SELECT data FROM app_settings WHERE id=1').get();
    const config = row ? z.record(z.unknown()).parse(JSON.parse(dataRow.parse(row).data)) : {};
    return aiConfigSchema.parse(config.ai ?? {});
  }
  saveAiConfig(config: AiConfig) {
    this.db.prepare("UPDATE app_settings SET data=json_set(data,'$.ai',json(?)) WHERE id=1").run(JSON.stringify(aiConfigSchema.parse(config)));
  }
  // Auth metadata is deliberately separate from configuration and contains no Cookie values.
  account(): Settings['account'] {
    const row = this.db.prepare('SELECT data FROM auth_metadata WHERE id=1').get();
    return row ? accountSchema.parse(JSON.parse(dataRow.parse(row).data)) : { loggedIn: false, message: '未登录' };
  }
  topics(now = Date.now()): Topic[] {
    return this.db.prepare('SELECT * FROM topics ORDER BY id').all().map(raw => {
      const row = z.object({ id: z.number(), config: z.string(), next_search: z.number(), last_run: z.number().nullable() }).parse(raw);
      const keywords = this.db.prepare('SELECT keyword FROM keywords WHERE topic_id=? ORDER BY rowid').all(row.id).map(k => z.object({ keyword: z.string() }).parse(k).keyword);
      const config = topicSchema.parse({ ...z.record(z.unknown()).parse(JSON.parse(row.config)), keywords });
      return { ...config, id: row.id, nextSearch: row.next_search, lastRun: row.last_run, todayDiscovered: this.count('discover', now, row.id), todayInteractions: this.attemptCount(now, row.id) };
    });
  }
  topic(id: number): Topic | undefined { return this.topics().find(t => t.id === id); }
  saveTopic(config: TopicConfig, id?: number): number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const { keywords, ...rest } = config;
      let topicId = id;
      if (topicId) {
        const previous = this.topic(topicId);
        const result = this.db.prepare('UPDATE topics SET config=? WHERE id=?').run(JSON.stringify(rest), topicId);
        if (!result.changes) throw new Error('Topic 不存在');
        // Changing judgment mode invalidates queued decisions from the previous mode atomically.
        if (previous?.aiJudgment !== config.aiJudgment) this.db.prepare("UPDATE interactions SET state='skipped' WHERE topic_id=? AND state='queued'").run(topicId);
        this.db.prepare('DELETE FROM keywords WHERE topic_id=?').run(topicId);
      } else topicId = Number(this.db.prepare('INSERT INTO topics(config,next_search) VALUES(?,0)').run(JSON.stringify(rest)).lastInsertRowid);
      for (const word of new Set(keywords)) this.db.prepare('INSERT INTO keywords VALUES(?,?)').run(topicId, word);
      this.db.exec('COMMIT'); return topicId;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  deleteTopic(id: number) {
    this.db.prepare("UPDATE interactions SET state='skipped' WHERE topic_id=? AND state='queued'").run(id);
    this.db.prepare('DELETE FROM topics WHERE id=?').run(id);
  }
  templates(): Template[] {
    return this.db.prepare('SELECT * FROM templates ORDER BY id').all().map(raw => {
      const r = z.object({ id: z.number(), topic_id: z.number(), kind: z.enum(['comment','reply']), text: z.string(), enabled: z.number() }).parse(raw);
      return { id: r.id, topicId: r.topic_id, kind: r.kind, text: r.text, enabled: !!r.enabled };
    });
  }
  saveTemplate(t: Omit<Template,'id'>, id?: number) {
    if (!this.topic(t.topicId)) throw new Error('Topic 不存在');
    if (id) {
      if (!this.db.prepare('UPDATE templates SET topic_id=?,kind=?,text=?,enabled=? WHERE id=?').run(t.topicId,t.kind,t.text,Number(t.enabled),id).changes) throw new Error('模板不存在');
      return id;
    }
    return Number(this.db.prepare('INSERT INTO templates(topic_id,kind,text,enabled) VALUES(?,?,?,?)').run(t.topicId,t.kind,t.text,Number(t.enabled)).lastInsertRowid);
  }
  log(data: Activity) { this.db.prepare('INSERT INTO activity(time,topic_id,action,data) VALUES(?,?,?,?)').run(data.time,data.topicId,data.action,JSON.stringify(data)); }
  activity(action = 'all', limit = 200, offset = 0): Activity[] {
    return this.db.prepare('SELECT id,data FROM activity WHERE (?=\'all\' OR action=?) ORDER BY id DESC LIMIT ? OFFSET ?').all(action,action,limit,offset).map(raw => {
      const row = dataRow.extend({ id: z.number() }).parse(raw);
      return { ...activitySchema.parse(JSON.parse(row.data)), id: row.id };
    });
  }
  recentComments(limit = 10): RecentComment[] {
    return this.db.prepare("SELECT i.id,i.action,i.attempted,i.content,i.target,i.receipt,d.video,d.keyword,t.config FROM interactions i JOIN discoveries d USING(bvid) LEFT JOIN topics t ON t.id=i.topic_id WHERE i.state='succeeded' ORDER BY i.attempted DESC,i.id DESC LIMIT ?").all(limit).map(raw => {
      const row = recentRowSchema.parse(raw); const video = videoSchema.parse(JSON.parse(row.video));
      const receipt = postReceiptSchema.catch({}).parse(row.receipt ? JSON.parse(row.receipt) : {});
      return { id: row.id, time: row.attempted, action: row.action, bvid: video.bvid, title: plainTitle(video.title), author: video.author, topic: row.config === null ? '已删除频道' : topicNameSchema.parse(JSON.parse(row.config)).name, keyword: row.keyword, content: row.content, target: row.target, cover: receipt.cover ?? null, rpid: receipt.rpid ?? null, stats: receipt.stats ?? { view: video.play }, statsAt: receipt.stats ? 'post' : 'discover' };
    });
  }
  count(action: string, now: number, topicId?: number) {
    return countRow.parse(this.db.prepare('SELECT count(*) AS n FROM activity WHERE time>=? AND action=? AND (? IS NULL OR topic_id=?)').get(dayStart(now),action,topicId ?? null,topicId ?? null)).n;
  }
  attemptCount(now: number, topicId?: number, action?: string) {
    return countRow.parse(this.db.prepare('SELECT count(*) AS n FROM interactions WHERE attempted>=? AND (? IS NULL OR topic_id=?) AND (? IS NULL OR action=?)').get(dayStart(now),topicId ?? null,topicId ?? null,action ?? null,action ?? null)).n;
  }
  discover(video: Video, topicId: number, keyword: string, now: number): boolean {
    return !!this.db.prepare('INSERT OR IGNORE INTO discoveries VALUES(?,?,?,?,?,?)').run(video.bvid,video.aid,topicId,JSON.stringify(video),keyword,now).changes;
  }
  queue(bvid: string, topicId: number, action: 'comment'|'reply', due: number) { this.db.prepare("INSERT INTO interactions(bvid,topic_id,action,state,due) VALUES(?,?,?,'queued',?)").run(bvid,topicId,action,due); }
  nextQueue(now: number) {
    const row = this.db.prepare("SELECT i.*,d.video,d.keyword FROM interactions i JOIN discoveries d USING(bvid) JOIN topics t ON t.id=i.topic_id WHERE i.state='queued' AND i.due<=? AND json_extract(t.config,'$.enabled')=1 ORDER BY i.due,i.id LIMIT 1").get(now);
    return row ? queueSchema.parse(row) : undefined;
  }
  close() { this.db.close(); }
}
