// Title hints only; historical model outputs never decide current screening or grouping.
import type { AdminRadarAssessment } from '@aihot/contracts/admin';
export const RADAR_RULES = {
  version: 'wechat-screen-v1',
  defaultHours: 48,
  extendedHours: 168,
  dailyLimit: 5,
  priority: /中国产业|中国企业|产能|供应链|采购|订单|贸易|出口|关税|权限|数据中心|supply chain|procurement|tariff|export|disk access|data center/i,
  noise: [
    { pattern: /^(?:台湾|台海|Taiwan).*?(?:政治|军事|地缘|半导体|芯片|军演|战争|politic|military|semiconductor|chip)|^(?:台积电|TSMC).*?(?:芯片|晶圆|半导体|产能|建厂|chip|fab|semiconductor)/i, reason: '台湾中心政治、军事、地缘或半导体议题：按公众号规则排除' },
    { pattern: /通行证.*(?:优惠|促销|折扣)|活动报名|购票优惠|参会优惠|招聘启事|岗位招聘|\bexpo\+? pass\b|\b(ticket|pass)\b.*\b(deal|discount)\b/i, reason: '活动、票务或招聘推广' },
    { pattern: /占星师|星座运势|娱乐八卦|明星绯闻|\bastrologers?\b|\bhoroscope\b/i, reason: '纯娱乐，偏离当前选题主线' },
  ],
  lanes: [
    { name: 'AI技术', pattern: /\bAI\b|人工智能|智能体|大模型|\bmacOS\b|\bStability\b|\bAnthropic\b|数据中心/i, value: '检查技术能力、成本或权限变化，是否改变真实工作和使用方式。', evidence: '产品公告、版本说明、权限文档；效果主张另找任务、基线与实测。' },
    { name: '地缘经济', pattern: /关税|出口|进口|贸易|海运|航运|央行|美联储|通胀|就业|债券|储备|\bG7\b|\bFed\b|\bECB\b|inflation|economy|employment|\bjobs\b|bond|diesel|shipping|export|tariff/i, value: '检查政策或数据变化如何影响订单、成本、市场准入与产业选择。', evidence: '政策或统计原文、实施日期、适用范围、比较期与数据口径。' },
    { name: '公司商业', pattern: /公司|集团|企业|银行|上市|租金|收购|融资|投资|产能|供应链|订单|零售|商业|免税|\b(Meta|Google|Apple|Microsoft|Amazon|IPO)\b|hedge fund|banks?|rent|mining|acquir|invest|business/i, value: '检查公司动作改变了谁的收入、成本、竞争位置或供应链选择。', evidence: '公司公告、财报、交易条件、客户或订单数据；区分计划与落地。' },
    { name: '真实体验', pattern: /汽车|住房|房价|房贷|孩子|消费者|隐私|消费|体验|\bcars\b|kids|house price|mortgage|privacy|consumer/i, value: '检查这项变化对日常使用、费用、隐私或选择有什么具体影响。', evidence: '规则或产品说明、适用人群、真实案例与必要的体验对照。' },
  ],
  changes: /发布|推出|上线|增长|下降|减少|增加|新增|收紧|禁止|限制|调整|扩张|扩产|翻倍|涨|跌|升至|达[到至]|破[亿万]|收购|融资|投资|签署|开始交易|改道|释放|提[出案]|\b(adds?|added|introduces?|launch|ban|tighten|grow|growth|release|surge|hits?|sell-off|rebuilding|halves|building|reopen|backs down)\b/i,
  uncertain: /可能|预计|预测|担心|警告|拟|计划|希望|提案|谈判|\b(might|may|could|warn|fears?|hopes?|sees|should|bill|plans?)\b/i,
};

export type RadarMaterial = { id: string; title: string; title_translation: string | null; title_zh: string | null; sourceId: string; sourceName: string; url: string; published_at: string | null; discovered_at: string; model_assessment?: AdminRadarAssessment | null };
export type RadarAssessment = {
  status: 'noise' | 'lead' | 'review'; reason: string; lane: string;
  freshness: 'recent' | 'extended' | 'old' | 'unknown' | 'future';
  angle: string; value: string; evidence: string; uncertainty: boolean;
  method: 'rules' | 'model';
};

export function assessMaterial(item: RadarMaterial, now: number): RadarAssessment {
  const text = item.title;
  const noise = RADAR_RULES.noise.find(r => r.pattern.test(text));
  const lane = RADAR_RULES.lanes.find(r => r.pattern.test(text));
  const change = RADAR_RULES.changes.test(text);
  const time = item.published_at ? Date.parse(item.published_at) : NaN;
  const age = (now - time) / 3_600_000;
  const freshness = !Number.isFinite(age) ? 'unknown' : age < -0.0834 ? 'future' : age <= 48 ? 'recent' : age <= 168 ? 'extended' : 'old';
  return {
    status: noise ? 'noise' : lane && change ? 'lead' : 'review',
    reason: noise?.reason ?? (lane && change ? `标题出现具体动作或数据变化，匹配${lane.name}` : !lane ? '主线关联不明确，需读原文判断' : '具体变化不够明确，需补原文'),
    lane: lane?.name ?? '', freshness,
    angle: lane && change ? `先核对“${item.title}”的事实与阶段，再追问：谁的成本、选择或工作方式发生变化？` : '先读原文，明确谁在何时做了什么，再判断能否形成切口。',
    value: lane?.value ?? '先确认与读者熟悉的产品、工作或产业问题有什么联系。',
    evidence: `媒体报道仅作线索。${lane?.evidence ?? '寻找对应公告、数据或原始报告，核对日期和主要主张。'}`,
    uncertainty: RADAR_RULES.uncertain.test(text),
    method:'rules',
  };
}

export function inTimeWindow(a: RadarAssessment, hours: 48 | 168 | 0): boolean {
  // Unknown dates remain visible for manual checking, but never enter the recommended five.
  return hours === 0 || a.freshness === 'unknown' || a.freshness === 'recent' || (hours === 168 && a.freshness === 'extended');
}

function occurrenceKey(item: RadarMaterial): string {
  const title = item.title;
  const time = item.published_at ? Date.parse(item.published_at) : NaN;
  if (!Number.isFinite(time)) return `single:${item.id}`;
  const day = new Date(time).toISOString().slice(0, 10);
  // Match a statistical release only when country, month, action and exact job count all agree.
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const month = months.findIndex(m => new RegExp(`\\b${m}\\b`, 'i').test(title));
  const zhMonth = /(\d{1,2})月/.exec(title);
  const releaseMonth = month >= 0 ? month + 1 : zhMonth ? Number(zhMonth[1]) : 0;
  const count = /\b([\d,]+)\s+jobs\b/i.exec(title);
  if (/\bUS\b|\bU\.S\.|美国/i.test(title) && /\b(adds|added)\b|新增/.test(title) && releaseMonth && count) {
    return `us-jobs:${day.slice(0, 4)}:${releaseMonth}:${count[1]!.replaceAll(',', '')}:${day}`;
  }
  // Otherwise require the same original headline and publication day. Broad topic words never merge.
  return `headline:${day}:${item.title.toLowerCase().replace(/[\s\p{P}]+/gu, '')}`;
}

export function groupMaterials<T extends RadarMaterial>(items: T[]): Array<{ key: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = occurrenceKey(item);
    const group = groups.get(key) ?? [];
    group.push(item); groups.set(key, group);
  }
  return [...groups].map(([key, rows]) => ({ key, items: rows }));
}

/** Recommendation diversity only: related progress remains separate in the occurrence cards. */
export function recommendationFamily(item: RadarMaterial): string {
  const text = item.title;
  const date = item.published_at ? Date.parse(item.published_at) : NaN;
  if (Number.isFinite(date) && /\bG7\b|七国集团/i.test(text) && /释放|release/i.test(text) && /1亿|100\s*(?:m|mn|million)\b/i.test(text) && /原油|石油|柴油|燃油|oil|diesel|fuel/i.test(text)) {
    return `g7-reserves:${new Date(date).toISOString().slice(0, 7)}:100m`;
  }
  return occurrenceKey(item);
}
