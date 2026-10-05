import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessMaterial, groupMaterials, inTimeWindow, recommendationFamily, type RadarMaterial } from '@aihot/industry/radar-rules';
const now = Date.parse('2026-10-03T08:00:00Z');
const item = (id: string, title: string, patch: Partial<RadarMaterial> = {}): RadarMaterial => ({ id, title, title_translation: null, title_zh: null, sourceId: id, sourceName: id, url: `https://example.org/${id}`, published_at: '2026-10-02T08:00:00Z', discovered_at: '2026-10-03T07:00:00Z', ...patch });

test('ticket offers and astrology are noise, while concrete employment changes remain', () => {
  assert.equal(assessMaterial(item('a', 'Don’t miss this $75 deal for your TechCrunch Disrupt Expo+ Pass'), now).status, 'noise');
  assert.equal(assessMaterial(item('b', 'I went to a gathering of astrologers'), now).status, 'noise');
  assert.equal(assessMaterial(item('c', 'US added 29,000 jobs in September'), now).status, 'lead');
  assert.notEqual(assessMaterial(item('d', 'AI系统推出身份通行证功能'), now).status, 'noise');
});

test('unknown changes remain for checking and forecasts are marked as uncertain', () => {
  const forecast = assessMaterial(item('a', 'German Economy Might Grow 1% This Year'), now);
  assert.equal(forecast.uncertainty, true);
  assert.equal(assessMaterial(item('b', 'An unfamiliar company'), now).status, 'review');
  assert.equal('score' in forecast, false);
  assert.match(forecast.evidence, /媒体报道仅作线索/);
});

test('time windows use publication time rather than a fresh collection timestamp', () => {
  const old = assessMaterial(item('a', 'AI推出新产品', { published_at: '2026-09-01T08:00:00Z' }), now);
  assert.equal(old.freshness, 'old');
  assert.equal(inTimeWindow(old, 168), false);
  assert.equal(inTimeWindow(old, 0), true);
  const extended = assessMaterial(item('b', 'AI推出新产品', { published_at: '2026-09-30T08:00:00Z' }), now);
  assert.equal(inTimeWindow(extended, 48), false);
  assert.equal(inTimeWindow(extended, 168), true);
  const unknown = assessMaterial(item('c', 'AI推出新产品', { published_at: null }), now);
  assert.equal(unknown.freshness, 'unknown');
  assert.equal(inTimeWindow(unknown, 48), true);
  assert.equal(inTimeWindow(assessMaterial(item('d', 'AI推出新产品', { published_at: '2026-10-04T08:00:00Z' }), now), 48), false);
});

test('same US employment release groups across headlines but conflicting numbers, periods or dates stay separate', () => {
  const a = item('ft', 'US economy adds just 29,000 jobs in September as hiring slows');
  const b = item('guardian', 'US added just 29,000 jobs in September in sharp drop');
  const groups = groupMaterials([a, b, item('different-number', 'US added just 30,000 jobs in September'), item('different-month', 'US added just 29,000 jobs in August'), item('different-date', b.title, { published_at: '2026-10-01T08:00:00Z' })]);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups[0]?.items.map(i => i.id), ['ft','guardian']);
});

test('shared topic words do not merge distinct actions; unknown dates do not merge', () => {
  assert.equal(groupMaterials([item('a', 'US borrowing costs hit high as global bond sell-off intensifies'), item('b', 'Quant hedge funds reap big gains from global bond sell-off')]).length, 2);
  assert.equal(groupMaterials([item('a', 'Company launches product', { published_at: null }), item('b', 'Company launches product', { published_at: null })]).length, 2);
});

test('related G7 reserve progress occupies one recommendation but stays as separate occurrences', () => {
  const a = item('a', 'G7 to release up to 100m barrels of emergency oil reserves');
  const b = item('b', 'US backs down from fuel export ban as G7 agrees to release 100mn barrels');
  assert.equal(recommendationFamily(a), recommendationFamily(b));
  assert.equal(groupMaterials([a,b]).length, 2);
  assert.notEqual(recommendationFamily(a), recommendationFamily(item('c', 'G7 leaders meet for a summit')));
  assert.notEqual(recommendationFamily(a), recommendationFamily(item('d', 'G7 to release 200m barrels of oil')));
});

test('historical model output and translation cannot control current suggestions or grouping', () => {
  const model = {status:'noise',lane:'AI技术',reason:'旧模型理由',angle:'旧切口',value:'旧价值',evidence:[],stage:'已发生',event_key:'same-event',event_date:'2026-10-02',repeat_risk:'可能重复',exclude_reason:'旧排除'} as unknown as NonNullable<RadarMaterial['model_assessment']>;
  const a=item('a','US added 29,000 jobs in September');
  assert.deepEqual(assessMaterial({...a,model_assessment:model,title_translation:'占星师旧译文'},now),assessMaterial(a,now));
  const b=item('b','Company launches another product');
  assert.equal(groupMaterials([{...a,model_assessment:model},{...b,model_assessment:model}]).length,2);
});
