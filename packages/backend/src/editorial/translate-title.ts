import { z } from 'zod';
import { config } from '../config.ts';
import { sql } from '../db.ts';
import { chatJson } from '../providers/llm.ts';
import { completeReceipt } from '../providers/receipts.ts';
import { modelFor } from './models.ts';
import { promptText, promptVersion } from './prompts.ts';

const Output = z.object({ title_zh: z.string().trim().min(1).max(1000).refine(s => /[\u3400-\u9fff]/.test(s), 'Chinese title required') });

/** Worker-only title translation, including materials subsequently rejected by the editorial filter. */
export async function translateMediaTitle(articleId: string, attemptTag?: string): Promise<void> {
  if (!config.modelCallsEnabled) return;
  const [row] = await sql<{ title: string; revision: number; source_id: string }[]>`SELECT title, revision, source_id FROM articles WHERE id=${articleId}`;
  if (!row || !row.source_id.startsWith('media-') || /[\u3400-\u9fff]/.test(row.title) || !/[A-Za-z]/.test(row.title)) return;
  const [existing] = await sql`SELECT article_id FROM article_title_translations WHERE article_id=${articleId} AND revision=${row.revision} AND original_title=${row.title}`;
  if (existing) return;
  const res = await chatJson({ model: await modelFor('translate'), purpose: 'translate_title',
    subject: `article:${articleId}@${row.revision}`, promptVersion: promptVersion('translate-title'),
    system: promptText('translate-title'), user: JSON.stringify({ title: row.title }), schema: Output,
    temperature: 0.1, maxTokens: 600, timeoutMs: 30_000, attemptTag });
  await sql.begin(async tx => {
    // A concurrent manual translation takes precedence. Revision/title matching hides stale answers.
    await tx`INSERT INTO article_title_translations(article_id,revision,original_title,translated_title,method)
      SELECT id,revision,title,${res.data.title_zh},'model' FROM articles WHERE id=${articleId} AND revision=${row.revision} AND title=${row.title}
      ON CONFLICT(article_id,revision) DO NOTHING`;
    await completeReceipt(tx, res.receiptId);
  });
}
