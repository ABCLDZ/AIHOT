import { credential } from '../config.ts';

/** A bounded diagnostic for manual collection, with provider credentials removed. */
export function radarSafeError(error: unknown): string {
  let text = error instanceof Error ? error.message : String(error);
  const secret = credential('models','DEEPSEEK_API_KEY');
  if (secret) text = text.replaceAll(secret,'[hidden]');
  return text.slice(0,500);
}
