import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface WechatContext {
  status: 'loaded' | 'missing'; hash: string; readAt: string;
  files: Array<{ path: string; hash: string }>; missing: string[];
  recent: Array<{ id: string; question: string; evidence: string; boundary: string }>;
  paused: string[];
}
/** Read-only editorial context. No article, scheduling or publication write happens here. */
export async function loadWechatContext(root = process.env.WECHAT_WORKSPACE_PATH): Promise<WechatContext> {
  const result: WechatContext = {status:'missing',hash:'missing',readAt:new Date().toISOString(),files:[],missing:[],recent:[],paused:[]};
  if (!root) { result.missing=['未配置公众号工作区'];return result; }
  const texts = new Map<string,string>();
  for (const relative of ['运营规则.md','文章/研究索引.md','选题池.md','本周排期.md']) {
    const file=path.join(root,relative);
    try { const content=await readFile(file,'utf8');texts.set(relative,content);result.files.push({path:file,hash:createHash('sha256').update(content).digest('hex')}); }
    catch { result.missing.push(relative); }
  }
  const rows=(texts.get('文章/研究索引.md') ?? '').split(/\r?\n/).filter(line => /^\|\s*\[T\d+/.test(line)).map(line => {
    const cols=line.split('|'); const id=/\[(T\d+)/.exec(cols[1] ?? '')?.[1] ?? '';
    const date=/(\d{4}-\d{2}-\d{2})_T/.exec(line)?.[1] ?? '';
    return {id,date,question:(cols[2] ?? '').trim().slice(0,300),evidence:(cols[3] ?? '').trim().slice(0,160),boundary:(cols[4] ?? '').trim().slice(0,180)};
  }).sort((a,b) => b.date.localeCompare(a.date));
  const cutoff=rows[9]?.date;
  result.recent=rows.filter((row,i) => i<10 || (cutoff && row.date===cutoff)).slice(0,16).map(({date,...row}) => row);
  result.paused=(texts.get('选题池.md') ?? '').split(/\r?\n/).filter(line => /用户暂停|用户要求.*暂停|继续暂停/.test(line)).map(line => line.slice(0,900)).slice(0,15);
  if (!result.recent.length) result.missing.push('研究索引中没有可比较的母稿');
  result.status=result.missing.length ? 'missing' : 'loaded';
  result.hash=createHash('sha256').update(JSON.stringify({recent:result.recent,paused:result.paused,rules:texts.get('运营规则.md'),missing:result.missing})).digest('hex');
  return result;
}
