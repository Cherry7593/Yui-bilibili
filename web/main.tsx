import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { defaultMinPlay, overviewActions, overviewSchema, topicSchema, templateSchema, settingsSchema, aiSettingsSchema, activitySchema, recentCommentSchema, type Overview, type TopicConfig, type Topic, type Template, type Limits, type Activity, type RecentComment } from '../server/model.js';
import './style.css';
const stateSchema = z.object({
  settings: settingsSchema,
  topics: z.array(topicSchema.and(z.object({ id: z.number(), nextSearch: z.number(), lastRun: z.number().nullable(), todayDiscovered: z.number(), todayInteractions: z.number() }))),
  templates: z.array(templateSchema.extend({ id: z.number() })),
  recentComments: z.array(recentCommentSchema), today: z.record(z.number()), overview: overviewSchema,
  system: z.object({ version: z.string(), node: z.string(), uptime: z.number(), writesEnabled: z.boolean(), queued: z.number() }),
});
type State = z.infer<typeof stateSchema>;
type Mutate = (path: string, method: string, body?: unknown, done?: string) => Promise<void>;
const pages = { dashboard: '总览', topics: '巡逻频道', templates: '评论模板', activity: '活动记录', settings: '设置' };
type Page = keyof typeof pages;
const labels: Record<string,string> = { discover: '发现', search: '搜索', judge: 'AI 判断', comment: '评论', reply: '回复', skip: '跳过', error: '失败', queue: '排队' };
const offline = '无法连接服务，请检查后端是否运行';
// The local service could not be reached; an action failing this way shares the toast of a failed status poll.
class OfflineError extends Error {}
async function api(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  // A dropped connection or a non-JSON reply would otherwise surface the browser's own English error text.
  const response = await fetch(`/api${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
    .catch(() => { throw new OfflineError(offline); });
  const data: unknown = await response.json().catch(() => { throw new Error('请求失败'); });
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(data);
    throw new Error(error.success ? error.data.error : '请求失败');
  }
  return data;
}
type Toast = { id: number; kind: 'success' | 'error'; message: string; key?: string; leaving?: boolean };
let toastCount = 0;
// At most three toasts. A keyed one (lost connection, the latest action's result) is updated in place, not stacked again.
function pushToast(list: Toast[], toast: Toast): Toast[] {
  if (toast.key && list.some(t => t.key === toast.key && !t.leaving)) return list.map(t => t.key === toast.key && !t.leaving ? { ...t, kind: toast.kind, message: toast.message } : t);
  return [...list, toast].slice(-3);
}
const toastIcons = { success: 'm8.5 12.5 2.5 2.5 4.5-5', error: 'm9.5 9.5 5 5m0-5-5 5' };
// Corner notice after TSL's: success fades after 4 s, paused while hovered or focused; errors stay until closed.
function ToastItem({ toast,onDismiss }: { toast: Toast; onDismiss: (gone: (toast: Toast) => boolean) => void }) {
  const [hovered,setHovered] = useState(false);
  const [focused,setFocused] = useState(false);
  const remaining = useRef(4000);
  useEffect(() => {
    if (toast.kind === 'error' || toast.leaving || hovered || focused) return;
    const started = Date.now();
    const timer = setTimeout(() => onDismiss(t => t.id === toast.id),remaining.current);
    return () => { clearTimeout(timer); remaining.current = Math.max(0,remaining.current - (Date.now() - started)); };
  },[toast.id,toast.kind,toast.leaving,hovered,focused,onDismiss]);
  return <div className={`toast ${toast.kind}${toast.leaving ? ' leaving' : ''}`} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
    <svg viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="9" /><path d={toastIcons[toast.kind]} /></svg>
    <span>{toast.message}</span>
    <button type="button" aria-label="关闭通知" onClick={() => onDismiss(t => t.id === toast.id)}><svg viewBox="0 0 24 24" aria-hidden><path d="m7 7 10 10M17 7 7 17" /></svg></button>
  </div>;
}
function App() {
  const [page,setPage] = useState<Page>('dashboard');
  const [state,setState] = useState<State>();
  const [toasts,setToasts] = useState<Toast[]>([]);
  const [dark,setDark] = useState(localStorage.getItem('theme') === 'dark');
  const [busy,setBusy] = useState(false);
  const notify = (kind: Toast['kind'],message: string,key?: string) => { const id = ++toastCount; setToasts(list => pushToast(list,{ id,kind,message,key })); };
  // Leaving toasts play their exit animation, then unmount.
  const dismiss = useCallback((gone: (toast: Toast) => boolean) => {
    setToasts(list => list.some(gone) ? list.map(t => gone(t) ? { ...t, leaving: true } : t) : list);
    setTimeout(() => setToasts(list => list.some(t => t.leaving && gone(t)) ? list.filter(t => !(t.leaving && gone(t))) : list),160);
  },[]);
  async function refresh() {
    try { setState(stateSchema.parse(await api('/state'))); dismiss(t => t.key === 'connection'); }
    catch { notify('error',offline,'connection'); }
  }
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh(); },5000); return () => clearInterval(timer); },[]);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('theme',dark ? 'dark' : 'light'); },[dark]);
  useEffect(() => {
    const onNavigation = () => { const value = window.location.pathname.slice(1); setPage(value in pages ? value as Page : 'dashboard'); };
    onNavigation(); window.addEventListener('popstate',onNavigation); return () => window.removeEventListener('popstate',onNavigation);
  },[]);
  const go = (key: Page) => { setPage(key); history.pushState(null,'',`/${key}`); };
  const mutate: Mutate = async (path,method,body,done = '已保存') => {
    // Each action's result replaces the previous one, so the corner holds one toast (plus a lost connection) and stays
    // clear of the header button below it.
    setBusy(true); dismiss(t => t.key === 'action');
    try { await api(path,method,body); await refresh(); notify('success',done,'action'); }
    catch (error) { notify('error',error instanceof Error ? error.message : '请求失败',error instanceof OfflineError ? 'connection' : 'action'); throw error; }
    finally { setBusy(false); }
  };
  return <div className="shell">
    <aside><a className="brand" href="/dashboard">Yui<span>bilibili patrol</span></a><div className="nav-label">工作空间</div><nav>{Object.entries(pages).map(([key,label],index) => <a key={key} href={`/${key}`} className={page === key ? 'selected' : ''} onClick={event => { event.preventDefault(); go(key as Page); }}><span>0{index+1}</span>{label}</a>)}</nav><div className="sidebar-bottom"><span className={`dot ${state?.settings.running ? 'running' : ''}`} />{state?.settings.running ? '巡逻中' : '已暂停'}<button onClick={() => setDark(!dark)}>{dark ? '浅色模式' : '深色模式'}</button></div></aside>
    <main><header><div><div className="eyebrow">YUI / {page.toUpperCase()}</div><h1>{pages[page]}</h1></div>{state && <button disabled={busy} className={state.settings.running ? '' : 'primary'} onClick={() => { void mutate('/scheduler','POST',{ running: !state.settings.running },state.settings.running ? '已暂停巡逻' : '已启动巡逻').catch(() => {}); }}>{state.settings.running ? '暂停巡逻' : '启动巡逻'}</button>}</header>
      {!state ? <p>正在连接本机服务…</p> : <>
        {!state.settings.account.loggedIn && <div className="warning">{state.settings.account.message} · {state.settings.account.message === '登录状态待检查' ? '启动后会自动检查，稍候即可。' : '请到设置登录；未登录不会互动。'}</div>}
        {state.settings.account.loggedIn && state.settings.account.renewal?.status === 'failed' && <div className="warning">登录自动续期失败，当前登录仍可用，12 小时后重试；若持续失败请到设置重新扫码登录。</div>}
        {page === 'dashboard' && <Dashboard state={state} go={go} />}
        {page === 'topics' && <Topics state={state} mutate={mutate} busy={busy} />}
        {page === 'templates' && <Templates state={state} mutate={mutate} busy={busy} />}
        {page === 'activity' && <Activities />}
        {page === 'settings' && <Settings state={state} mutate={mutate} refresh={refresh} busy={busy} />}
      </>}
      <footer>Yui-bilibili · 低频巡逻，安全优先 · V1</footer>
    </main>
    <div className="toasts" aria-live="polite">{toasts.map(toast => <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />)}</div>
  </div>;
}
function Dashboard({ state,go }: { state: State; go: (page: Page) => void }) {
  return <><section className="status-line"><span className={`dot ${state.settings.running ? 'running' : ''}`} /><strong>{state.settings.running ? 'Running / 巡逻中' : 'Paused / 已暂停'}</strong><span>{state.settings.pauseReason || '按照频道配置发现视频，等待后互动'}</span></section><div className="overview"><div className="section-heading"><h2>巡逻摘要 <small>累计 · 今日按 Asia/Shanghai 计</small></h2><a href="/activity" onClick={event => { event.preventDefault(); go('activity'); }}>查看活动记录 →</a></div><div className="stat-grid">{overviewActions.map(action => <div className="card stat-card" key={action}><div className="stat-head"><span>累计{labels[action]}</span><small>今日 +{(state.today[action] ?? 0).toLocaleString('zh-CN')}</small></div><strong>{state.overview.totals[action].toLocaleString('zh-CN')}</strong></div>)}</div><Heatmap overview={state.overview} /></div><section><h2>巡逻频道 <small>{state.topics.filter(t => t.enabled).length} 个启用 · {state.system.queued} 条待互动</small></h2>{!state.topics.length ? <p className="empty">还没有频道。添加关键词和至少两条不同的模板，再开启巡逻。</p> : state.topics.map(topic => <div className="list-row" key={topic.id}><strong>{topic.name}</strong><span>{topic.keywords.join(' / ')}</span><span className="tag">{topic.enabled ? '已启用' : '已暂停'}</span></div>)}</section><section><h2>最近评论 <small>仅含已确认发送成功的评论与回复</small></h2><RecentComments rows={state.recentComments} /></section></>;
}
const weekdayNames = ['一','二','三','四','五','六','日'];
const heatMetrics = { all: '互动', comment: '评论', reply: '回复' } as const;
type HeatMetric = keyof typeof heatMetrics;
// Day indexes are Asia/Shanghai calendar days, so the UTC fields of day * 86400000 are that calendar date.
const calendar = (day: number) => new Date(day * 86400000);
// Tooltip body: date and weekday, the selected metric, then the comment / reply split.
function HeatTip({ day,comment,reply,metric }: { day: number; comment: number; reply: number; metric: HeatMetric }) {
  const primary = { all: `${comment + reply} 条互动`, comment: `${comment} 条评论`, reply: `${reply} 条回复` }[metric];
  return <div className="heat-tip-box">
    <div className="heat-tip-muted">{`${calendar(day).toISOString().slice(0,10)} 周${weekdayNames[(day + 3) % 7]}`}</div>
    {comment + reply ? <><div><strong>{primary}</strong></div><div className="heat-tip-muted">{`评论 ${comment} · 回复 ${reply}`}</div></> : <div>无互动</div>}
  </div>;
}
function Heatmap({ overview }: { overview: Overview }) {
  const [metric,setMetric] = useState<HeatMetric>('all');
  // The hovered day; x / y are the cell's top centre inside the heatmap area.
  const [hover,setHover] = useState<{ day: number; x: number; y: number }>();
  const area = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const arrow = useRef<HTMLSpanElement>(null);
  // Narrow screens scroll horizontally; start at the latest weeks.
  useEffect(() => { if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth; },[]);
  // Keep the tooltip inside the area with its arrow on the cell; placed before paint, so it never flickers.
  useLayoutEffect(() => {
    if (!hover || !area.current || !tip.current || !arrow.current) return;
    const left = Math.min(Math.max(hover.x - tip.current.offsetWidth / 2,0),Math.max(area.current.clientWidth - tip.current.offsetWidth,0));
    tip.current.style.left = `${left}px`;
    arrow.current.style.left = `${hover.x - left}px`;
  });
  const sends = new Map(overview.daily.map(row => [row.day,row]));
  const count = (day: number) => { const row = sends.get(day); return !row ? 0 : metric === 'all' ? row.comment + row.reply : row[metric]; };
  // Rows run Monday to Sunday; the first column is the Monday 52 weeks before this week's.
  const first = overview.day - (overview.day + 3) % 7 - 52 * 7;
  const days = Array.from({ length: overview.day - first + 1 },(_,index) => first + index);
  const max = Math.max(0,...days.map(count));
  const total = days.reduce((sum,day) => sum + count(day),0);
  const monthOf = (week: number) => calendar(first + week * 7).getUTCMonth();
  // A month is labelled where its first full column starts; column 0 only when its month lasts three columns.
  const months = Array.from({ length: 53 },(_,week) => (week > 0 ? monthOf(week) !== monthOf(week - 1) : monthOf(1) === monthOf(0) && monthOf(2) === monthOf(0)) ? `${monthOf(week) + 1}月` : '');
  // Shown at once on entering a cell (no native title delay); gaps between cells keep the last day, so it never flickers.
  const showTip = (target: EventTarget) => {
    if (!(target instanceof HTMLElement) || !target.dataset.day || !area.current) return;
    const box = area.current.getBoundingClientRect();
    const cell = target.getBoundingClientRect();
    setHover({ day: Number(target.dataset.day), x: cell.left + cell.width / 2 - box.left, y: cell.top - box.top });
  };
  // Read by day on every render, so a 5-second refresh updates an open tooltip.
  const hovered = hover && sends.get(hover.day);
  return <div className="card heatmap-card">
    <div className="section-heading"><div><h2>互动热力图</h2><small>最近 53 周每日发送成功的{heatMetrics[metric]}数，悬停查看当日明细</small></div><div className="segmented" role="group" aria-label="热力图统计">{Object.entries(heatMetrics).map(([key,label]) => <button key={key} type="button" aria-pressed={metric === key} onClick={() => setMetric(key as HeatMetric)}>{label}</button>)}</div></div>
    <div className="heatmap-area" ref={area}>
      <div className="heatmap-scroll" ref={scroller} tabIndex={0} aria-label="互动热力图，可横向滚动" onScroll={() => setHover(undefined)}>
        <div className="heatmap" role="img" aria-label={`最近 53 周共 ${total} 条${heatMetrics[metric]}，单日最多 ${max} 条`} onMouseLeave={() => setHover(undefined)}>
          <span />
          <div className="heatmap-months">{months.map((label,week) => <span key={week}>{label}</span>)}</div>
          <div className="heatmap-weekdays">{weekdayNames.map((name,index) => <span key={name}>{index % 2 === 0 && index < 6 ? name : ''}</span>)}</div>
          <div className="heatmap-cells" onMouseOver={event => showTip(event.target)}>{days.map(day => { const n = count(day); return <i key={day} data-day={day} className={`heat-${n === 0 ? 0 : Math.min(4,Math.ceil(n / max * 4))}`} />; })}</div>
        </div>
      </div>
      {hover && <div className="heat-tip" ref={tip} style={{ top: hover.y }} aria-hidden><HeatTip day={hover.day} comment={hovered?.comment ?? 0} reply={hovered?.reply ?? 0} metric={metric} /><span className="heat-tip-arrow" ref={arrow} /></div>}
    </div>
    <div className="heatmap-foot"><small>只统计确认发送成功的评论与回复；日界为 Asia/Shanghai。</small><span className="legend" aria-hidden>少{[0,1,2,3,4].map(level => <i key={level} className={`heat-${level}`} />)}多</span></div>
  </div>;
}
const compact = new Intl.NumberFormat('zh-CN',{ notation: 'compact', maximumFractionDigits: 1 });
function commentUrl(row: RecentComment) {
  const video = `https://www.bilibili.com/video/${encodeURIComponent(row.bvid)}/`;
  return row.rpid ? `${video}#reply${row.rpid}` : video;
}
function RecentComments({ rows }: { rows: RecentComment[] }) {
  if (!rows.length) return <p className="empty">还没有发送成功的评论。</p>;
  return <div className="comment-list">{rows.map(row => {
    const stats = [['播放',row.stats.view],['点赞',row.stats.like],['评论',row.stats.reply],['收藏',row.stats.favorite]] as const;
    // Left: the video; right: what was sent there, a reply under the quoted comment it answers (older rows did not
    // keep that text). The panel stretches to the row so both bottoms line up.
    return <a key={row.id} className="comment-card" href={commentUrl(row)} target="_blank" rel="noreferrer">
      <div className="cover"><span>暂无封面</span>{row.cover && <img src={row.cover.includes('@') ? row.cover : `${row.cover}@320w_180h_1c`} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} />}</div>
      <div className="comment-video">
        <strong>{row.title || row.bvid}</strong>
        <small>UP {row.author} · {row.bvid} · {row.topic}</small>
        <small className="comment-stats">{stats.filter(([,value]) => value !== undefined).map(([label,value]) => `${label} ${compact.format(value ?? 0)}`).join(' · ')}（{row.statsAt === 'post' ? '发送时' : '发现时'}）</small>
      </div>
      <div className="comment-panel">
        <small className="comment-kind"><span className="tag">{row.action === 'reply' ? '回复' : '评论'}</span>{row.action === 'comment' ? '直接评论视频' : row.target ? `@${row.target}${row.targetLikes !== null ? ` · ${compact.format(row.targetLikes)} 赞` : ''}` : '普通评论'}</small>
        {row.targetContent && <blockquote className="comment-quote" title={row.targetContent}>{row.targetContent}</blockquote>}
        <p className="comment-content">{row.content}</p>
        <small className="comment-meta"><span>{new Date(row.time).toLocaleString('zh-CN')}</span><span className="jump">{row.rpid ? '定位到这条评论 ↗' : '打开视频 ↗'}</span></small>
      </div>
    </a>;
  })}</div>;
}
const blankTopic: TopicConfig = { name: '', enabled: false, aiJudgment: false, aiInteraction: 'reply', writingMode: 'template', style: '', keywords: [], intervalMin: 30, intervalMax: 90, maxAgeHours: 72, minPlay: null, maxPlay: null, replyMinLikes: 50, dailySearch: 20, dailyComment: 5, dailyReply: 3, skipProbability: 70, commentProbability: 20, replyProbability: 10 };
function Topics({ state,mutate,busy }: { state: State; mutate: Mutate; busy: boolean }) {
  const [draft,setDraft] = useState<TopicConfig & { id?: number }>();
  const [keywords,setKeywords] = useState('');
  const numberFields: [keyof TopicConfig,string][] = [['intervalMin','搜索间隔最小（分钟）'],['intervalMax','搜索间隔最大（分钟）'],['maxAgeHours','最近发布（小时）'],['minPlay',`最低播放量（空 = ${defaultMinPlay}）`],['maxPlay','最高播放量（可空）'],['replyMinLikes','回复评论最低点赞数（0 = 不限）'],['dailySearch','每日最多搜索'],['dailyComment','每日最多评论'],['dailyReply','每日最多回复'],['skipProbability','Skip 概率（%）'],['commentProbability','Comment 概率（%）'],['replyProbability','Reply 概率（%）']];
  function edit(topic?: Topic) { setDraft(topic ?? { ...blankTopic }); setKeywords(topic?.keywords.join('\n') ?? ''); }
  return <><div className="section-heading"><p>独立关键词、搜索节奏与互动规则，不绑定任何分区。</p><button onClick={() => edit()}>+ 新建频道</button></div><div className="topic-grid">{state.topics.map(topic => <article key={topic.id}><div className="section-heading"><h2>{topic.name}</h2><span className="tag">{topic.enabled ? '已启用' : '已暂停'}</span></div><p>{topic.keywords.join(' / ')}</p><div className="mini-stats">今日发现 {topic.todayDiscovered} · 互动尝试 {topic.todayInteractions}</div><p className="muted">最近运行：{topic.lastRun ? new Date(topic.lastRun).toLocaleString('zh-CN') : '尚未运行'}</p><div className="actions"><button onClick={() => edit(topic)}>编辑</button><button disabled={busy} onClick={() => { void mutate(`/topics/${topic.id}`,'PUT',{ ...topic, enabled: !topic.enabled },topic.enabled ? '已暂停频道' : '已开启频道').catch(() => {}); }}>{topic.enabled ? '暂停频道' : '开启频道'}</button></div></article>)}</div>{draft && <section className="editor"><div className="section-heading"><h2>{draft.id ? '编辑频道' : '新建频道'}</h2><button onClick={() => setDraft(undefined)}>关闭</button></div><form onSubmit={event => { event.preventDefault(); void mutate(draft.id ? `/topics/${draft.id}` : '/topics',draft.id ? 'PUT' : 'POST',{ ...draft, keywords: keywords.split('\n').map(s => s.trim()).filter(Boolean) },draft.id ? '已保存频道' : '已新建频道').then(() => setDraft(undefined)).catch(() => {}); }}><label>名称<input required value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label><label>搜索关键词（每行一个）<textarea required value={keywords} onChange={e => setKeywords(e.target.value)} /></label><label className="check"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用这个频道</label>
    <label className="check"><input type="checkbox" checked={draft.aiJudgment} onChange={e => setDraft({ ...draft, aiJudgment: e.target.checked })} />AI 判断视频（默认关闭）</label>
    <div className="form-grid"><label>AI 互动方式<select disabled={!draft.aiJudgment} value={draft.aiInteraction} onChange={e => setDraft({ ...draft, aiInteraction: e.target.value === 'comment' ? 'comment' : 'reply' })}><option value="reply">回复高赞评论</option><option value="comment">评论视频</option></select></label><label>写法<select disabled={!draft.aiJudgment} value={draft.writingMode} onChange={e => setDraft({ ...draft, writingMode: e.target.value === 'ai' ? 'ai' : 'template' })}><option value="template">固定模板</option><option value="ai">AI 撰写</option></select></label><label>风格说明（可选）<input maxLength={300} disabled={!draft.aiJudgment || draft.writingMode !== 'ai'} value={draft.style} onChange={e => setDraft({ ...draft, style: e.target.value })} /></label></div>
    <p className="muted">{draft.aiJudgment ? <>模型只判断新视频值不值得互动；怎么互动由「AI 互动方式」决定，回复时没有达到点赞门槛的评论就跳过，不改为评论视频。跳过、拿不准或失败都不入队。发送前才抽模板或撰写，仍受限额与间隔约束。请先在<a href="/settings">设置页</a>填写接口根地址、模型名和 API key。</> : '关闭 AI 判断时按概率分流并使用固定模板；写法与风格说明不生效。'}</p>
    <p className="muted">按播放量排序，在发布时间窗内只取第一页最多 50 条。最低播放量留空使用 {defaultMinPlay}，填 0 表示不限；最高播放量留空不限。提高门槛会减少候选，每日额度不是保证互动量。</p>
    <div className="form-grid">{numberFields.map(([key,label]) => <label key={key}>{label}<input type="number" min={key.endsWith('Probability') || key.startsWith('daily') || key.endsWith('Play') || key === 'replyMinLikes' ? 0 : 1} step="1" value={typeof draft[key] === 'number' ? draft[key] : ''} onChange={e => setDraft({ ...draft, [key]: e.target.value === '' && key.endsWith('Play') ? null : Number(e.target.value) })} /></label>)}</div><p className="muted">三种概率之和必须为 100；AI 判断开启时不使用概率分流。回复只选点赞数不低于门槛的普通根评论，没有就跳过。搜索与互动等待使用随机范围。</p><div className="actions"><button className="primary" disabled={busy}>保存频道</button>{draft.id && <button type="button" className="danger" disabled={busy} onClick={() => { if (confirm('删除频道？历史视频去重记录将保留。')) void mutate(`/topics/${draft.id}`,'DELETE',undefined,'已删除频道').then(() => setDraft(undefined)).catch(() => {}); }}>删除频道</button>}</div></form></section>}</>;
}
function Templates({ state,mutate,busy }: { state: State; mutate: Mutate; busy: boolean }) {
  const [draft,setDraft] = useState<Omit<Template,'id'> & { id?: number }>({ topicId: state.topics[0]?.id ?? 0, kind: 'comment', text: '', enabled: true });
  return <><p>模板直接绑定频道。评论与回复各自管理；连续相同内容会安全跳过。</p><section className="editor"><h2>{draft.id ? '编辑模板' : '添加模板'}</h2><form onSubmit={event => { event.preventDefault(); void mutate(draft.id ? `/templates/${draft.id}` : '/templates',draft.id ? 'PUT' : 'POST',draft,draft.id ? '已保存模板' : '已添加模板').then(() => setDraft({ ...draft, id: undefined, text: '' })).catch(() => {}); }}><div className="form-grid"><label>所属频道<select required value={draft.topicId} onChange={e => setDraft({ ...draft, topicId: Number(e.target.value) })}><option value="0" disabled>请选择频道</option>{state.topics.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label>类型<select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value === 'reply' ? 'reply' : 'comment' })}><option value="comment">视频评论模板</option><option value="reply">普通评论回复模板</option></select></label></div><label>内容<textarea required maxLength={300} value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} /></label><label className="check"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用模板</label><button className="primary" disabled={busy || !state.topics.length}>保存模板</button></form></section><section>{state.templates.map(template => <div className="list-row template-row" key={template.id}><div><strong>{template.text}</strong><p className="muted">{state.topics.find(t => t.id === template.topicId)?.name} / {template.kind === 'comment' ? '视频评论' : '用户回复'} / {template.enabled ? '启用' : '禁用'}</p></div><div className="actions"><button onClick={() => setDraft(template)}>编辑</button><button disabled={busy} onClick={() => { void mutate(`/templates/${template.id}`,'PUT',{ ...template, enabled: !template.enabled },template.enabled ? '已禁用模板' : '已启用模板').catch(() => {}); }}>{template.enabled ? '禁用' : '启用'}</button><button className="danger" disabled={busy} onClick={() => { void mutate(`/templates/${template.id}`,'DELETE',undefined,'已删除模板').catch(() => {}); }}>删除</button></div></div>)}</section></>;
}
function ActivityTable({ rows }: { rows: Activity[] }) {
  return !rows.length ? <p className="empty">暂无活动。默认不会自动巡逻。</p> : <div className="table-scroll"><table><thead><tr><th>时间 / 频道</th><th>关键词 / 视频 / UP 主</th><th>动作 / 内容 / 对象</th><th>结果</th></tr></thead><tbody>{rows.map((row,index) => <tr key={row.id ?? index}><td>{new Date(row.time).toLocaleString('zh-CN')}<small>{row.topic}</small></td><td>{row.bvid ? <a target="_blank" rel="noreferrer" href={`https://www.bilibili.com/video/${encodeURIComponent(row.bvid)}`}>{row.title || row.bvid}</a> : '—'}<small>{row.keyword} {row.author && `· UP ${row.author}`}</small></td><td><span className="tag">{labels[row.action] ?? row.action}</span><small>{row.content} {row.target && `→ @${row.target}${row.targetLikes !== undefined ? `（${row.targetLikes} 赞）` : ''}`}</small>{row.targetContent && <small className="activity-quote">{row.targetContent}</small>}</td><td>{row.result}<small className="error">{row.error}</small></td></tr>)}</tbody></table></div>;
}
function Activities() {
  const [filter,setFilter] = useState('all'); const [rows,setRows] = useState<Activity[]>([]); const [offset,setOffset] = useState(0); const [error,setError] = useState('');
  useEffect(() => { let alive = true; api(`/activity?action=${filter}&offset=${offset}`).then(data => { if (alive) setRows(z.array(activitySchema).parse(data)); }).catch(() => setError('活动记录加载失败')); return () => { alive = false; }; },[filter,offset]);
  return <><div className="section-heading"><p>搜索、发现、AI 判断、互动和错误的完整轨迹。</p><select aria-label="活动筛选" value={filter} onChange={e => { setFilter(e.target.value); setOffset(0); }}>{['all','judge','comment','reply','skip','error'].map(key => <option key={key} value={key}>{key === 'all' ? '全部' : labels[key]}</option>)}</select></div>{error && <p className="error">{error}</p>}<ActivityTable rows={rows} /><div className="actions"><button disabled={offset === 0} onClick={() => setOffset(Math.max(0,offset-100))}>较新记录</button><button disabled={rows.length < 100} onClick={() => setOffset(offset+100)}>较早记录</button></div></>;
}
function Settings({ state,mutate,refresh,busy }: { state: State; mutate: Mutate; refresh: () => Promise<void>; busy: boolean }) {
  const [limits,setLimits] = useState<Limits>(state.settings.limits); const [cookie,setCookie] = useState(''); const [refreshToken,setRefreshToken] = useState(''); const [qr,setQr] = useState(''); const [qrStatus,setQrStatus] = useState('');
  const [aiBaseUrl,setAiBaseUrl] = useState(state.settings.ai.baseUrl); const [aiModel,setAiModel] = useState(state.settings.ai.model);
  const [apiKey,setApiKey] = useState(''); const [clearApiKey,setClearApiKey] = useState(false);
  const [aiBusy,setAiBusy] = useState(false); const [aiNotice,setAiNotice] = useState('');
  const [aiSaving,setAiSaving] = useState(false);
  const aiDirty = aiBaseUrl !== state.settings.ai.baseUrl || aiModel !== state.settings.ai.model || !!apiKey || clearApiKey;
  async function aiAction(check: boolean) {
    setAiBusy(true); setAiSaving(!check); setAiNotice('');
    try {
      if (check) {
        const result = z.object({ message: z.string() }).parse(await api('/ai/check','POST'));
        setAiNotice(result.message);
      } else {
        await api('/ai/settings','PUT',{ baseUrl: aiBaseUrl, model: aiModel, ...(clearApiKey ? { apiKey: '' } : apiKey ? { apiKey } : {}) });
        const saved = aiSettingsSchema.parse({ baseUrl: aiBaseUrl, model: aiModel });
        setAiBaseUrl(saved.baseUrl); setAiModel(saved.model);
        setApiKey(''); setClearApiKey(false); await refresh(); setAiNotice('模型配置已保存');
      }
    } catch (error) { setAiNotice(error instanceof Error ? error.message : '模型请求失败'); }
    finally { setAiSaving(false); setAiBusy(false); }
  }
  const renewal = state.settings.account.renewal;
  const renewedAt = renewal?.at ? new Date(renewal.at).toLocaleString('zh-CN') : '';
  const renewalNote = !state.settings.account.loggedIn ? '' : !renewal ? '自动续期：等待下一次登录检查' : {
    current: `自动续期已开启 · ${renewedAt} 检查，暂不需要刷新`,
    renewed: `自动续期已开启 · ${renewedAt} 已自动续期`,
    failed: `自动续期失败（${renewedAt}）：当前登录仍可用，12 小时后重试；若持续失败请重新扫码登录`,
    unsupported: '未保存刷新令牌，无法自动续期：扫码登录会自动保存；Cookie 登录可填写 ac_time_value',
  }[renewal.status];
  const limitFields: [keyof Limits,string][] = [['dailySearch','每日最多搜索'],['dailyComment','每日最多评论'],['dailyReply','每日最多回复'],['dailyTotal','每日最多总互动'],['waitMin','两次互动最短间隔（分钟）'],['waitMax','最长随机等待（分钟）'],['failureLimit','连续失败暂停阈值']];
  async function qrStart() {
    try { const value = z.object({ qrcode_image: z.string(), message: z.string() }).parse(await api('/account/qr','POST')); setQr(value.qrcode_image); setQrStatus(value.message); }
    catch (error) { setQr(''); setQrStatus(`${error instanceof Error ? error.message : '二维码生成失败'}；可改用 Cookie 登录`); }
    await refresh();
  }
  // True once the scan reaches a final state; removing the QR then stops polling.
  async function qrCheck(): Promise<boolean> {
    try {
      const value = z.object({ status: z.string().optional(), message: z.string() }).parse(await api('/account/qr/check','POST'));
      setQrStatus(value.message);
      if (value.status === 'waiting_scan' || value.status === 'waiting_confirm') return false;
    } catch (error) { setQrStatus(`${error instanceof Error ? error.message : '扫码状态检查失败'}；请重新生成二维码或改用 Cookie 登录`); }
    setQr(''); await refresh(); return true;
  }
  useEffect(() => {
    if (!qr) return;
    // One request at a time while the QR is shown; Bilibili expires it after 180 seconds.
    let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => { timer = setTimeout(() => { void qrCheck().then(final => { if (!final && !stopped) poll(); }); },2000); };
    poll();
    return () => { stopped = true; clearTimeout(timer); };
  },[qr]);
  return <><section><h2>AI 模型 <small>全局一份 / OpenAI 兼容 Chat Completions</small></h2>
    <form onSubmit={event => { event.preventDefault(); void aiAction(false); }}>
      <div className="form-grid">
        <label>接口根地址<input type="url" autoComplete="off" maxLength={2048} disabled={aiSaving} value={aiBaseUrl} placeholder="https://api.deepseek.com 或 https://api.siliconflow.cn/v1" onChange={event => { setAiBaseUrl(event.target.value); setAiNotice(''); }} /></label>
        <label>模型名<input autoComplete="off" maxLength={200} disabled={aiSaving} value={aiModel} placeholder="由服务商提供的模型名，可自由填写" onChange={event => { setAiModel(event.target.value); setAiNotice(''); }} /></label>
        <label>API key（{state.settings.ai.apiKeyConfigured ? '已配置' : '未配置'}）<input type="password" autoComplete="new-password" maxLength={4096} disabled={aiSaving || clearApiKey} value={apiKey} placeholder="留空保留已保存的 key；填入新 key 可替换" onChange={event => { setApiKey(event.target.value); setAiNotice(''); }} /></label>
      </div>
      <label className="check"><input type="checkbox" disabled={aiSaving} checked={clearApiKey} onChange={event => { setClearApiKey(event.target.checked); setApiKey(''); setAiNotice(''); }} />清空已保存的 API key（保存后生效）</label>
      <p className="muted">地址和模型名可留空以清空。缺任一项时，AI 判断频道不能保存或启动；AI 关闭的频道不受影响。自动追加一次 /chat/completions，不强加 /v1；地址不允许账号密码、查询参数或片段。</p>
      <div className="actions"><button className="primary" disabled={busy || aiBusy}>保存模型配置</button><button type="button" disabled={busy || aiBusy || aiDirty} onClick={() => { void aiAction(true); }}>检查已保存配置的连接</button></div>
      <p className="muted">修改后请先保存再检查。检查只发送最短模型请求，结果仅显示在此处，不记录巡逻活动、不发送 B 站内容。key 仅存本机，不会从接口回显。</p>
      {aiNotice && <p role="status">{aiNotice}</p>}
    </form></section>
    <section><h2>账号 <small>单账号 / 本机私有存储</small></h2><div className="status-line"><span className={`dot ${state.settings.account.loggedIn ? 'running' : ''}`} /><strong>{state.settings.account.username || (state.settings.account.loggedIn ? '已登录' : '未登录')}</strong><span>{state.settings.account.message}</span></div>{renewalNote && <p className="muted">{renewalNote}</p>}<div className="actions"><button disabled={busy} onClick={() => { void mutate('/account/check','POST',undefined,'已检查登录状态').catch(() => {}); }}>检查登录状态</button><button disabled={busy} onClick={() => { void mutate('/account','DELETE',undefined,'已退出登录').then(() => { setCookie(''); setQr(''); }).catch(() => {}); }}>退出登录</button></div><form onSubmit={event => { event.preventDefault(); const value = cookie; const token = refreshToken; setCookie(''); setRefreshToken(''); void mutate('/account/cookie','POST',{ cookie: value, refreshToken: token },'已保存登录信息').catch(() => {}); }}><label>Cookie 登录<input type="password" autoComplete="off" value={cookie} onChange={e => setCookie(e.target.value)} placeholder="粘贴本账号的完整 Cookie，仅本机保存" required /></label><label>刷新令牌 ac_time_value（可选，用于自动续期）<input type="password" autoComplete="off" value={refreshToken} onChange={e => setRefreshToken(e.target.value)} placeholder="在该账号的 bilibili.com 页面控制台运行 localStorage.ac_time_value" /></label><p className="muted">需包含 SESSDATA、bili_jct、DedeUserID。不会显示或写入日志。重新登录会暂停巡逻。刷新令牌只填专用或无痕窗口里的登录；与日常浏览器共用时，任一方续期都会把另一方挤下线。</p><button disabled={busy} className="primary">保存并验证登录</button></form><div className="actions"><button disabled={busy || !!qr} onClick={() => { void qrStart(); }}>生成登录二维码</button></div>{qr && <img className="qr" src={qr} alt="Bilibili 登录二维码" />}<p className="muted" role="status">{qrStatus || '扫码后在手机上确认，状态会自动更新；不成功时可使用 Cookie 登录。'}</p></section><section><h2>全局限制 <small>与频道限制同时生效；失败尝试也计入额度</small></h2><form onSubmit={e => { e.preventDefault(); void mutate('/limits','PUT',limits,'已保存全局限制').catch(() => {}); }}><div className="form-grid">{limitFields.map(([key,label]) => <label key={key}>{label}<input type="number" min={key.startsWith('daily') ? 0 : 1} value={limits[key]} onChange={e => setLimits({ ...limits, [key]: Number(e.target.value) })} required /></label>)}</div><button className="primary" disabled={busy}>保存全局限制</button></form></section><section><h2>调度器</h2><p>{state.settings.running ? 'Running / 巡逻中' : `Paused / ${state.settings.pauseReason}`}</p><p className="muted">默认暂停；未登录不发评论；验证码或风控立即停止。重启后需要手动启动。</p>{!state.system.writesEnabled && <div className="warning">真实写操作已禁用。如本人确认要进行真实互动，请停止服务，在启动环境中显式设置 BILIBILI_WRITES_ENABLED=true 后重新启动；程序不会自动加载 .env。开发和自动化测试期间保持关闭。</div>}</section><section><h2>系统</h2><dl><dt>版本</dt><dd>{state.system.version}</dd><dt>Node</dt><dd>{state.system.node}</dd><dt>已运行</dt><dd>{state.system.uptime} 秒</dd><dt>持久化</dt><dd>SQLite / 本机单进程</dd></dl></section></>;
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(<App />);
