import { stub, tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { config } from '@aihot/backend/config';
import { sql, closeDb } from '@aihot/backend/db';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { sourceDetail } from '@aihot/backend/admin/sources';
import { translateMediaTitle } from '@aihot/backend/editorial/translate-title';

const sourceId = `media-title-${tag()}`;
const provider = await stub(() => ({ choices: [{ message: { content: JSON.stringify({ title_zh: '公司发布新设备' }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
process.env.DEEPSEEK_BASE_URL = `${provider.url}/v1`;
process.env.DEEPSEEK_API_KEY = 'test-key';
const originalValve = config.modelCallsEnabled;
await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${sourceId},'媒体标题测试','rss','T2','editorial','2100-01-01')`;
after(async () => { config.modelCallsEnabled = originalValve; await provider.close(); await closeDb(); });

test('media titles obey the valve, cache translations, and hide old revisions', async () => {
  const material = (title: string) => upsertMaterial({ sourceId, url: `https://example.org/${sourceId}`, title, via: 'fetch', publishedAt: new Date() });
  const { articleId } = await material(`Company introduces a gadget ${sourceId}`);
  config.modelCallsEnabled = false;
  await translateMediaTitle(articleId);
  assert.equal(provider.hits(), 0);
  config.modelCallsEnabled = true;
  await translateMediaTitle(articleId);
  await translateMediaTitle(articleId);
  assert.equal(provider.hits(), 1);
  assert.equal((await sourceDetail(sourceId))?.items[0]?.title_translation, '公司发布新设备');
  await material(`Company updates its gadget ${sourceId}`);
  assert.equal((await sourceDetail(sourceId))?.items[0]?.title_translation, null);
  await translateMediaTitle(articleId);
  assert.equal(provider.hits(), 2);
  await material('公司发布新设备');
  await translateMediaTitle(articleId);
  assert.equal(provider.hits(), 2);
  assert.equal((await sourceDetail(sourceId))?.items[0]?.title_translation, null);
});
