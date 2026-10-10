import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { BiliError, accountSchema, renewalSchema, videoSchema, commentSchema, postStatsSchema, type Account, type Bilibili, type PostReceipt, type SearchWindow } from './model.js';
const errorResult = z.object({ error_type: z.enum(['risk','auth','api','disabled']) });
// Covers render as <img>, so only Bilibili's image CDN is kept, always over HTTPS.
export function coverUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
    if (!['http:','https:'].includes(url.protocol) || !(url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com'))) return undefined;
    url.protocol = 'https:';
    return url.href;
  } catch { return undefined; }
}
export function loginAccount(data: unknown): Account {
  const value = z.object({ logged_in: z.boolean(), username: z.string().optional(), uid: z.string().optional(), message: z.string(), renewal: z.unknown() }).parse(data);
  // Renewal is display-only; a malformed report must not fail the login check itself.
  const renewal = renewalSchema.safeParse(value.renewal);
  return accountSchema.parse({ loggedIn: value.logged_in, username: value.username, uid: value.uid, message: value.message, ...(renewal.success ? { renewal: renewal.data } : {}) });
}
// The send already succeeded; malformed display metadata only drops the affected field.
export function postReceipt(data: unknown): PostReceipt {
  const value = z.object({ rpid: z.unknown(), cover: z.unknown(), stat: z.unknown() }).partial().catch({}).parse(data);
  const rpid = z.number().int().positive().safeParse(value.rpid);
  const cover = typeof value.cover === 'string' ? coverUrl(value.cover) : undefined;
  const stats = postStatsSchema.safeParse(value.stat);
  return { ...(rpid.success ? { rpid: rpid.data } : {}), ...(cover ? { cover } : {}), ...(stats.success ? { stats: stats.data } : {}) };
}
export class McpBilibili implements Bilibili {
  private client = new Client({ name: 'yui-bilibili', version: '1.0.0' });
  private connected?: Promise<void>;
  constructor(private python: string, private credentialFile: string) {}
  private connect() {
    if (!this.connected) {
      const env: Record<string,string> = {};
      for (const [key,value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
      env.BILI_CREDENTIAL_FILE = this.credentialFile;
      this.connected = this.client.connect(new StdioClientTransport({ command: this.python, args: ['bridge/server.py'], cwd: process.cwd(), env, stderr: 'ignore' }));
    }
    return this.connected;
  }
  private async call(name: string, args: Record<string,unknown> = {}): Promise<unknown> {
    try {
      await this.connect();
      const response = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 45000 });
      const parsed = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }).parse(response);
      if (parsed.isError) throw new BiliError('api');
      const text = parsed.content.find(c => c.type === 'text')?.text;
      if (!text) throw new BiliError('api');
      const data: unknown = JSON.parse(text);
      const error = errorResult.safeParse(data);
      if (error.success) throw new BiliError(error.data.error_type);
      return data;
    } catch (error) {
      if (error instanceof BiliError) throw error;
      throw new BiliError('api');
    }
  }
  async checkLogin() {
    try {
      return loginAccount(await this.call('bili_check_credential'));
    } catch (e) {
      if (e instanceof BiliError && e.kind === 'auth') return { loggedIn: false, message: '登录失效，请重新登录' };
      throw e;
    }
  }
  async search(keyword: string, window: SearchWindow) {
    const result = z.object({ videos: z.array(z.unknown()) }).parse(await this.call('bili_search', { keyword, num: 50, order: 'click', published_after: window.publishedAfter, published_before: window.publishedBefore }));
    const videos = [];
    for (const value of result.videos) {
      const parsed = videoSchema.safeParse(value);
      if (parsed.success) videos.push(parsed.data);
    }
    return videos;
  }
  async comments(bvid: string) {
    const result = z.object({ comments: z.array(z.unknown()) }).parse(await this.call('bili_comments', { bvid, num: 30 }));
    const comments = [];
    for (const value of result.comments) {
      const parsed = commentSchema.safeParse(value);
      if (parsed.success) comments.push(parsed.data);
    }
    return comments;
  }
  async post(bvid: string, text: string, rpid = 0) {
    const data = await this.call('bili_reply', { bvid, text, rpid, root: rpid });
    const result = z.object({ success: z.literal(true) }).safeParse(data);
    if (!result.success) throw new BiliError('api');
    return postReceipt(data);
  }
  async tools() {
    await this.connect();
    return (await this.client.listTools()).tools;
  }
  async qrStart() { return z.object({ status: z.string(), message: z.string(), qrcode_image: z.string() }).parse(await this.call('bili_login')); }
  async qrCheck() { return z.object({ status: z.string().optional(), message: z.string() }).parse(await this.call('bili_login_check')); }
  async resetSession() {
    await this.client.close();
    this.client = new Client({ name: 'yui-bilibili', version: '1.0.0' });
    this.connected = undefined;
  }
  async close() { await this.client.close(); }
}
