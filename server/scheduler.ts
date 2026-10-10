import { z } from 'zod';
import { Store, STARTUP_PAUSE } from './store.js';
import { BiliError, dayStart, defaultMinPlay, safeComment, videoSchema } from './model.js';
import type { Bilibili, Topic, TopicConfig, Video, Activity, Template, OrdinaryComment } from './model.js';
import { AiConfigError, AiFailure, AiLocalCheck, OpenAiPatrol, aiReplyCandidate, safeAiText } from './ai.js';
import type { PatrolAi } from './ai.js';
function eligible(video: Video, topic: TopicConfig, now: number) {
  const published = video.pubdate * 1000;
  return published <= now && published >= now - topic.maxAgeHours * 3600000
    && video.play >= (topic.minPlay ?? defaultMinPlay) && (topic.maxPlay === null || video.play <= topic.maxPlay);
}
export class Scheduler {
  private active?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private generation = 0;
  private nextLoginCheck = 0;
  private nextIdleCheck = 0;
  constructor(readonly store: Store, private bili: Bilibili, private clock = Date.now, private random = Math.random, private ai: PatrolAi = new OpenAiPatrol(() => store.aiConfig())) {}
  startTimer() { this.timer = setInterval(() => { void this.tick(); }, 1000); }
  async pause(reason = '手动暂停') {
    this.generation++;
    const s = this.store.settings(); s.running = false; s.pauseReason = reason; this.store.saveSettings(s);
    await this.active;
  }
  async run() {
    await this.pause();
    const generation = this.generation;
    this.checkAiConfiguration();
    const account = await this.bili.checkLogin();
    if (generation !== this.generation) return;
    this.checkAiConfiguration();
    const s = this.store.settings(); s.account = account;
    if (!account.loggedIn) { s.pauseReason = '未登录，不能运行'; this.store.saveSettings(s); throw new BiliError('auth'); }
    s.running = true; s.pauseReason = ''; s.failures = 0; s.retryAt = 0; s.readFailures = 0; s.readRetryAt = 0;
    this.nextLoginCheck = this.clock() + 300000;
    this.store.saveSettings(s);
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.cycle().finally(() => { this.active = undefined; });
    return this.active;
  }
  private checkAiConfiguration() {
    if (!this.store.topics().some(t => t.aiJudgment)) return;
    try { this.ai.assertConfigured(); }
    catch (error) {
      const reason = error instanceof AiConfigError ? error.message : 'AI 配置无效';
      const s = this.store.settings(); s.running = false; s.pauseReason = reason; this.store.saveSettings(s);
      this.generation++;
      throw new AiConfigError(reason);
    }
  }
  saveTopic(config: TopicConfig, id?: number): number {
    // A rejected save must not persist a hidden channel, change enablement or invalidate its queue.
    if (config.aiJudgment) {
      try { this.ai.assertConfigured(); }
      catch (error) { throw error instanceof AiConfigError ? error : new AiConfigError('AI 配置无效'); }
    }
    return this.store.saveTopic(config, id);
  }
  private topicAiError(topic: Topic): AiConfigError | undefined {
    if (!topic.aiJudgment) return;
    try { this.ai.assertConfigured(); }
    catch (error) {
      const reason = error instanceof AiConfigError ? error.message : 'AI 配置无效';
      this.store.saveTopic({ ...topic, enabled: false }, topic.id);
      this.store.db.prepare("UPDATE interactions SET state='skipped' WHERE topic_id=? AND state='queued'").run(topic.id);
      this.log(topic, 'error', 'AI 配置无效，频道已暂停', { error: reason });
      return new AiConfigError(`${reason}；频道已暂停`);
    }
  }
  private live(generation: number) { return generation === this.generation && this.store.settings().running; }
  private wait(min: number, max: number) { return Math.round((min + this.random() * (max - min)) * 60000); }
  private log(topic: Topic | undefined, action: string, result: string, details: Partial<Activity> = {}) {
    this.store.log({ time: this.clock(), topicId: topic?.id ?? null, topic: topic?.name ?? '系统', keyword: '', bvid: '', title: '', author: '', action, content: '', target: '', result, error: '', ...details });
  }
  private fail(error: unknown, topic?: Topic, details: Partial<Activity> = {}, channel: 'read'|'interaction' = 'read') {
    const failure = error instanceof BiliError ? error : new BiliError('api');
    const s = this.store.settings();
    const failures = channel === 'interaction' ? ++s.failures : ++s.readFailures;
    const retryAt = this.clock() + Math.min(3600000, 60000 * 2 ** Math.min(failures - 1, 6));
    if (channel === 'interaction') s.retryAt = retryAt; else s.readRetryAt = retryAt;
    if (failure.kind === 'risk' || failure.kind === 'auth' || failure.kind === 'disabled' || failures >= s.limits.failureLimit) {
      s.running = false;
      s.pauseReason = failure.kind === 'api' ? '连续失败，已自动暂停' : failure.message;
      if (failure.kind === 'auth') s.account = { loggedIn: false, message: failure.message };
      this.generation++;
    }
    this.store.saveSettings(s);
    this.log(topic,'error','失败',{ ...details, error: failure.message });
  }
  // Paused: verify login at startup and every 12 hours (5 minutes after a failed check), which also gives the
  // bridge a chance to renew cookies.
  private async idleLoginCheck() {
    if (this.clock() < this.nextIdleCheck) return;
    this.nextIdleCheck = this.clock() + 12 * 3600000;
    const generation = this.generation;
    try {
      const account = await this.bili.checkLogin();
      if (generation !== this.generation) return;
      const s = this.store.settings();
      if (s.running) return;
      s.account = account;
      if (account.loggedIn && s.pauseReason === STARTUP_PAUSE) s.pauseReason = '启动后暂停；登录有效，可手动启动巡逻';
      this.store.saveSettings(s);
    } catch { this.nextIdleCheck = this.clock() + 5 * 60000; }
  }
  private async cycle() {
    const initial = this.store.settings();
    if (!initial.running) return this.idleLoginCheck();
    const generation = this.generation;
    try {
      const topics = this.store.topics(this.clock());
      // Validate local configuration even on idle/backoff ticks, without pausing unrelated channels.
      for (const topic of topics) if (topic.enabled && this.topicAiError(topic)) topic.enabled = false;
      if (this.clock() < initial.readRetryAt) return;
      const dueSearch = topics.some(t => t.enabled && t.nextSearch <= this.clock());
      const dueInteraction = this.clock() >= initial.retryAt && this.clock() >= initial.nextInteraction && !!this.store.nextQueue(this.clock());
      if (!dueSearch && !dueInteraction && this.clock() < this.nextLoginCheck) return;
      const account = await this.bili.checkLogin();
      this.nextLoginCheck = this.clock() + 300000;
      if (!this.live(generation)) return;
      const current = this.store.settings(); current.account = account; this.store.saveSettings(current);
      if (!account.loggedIn) throw new BiliError('auth');
      for (const topic of topics) {
        if (!this.live(generation)) return;
        if (!topic.enabled || topic.nextSearch > this.clock()) continue;
        await this.discover(topic, generation);
        if (this.store.settings().readRetryAt > this.clock()) return;
      }
      if (this.live(generation)) await this.interact(generation);
    } catch (error) {
      if (error instanceof AiConfigError) this.log(undefined, 'error', '启动配置无效', { error: error.message });
      else this.fail(error);
    }
  }
  private async discover(topic: Topic, generation: number) {
    const now = this.clock();
    const limits = this.store.settings().limits;
    if (this.store.count('search',now,topic.id) >= topic.dailySearch || this.store.count('search',now) >= limits.dailySearch) {
      this.store.db.prepare('UPDATE topics SET next_search=? WHERE id=?').run(dayStart(now) + 86400000,topic.id); return;
    }
    const keyword = topic.keywords[this.store.count('search',now,topic.id) % topic.keywords.length];
    this.store.db.prepare('UPDATE topics SET next_search=?,last_run=? WHERE id=?').run(now + this.wait(topic.intervalMin,topic.intervalMax),now,topic.id);
    this.log(topic,'search','已请求',{ keyword });
    let videos: Video[];
    try { videos = await this.bili.search(keyword, { publishedAfter: Math.floor((now - topic.maxAgeHours * 3600000) / 1000), publishedBefore: Math.floor(now / 1000) }); }
    catch (error) { this.fail(error,topic,{ keyword }); return; }
    if (!this.live(generation)) return;
    const successful = this.store.settings(); successful.readFailures = 0; successful.readRetryAt = 0; this.store.saveSettings(successful);
    // Configuration may change while a network call is in progress.
    for (const video of videos) {
      if (!this.live(generation)) return;
      const currentTopic = this.store.topic(topic.id);
      if (!currentTopic?.enabled || this.topicAiError(currentTopic)) return;
      if (!eligible(video, currentTopic, this.clock())) continue;
      if (!this.store.discover(video,topic.id,keyword,now)) continue;
      const details = { keyword, bvid: video.bvid, title: video.title, author: video.author };
      this.log(currentTopic,'discover','已发现',details);
      if (currentTopic.aiJudgment) {
        try {
          const decision = await this.ai.judge(currentTopic, video, keyword);
          const latestTopic = this.store.topic(topic.id);
          if (!this.live(generation) || !latestTopic?.enabled || this.topicAiError(latestTopic)) return;
          this.log(currentTopic, 'judge', `AI 判断：${{ skip: '跳过', comment: '评视频', reply: '回评论' }[decision.action]}`, { ...details, content: decision.reason });
          if (decision.action === 'skip') this.log(currentTopic, 'skip', 'AI 判断跳过', { ...details, content: decision.reason });
          else if (latestTopic.aiJudgment && eligible(video, latestTopic, this.clock())) {
            this.store.queue(video.bvid, topic.id, decision.action, this.clock() + this.wait(limits.waitMin, limits.waitMax));
            this.log(currentTopic, 'queue', '等待互动', { ...details, content: decision.action === 'comment' ? '视频评论' : '回复普通评论' });
          }
        } catch (error) {
          this.log(currentTopic, 'judge', 'AI 判断：跳过', { ...details, content: error instanceof AiFailure ? error.message : '模型调用失败，已跳过' });
          this.log(currentTopic, 'skip', error instanceof AiLocalCheck ? 'AI 判断原因未通过本地检查，已跳过' : 'AI 判断失败，已跳过', details);
        }
        continue;
      }
      const roll = this.random() * 100;
      if (roll < currentTopic.skipProbability) this.log(currentTopic,'skip','概率跳过',details);
      else {
        const action = roll < currentTopic.skipProbability + currentTopic.commentProbability ? 'comment' : 'reply';
        this.store.queue(video.bvid,topic.id,action,now + this.wait(limits.waitMin,limits.waitMax));
        this.log(currentTopic,'queue','等待互动',{ ...details, content: action === 'comment' ? '视频评论' : '回复普通评论' });
      }
    }
  }
  private async interact(generation: number) {
    const now = this.clock();
    const s = this.store.settings();
    const last = z.object({ last: z.number().nullable() }).parse(this.store.db.prepare('SELECT max(attempted) AS last FROM interactions').get()).last;
    if (now < s.retryAt || now < s.nextInteraction || (last !== null && now < last + s.limits.waitMin * 60000)) return;
    const item = this.store.nextQueue(now);
    if (!item) return;
    const topic = this.store.topic(item.topic_id);
    if (!topic?.enabled || this.topicAiError(topic)) return;
    const video = videoSchema.parse(JSON.parse(item.video));
    const details = { keyword: item.keyword, bvid: video.bvid, title: video.title, author: video.author };
    if (!eligible(video, topic, now)) {
      this.store.db.prepare("UPDATE interactions SET state='skipped' WHERE id=?").run(item.id);
      this.log(topic,'skip','排队后视频不再满足热度或时间窗',details); return;
    }
    const limit = item.action === 'comment' ? s.limits.dailyComment : s.limits.dailyReply;
    const topicLimit = item.action === 'comment' ? topic.dailyComment : topic.dailyReply;
    if (this.store.attemptCount(now) >= s.limits.dailyTotal || this.store.attemptCount(now,undefined,item.action) >= limit || this.store.attemptCount(now,topic.id,item.action) >= topicLimit) {
      this.store.db.prepare('UPDATE interactions SET due=? WHERE id=?').run(dayStart(now)+86400000+this.wait(s.limits.waitMin,s.limits.waitMax),item.id); return;
    }
    const skip = (reason: string) => {
      this.store.db.prepare("UPDATE interactions SET state='skipped' WHERE id=? AND state='queued'").run(item.id);
      this.log(topic, 'skip', reason, details);
    };
    const aiWriting = topic.aiJudgment && topic.writingMode === 'ai';
    let template: Template | undefined;
    let text = '';
    if (!aiWriting) {
      const pool = this.store.templates().filter(t => t.topicId === topic.id && t.kind === item.action && t.enabled && t.text !== s.lastContent);
      if (!pool.length) { skip('无可用且不重复的模板'); return; }
      template = pool[Math.floor(this.random() * pool.length)];
      text = template.text;
    }
    let rpid = 0; let target = '';
    let candidates: OrdinaryComment[] = [];
    if (item.action === 'reply') {
      let comments;
      try { comments = await this.bili.comments(item.bvid); }
      catch (error) { this.fail(error,topic,{ ...details, content: text },'interaction'); return; }
      if (!this.live(generation) || !this.store.topic(topic.id)?.enabled) return;
      candidates = comments.filter(c => topic.aiJudgment ? aiReplyCandidate(c, this.store.account().uid) : safeComment(c) && c.uid !== this.store.account().uid);
      if (!candidates.length) { skip('无可确认安全的普通评论'); return; }
      if (!aiWriting) {
        const chosen = candidates[Math.floor(this.random() * candidates.length)]; rpid = chosen.rpid; target = chosen.user;
      }
    }
    if (aiWriting) {
      try {
        const written = await this.ai.write(topic, video, item.keyword, candidates);
        if (!safeAiText(written.text) || (item.action === 'reply' ? !candidates.some(c => c.rpid === written.rpid) : written.rpid !== 0)) throw new AiFailure('AI 撰写未通过本地检查，已跳过');
        text = written.text; rpid = written.rpid; target = candidates.find(c => c.rpid === rpid)?.user ?? '';
      } catch (error) { skip(error instanceof AiFailure ? error.message : 'AI 撰写失败，已跳过'); return; }
      if (!this.live(generation) || !this.store.topic(topic.id)?.enabled) return;
    }
    // Recheck login immediately before writing, after comment reads and before claiming.
    try {
      const account = await this.bili.checkLogin();
      if (!this.live(generation) || !this.store.topic(topic.id)?.enabled) return;
      if (!account.loggedIn) throw new BiliError('auth');
      const latest = this.store.settings();
      const latestTopic = this.store.topic(topic.id);
      if (!latestTopic || this.topicAiError(latestTopic)) return;
      if (latestTopic.aiJudgment !== topic.aiJudgment) return;
      if (topic.aiJudgment && (latestTopic.writingMode !== topic.writingMode || (aiWriting && latestTopic.style !== topic.style))) return;
      const claimTime = this.clock();
      if (!eligible(video, latestTopic, claimTime)) { skip('发送前视频不再满足热度或时间窗'); return; }
      const lastAttempt = z.object({ last: z.number().nullable() }).parse(this.store.db.prepare('SELECT max(attempted) AS last FROM interactions').get()).last;
      if (claimTime < latest.nextInteraction || (lastAttempt !== null && claimTime < lastAttempt + latest.limits.waitMin * 60000)) return;
      const latestLimit = item.action === 'comment' ? latest.limits.dailyComment : latest.limits.dailyReply;
      const latestTopicLimit = item.action === 'comment' ? latestTopic.dailyComment : latestTopic.dailyReply;
      if (this.store.attemptCount(this.clock()) >= latest.limits.dailyTotal || this.store.attemptCount(this.clock(),undefined,item.action) >= latestLimit || this.store.attemptCount(this.clock(),topic.id,item.action) >= latestTopicLimit) return;
      if (text === latest.lastContent) { if (aiWriting) skip('AI 撰写与上一条相同，已跳过'); return; }
      if (template && !this.store.templates().some(t => t.id === template.id && t.enabled && t.text === text && t.topicId === topic.id && t.kind === item.action)) return;
      // Claim + persist pacing before network I/O: a timeout/crash must never replay this video.
      const claim = this.store.db.prepare("UPDATE interactions SET state='claimed',attempted=?,content=?,target=? WHERE id=? AND state='queued'").run(claimTime,text,target,item.id);
      if (!claim.changes) return;
      const current = this.store.settings(); current.lastContent = text; current.nextInteraction = claimTime + this.wait(current.limits.waitMin,current.limits.waitMax); this.store.saveSettings(current);
      const receipt = await this.bili.post(item.bvid,text,rpid);
      this.store.db.prepare("UPDATE interactions SET state='succeeded',receipt=? WHERE id=?").run(JSON.stringify(receipt ?? {}),item.id);
      const successful = this.store.settings(); successful.failures = 0; successful.retryAt = 0; this.store.saveSettings(successful);
      this.log(topic,item.action,'成功',{ ...details, content: text, target });
    } catch (error) {
      this.store.db.prepare("UPDATE interactions SET state='failed' WHERE id=? AND state='claimed'").run(item.id);
      this.fail(error,topic,{ ...details, content: text, target },'interaction');
    }
  }
  async close() { clearInterval(this.timer); await this.pause('服务停止'); }
}
