import { z } from 'zod';
import { sql } from '../db.ts';
import { chatJson } from '../providers/llm.ts';
import { completeReceipt } from '../providers/receipts.ts';
import { modelFor } from './models.ts';
import { promptText, promptVersion } from './prompts.ts';
import { loadWechatContext, type WechatContext } from './wechat-context.ts';

export const RADAR_SCREEN_VERSION = promptVersion('radar-screen');
const short = z.string().trim().min(1).max(700);
const Output = z.object({
  title_zh: z.string().trim().min(1).max(1000).refine(s => /[\u3400-\u9fff]/.test(s)).nullable(),
  status: z.enum(['lead','review','noise']), lane: z.enum(['AI技术','地缘经济','公司商业','真实体验','']),
  reason: short, change: short, angle: short, value: short,
  evidence: z.array(short).min(2).max(4), stage: z.enum(['已发生','计划或提案','预测','未知']),
  event_key: z.string().trim().min(1).max(240).nullable(),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  expected_question: short, expected_answer: short, incremental_value: short, boundary: short,
  repeat_risk: z.enum(['待判断','可能重复','有新增线索']), previous_ids: z.array(z.string().regex(/^T\d+$/)).max(10),
  repeat_reason: short, exclude_reason: z.string().trim().min(1).max(300).nullable(),
});

/** Called only by the user-triggered, single-round worker. Never from a page read. */
export async function screenRadarArticle(articleId: string, providedContext?: WechatContext): Promise<boolean> {
  const context=providedContext ?? await loadWechatContext();
  const [a] = await sql<{ id: string; revision: number; title: string; excerpt: string | null; body_text: string | null; published_at: Date | null; source_name: string; source_kind:string }[]>`
    SELECT a.id,a.revision,a.title,a.excerpt,a.body_text,a.published_at,s.name AS source_name,s.kind AS source_kind FROM articles a JOIN sources s ON s.id=a.source_id WHERE a.id=${articleId} AND a.source_id LIKE 'media-%'`;
  if (!a) return false;
  const [cached] = await sql`SELECT 1 FROM article_radar_assessments WHERE article_id=${a.id} AND revision=${a.revision} AND original_title=${a.title} AND prompt_version=${RADAR_SCREEN_VERSION} AND context_hash=${context.hash}`;
  if (cached) return false;
  const excerpt=(a.excerpt ?? '').slice(0,1600);
  const bodyExcerpt=(a.body_text ?? '').slice(0,1600);
  const inputScope={kind:excerpt && bodyExcerpt ? 'title+both' : bodyExcerpt ? 'title+body_excerpt' : excerpt ? (a.source_kind==='rss' ? 'title+rss_excerpt' : 'title+excerpt') : 'title_only',excerpt_chars:excerpt.length,body_excerpt_chars:bodyExcerpt.length};
  const result = await chatJson({ model: await modelFor('radar'), purpose: 'radar_screen', subject: `article:${a.id}@${a.revision}`,
    promptVersion: RADAR_SCREEN_VERSION+':'+context.hash.slice(0,16), system: promptText('radar-screen'),
    user: JSON.stringify({ title: a.title, source: a.source_name, published_at: a.published_at, excerpt, body_excerpt:bodyExcerpt, evidence_scope:inputScope, editorial_context:{status:context.status,recent:context.recent,paused:context.paused} }),
    schema: Output.refine(data => /[\u3400-\u9fff]/.test(a.title) || !!data.title_zh, {message:'Missing Chinese title translation'}), temperature: 0.1, maxTokens: 1800, timeoutMs: 45_000 });
  if (context.status==='missing') { result.data.repeat_risk='待判断';result.data.repeat_reason='近期重复未检查：公众号上下文缺项';result.data.previous_ids=[]; }
  else result.data.previous_ids=result.data.previous_ids.filter(id => context.recent.some(row => row.id===id));
  if (result.data.exclude_reason) result.data.status='noise';
  let committed = false;
  await sql.begin(async tx => {
    const [current] = await tx`SELECT id FROM articles WHERE id=${a.id} AND revision=${a.revision} AND title=${a.title} FOR UPDATE`;
    if (current) {
      await tx`INSERT INTO article_radar_assessments(article_id,revision,original_title,prompt_version,context_hash,output,model,receipt_id)
        VALUES(${a.id},${a.revision},${a.title},${RADAR_SCREEN_VERSION},${context.hash},${tx.json({...result.data,input_scope:inputScope})},${result.model},${result.receiptId}) ON CONFLICT DO NOTHING`;
      if (result.data.title_zh && !/[\u3400-\u9fff]/.test(a.title)) await tx`INSERT INTO article_title_translations(article_id,revision,original_title,translated_title,method)
        VALUES(${a.id},${a.revision},${a.title},${result.data.title_zh},'model-radar') ON CONFLICT(article_id,revision) DO NOTHING`;
      committed = true;
    }
    await completeReceipt(tx,result.receiptId);
  });
  return committed;
}
