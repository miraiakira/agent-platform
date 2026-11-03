import {it,expect} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {EvaluationRunner,summarize} from '../src/runner';
import {parseDataset,contentHash} from '../src/schema';
it('returns a failing CLI exit code for an intentional regression and preserves JSON/Markdown reports',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'eap-eval-gate-'));try{
  const d=parseDataset(await readFile(new URL('../datasets/risk-v1.json',import.meta.url),'utf8'));const baseline=await new EvaluationRunner({clock:{now:()=>100}}).run(d,{case_timeout_ms:30});
  const current=structuredClone(baseline);current.results[0].status='failed';current.results[0].score=0;current.summary=summarize(current.results,current.summary.total);
  for(const r of current.results){const {result_hash,...body}=r;r.result_hash=contentHash(body);}const {report_hash,...body}=current;current.report_hash=contentHash(body);
  const previous=join(directory,'baseline.json'),changed=join(directory,'current.json'),output=join(directory,'output');await writeFile(previous,JSON.stringify(baseline));await writeFile(changed,JSON.stringify(current));
  const child=spawn(process.execPath,['--import','tsx','src/cli.ts','compare','--baseline',previous,'--current',changed,'--out',output],{cwd:new URL('../',import.meta.url),stdio:'ignore'});
  const exit=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});expect(exit).toBe(1);
  expect(JSON.parse(await readFile(join(output,'gate.json'),'utf8')).passed).toBe(false);expect(await readFile(join(output,'summary.md'),'utf8')).toContain('FAIL');expect(JSON.parse(await readFile(join(output,'report.json'),'utf8')).results).toHaveLength(6);
 }finally{await rm(directory,{recursive:true,force:true});}
},10000);
