import type { AdminRadarRun } from '@aihot/contracts/admin';
import { sql } from '../db.ts';
import { collectSource } from '../sources/collect.ts';
import { radarSafeError } from '../admin/radar.ts';
import { loadWechatContext, type WechatContext } from '../editorial/wechat-context.ts';

type Dependencies = { collect?: typeof collectSource; context?: () => Promise<WechatContext> };
export async function runRadarUpdate(id: string, dependencies: Dependencies = {}): Promise<void> {
  const [claimed] = await sql`UPDATE radar_update_runs SET state='running',stage='采集媒体新报道',updated_at=now() WHERE id=${id} AND state='pending' RETURNING id`;
  if (!claimed) return;
  const detail: AdminRadarRun['detail'] = { mode:'collect_only',sources:[],modelDone:0,modelFailed:0,modelTotal:0,pending:0,modelErrors:[] };
  const progress = async (stage: string) => {
    const rows = await sql`UPDATE radar_update_runs SET stage=${stage},detail=${sql.json(detail)},updated_at=now() WHERE id=${id} AND state='running' RETURNING id`;
    if (!rows.length) throw new Error('任务已结束或被新的运行状态取代');
  };
  try {
    const context=await (dependencies.context ?? loadWechatContext)();
    detail.context={status:context.status,hash:context.hash,readAt:context.readAt,files:context.files,missing:context.missing,recentIds:context.recent.map(r => r.id)};
    const sources = await sql<{ id: string; name: string }[]>`SELECT id,name FROM sources WHERE id LIKE 'media-%' AND enabled AND kind IN ('rss','web_list','json_list') ORDER BY id`;
    for (const source of sources) {
      await progress('正在采集：'+source.name);
      try {
        const result = await (dependencies.collect ?? collectSource)(source.id,{ process:false });
        detail.sources!.push({ sourceId:source.id,name:source.name,status:result.status,created:result.created,revised:result.revised,...(result.error ? {error:radarSafeError(result.error)} : {}) });
      } catch (error) { detail.sources!.push({sourceId:source.id,name:source.name,status:'failed',created:0,revised:0,error:radarSafeError(error)}); }
      await progress('已采集 '+detail.sources!.length+' / '+sources.length+' 家媒体');
    }
    const failed=detail.sources!.some(s => s.status==='failed');
    await sql`UPDATE radar_update_runs SET state=${failed ? 'partial' : 'completed'},stage=${failed ? '采集完成，部分信源失败' : '采集完成，待当前助手阅读筛选'},detail=${sql.json(detail)},finished_at=now(),updated_at=now() WHERE id=${id} AND state='running'`;
  } catch (error) {
    await sql`UPDATE radar_update_runs SET state='failed',stage='更新中断，已保存结果保留',detail=${sql.json(detail)},error=${radarSafeError(error)},finished_at=now(),updated_at=now() WHERE id=${id} AND state='running'`;
  }
}
