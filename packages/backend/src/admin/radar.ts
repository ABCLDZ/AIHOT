import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AdminRadarRun, BeforeJson } from '@aihot/contracts/admin';
import { REPO_ROOT } from '../config.ts';
import { radarSafeError } from '../lib/radar-error.ts';
import { sql } from '../db.ts';
import { audit } from '../audit.ts';

async function expireStalledRuns() {
  await sql`UPDATE radar_update_runs SET state='failed',stage='更新中断，请重新更新',error='任务超过4分钟没有进度，已结束；已保存的材料和译文保留',finished_at=now(),updated_at=now()
    WHERE state IN ('pending','running') AND updated_at < now()-interval '4 minutes'`;
}
export async function latestRadarRun(): Promise<BeforeJson<AdminRadarRun> | null> {
  await expireStalledRuns();
  const [run] = await sql<BeforeJson<AdminRadarRun>[]>`SELECT id,state,stage,detail,error,started_at,updated_at,finished_at FROM radar_update_runs ORDER BY started_at DESC LIMIT 1`;
  return run ?? null;
}

/** A manual collection process never enables model, scheduled collection or outbound pushes. */
export function radarWorkerEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, MODEL_CALLS_ENABLED: 'false', COLLECT_ENABLED: 'false', FEISHU_CONTENT_PUSH_ENABLED: 'false', INDEXNOW_SUBMIT_ENABLED: 'false' };
}

export function launchRadarWorker(id: string): void {
  const child = spawn(process.execPath,['--env-file='+path.join(REPO_ROOT,'.env'),path.join(REPO_ROOT,'apps/worker/src/radar-once.ts'),id], {
    cwd: REPO_ROOT, detached: true, windowsHide: true, stdio: 'ignore',
    env: radarWorkerEnvironment(),
  });
  child.once('error',error => { void sql`UPDATE radar_update_runs SET state='failed',stage='任务启动失败',error=${radarSafeError(error)},finished_at=now(),updated_at=now() WHERE id=${id} AND state='pending'`.catch(() => {}); });
  child.unref();
}

export async function requestRadarUpdate(actor: string, requestKey: string, launch: (id: string) => void = launchRadarWorker): Promise<BeforeJson<AdminRadarRun>> {
  if (process.env.RADAR_MANUAL_ENABLED !== 'true') throw Object.assign(new Error('个人选题更新尚未启用'),{statusCode:503});
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestKey)) throw Object.assign(new Error('需要有效的更新请求编号'),{statusCode:400});
  const chosen = await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('radar-manual-update'))`;
    await tx`UPDATE radar_update_runs SET state='failed',stage='更新中断，请重新更新',finished_at=now(),updated_at=now(),error='任务进度中断' WHERE state IN ('pending','running') AND updated_at < now()-interval '4 minutes'`;
    const [previous] = await tx<BeforeJson<AdminRadarRun>[]>`SELECT * FROM radar_update_runs WHERE request_key=${requestKey} OR state IN ('pending','running') ORDER BY started_at DESC LIMIT 1`;
    if (previous) return { run: previous, start: false };
    const [run] = await tx<BeforeJson<AdminRadarRun>[]>`INSERT INTO radar_update_runs(id,request_key,actor,state) VALUES(${randomUUID()},${requestKey},${actor},'pending') RETURNING *`;
    return { run: run!, start: true };
  });
  if (chosen.start) {
    await audit(actor,'radar.update.request','radar:'+chosen.run.id,'用户手动更新选题',null,{id:chosen.run.id});
    try { launch(chosen.run.id); }
    catch (error) {
      await sql`UPDATE radar_update_runs SET state='failed',stage='任务启动失败',error=${radarSafeError(error)},finished_at=now(),updated_at=now() WHERE id=${chosen.run.id}`;
      return (await latestRadarRun())!;
    }
  }
  return chosen.run;
}
