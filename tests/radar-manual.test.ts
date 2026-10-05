import { stub,tag } from './setup.ts';
import assert from 'node:assert/strict';
import { after,test } from 'node:test';
import { sql,closeDb } from '@aihot/backend/db';
import { upsertMaterial } from '@aihot/backend/content/materials';
import { sourceDetail } from '@aihot/backend/admin/sources';
import { requestRadarUpdate,latestRadarRun,radarWorkerEnvironment } from '@aihot/backend/admin/radar';
import { runRadarUpdate } from '@aihot/backend/jobs/radar';
import { screenRadarArticle } from '@aihot/backend/editorial/radar-screen';
import type { WechatContext } from '@aihot/backend/editorial/wechat-context';
import { buildApp } from '../apps/api/src/app.ts';

const T=tag();
const SOURCE='media-radar-'+T;
const context: WechatContext={status:'loaded',hash:'context-'+T,readAt:new Date().toISOString(),files:[],missing:[],recent:[{id:'T122',question:'旧答案',evidence:'原始材料',boundary:'不外推'}],paused:[]};
const answer={title_zh:'公司推出新产品',status:'lead',lane:'AI技术',reason:'报道给出具体产品动作',change:'公司称推出新产品',angle:'产品改变了哪项权限？',value:'理解实际使用的权限变化',evidence:['产品版本公告','适用人群和权限文档'],stage:'已发生',event_key:null,event_date:null,expected_question:'哪项使用方式发生变化？',expected_answer:'假设需要更精细权限，待核',incremental_value:'具体权限机制待核',boundary:'不推定用户已经广泛采用',repeat_risk:'有新增线索',previous_ids:['T122','T999'],repeat_reason:'与旧答案不同但仍待核证据',exclude_reason:null};
const provider=await stub(() => ({choices:[{message:{content:JSON.stringify(answer)}}],usage:{prompt_tokens:10,completion_tokens:10}}));
process.env.DEEPSEEK_BASE_URL=provider.url+'/v1';process.env.DEEPSEEK_API_KEY='test-key';process.env.RADAR_MODEL='deepseek-flash';process.env.RADAR_MANUAL_ENABLED='true';
await sql`INSERT INTO sources(id,name,kind,tier,participation_mode,next_fetch_at) VALUES(${SOURCE},'手动更新测试','rss','T2','editorial','2100-01-01')`;
after(async () => {await provider.close();await closeDb();});

test('manual model results cache, preserve reviewed translations and disappear on material revision',async () => {
  const material=(title:string) => upsertMaterial({sourceId:SOURCE,url:'https://example.org/'+SOURCE,title,via:'fetch',publishedAt:new Date()});
  const {articleId}=await material('Company launches gadget '+T);
  await sql`INSERT INTO article_title_translations(article_id,revision,original_title,translated_title,method) SELECT id,revision,title,'人工校对译文','agent-reviewed-trial' FROM articles WHERE id=${articleId}`;
  assert.equal(await screenRadarArticle(articleId,context),true);
  assert.equal(await screenRadarArticle(articleId,context),false);
  assert.equal(provider.hits(),1);
  const detail=await sourceDetail(SOURCE);
  assert.equal(detail?.items[0]?.title_translation,'人工校对译文');
  assert.deepEqual(detail?.items[0]?.model_assessment?.previous_ids,['T122']);
  await material('Company updates gadget '+T);
  assert.equal((await sourceDetail(SOURCE))?.items[0]?.model_assessment,null);
  await screenRadarArticle(articleId,{...context,status:'missing',hash:'missing-'+T,missing:['研究索引']});
  assert.equal((await sourceDetail(SOURCE))?.items[0]?.model_assessment?.repeat_risk,'待判断');
  assert.match((await sourceDetail(SOURCE))?.items[0]?.model_assessment?.repeat_reason ?? '',/近期重复未检查/);
});

test('concurrent button requests share one run; retrying the same request never launches again',async () => {
  await sql`UPDATE radar_update_runs SET state='failed',finished_at=now() WHERE state IN ('pending','running')`;
  const launched:string[]=[];
  const [a,b]=await Promise.all([requestRadarUpdate('test','request-a-'+T,id => launched.push(id)),requestRadarUpdate('test','request-b-'+T,id => launched.push(id))]);
  assert.equal(a.id,b.id);assert.equal(launched.length,1);
  const seen:boolean[]=[];
  const modelHitsBefore=provider.hits();
  await runRadarUpdate(a.id,{context:async()=>context,collect:async(id,opts) => {
    seen.push(opts?.process===false);
    return {sourceId:id,status:'failed',found:0,created:0,revised:0,error:'fixture unavailable'};
  }});
  const completed=await latestRadarRun();
  assert.equal(completed?.state,'partial');assert.ok(seen.length>0 && seen.every(Boolean));
  assert.equal(completed?.detail.mode,'collect_only');assert.equal(completed?.detail.modelTotal,0);assert.equal(completed?.detail.modelFailed,0);assert.equal(provider.hits(),modelHitsBefore);
  await requestRadarUpdate('test','request-a-'+T,id => launched.push(id));
  assert.equal(launched.length,1);
});

test('manual update and progress are protected by admin authentication',async () => {
  const app=await buildApp();
  try {
    assert.equal((await app.inject({method:'POST',url:'/api/admin/radar/update',payload:{}})).statusCode,401);
    assert.equal((await app.inject({method:'GET',url:'/api/admin/radar/update'})).statusCode,401);
  } finally {await app.close();}
});

test('manual collection cannot reopen model, scheduled collection or outbound push valves', () => {
  const saved=process.env.MODEL_CALLS_ENABLED;
  process.env.MODEL_CALLS_ENABLED='true';
  try {
    const env=radarWorkerEnvironment();
    for (const key of ['MODEL_CALLS_ENABLED','COLLECT_ENABLED','FEISHU_CONTENT_PUSH_ENABLED','INDEXNOW_SUBMIT_ENABLED']) assert.equal(env[key],'false');
  } finally { if (saved===undefined) delete process.env.MODEL_CALLS_ENABLED;else process.env.MODEL_CALLS_ENABLED=saved; }
});
