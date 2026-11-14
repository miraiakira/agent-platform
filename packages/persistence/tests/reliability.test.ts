import {describe,it,expect,afterEach,vi} from 'vitest';
import {configurationChecks,errorBudget,burnAlert,readinessPassed,assertFaultSafety} from '../src/reliability';
import {retryDelay} from '../src/limits';
describe('reliability configuration, SLO and fail-closed gate',()=>{
 afterEach(()=>vi.unstubAllEnvs());
 it('does not mistake zero samples for an achieved SLO',()=>{expect(errorBudget(0,0,.999).verification).toBe('NOT VERIFIED');expect(burnAlert({good:0,total:0},{good:1,total:1},.999,14.4)).toBeNull();});
 it('computes budgets and requires both burn windows',()=>{const b=errorBudget(999,1000,.999);expect(b.burn_rate).toBeCloseTo(1);expect(b.remaining_fraction).toBeCloseTo(0);expect(burnAlert({good:98,total:100},{good:980,total:1000},.999,14.4)).toBe(true);expect(burnAlert({good:98,total:100},{good:1000,total:1000},.999,14.4)).toBe(false);expect(()=>errorBudget(2,1,.99)).toThrow();});
 it('rejects development secrets, unsafe TLS, unapproved Mock and fault injection without exposing secrets',()=>{const sentinel='development-secret-never-print-123456789';const checks=configurationChecks({NODE_ENV:'production',DATABASE_URL:'postgresql://root:private@localhost/db',BETTER_AUTH_SECRET:sentinel,LLM_PROVIDER:'mock',ENABLE_FAULT_INJECTION:'true'});expect(checks.filter(c=>c.grade==='FAIL').map(c=>c.id)).toContain('DATABASE_TLS');expect(readinessPassed(checks)).toBe(false);expect(JSON.stringify(checks)).not.toContain(sentinel);expect(JSON.stringify(checks)).not.toContain('private');});
 it('rejects evidence-free critical manual checks',()=>{expect(readinessPassed([])).toBe(false);expect(readinessPassed([{id:'production-auth',critical:true,grade:'WARN',verification:'NOT VERIFIED',reason:'MANUAL REVIEW'}])).toBe(false);});
 it('refuses production fault switches and bounds retry jitter',()=>{vi.stubEnv('NODE_ENV','production');vi.stubEnv('ENABLE_FAULT_INJECTION','true');expect(assertFaultSafety).toThrow('FORBIDDEN');expect(retryDelay(99,1000,()=>0)).toBe(22500);expect(retryDelay(99,1000,()=>1)).toBe(30000);});
});
