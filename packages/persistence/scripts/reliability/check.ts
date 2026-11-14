import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {artifacts,assertTestTarget,metadata,run,save} from './common';
assertTestTarget();await mkdir(artifacts,{recursive:true,mode:0o700});let logs='';const code=await run('pnpm',['check'],process.env,b=>{logs+=b.toString();process.stdout.write(b);});await writeFile(resolve(artifacts,'pnpm-check.log'),logs,{mode:0o600});await save('regression',{...await metadata('pnpm-check'),status:code===0?'PASS':'FAIL',exit_code:code});process.exitCode=code;
