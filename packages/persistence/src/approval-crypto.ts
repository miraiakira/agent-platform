import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => (value as Record<string,unknown>)[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  throw new Error('Invalid canonical JSON');
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const argumentsHash = (json: string) => digest(JSON.parse(json));
function key() {
  const value = process.env.AGENT_CHECKPOINT_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('AGENT_CHECKPOINT_KEY requires 64 hex characters');
  return Buffer.from(value, 'hex');
}
export function seal(value: unknown, aad: string) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv); cipher.setAAD(Buffer.from(aad));
  return { version: 1, iv: iv.toString('hex'), ciphertext: Buffer.concat([cipher.update(canonical(value)), cipher.final()]).toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}
export function unseal<T>(envelope: unknown, aad: string): T {
  const e = envelope as { version: number; iv: string; tag: string; ciphertext: string };
  if (!e || e.version !== 1) throw new Error('Unknown encrypted payload');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(e.iv, 'hex')); decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(e.tag, 'hex'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(e.ciphertext, 'hex')), decipher.final()]).toString()) as T;
}
export function displayArguments(name: string, json: string): Record<string, unknown> {
  const value = JSON.parse(json) as Record<string, unknown>;
  if (name === 'get_high_risk_transactions') return { date: typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date) ? value.date : '[hidden]', limit: typeof value.limit === 'number' ? value.limit : '[hidden]' };
  return { notice: '所有参数已脱敏隐藏' };
}
