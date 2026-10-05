import { runRadarUpdate } from '@aihot/backend/jobs/radar';
import { stopBoss } from '@aihot/backend/jobs/queue';
import { closeDb } from '@aihot/backend/db';
const id=process.argv[2];
try {
  if (!id) throw new Error('Missing manual run id');
  await runRadarUpdate(id);
} finally { await stopBoss();await closeDb(); }
