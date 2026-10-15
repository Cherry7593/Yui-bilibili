import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { defaultMinPlay, topicSchema, templateSchema, settingsSchema, aiSettingsSchema, activitySchema, recentCommentSchema, type TopicConfig, type Topic, type Template, type Limits, type Activity, type RecentComment } from '../server/model.js';
import './style.css';
const stateSchema = z.object({
  settings: settingsSchema,
  topics: z.array(topicSchema.and(z.object({ id: z.number(), nextSearch: z.number(), lastRun: z.number().nullable(), todayDiscovered: z.number(), todayInteractions: z.number() }))),
  templates: z.array(templateSchema.extend({ id: z.number() })),
  recentComments: z.array(recentCommentSchema), today: z.record(z.number()),
  system: z.object({ version: z.string(), node: z.string(), uptime: z.number(), writesEnabled: z.boolean(), queued: z.number() }),
});
type State = z.infer<typeof stateSchema>;
type Mutate = (path: string, method: string, body?: unknown) => Promise<void>;
const pages = { dashboard: '总览', topics: '巡逻频道', templates: '评论模板', activity: '活动记录', settings: '设置' };
type Page = keyof typeof pages;
const labels: Record<string,string> = { discover: '发现', search: '搜索', judge: 'AI 判断', comment: '评论', reply: '回复', skip: '跳过', error: '失败', queue: '排队' };
async function api(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const response = await fetch(`/api${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const data: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(data);
    throw new Error(error.success ? error.data.error : '请求失败');
  }
  return data;
}
function App() {
  const [page,setPage] = useState<Page>('dashboard');
  const [state,setState] = useState<State>();
  const [notice,setNotice] = useState('');
  const [dark,setDark] = useState(localStorage.getItem('theme') === 'dark');
  const [busy,setBusy] = useState(false);
  async function refresh() {
    try { setState(stateSchema.parse(await api('/state'))); }
    catch { setNotice('无法连接服务，请检查后端是否运行'); }
  }
  useEffect(() => { void refresh(); const timer = setInterval(() => { void refresh(); },5000); return () => clearInterval(timer); },[]);
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('theme',dark ? 'dark' : 'light'); },[dark]);
  useEffect(() => {
    const onNavigation = () => { const value = window.location.pathname.slice(1); setPage(value in pages ? value as Page : 'dashboard'); };
    onNavigation(); window.addEventListener('popstate',onNavigation); return () => window.removeEventListener('popstate',onNavigation);
  },[]);
  const mutate: Mutate = async (path,method,body) => {
    setBusy(true); setNotice('');
    try { await api(path,method,body); await refresh(); setNotice('已保存'); }
    catch (error) { setNotice(error instanceof Error ? error.message : '请求失败'); throw error; }
    finally { setBusy(false); }
  };
  return <div className="shell">
    <aside><a className="brand" href="/dashboard">Yui<span>bilibili patrol</span></a><div className="nav-label">工作空间</div><nav>{Object.entries(pages).map(([key,label],index) => <a key={key} href={`/${key}`} className={page === key ? 'selected' : ''} onClick={event => { event.preventDefault(); setPage(key as Page); history.pushState(null,'',`/${key}`); }}><span>0{index+1}</span>{label}</a>)}</nav><div className="sidebar-bottom"><span className={`dot ${state?.settings.running ? 'running' : ''}`} />{state?.settings.running ? '巡逻中' : '已暂停'}<button onClick={() => setDark(!dark)}>{dark ? '浅色模式' : '深色模式'}</button></div></aside>
    <main><header><div><div className="eyebrow">YUI / {page.toUpperCase()}</div><h1>{pages[page]}</h1></div>{state && <button disabled={busy} className={state.settings.running ? '' : 'primary'} onClick={() => { void mutate('/scheduler','POST',{ running: !state.settings.running }).catch(() => {}); }}>{state.settings.running ? '暂停巡逻' : '启动巡逻'}</button>}</header>
      {notice && <div className="notice" role="status">{notice}</div>}
      {!state ? <p>正在连接本机服务…</p> : <>
        {!state.settings.account.loggedIn && <div className="warning">{state.settings.account.message} · {state.settings.account.message === '登录状态待检查' ? '启动后会自动检查，稍候即可。' : '请到设置登录；未登录不会互动。'}</div>}
        {state.settings.account.loggedIn && state.settings.account.renewal?.status === 'failed' && <div className="warning">登录自动续期失败，当前登录仍可用，12 小时后重试；若持续失败请到设置重新扫码登录。</div>}
        {page === 'dashboard' && <Dashboard state={state} />}
        {page === 'topics' && <Topics state={state} mutate={mutate} busy={busy} />}
        {page === 'templates' && <Templates state={state} mutate={mutate} busy={busy} />}
        {page === 'activity' && <Activities />}
        {page === 'settings' && <Settings state={state} mutate={mutate} refresh={refresh} busy={busy} />}
      </>}
      <footer>Yui-bilibili · 低频巡逻，安全优先 · V1</footer>
    </main>
  </div>;
}
function Dashboard({ state }: { state: State }) {
  return <><section className="status-line"><span className={`dot ${state.settings.running ? 'running' : ''}`} /><strong>{state.settings.running ? 'Running / 巡逻中' : 'Paused / 已暂停'}</strong><span>{state.settings.pauseReason || '按照频道配置发现视频，等待后互动'}</span></section><h2>今天 <small>Asia/Shanghai</small></h2><div className="metrics">{['discover','comment','reply','skip','error'].map(action => <div key={action}><span>{labels[action]}</span><strong>{state.today[action] ?? 0}</strong></div>)}</div><section><h2>巡逻频道 <small>{state.topics.filter(t => t.enabled).length} 个启用 · {state.system.queued} 条待互动</small></h2>{!state.topics.length ? <p className="empty">还没有频道。添加关键词和至少两条不同的模板，再开启巡逻。</p> : state.topics.map(topic => <div className="list-row" key={topic.id}><strong>{topic.name}</strong><span>{topic.keywords.join(' / ')}</span><span className="tag">{topic.enabled ? '已启用' : '已暂停'}</span></div>)}</section><section><h2>最近评论 <small>仅含已确认发送成功的评论与回复</small></h2><RecentComments rows={state.recentComments} /></section></>;
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
    return <a key={row.id} className="comment-card" href={commentUrl(row)} target="_blank" rel="noreferrer">
      <div className="cover"><span>暂无封面</span>{row.cover && <img src={row.cover.includes('@') ? row.cover : `${row.cover}@320w_180h_1c`} alt="" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true; }} />}</div>
      <div className="comment-body">
        <strong>{row.title || row.bvid}</strong>
        <small>UP {row.author} · {row.bvid} · {row.topic}</small>
        <p className="comment-content">{row.action === 'reply' && <span className="tag">{row.target ? `回复 @${row.target}${row.targetLikes !== null ? ` · ${row.targetLikes} 赞` : ''}` : '回复'}</span>}{row.content}</p>
        <small className="comment-meta"><span>{stats.filter(([,value]) => value !== undefined).map(([label,value]) => `${label} ${compact.format(value ?? 0)}`).join(' · ')}（{row.statsAt === 'post' ? '发送时' : '发现时'}）</span><span>{new Date(row.time).toLocaleString('zh-CN')}</span><span className="jump">{row.rpid ? '定位到这条评论 ↗' : '打开视频 ↗'}</span></small>
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
  return <><div className="section-heading"><p>独立关键词、搜索节奏与互动规则，不绑定任何分区。</p><button onClick={() => edit()}>+ 新建频道</button></div><div className="topic-grid">{state.topics.map(topic => <article key={topic.id}><div className="section-heading"><h2>{topic.name}</h2><span className="tag">{topic.enabled ? '已启用' : '已暂停'}</span></div><p>{topic.keywords.join(' / ')}</p><div className="mini-stats">今日发现 {topic.todayDiscovered} · 互动尝试 {topic.todayInteractions}</div><p className="muted">最近运行：{topic.lastRun ? new Date(topic.lastRun).toLocaleString('zh-CN') : '尚未运行'}</p><div className="actions"><button onClick={() => edit(topic)}>编辑</button><button disabled={busy} onClick={() => { void mutate(`/topics/${topic.id}`,'PUT',{ ...topic, enabled: !topic.enabled }).catch(() => {}); }}>{topic.enabled ? '暂停频道' : '开启频道'}</button></div></article>)}</div>{draft && <section className="editor"><div className="section-heading"><h2>{draft.id ? '编辑频道' : '新建频道'}</h2><button onClick={() => setDraft(undefined)}>关闭</button></div><form onSubmit={event => { event.preventDefault(); void mutate(draft.id ? `/topics/${draft.id}` : '/topics',draft.id ? 'PUT' : 'POST',{ ...draft, keywords: keywords.split('\n').map(s => s.trim()).filter(Boolean) }).then(() => setDraft(undefined)).catch(() => {}); }}><label>名称<input required value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label><label>搜索关键词（每行一个）<textarea required value={keywords} onChange={e => setKeywords(e.target.value)} /></label><label className="check"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用这个频道</label>
    <label className="check"><input type="checkbox" checked={draft.aiJudgment} onChange={e => setDraft({ ...draft, aiJudgment: e.target.checked })} />AI 判断视频（默认关闭）</label>
    <div className="form-grid"><label>AI 互动方式<select disabled={!draft.aiJudgment} value={draft.aiInteraction} onChange={e => setDraft({ ...draft, aiInteraction: e.target.value === 'comment' ? 'comment' : 'reply' })}><option value="reply">回复高赞评论</option><option value="comment">评论视频</option></select></label><label>写法<select disabled={!draft.aiJudgment} value={draft.writingMode} onChange={e => setDraft({ ...draft, writingMode: e.target.value === 'ai' ? 'ai' : 'template' })}><option value="template">固定模板</option><option value="ai">AI 撰写</option></select></label><label>风格说明（可选）<input maxLength={300} disabled={!draft.aiJudgment || draft.writingMode !== 'ai'} value={draft.style} onChange={e => setDraft({ ...draft, style: e.target.value })} /></label></div>
    <p className="muted">{draft.aiJudgment ? <>模型只判断新视频值不值得互动；怎么互动由「AI 互动方式」决定，回复时没有达到点赞门槛的评论就跳过，不改为评论视频。跳过、拿不准或失败都不入队。发送前才抽模板或撰写，仍受限额与间隔约束。请先在<a href="/settings">设置页</a>填写接口根地址、模型名和 API key。</> : '关闭 AI 判断时按概率分流并使用固定模板；写法与风格说明不生效。'}</p>
    <p className="muted">按播放量排序，在发布时间窗内只取第一页最多 50 条。最低播放量留空使用 {defaultMinPlay}，填 0 表示不限；最高播放量留空不限。提高门槛会减少候选，每日额度不是保证互动量。</p>
    <div className="form-grid">{numberFields.map(([key,label]) => <label key={key}>{label}<input type="number" min={key.endsWith('Probability') || key.startsWith('daily') || key.endsWith('Play') || key === 'replyMinLikes' ? 0 : 1} step="1" value={typeof draft[key] === 'number' ? draft[key] : ''} onChange={e => setDraft({ ...draft, [key]: e.target.value === '' && key.endsWith('Play') ? null : Number(e.target.value) })} /></label>)}</div><p className="muted">三种概率之和必须为 100；AI 判断开启时不使用概率分流。回复只选点赞数不低于门槛的普通根评论，没有就跳过。搜索与互动等待使用随机范围。</p><div className="actions"><button className="primary" disabled={busy}>保存频道</button>{draft.id && <button type="button" className="danger" disabled={busy} onClick={() => { if (confirm('删除频道？历史视频去重记录将保留。')) void mutate(`/topics/${draft.id}`,'DELETE').then(() => setDraft(undefined)).catch(() => {}); }}>删除频道</button>}</div></form></section>}</>;
}
function Templates({ state,mutate,busy }: { state: State; mutate: Mutate; busy: boolean }) {
  const [draft,setDraft] = useState<Omit<Template,'id'> & { id?: number }>({ topicId: state.topics[0]?.id ?? 0, kind: 'comment', text: '', enabled: true });
  return <><p>模板直接绑定频道。评论与回复各自管理；连续相同内容会安全跳过。</p><section className="editor"><h2>{draft.id ? '编辑模板' : '添加模板'}</h2><form onSubmit={event => { event.preventDefault(); void mutate(draft.id ? `/templates/${draft.id}` : '/templates',draft.id ? 'PUT' : 'POST',draft).then(() => setDraft({ ...draft, id: undefined, text: '' })).catch(() => {}); }}><div className="form-grid"><label>所属频道<select required value={draft.topicId} onChange={e => setDraft({ ...draft, topicId: Number(e.target.value) })}><option value="0" disabled>请选择频道</option>{state.topics.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><label>类型<select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value === 'reply' ? 'reply' : 'comment' })}><option value="comment">视频评论模板</option><option value="reply">普通评论回复模板</option></select></label></div><label>内容<textarea required maxLength={300} value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} /></label><label className="check"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} />启用模板</label><button className="primary" disabled={busy || !state.topics.length}>保存模板</button></form></section><section>{state.templates.map(template => <div className="list-row template-row" key={template.id}><div><strong>{template.text}</strong><p className="muted">{state.topics.find(t => t.id === template.topicId)?.name} / {template.kind === 'comment' ? '视频评论' : '用户回复'} / {template.enabled ? '启用' : '禁用'}</p></div><div className="actions"><button onClick={() => setDraft(template)}>编辑</button><button disabled={busy} onClick={() => { void mutate(`/templates/${template.id}`,'PUT',{ ...template, enabled: !template.enabled }).catch(() => {}); }}>{template.enabled ? '禁用' : '启用'}</button><button className="danger" disabled={busy} onClick={() => { void mutate(`/templates/${template.id}`,'DELETE').catch(() => {}); }}>删除</button></div></div>)}</section></>;
}
function ActivityTable({ rows }: { rows: Activity[] }) {
  return !rows.length ? <p className="empty">暂无活动。默认不会自动巡逻。</p> : <div className="table-scroll"><table><thead><tr><th>时间 / 频道</th><th>关键词 / 视频 / UP 主</th><th>动作 / 内容 / 对象</th><th>结果</th></tr></thead><tbody>{rows.map((row,index) => <tr key={row.id ?? index}><td>{new Date(row.time).toLocaleString('zh-CN')}<small>{row.topic}</small></td><td>{row.bvid ? <a target="_blank" rel="noreferrer" href={`https://www.bilibili.com/video/${encodeURIComponent(row.bvid)}`}>{row.title || row.bvid}</a> : '—'}<small>{row.keyword} {row.author && `· UP ${row.author}`}</small></td><td><span className="tag">{labels[row.action] ?? row.action}</span><small>{row.content} {row.target && `→ @${row.target}${row.targetLikes !== undefined ? `（${row.targetLikes} 赞）` : ''}`}</small></td><td>{row.result}<small className="error">{row.error}</small></td></tr>)}</tbody></table></div>;
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
    <section><h2>账号 <small>单账号 / 本机私有存储</small></h2><div className="status-line"><span className={`dot ${state.settings.account.loggedIn ? 'running' : ''}`} /><strong>{state.settings.account.username || (state.settings.account.loggedIn ? '已登录' : '未登录')}</strong><span>{state.settings.account.message}</span></div>{renewalNote && <p className="muted">{renewalNote}</p>}<div className="actions"><button disabled={busy} onClick={() => { void mutate('/account/check','POST').catch(() => {}); }}>检查登录状态</button><button disabled={busy} onClick={() => { void mutate('/account','DELETE').then(() => { setCookie(''); setQr(''); }).catch(() => {}); }}>退出登录</button></div><form onSubmit={event => { event.preventDefault(); const value = cookie; const token = refreshToken; setCookie(''); setRefreshToken(''); void mutate('/account/cookie','POST',{ cookie: value, refreshToken: token }).catch(() => {}); }}><label>Cookie 登录<input type="password" autoComplete="off" value={cookie} onChange={e => setCookie(e.target.value)} placeholder="粘贴本账号的完整 Cookie，仅本机保存" required /></label><label>刷新令牌 ac_time_value（可选，用于自动续期）<input type="password" autoComplete="off" value={refreshToken} onChange={e => setRefreshToken(e.target.value)} placeholder="在该账号的 bilibili.com 页面控制台运行 localStorage.ac_time_value" /></label><p className="muted">需包含 SESSDATA、bili_jct、DedeUserID。不会显示或写入日志。重新登录会暂停巡逻。刷新令牌只填专用或无痕窗口里的登录；与日常浏览器共用时，任一方续期都会把另一方挤下线。</p><button disabled={busy} className="primary">保存并验证登录</button></form><div className="actions"><button disabled={busy || !!qr} onClick={() => { void qrStart(); }}>生成登录二维码</button></div>{qr && <img className="qr" src={qr} alt="Bilibili 登录二维码" />}<p className="muted" role="status">{qrStatus || '扫码后在手机上确认，状态会自动更新；不成功时可使用 Cookie 登录。'}</p></section><section><h2>全局限制 <small>与频道限制同时生效；失败尝试也计入额度</small></h2><form onSubmit={e => { e.preventDefault(); void mutate('/limits','PUT',limits).catch(() => {}); }}><div className="form-grid">{limitFields.map(([key,label]) => <label key={key}>{label}<input type="number" min={key.startsWith('daily') ? 0 : 1} value={limits[key]} onChange={e => setLimits({ ...limits, [key]: Number(e.target.value) })} required /></label>)}</div><button className="primary" disabled={busy}>保存全局限制</button></form></section><section><h2>调度器</h2><p>{state.settings.running ? 'Running / 巡逻中' : `Paused / ${state.settings.pauseReason}`}</p><p className="muted">默认暂停；未登录不发评论；验证码或风控立即停止。重启后需要手动启动。</p>{!state.system.writesEnabled && <div className="warning">真实写操作已禁用。如本人确认要进行真实互动，请停止服务，在启动环境中显式设置 BILIBILI_WRITES_ENABLED=true 后重新启动；程序不会自动加载 .env。开发和自动化测试期间保持关闭。</div>}</section><section><h2>系统</h2><dl><dt>版本</dt><dd>{state.system.version}</dd><dt>Node</dt><dd>{state.system.node}</dd><dt>已运行</dt><dd>{state.system.uptime} 秒</dd><dt>持久化</dt><dd>SQLite / 本机单进程</dd></dl></section></>;
}
const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
createRoot(root).render(<App />);
