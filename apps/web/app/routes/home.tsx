import { data as withHeaders, Link, redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/home";
import type { TimelineResponse } from "@aihot/contracts/site";
import { isCategoryKey, isChannelKey } from "@aihot/contracts/taxonomy";
import { loadOr404, queryString, releaseBoundCache } from "../lib/api.server";
import { listPath, organizationLd, pageMeta } from "../lib/seo";
import { Timeline } from "../features/feed/Timeline";
import { HotTopics } from "../features/feed/HotTopics";
import { SearchField } from "../features/feed/Filters";
import { beijingDate, beijingWeekday } from "../lib/format";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");
  // Search lives on /all; keep the parameters so old links still land on results.
  if (q && q.trim()) throw redirect(`/all${url.search}`);
  const channelParam = url.searchParams.get("channel") ?? "all";
  const categoryParam = url.searchParams.get("category");
  const channel = isChannelKey(channelParam) ? channelParam : "all";
  const category = categoryParam && isCategoryKey(categoryParam) ? categoryParam : null;
  const tag = url.searchParams.get("tag")?.trim() || null;
  const upstream = new Headers();
  const data = await loadOr404<TimelineResponse>(`/api/site/timeline${queryString({ channel: channel === "all" ? null : channel, category, tag })}`, { responseHeaders: upstream, signal: request.signal });
  return withHeaders({ data, filters: { channel, category, tag, topic: null } }, { headers: releaseBoundCache(data.refreshAt, 60, Date.now(), upstream) });
}

export function meta({ loaderData }: Route.MetaArgs) {
  const f = loaderData?.filters;
  const path = listPath("/", { channel: f && f.channel !== "all" ? f.channel : null, category: f?.category, tag: f?.tag });
  return pageMeta({ path, jsonLd: path === "/" ? organizationLd() : undefined });
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return loaderHeaders;
}

function TodayLabel() {
  const today = beijingDate(Date.now());
  const [, m, d] = today.split("-").map(Number) as [number, number, number];
  return (
    <span className="text-[12.5px] text-ink-4" suppressHydrationWarning>
      {m}月{d}日 · {beijingWeekday(today).replace("星期", "周")}
    </span>
  );
}

export default function Home() {
  const { data, filters } = useLoaderData<typeof loader>();
  const title = filters.tag ? `#${filters.tag}` : "已整理的线索";
  return (
    <div className="pb-6">
      <header className="flex items-center justify-between py-5 lg:pb-6 lg:pt-0">
        <span className="text-xs font-semibold tracking-[0.16em] text-accent">公众号 / EDITORIAL DESK</span><TodayLabel />
      </header>
      <section className="rounded-sheet border border-line bg-surface p-6 sm:p-9">
        <p className="mb-3 text-xs font-medium text-ink-3">科技 · 商业 · 地缘观察</p>
        <h1 className="text-[30px] font-semibold leading-[1.3] tracking-tight text-ink sm:text-[40px]">今天，什么变化<br />值得写给读者？</h1>
        <p className="mt-4 max-w-xl text-sm leading-7 text-ink-3">从一手材料里找到具体动作，解释技术、资本、产业链和国家能力如何改变现实中的利益。</p>
        <div className="mt-7 flex flex-wrap items-center gap-4">
          <Link to="/admin" className="rounded-control bg-accent px-5 py-3 text-sm font-semibold text-white hover:opacity-90">进入选题工作台 ↗</Link>
          <span className="text-xs text-ink-3">看材料 · 留候选 · 核证据 · 再决定</span>
        </div>
      </section>
      <section className="my-5 rounded-panel bg-accent-soft px-5 py-4">
        <p className="text-xs font-semibold text-accent">当前选题重心</p>
        <h2 className="mt-1 text-base font-semibold text-ink">中国产业能力在全球市场中的位置，怎样变化？</h2>
        <p className="mt-2 text-xs leading-6 text-ink-3">关注海外需求、采购与产地调整，以及具体产品的准入、成本和选择变化。</p>
      </section>
      <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[['AI技术', '新能力进入真实工作'], ['地缘经济', '规则怎样改变产业位置'], ['公司商业', '经营、订单与利益变化'], ['真实体验', '产品与日常生活的变化']].map(([label, note]) => <div key={label} className="rounded-card border border-line px-4 py-4"><h2 className="text-sm font-semibold text-ink">{label}</h2><p className="mt-2 text-xs leading-5 text-ink-3">{note}</p></div>)}
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold text-ink">{title}</h2><SearchField variant="track" keep={{ category: filters.category }} /></div>
      {data.hot && <HotTopics entries={data.hot} />}
      <p className="mb-4 text-xs leading-6 text-ink-3">这里展示完成整理的线索；刚抓取的原始材料请进入选题工作台查看。材料收录不代表已推荐选题。</p>
      <Timeline initial={data} filters={data.filters} />
    </div>
  );
}
