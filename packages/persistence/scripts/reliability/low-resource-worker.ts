// Explicitly authorized, short-lived fixture worker. Never used by production startup.
import {MockProvider} from '@eap/ai';
import {ToolRegistry} from '../../../tools/src/index';
import {KnowledgeStore} from '../../../knowledge/src/index';
import {createRuntimePool,assertWorkerProductionSafety,SecurityStore,ApprovalStore,JobLifecycle,AgentJobQueue,AgentEventStore,PersistenceStore} from '../../src/index';
import {runWorker} from '../../../../services/agent-worker/src/worker';
import {AgentExecutor} from '../../../../services/agent-worker/src/executor';
import {safeError,cleanupSteps,CleanupError} from './diagnostics';

async function main(){
 if(process.argv[2]!=='--execute'||process.argv.length!==3||process.env.LOW_RESOURCE_EXECUTION_APPROVED!=='true'||process.env.LOW_RESOURCE_FIXTURE_READY!=='true'){
  console.log(JSON.stringify({status:'NOT VERIFIED',reason:'EXPLICIT_FIXTURE_EXECUTION_APPROVAL_REQUIRED',started:false}));process.exitCode=2;return;
 }
 if(process.env.NODE_ENV==='production')throw Object.assign(new Error('Production fixture forbidden'),{code:'PRODUCTION_FIXTURE_FORBIDDEN'});
 assertWorkerProductionSafety();
 if(process.env.LLM_PROVIDER!=='mock'||process.env.EMBEDDING_PROVIDER!=='mock')throw Object.assign(new Error('Explicit Mock fixture required'),{code:'MOCK_FIXTURE_REQUIRED'});
 const target=new URL(process.env.DATABASE_URL??'');
 if(!['127.0.0.1','localhost'].includes(target.hostname)||target.port!=='5544'||target.pathname!=='/eap_test')throw Object.assign(new Error('Dedicated fixture database required'),{code:'DEDICATED_DATABASE_REQUIRED'});
 // Local fixture-only limits. createRuntimePool still validates a restricted runtime identity.
 process.env.OTEL_ENABLED='false';process.env.PG_POOL_MAX='2';process.env.PG_STATEMENT_TIMEOUT_MS='2000';
 const pool=createRuntimePool('eap_worker'),stop=new AbortController();
 const halt=()=>stop.abort();process.once('SIGINT',halt);process.once('SIGTERM',halt);
 const timer=setTimeout(halt,30000);
 try{
  const schema=(await pool.query('SELECT current_schema() AS schema')).rows[0]?.schema;
  if(typeof schema!=='string'||!/^integration_[0-9a-f]{32}$/.test(schema))throw Object.assign(new Error('Isolated fixture schema required'),{code:'FIXTURE_SCHEMA_REQUIRED'});
  const security=new SecurityStore(pool),approvals=new ApprovalStore(pool),lifecycle=new JobLifecycle(pool,security);
  const tools=new ToolRegistry((name,args,context)=>security.authorizeTool(name,args,context));
  console.log(JSON.stringify({status:'NOT VERIFIED',started:true,scope:'isolated-fixture-only',concurrency:1,provider:'mock',registered_tools:0,background_loops:['agent'],max_lifetime_ms:30000}));
  await runWorker({workerId:`low-resource-${process.pid}`,queue:new AgentJobQueue(pool,true),lifecycle,approvals,
   executor:new AgentExecutor({store:new PersistenceStore(pool),events:new AgentEventStore(pool),lifecycle,security,approvals,
    provider:new MockProvider(),tools,knowledge:new KnowledgeStore(pool),maxDurationMs:5000}),
   concurrency:1,pollIntervalMs:1000,shutdownGraceMs:1000,signal:stop.signal,
   onError:error=>console.error(JSON.stringify({event:'fixture.worker_error',error:safeError(error)})),
  });
 }finally{
  clearTimeout(timer);stop.abort();process.removeListener('SIGINT',halt);process.removeListener('SIGTERM',halt);
  try{await cleanupSteps([{step:'fixture_worker.pool.end',run:()=>pool.end()}]);}
  catch(error){console.error(JSON.stringify({status:'FAIL',reason:'FIXTURE_WORKER_CLEANUP_FAILED',steps:error instanceof CleanupError?error.results:undefined,error:safeError(error)}));process.exitCode=1;}
 }
}
void main().catch(error=>{console.error(JSON.stringify({status:'FAIL',reason:'LOW_RESOURCE_WORKER_FAILED',error:safeError(error)}));process.exitCode=1;});
