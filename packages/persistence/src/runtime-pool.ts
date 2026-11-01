import { createPool } from './db';
import { assertRuntimeRole, scopedPool } from './security-context';
export function createRuntimePool(role: 'eap_app' | 'eap_worker') {
  const raw = createPool();
  let checked: Promise<void> | undefined;
  return scopedPool(raw, role, () => checked ??= assertRuntimeRole(raw));
}
