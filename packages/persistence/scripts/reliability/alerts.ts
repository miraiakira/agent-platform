import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {root,artifacts,metadata,run,save} from './common';
let log='';const code=await run('docker',['run','--rm','--network','none','--entrypoint','/bin/promtool','-v',`${resolve(root,'infra/observability')}:/rules:ro`,'-w','/rules','prom/prometheus:v3.6.0','test','rules','reliability-alerts.test.yaml'],process.env,b=>log+=b.toString());await save('alerts',{...await metadata('promtool'),status:code===0?'PASS':'FAIL',exit_code:code});await writeFile(resolve(artifacts,'alerts','promtool.log'),log,{mode:0o600});console.log(JSON.stringify({status:code===0?'PASS':'FAIL'}));process.exitCode=code;
