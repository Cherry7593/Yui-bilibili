import { z } from 'zod';
const quota = z.number().int().min(0).max(10000);
const minutes = z.number().min(1).max(10080);
export const defaultMinPlay = 1000;
export const topicSchema = z.object({
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(false),
  aiJudgment: z.boolean().default(false),
  writingMode: z.enum(['template', 'ai']).default('template'),
  // With AI judgment the model only decides skip / interact; this decides how. Probabilities apply only without AI.
  aiInteraction: z.enum(['reply', 'comment']).default('reply'),
  style: z.string().trim().max(300).default(''),
  keywords: z.array(z.string().trim().min(1).max(100)).min(1).max(30),
  intervalMin: minutes.default(30), intervalMax: minutes.default(90),
  maxAgeHours: z.number().min(1).max(8760).default(72),
  minPlay: z.number().int().min(0).nullable().default(null),
  maxPlay: z.number().int().min(0).nullable().default(null),
  // Reply only to root comments with at least this many likes; 0 removes the threshold.
  replyMinLikes: z.number().int().min(0).max(100000000).default(50),
  dailySearch: quota.default(20), dailyComment: quota.default(5), dailyReply: quota.default(3),
  skipProbability: quota.default(70), commentProbability: quota.default(20), replyProbability: quota.default(10),
}).superRefine((v, ctx) => {
  if (v.intervalMax < v.intervalMin) ctx.addIssue({ code: 'custom', message: '搜索间隔最大值不能小于最小值' });
  if (v.minPlay !== null && v.maxPlay !== null && v.maxPlay < v.minPlay) ctx.addIssue({ code: 'custom', message: '播放量最大值不能小于最小值' });
  if (v.skipProbability + v.commentProbability + v.replyProbability !== 100) ctx.addIssue({ code: 'custom', message: '互动概率之和必须为 100' });
});
export type TopicConfig = z.infer<typeof topicSchema>;
export type Topic = TopicConfig & { id: number; nextSearch: number; lastRun: number | null; todayDiscovered: number; todayInteractions: number };
export const templateSchema = z.object({ topicId: z.number().int().positive(), kind: z.enum(['comment', 'reply']), text: z.string().trim().min(1).max(300), enabled: z.boolean().default(true) });
export type Template = z.infer<typeof templateSchema> & { id: number };
export const limitsSchema = z.object({
  dailySearch: quota.default(200), dailyComment: quota.default(10), dailyReply: quota.default(5), dailyTotal: quota.default(15),
  waitMin: minutes.default(5), waitMax: minutes.default(30), failureLimit: z.number().int().min(1).max(20).default(3),
}).refine(v => v.waitMax >= v.waitMin, '互动等待最大值不能小于最小值');
export type Limits = z.infer<typeof limitsSchema>;
// Web cookie renewal reported by the bridge login check; unsupported means no saved refresh_token.
export const renewalSchema = z.object({ status: z.enum(['current', 'renewed', 'failed', 'unsupported']), at: z.number().optional() });
export const accountSchema = z.object({ loggedIn: z.boolean(), username: z.string().optional(), uid: z.string().optional(), message: z.string(), renewal: renewalSchema.optional() });
export type Account = z.infer<typeof accountSchema>;
// Secret schema is for SQLite/model calls only; Settings is safe to serialize.
export const aiConfigSchema = z.object({ baseUrl: z.string().trim().max(2048).default(''), model: z.string().trim().max(200).default(''), apiKey: z.string().trim().max(4096).default('') });
export type AiConfig = z.infer<typeof aiConfigSchema>;
export const aiSettingsSchema = aiConfigSchema.omit({ apiKey: true }).extend({ apiKeyConfigured: z.boolean().default(false) });
// failures/retryAt belong to queue execution; reads have an independent failure streak.
export const settingsSchema = z.object({ limits: limitsSchema, running: z.boolean(), pauseReason: z.string(), failures: z.number(), retryAt: z.number(), readFailures: z.number().default(0), readRetryAt: z.number().default(0), nextInteraction: z.number(), lastContent: z.string(), account: accountSchema, ai: aiSettingsSchema.default({}) });
export type Settings = z.infer<typeof settingsSchema>;
export const videoSchema = z.object({ bvid: z.string().regex(/^BV[0-9A-Za-z]{10}$/), aid: z.number().int().positive(), title: z.string(), author: z.string(), play: z.number().nonnegative(), pubdate: z.number().positive() });
export type Video = z.infer<typeof videoSchema>;
export const commentSchema = z.object({ rpid: z.number().int().positive(), user: z.string(), content: z.string(), pinned: z.boolean(), ordinary: z.boolean(), like: z.number().int().nonnegative(), uid: z.string().optional() });
export type OrdinaryComment = z.infer<typeof commentSchema>;
export const activitySchema = z.object({ id: z.number().optional(), time: z.number(), topicId: z.number().nullable(), topic: z.string(), keyword: z.string(), bvid: z.string(), title: z.string(), author: z.string(), action: z.string(), content: z.string(), target: z.string(), result: z.string(), error: z.string(),
  // Likes and text of the replied comment when it was read before sending; absent for comments and older rows.
  targetLikes: z.number().int().nonnegative().optional(), targetContent: z.string().optional() });
export type Activity = z.infer<typeof activitySchema>;
const statCount = z.number().int().nonnegative();
export const postStatsSchema = z.object({ view: statCount, like: statCount, reply: statCount, favorite: statCount });
// Display-only facts returned with a confirmed send; any field may be absent.
export const postReceiptSchema = z.object({ rpid: z.number().int().positive().optional(), cover: z.string().optional(), stats: postStatsSchema.optional() });
export type PostReceipt = z.infer<typeof postReceiptSchema>;
// Only confirmed sends. Stats come from the send receipt, or the discovery play count for older rows.
// targetContent defaults so a page built after it was added still loads from a server started before.
export const recentCommentSchema = z.object({
  id: z.number(), time: z.number(), action: z.enum(['comment', 'reply']), bvid: z.string(), title: z.string(), author: z.string(), topic: z.string(), keyword: z.string(), content: z.string(), target: z.string(), targetLikes: z.number().nullable(), targetContent: z.string().nullable().default(null),
  cover: z.string().nullable(), rpid: z.number().nullable(), stats: postStatsSchema.partial().extend({ view: z.number() }), statsAt: z.enum(['post', 'discover']),
});
export type RecentComment = z.infer<typeof recentCommentSchema>;
export type SearchWindow = { publishedAfter: number; publishedBefore: number };
export interface Bilibili {
  checkLogin(): Promise<Account>;
  search(keyword: string, window: SearchWindow): Promise<Video[]>;
  comments(bvid: string): Promise<OrdinaryComment[]>;
  post(bvid: string, text: string, rpid?: number): Promise<PostReceipt | void>;
}
export class BiliError extends Error {
  constructor(public kind: 'risk' | 'auth' | 'api' | 'disabled') {
    super({ risk: '验证码或风控：已停止互动', auth: '登录失效，请重新登录', api: 'Bilibili API 请求失败', disabled: '真实写操作未启用' }[kind]);
  }
}
// Fixed account day: Asia/Shanghai, independent of host timezone and DST. Day index 0 is 1970-01-01 (Thursday).
export function dayIndex(now: number) { return Math.floor((now + 8 * 3600000) / 86400000); }
export function dayStart(now: number) { return dayIndex(now) * 86400000 - 8 * 3600000; }
export const overviewActions = ['discover', 'comment', 'reply', 'skip', 'error'] as const;
const overviewCount = z.number().int().nonnegative();
// Overview numbers are Activity counts, like today's: all-time totals plus daily sends for the heatmap.
export const overviewSchema = z.object({
  day: z.number().int(),
  totals: z.object({ discover: overviewCount, comment: overviewCount, reply: overviewCount, skip: overviewCount, error: overviewCount }),
  daily: z.array(z.object({ day: z.number().int(), comment: overviewCount, reply: overviewCount })),
});
export type Overview = z.infer<typeof overviewSchema>;
// The heatmap shows 53 weeks; its first Monday is at most 370 days before today.
export const overviewDays = 371;
export const toolNames = ['bili_login','bili_login_check','bili_check_credential','bili_search','bili_comments','bili_subtitle','bili_danmaku','bili_video_info','bili_reply','bili_crawl','bili_send_dynamic','bili_upload_video','bili_upload_video_multi','bili_send_opus','bili_video_zones','bili_hot_videos','bili_hot_buzzwords','bili_weekly_hot','bili_rank','bili_user_info','bili_user_videos','bili_favorite_lists','bili_favorite_content','bili_send_message','bili_unread_messages','bili_received_replies','bili_received_at_and_likes'] as const;
