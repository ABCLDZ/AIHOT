import { useEffect, useRef, useState } from 'react';
import { Link, useRevalidator } from 'react-router';
import type { Route } from './+types/index';
import type { AdminSources, AdminSourceDetail, AdminRadarRun } from '@aihot/contracts/admin';
import { SITE } from '@aihot/industry/site';
import { assessMaterial, groupMaterials, inTimeWindow, recommendationFamily, RADAR_RULES } from '@aihot/industry/radar-rules';
import { adminGet } from '../../lib/admin.server';
import { bj } from '../../features/admin/format';
import { HEALTH_LABEL } from '../../features/admin/labels';
import { AdminPage, Badge, Button, Card, Empty, Input, Stat, Textarea } from '../../features/admin/ui';
import { useAdminAction } from '../../features/admin/action';

const LANES = ['AI技术', '地缘经济', '公司商业', '真实体验'] as const;
const SCORE_NAMES = ['热度', '变化与读者价值', '定位', '证据', '当天完成成本'] as const;
const STORAGE = 'wechat-radar-reviews-v1';
const FOREIGN_SOURCES = new Set(['media-ap', 'media-ft', 'media-guardian', 'media-bloomberg', 'media-techcrunch']);
function chineseTitle(item: { title_translation: string | null; title_zh: string | null }): string {
  const translated = item.title_translation ?? item.title_zh;
  return translated && /[\u3400-\u9fff]/.test(translated) ? translated+'（已有译文，待当前助手复核）' : '待当前助手提供中文说明';
}
type Review = { state: 'pending' | 'keep' | 'skip'; lane: string; angle: string; value: string; evidence: string; scores: Array<number | null>; heatException: boolean; heatBasis?: string; dimensions?: string[]; answer?: string; delta?: string; boundary?: string; interests?: string; checkedEvidence?: string };
const DIMENSIONS=['技术','资本','产业链','国家能力'];
const blank = (): Review => ({ state: 'pending', lane: '', angle: '', value: '', evidence: '', scores: [null, null, null, null, null], heatException: false,heatBasis:'',dimensions:[],answer:'',delta:'',boundary:'',interests:'',checkedEvidence:'' });
function validReview(value: unknown): value is Review {
  if (!value || typeof value !== 'object') return false;
  const r = value as Review;
  return ['pending', 'keep', 'skip'].includes(r.state) && ['', ...LANES].includes(r.lane) && [r.angle, r.value, r.evidence].every(s => typeof s === 'string') && [r.heatBasis,r.answer,r.delta,r.boundary,r.interests,r.checkedEvidence].every(s => s===undefined || typeof s==='string') && (r.dimensions===undefined || (Array.isArray(r.dimensions) && r.dimensions.every(d => DIMENSIONS.includes(d)))) && typeof r.heatException === 'boolean' && Array.isArray(r.scores) && r.scores.length === 5 && r.scores.every(s => s === null || (Number.isInteger(s) && s >= 0 && s <= 5));
}
export async function loader({ request }: Route.LoaderArgs) {
  const sources = await adminGet<AdminSources>(request, '/api/admin/sources');
  const {run:lastRun}=await adminGet<{run:AdminRadarRun|null}>(request,'/api/admin/radar/update');
  sources.rows = sources.rows.filter(source => source.id.startsWith('media-'));
  sources.totals = { total: sources.rows.length, enabled: sources.rows.filter(s => s.enabled).length, failing: sources.rows.filter(s => s.health === 'failing').length, degraded: sources.rows.filter(s => s.health === 'degraded').length };
  // Raw materials stay behind the admin session; reads are bounded to one source page.
  const details = await Promise.all(sources.rows.map(source => adminGet<AdminSourceDetail>(request, `/api/admin/sources/${encodeURIComponent(source.id)}`)));
  const unique = new Map(details.flatMap(d => d.items.map(item => [item.id, { ...item, sourceId: d.source.id, sourceName: d.source.name, firstParty: d.source.first_party }] as const)));
  const items = [...unique.values()].sort((a, b) => Date.parse(b.published_at ?? b.discovered_at) - Date.parse(a.published_at ?? a.discovered_at));
  return { sources, items, lastRun, checkedAt: new Date().toISOString() };
}
export const meta: Route.MetaFunction = () => [{ title: `公众号选题工作台 · ${SITE.name}` }, { name: 'robots', content: 'noindex, nofollow' }];
export const headers: Route.HeadersFunction = () => ({ 'Cache-Control': 'no-store' });

export default function Workbench({ loaderData }: Route.ComponentProps) {
  const { sources, items, checkedAt, lastRun } = loaderData;
  const refresh = useRevalidator();
  const command=useAdminAction();
  const [updateRun,setUpdateRun]=useState(lastRun);
  const [progressError,setProgressError]=useState('');
  const updating=updateRun?.state==='pending' || updateRun?.state==='running';
  useEffect(() => { setUpdateRun(lastRun); },[lastRun]);
  useEffect(() => {
    if (!updating) return;
    let gone=false;
    let timer: ReturnType<typeof setTimeout>;
    const controller=new AbortController();
    async function poll() {
      try {
        const response=await fetch('/api/admin/radar/update',{credentials:'same-origin',signal:controller.signal});
        if (!response.ok) throw new Error('progress unavailable');
        const data=await response.json() as {run:AdminRadarRun|null};
        if (gone) return;
        setProgressError('');setUpdateRun(data.run);
        if (data.run && data.run.state!=='pending' && data.run.state!=='running') { refresh.revalidate();return; }
      } catch { if (gone) return;setProgressError('暂时无法读取进度，任务可能仍在运行；请稍后刷新列表。'); }
      if (!gone) timer=setTimeout(poll,3000);
    }
    timer=setTimeout(poll,1000);
    return () => {gone=true;clearTimeout(timer);controller.abort();};
  },[updating,updateRun?.id]);
  async function updateRadar() {
    const result=await command.run<{run:AdminRadarRun}>('POST','/api/admin/radar/update',{}, {label:'radar-update',revalidate:false});
    if (result) {setUpdateRun(result.run);setProgressError('');if (!['pending','running'].includes(result.run.state)) refresh.revalidate();}
  }
  const [reviews, setReviews] = useState<Record<string, Review>>({});
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState('');
  const backupInput=useRef<HTMLInputElement>(null);
  const [backupMessage,setBackupMessage]=useState('');
  const [search, setSearch] = useState('');
  const [lane, setLane] = useState('全部');
  const [view, setView] = useState<'all' | 'keep' | 'pending' | 'skip'>('all');
  const [screen, setScreen] = useState<'screen' | 'all' | 'noise'>('screen');
  const [hours, setHours] = useState<48 | 168 | 0>(48);
  const [activeId, setActiveId] = useState(items[0]?.id ?? '');
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid record');
        setReviews(Object.fromEntries(Object.entries(parsed).filter(([id, r]) => /^[a-zA-Z0-9_-]+$/.test(id) && validReview(r))));
      }
    } catch { setStorageError('无法读取本地标记，本次操作暂不能保证保存。'); }
    setReady(true);
  }, []);
  function update(id: string, patch: Partial<Review>) {
    if (!ready) return;
    const next = { ...reviews, [id]: { ...(reviews[id] ?? blank()), ...patch } };
    setReviews(next);
    try { localStorage.setItem(STORAGE, JSON.stringify(next)); setStorageError(''); }
    catch { setStorageError('浏览器保存失败；当前修改仅在此页面，离开前请导出候选。'); }
  }
  function choose(id: string) {
    setActiveId(id);
    if (window.matchMedia('(max-width: 1279px)').matches) requestAnimationFrame(() => {
      const panel = document.getElementById('radar-evaluation');
      panel?.focus({ preventScroll: true }); panel?.scrollIntoView({ block: 'start' });
    });
  }
  const marked = items.filter(item => reviews[item.id]?.state === 'keep');
  const active = items.find(item => item.id === activeId);
  const review = active ? reviews[active.id] ?? blank() : blank();
  const assessments = new Map(items.map(item => [item.id,assessMaterial(item,Date.parse(checkedAt))] as const));
  const activeAssessment = active ? assessments.get(active.id)! : null;
  const allGroups = groupMaterials(items);
  const resolvedFamilies = new Set(items.filter(item => reviews[item.id] && reviews[item.id]!.state !== 'pending').map(recommendationFamily));
  const orderedRecommendations = allGroups.filter(g => {
    const a = assessments.get(g.items[0]!.id)!;
    return !resolvedFamilies.has(recommendationFamily(g.items[0]!)) && a.status === 'lead' && (a.freshness === 'recent' || (hours === 168 && a.freshness === 'extended'));
  }).sort((a, b) => {
    const left = assessments.get(a.items[0]!.id)!;
    const right = assessments.get(b.items[0]!.id)!;
    const focus = (item: typeof items[number]) => Number(RADAR_RULES.priority.test(item.title));
    return focus(b.items[0]!) - focus(a.items[0]!) || Number(left.uncertainty) - Number(right.uncertainty);
  });
  const recommendationFamilies = new Map<string, typeof allGroups[number]>();
  for (const g of orderedRecommendations) {
    const family = recommendationFamily(g.items[0]!);
    const previous = recommendationFamilies.get(family);
    if (previous) previous.items.push(...g.items);
    else recommendationFamilies.set(family, { key: g.key, items: [...g.items] });
  }
  const recommended = [...recommendationFamilies.values()].slice(0, RADAR_RULES.dailyLimit);
  const noiseCount = items.filter(i => assessments.get(i.id)!.status === 'noise').length;
  const visible = items.filter(item => {
    const r = reviews[item.id] ?? blank();
    const a = assessments.get(item.id)!;
    return (screen === 'all' || (screen === 'noise' ? a.status === 'noise' : a.status !== 'noise' && inTimeWindow(a, hours))) && (view === 'all' || r.state === view) && (lane === '全部' || (r.lane || a.lane) === lane) && `${item.title} ${item.title_zh ?? ''} ${item.title_translation ?? ''} ${item.sourceName} ${r.angle}`.toLowerCase().includes(search.trim().toLowerCase());
  });
  const displayed = screen === 'all' ? visible.map(item => ({ key: item.id, items: [item] })) : groupMaterials(visible);
  const complete = review.scores.every(n => n !== null);
  const total = review.scores.reduce<number>((sum, n) => sum + (n ?? 0), 0);
  const scorePass = complete && total >= 18 && !!review.lane && new Set(review.dimensions ?? []).size>=2 && (review.scores[1] ?? 0) >= 4 && (review.scores[3] ?? 0) >= 4 && ((review.scores[0] ?? 0) >= 4 || ((review.scores[0] ?? 0) === 3 && review.heatException && !!review.heatBasis?.trim()));
  function downloadText(name: string,text: string,type: string) {
    const url=URL.createObjectURL(new Blob([text],{type}));
    const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  function exportBackup() { downloadText('公众号人工记录备份.json',JSON.stringify({schemaVersion:2,exportedAt:new Date().toISOString(),reviews},null,2),'application/json'); }
  async function importBackup(file: File) {
    try {
      if (file.size>2_000_000) throw new Error('文件过大');
      const data=JSON.parse(await file.text());
      if (data.schemaVersion!==2 || !data.reviews || typeof data.reviews!=='object' || Array.isArray(data.reviews)) throw new Error('备份格式不符');
      const entries=Object.entries(data.reviews);
      if (!entries.every(([id,r]) => /^[a-zA-Z0-9_-]{1,100}$/.test(id) && validReview(r))) throw new Error('备份记录无效');
      const next={...Object.fromEntries(entries) as Record<string,Review>,...reviews};
      localStorage.setItem(STORAGE,JSON.stringify(next));setReviews(next);setBackupMessage(`已导入${entries.length}条记录，已有人工记录优先保留。`);
    } catch {setBackupMessage('导入失败：请选择有效的人工记录JSON备份，现有记录未改变。');}
  }
  function exportCandidates() {
    const text = ['# 公众号候选选题', `导出时间：${bj(new Date().toISOString(), true)} · 北京时间`, `更新批次：${updateRun?.id ?? '尚未运行'}`, `筛选窗口：${hours || '不限'}${hours ? '小时' : ''}`, `公众号重复检查：须由当前助手完成；工具读取参考ID不代表已查重`, `上下文读取时间：${updateRun?.detail.context?.readAt ?? '未读取'} · 版本：${updateRun?.detail.context?.hash ?? '无'}`, ...(updateRun?.detail.context?.files ?? []).map(f => `- 上下文文件：${f.path} · SHA256：${f.hash}`), '仅为媒体线索草稿，未阅读全文或核验一手证据，不代表可写或已选定。', '', ...marked.flatMap(item => {
      const r = reviews[item.id]!;
      const a = assessments.get(item.id)!;
      const related = allGroups.find(g => g.items.some(i => i.id === item.id))?.items.filter(i => i.id !== item.id) ?? [];
      const model=item.model_assessment;
      const eventId=allGroups.find(g => g.items.some(i => i.id===item.id))?.key ?? item.id;
      return [`## ${item.title}`, ...(FOREIGN_SOURCES.has(item.sourceId) ? [`中文：${chineseTitle(item)}`] : []), `- article_id：${item.id} · 内容版本：${item.revision}`, `- 疑似事件标识：${eventId}（归组可能变化；人工记录绑定article_id）`, `- 主线：${r.lane || '待归类'}`, `- 分析维度：${r.dimensions?.join('、') || '待填写'}`, `- 来源：${item.sourceName}`, `- 原文：${item.url}`, `- 发布时间：${item.published_at ? bj(item.published_at, true) : '未提供，需核验'}`, `- 首次收录：${bj(item.discovered_at,true)}`, `- 事件日期：未知，待当前助手核对`, `- 输入范围：原标题与RSS摘要（已有时）；未阅读全文或核验一手证据`, `- RSS摘要：${item.excerpt || '未提供'}`, `- 标题规则提示：${a.reason}`, `- 当前助手重复检查：未记录，须在公众号工作区对照母稿`, ...(model ? [`- 历史模型记录（停用，仅回查）：${JSON.stringify({meta:item.model_meta,assessment:model})}`] : []), `- 热度3分例外依据：${r.heatBasis || '待补；媒体数量不等于公众热度'}`, ...related.map(i => `- 疑似同一事件报道：${i.id} · ${i.sourceName} · ${i.title_translation ?? i.title} · ${i.url}`), `- 选题切口：${r.angle || '待补'}`, `- 读者价值：${r.value || '待补'}`, `- 待补证据：${r.evidence || a.evidence}`, `- 人工独立答案：${r.answer || '待判断'}`, `- 人工差异与增量：${r.delta || '待判断'}`, `- 受益/付费/风险：${r.interests || '待判断'}`, `- 人工边界：${r.boundary || '待判断'}`, `- 已核一手链接：${r.checkedEvidence || '未核验'}`, `- 人工评分：${SCORE_NAMES.map((name, i) => `${name} ${r.scores[i] ?? '未评'}`).join(' / ')}`, ''];
    })].join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `公众号候选-${new Date().toISOString().slice(0, 10)}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <AdminPage title="公众号选题工作台" subtitle="按需采集原报道，交给当前公众号助手阅读、中文说明与查重。" actions={<><Button tone="primary" disabled={updating || command.pending!==null} onClick={updateRadar}>{updating ? '正在采集…' : '采集新素材'}</Button><Button disabled={refresh.state !== 'idle'} onClick={() => refresh.revalidate()}>{refresh.state === 'idle' ? '刷新列表' : '正在刷新…'}</Button><Button disabled={!marked.length || !ready} onClick={exportCandidates}>导出候选 {marked.length ? `(${marked.length})` : ''}</Button></>}>
    <section aria-label="更新状态" aria-live="polite" className="mb-5 rounded-panel border border-line bg-surface p-4 text-xs leading-6 text-ink-3">
      <p className="font-semibold text-ink">{updateRun?.detail.mode==='collect_only' ? updateRun.stage : '当前仅采集入口尚无新批次；旧更新结果仅供回查'}</p>
      <p>采集新素材只抓取已启用信源并去重入库；不调用外部模型或自动翻译。刷新列表只读取已保存结果。</p>
      {updateRun && <><p>开始：{bj(updateRun.started_at,true)}{updateRun.finished_at ? ` · 结束：${bj(updateRun.finished_at,true)}` : ''} · 新增 {updateRun.detail.sources?.reduce((n,s) => n+s.created,0) ?? 0} 篇 · {updateRun.detail.mode==='collect_only' ? '仅采集批次' : '历史混合批次（已停用）'}</p><p>近期重复：{updateRun.detail.context?.status==='loaded' ? `已读取参考ID ${updateRun.detail.context.recentIds.join('、')}，尚待当前助手对照母稿` : '近期重复未检查，等待读取公众号工作区'}</p>{updateRun.error && <p role="alert" className="text-hot">{updateRun.error}</p>}<details><summary className="cursor-pointer">各信源与失败详情</summary>{updateRun.detail.sources?.map(s => <p key={s.sourceId}>{s.name}：{s.status==='ok' ? `成功，新增${s.created}、修订${s.revised}` : s.error ?? s.status}</p>)}{sources.rows.filter(s => !s.enabled).map(s => <p key={s.id}>{s.name}：暂停 · {s.last_error ?? '未启用'}</p>)}{updateRun.detail.modelErrors?.map(e => <p key={e.articleId}>{e.articleId}：{e.error}</p>)}</details></>}
      {progressError && <p role="alert" className="text-hot">{progressError}</p>}
      <div className="mt-2 flex flex-wrap gap-2"><Button size="sm" disabled={!ready} onClick={exportBackup}>备份人工记录</Button><Button size="sm" disabled={!ready} onClick={() => backupInput.current?.click()}>恢复人工记录</Button><input ref={backupInput} type="file" accept="application/json,.json" className="hidden" aria-label="人工记录备份文件" onChange={e => {const file=e.target.files?.[0];if(file) void importBackup(file);e.target.value='';}} /></div><p>{backupMessage || '人工记录仅保存在当前浏览器，可备份恢复；采集不会覆盖它们。'}</p>
    </section>
    <section className="mb-6 rounded-sheet border border-accent/20 bg-accent-soft p-5 sm:p-7">
      <div className="flex flex-wrap items-center justify-between gap-3"><span className="text-[11px] font-semibold tracking-[0.16em] text-accent">EDITOR'S FOCUS / 当前重心</span><span className="text-xs text-ink-3">数据读取于 {bj(checkedAt)}</span></div>
      <h2 className="mt-3 text-xl font-semibold leading-normal tracking-tight text-ink sm:text-[27px]">中国产业能力，在全球市场中的位置怎样变化？</h2>
      <p className="mt-3 max-w-3xl text-sm leading-7 text-ink-3">优先看海外需求、采购与产地调整，以及产业规则改变了谁的订单、成本和选择。技术进入真实工作、公司经营与日常体验，也可以独立成为好选题。</p>
      <div className="mt-5 flex flex-wrap gap-2">{['技术', '资本', '产业链', '国家能力'].map(text => <span key={text} className="rounded-full border border-accent/20 px-3 py-1 text-xs text-accent">{text}</span>)}<span className="self-center text-xs text-ink-3">可写前至少命中两个分析维度</span></div>
    </section>
    <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Stat label="最近收录的材料" value={items.length} hint="来自当前信源页；含历史回填" />
      <Stat label="建议先看" value={recommended.length} hint="仅原标题规则提示，待助手阅读" />
      <Stat label="我的候选" value={ready ? marked.length : '—'} hint={marked.length > 5 ? '建议聚焦到 3–5 个' : '最多5个，不足不凑数'} />
      <Stat label="启用的信源" value={`${sources.totals.enabled} / ${sources.totals.total}`} hint={sources.rows.some(s => !s.enabled) ? `${sources.rows.filter(s => !s.enabled).length} 个暂不可采集，见信源状态` : '来源与抓取记录可回查'} />
    </div>
    {storageError && <p role="alert" className="mb-4 rounded-control bg-amber-soft p-3 text-sm text-amber-ink">{storageError}</p>}
    <section aria-label="规则推荐" className="mb-5 rounded-panel border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold text-ink">建议先看 · 最多 5 个事件</h2><span className="text-xs text-ink-3">热度待判断 · 一手证据待核</span></div>
      <p className="mt-2 text-xs leading-6 text-ink-3">按具体变化、主线和原文日期初筛。只用原标题规则提供浏览提示；历史模型结果不参与本轮推荐或归组。当前助手须阅读材料、中文说明并对照母稿，页面提示不代表完成初筛或核验。可为0—5个，不凑数。</p>
      <div className="mt-3 space-y-2">{recommended.map((g, i) => { const item = g.items[0]!; return <div key={g.key}><button onClick={() => choose(item.id)} className="block w-full text-left text-sm leading-6 text-ink hover:text-accent"><span className="mr-2 text-accent">{i + 1}.</span>{item.title_translation ?? item.title}<span className="ml-2 text-xs text-ink-3">{assessments.get(item.id)!.lane}{g.items.length > 1 ? ` · ${g.items.length} 篇相关报道` : ''}</span></button>{g.items.length > 1 && <details className="ml-5 mt-1 text-xs leading-6 text-ink-3"><summary className="cursor-pointer">展开相关报道与进展</summary><p>相关进展不一定是同一次发生，动作和阶段分别核对。</p>{g.items.map(other => <button key={other.id} onClick={() => choose(other.id)} className="block text-left hover:text-accent">{other.sourceName} · {other.title_translation ?? other.title}</button>)}</details>}</div>; })}</div>
      {!recommended.length && <p className="mt-3 text-xs text-ink-3">当前没有满足日期和具体变化条件的推荐；可以查看待补材料或放宽到 7 天。</p>}
    </section>
    <div className="mb-4 flex flex-wrap items-center gap-2">{([['screen', '规则初筛'], ['all', '全部材料'], ['noise', `已滤噪声 (${noiseCount})`]] as const).map(([key, name]) => <Button key={key} tone={screen === key ? 'primary' : undefined} aria-pressed={screen === key} onClick={() => setScreen(key)}>{name}</Button>)}<select aria-label="原文时间范围" value={hours} onChange={e => setHours(Number(e.target.value) as 48 | 168 | 0)} className="h-10 rounded-control border border-line bg-surface px-3 text-sm text-ink"><option value={48}>最近 48 小时</option><option value={168}>最近 7 天</option><option value={0}>不限日期</option></select><span className="text-xs text-ink-3">全部材料保留旧闻及噪声；日期不明需核验</span></div>
    <div className="mb-5 flex flex-wrap gap-2" aria-label="选题主线筛选">{['全部', ...LANES].map(text => <button key={text} onClick={() => setLane(text)} aria-pressed={lane === text} className={`rounded-full border px-4 py-2 text-sm transition-colors ${lane === text ? 'border-accent bg-accent text-white' : 'border-line bg-surface text-ink-3 hover:border-accent'}`}>{text}</button>)}<span className="self-center text-xs text-ink-4">未手动归类时，按标题建议主线筛选</span></div>
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_350px]">
      <section id="radar-materials" className="min-w-0 scroll-mt-28">
        <div className="mb-3 flex flex-wrap items-center gap-2"><div className="min-w-[160px] flex-1"><Input aria-label="搜索材料" placeholder="搜索标题、信源或选题切口" value={search} onChange={e => setSearch(e.target.value)} /></div><select aria-label="材料状态筛选" value={view} onChange={e => { setView(e.target.value as typeof view); if (e.target.value === 'keep' || e.target.value === 'skip') setScreen('all'); }} className="h-10 rounded-control border border-line bg-surface px-3 text-sm text-ink"><option value="all">全部材料</option><option value="pending">待判断</option><option value="keep">我的候选</option><option value="skip">暂不采用</option></select></div>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-3"><span>{displayed.length} 张卡片 · {visible.length} 篇报道 · 按原文时间排序</span><span>原文日期缺失时按收录时间</span></div>
        <div className="space-y-3">{displayed.map((group, i) => {
          const item = group.items[0]!;
          const a = assessments.get(item.id)!;
          const r = reviews[item.id] ?? blank();
          return <article key={item.id} className={`rounded-panel border bg-surface p-4 sm:p-5 ${activeId === item.id ? 'border-accent shadow-sm' : 'border-line'}`}>
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3"><span className="num text-ink-4">{String(i + 1).padStart(2, '0')}</span><span>{item.sourceName}</span>{item.firstParty && <Badge>一手来源</Badge>}{r.lane && <Badge>{r.lane}</Badge>}<span className="ml-auto">{item.published_at ? bj(item.published_at) : '原文日期待核验'}</span></div>
            <h3 className="mt-3"><button onClick={() => choose(item.id)} className="text-left text-[16px] font-semibold leading-7 text-ink hover:text-accent">{item.title}</button></h3>
            {FOREIGN_SOURCES.has(item.sourceId) && <p className="mt-2 text-sm leading-7 text-ink-3">中文：{chineseTitle(item)}</p>}
            <p className="mt-2 text-xs leading-6 text-ink-3">{'原标题规则提示'}：{a.reason}{a.lane && !r.lane ? ` · 建议主线：${a.lane}` : ''}{a.freshness === 'unknown' ? ' · 日期待核' : a.freshness === 'future' ? ' · 日期异常' : a.freshness === 'old' ? ' · 超过7天' : ''}{a.uncertainty ? ' · 预测或计划，阶段待核' : ''}</p>
            {item.model_assessment && <details className="mt-2 text-xs leading-6 text-ink-3"><summary>历史模型记录（停用，仅供回查）</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify({meta:item.model_meta,assessment:item.model_assessment},null,2)}</pre></details>}
            {group.items.length > 1 && <details className="mt-3 text-xs leading-6 text-ink-3"><summary className="cursor-pointer text-accent">{group.items.length} 篇疑似同一事件报道 · 展开核对</summary><p>按事件要素保守匹配，数字和阶段仍须读原文核对。</p>{group.items.map(other => <div key={other.id} className="mt-2"><a href={other.url} target="_blank" rel="noopener noreferrer" className="hover:text-accent">{other.sourceName} · {other.title_translation ?? other.title} ↗</a><button onClick={() => choose(other.id)} className="ml-3 text-accent">评估这篇{reviews[other.id]?.state === 'keep' ? '（已候选）' : ''}</button></div>)}</details>}
            {r.angle && <p className="mt-2 text-sm leading-6 text-ink-3">切口：{r.angle}</p>}
            <div className="mt-4 flex flex-wrap items-center gap-3"><Badge tone={r.state === 'keep' ? 'accent' : 'muted'}>{r.state === 'keep' ? '已留作候选' : r.state === 'skip' ? '暂不采用' : '待判断'}</Badge><span className="text-xs text-ink-4">{item.visibility !== null ? '已有整理结果' : '原始材料 · 尚未整理'}</span><button onClick={() => choose(item.id)} className="ml-auto text-xs font-medium text-accent">评估选题 →</button><a href={item.url} target="_blank" rel="noopener noreferrer" className="text-xs text-ink-3 hover:text-accent">看原文 ↗</a></div>
          </article>;
        })}</div>
        {!visible.length && <Empty>{items.length ? '没有符合筛选条件的材料。试试全部主线或其他关键词。' : '还没有收录材料，先到信源管理检查来源和抓取记录。'}</Empty>}
      </section>
      <aside id="radar-evaluation" tabIndex={-1} aria-label="选题判断面板" className="scroll-mt-28 space-y-4 xl:sticky xl:top-5">
        <Card title="选题判断" right={<span className="text-xs">人工填写</span>}>
          <a href="#radar-materials" className="mb-4 block text-xs text-accent xl:hidden">↑ 返回材料列表</a>
          {active ? <div key={active.id} className="space-y-4">
            <h3 className="text-sm font-semibold leading-6 text-ink">{active.title}</h3>
            {FOREIGN_SOURCES.has(active.sourceId) && <p className="text-sm leading-6 text-ink-3">中文：{chineseTitle(active)}</p>}
            {activeAssessment && <div className="rounded-control bg-bg-sunk p-3 text-xs leading-6 text-ink-3"><h4 className="font-semibold text-ink">初筛提示 · {'仅原标题规则'}</h4><p>{activeAssessment.reason}</p><p>建议切口：{activeAssessment.angle}</p><p>读者价值：{activeAssessment.value}</p><p>待核证据：{activeAssessment.evidence}</p><p className="mt-2">热度待判断；未阅读全文、未核验一手证据。{activeAssessment.uncertainty ? '预测、提案或计划不能写成已落地。' : ''}</p><Button disabled={!ready} onClick={() => update(active.id, { lane: review.lane || activeAssessment.lane, angle: review.angle || activeAssessment.angle, value: review.value || activeAssessment.value, evidence: review.evidence || activeAssessment.evidence })}>填入尚未填写的提示</Button></div>}
            <label className="block text-xs text-ink-3">主线标签<select aria-label="主线标签" disabled={!ready} value={review.lane} onChange={e => update(active.id, { lane: e.target.value })} className="mt-2 h-10 w-full rounded-control border border-line bg-surface px-3 text-sm text-ink"><option value="">待归类</option>{LANES.map(text => <option key={text}>{text}</option>)}</select></label>
            <fieldset className="text-xs text-ink-3"><legend>分析维度 · 至少两个</legend><div className="mt-2 flex flex-wrap gap-3">{DIMENSIONS.map(d => <label key={d}><input type="checkbox" aria-label={`${d}维度`} disabled={!ready} checked={review.dimensions?.includes(d) ?? false} onChange={e => update(active.id,{dimensions:e.target.checked ? [...(review.dimensions ?? []),d] : (review.dimensions ?? []).filter(v => v!==d)})} /> {d}</label>)}</div></fieldset>
            {([['angle', '选题切口', '谁做了什么？近期具体改变了什么？'], ['value', '读者价值', '读者看完能解释什么？'], ['evidence', '待补证据', '还缺哪份公告、数据或实际案例？']] as const).map(([field, label, placeholder]) => <label key={field} className="block text-xs text-ink-3">{label}<Textarea aria-label={label} disabled={!ready} rows={2} className="mt-2" value={review[field]} placeholder={placeholder} onChange={e => update(active.id, { [field]: e.target.value })} /></label>)}
            <div className="border-t border-line pt-4"><div className="mb-3 flex items-center justify-between"><h4 className="text-sm font-semibold text-ink">选题评分</h4><span className="text-xs text-ink-3">{complete ? `${total} / 25` : '未评完 / 25'}</span></div>
              <div className="space-y-2">{SCORE_NAMES.map((name, i) => <label key={name} className="flex items-center justify-between gap-2 text-xs text-ink-3">{name}<select aria-label={`${name}评分`} disabled={!ready} value={review.scores[i] ?? ''} onChange={e => { const scores = [...review.scores]; scores[i] = e.target.value === '' ? null : Number(e.target.value); update(active.id, { scores }); }} className="h-8 rounded-control border border-line bg-surface px-2 text-sm text-ink"><option value="">未评</option>{[0, 1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n} 分</option>)}</select></label>)}</div>
              <label className="mt-3 flex items-start gap-2 text-xs leading-5 text-ink-3"><input aria-label="热度3分例外" type="checkbox" className="mt-1 accent-[var(--accent)]" disabled={!ready} checked={review.heatException} onChange={e => update(active.id, { heatException: e.target.checked })} />热度3分时，同时有近期一手动作、熟悉产品场景和可感知后果，已记录依据。</label>
              {(review.scores[0]===3 || review.heatException) && <label className="mt-2 block text-xs text-ink-3">热度例外依据<Textarea aria-label="热度例外依据" disabled={!ready} rows={2} value={review.heatBasis ?? ''} onChange={e => update(active.id,{heatBasis:e.target.value})} placeholder="一手动作及链接、熟悉场景、可感知后果；三项都要有" /></label>}
              <p className={`mt-3 rounded-control p-3 text-xs leading-6 ${scorePass ? 'bg-accent-soft text-accent' : 'bg-bg-sunk text-ink-3'}`}>{!complete ? '总分 ≥18，变化和证据各 ≥4，热度 ≥4（或满足3分例外）；一个主线、至少两个分析维度。' : scorePass ? '分数达到初步门槛。还需核对原文证据与近期重复题，再决定是否可写。' : '尚未达到选题分数门槛或定位条件，检查分项、两个维度和热度例外依据。'}</p>
            </div>
            <details className="text-xs text-ink-3"><summary className="cursor-pointer">人工答案、差异与核验记录</summary><div className="mt-3 space-y-3">{([['answer','独立答案'],['delta','与旧稿的差异与增量'],['boundary','结论边界'],['interests','谁受益、谁付费、谁承担风险'],['checkedEvidence','已核一手链接']] as const).map(([field,label]) => <label key={field} className="block">{label}<Textarea aria-label={label} rows={2} disabled={!ready} value={review[field] ?? ''} onChange={e => update(active.id,{[field]:e.target.value})} /></label>)}</div></details>
            <div className="flex flex-wrap gap-2"><Button tone="primary" disabled={!ready} onClick={() => update(active.id, { state: 'keep' })}>留作候选</Button><Button disabled={!ready} onClick={() => update(active.id, { state: 'skip' })}>暂不采用</Button>{review.state !== 'pending' && <Button disabled={!ready} onClick={() => update(active.id, { state: 'pending' })}>恢复待判断</Button>}</div>
            <Link className="block text-xs text-accent" to={`/admin/content/${active.id}`}>查看材料与处理记录 ↗</Link>
            <p className="text-[11px] leading-5 text-ink-4">标记和笔记保存在当前浏览器。导出后再交给文章工作流；选题与发布由你确认。</p>
          </div> : <Empty>选中一条材料开始判断。</Empty>}
        </Card>
        <Card title="信源状态" right={<Link to="/admin/sources" className="text-accent">管理 ↗</Link>}><div className="space-y-3">{sources.rows.map(source => <div key={source.id}><Link to={`/admin/sources/${source.id}`} className="flex items-start justify-between gap-2 text-xs"><span className="text-ink-3">{source.name}</span><span className={`shrink-0 ${!source.enabled ? 'text-hot' : source.fail_count ? 'text-hot' : 'text-accent'}`}>{!source.enabled ? '暂不可采集' : HEALTH_LABEL[source.health] ?? '启用'}</span></Link>{!source.enabled && source.last_error && <p className="mt-1 text-[11px] leading-5 text-ink-4">{source.last_error}</p>}</div>)}</div></Card>
        <p className="px-1 text-xs leading-6 text-ink-4">今日候选还要与最近 10 篇主题、最近 3–5 篇核心答案和标题比对，避免重复解释同一个问题。</p>
      </aside>
    </div>
  </AdminPage>;
}
