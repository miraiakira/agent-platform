import {spawn,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile,mkdir,writeFile,chmod} from 'node:fs/promises';
import {resolve} from 'node:path';
export const root=resolve(import.meta.dirname,'../../../..');
export const artifacts=resolve(root,'artifacts/day14');
export function assertTestTarget(){let u:URL;try{u=new URL(process.env.TEST_DATABASE_URL??'');}catch{throw new Error('TEST_DATABASE_URL_REQUIRED_OR_INVALID');}if(!['127.0.0.1','localhost'].includes(u.hostname)||u.pathname!=='/eap_test')throw new Error('ISOLATED_LOCAL_TEST_DATABASE_REQUIRED');return u;}
// Broader coverage intentionally invalidates old evidence fingerprints.
export async function fingerprint(){const paths=execFileSync('git',['ls-files','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).split('\n').filter(p=>(/\.(ts|tsx|js|jsx|mjs|cjs|go|mod|sum|lock|json|sql|ya?ml|sh)$/.test(p)||/(^|\/)Dockerfile(?:\.[^/]+)?$/.test(p))&&!p.startsWith('docs/')&&!p.startsWith('artifacts/')).sort();const h=createHash('sha256');for(const path of paths){try{h.update(path);h.update(await readFile(resolve(root,path)));}catch{h.update('deleted');}}return h.digest('hex');}
export async function metadata(kind:string){return {kind,scope:'isolated-fixture',generated_at:new Date().toISOString(),source_sha256:await fingerprint(),revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()};}
export async function save(dir:string,data:unknown,markdown?:string){const out=resolve(artifacts,dir);await mkdir(out,{recursive:true,mode:0o700});await chmod(out,0o700);await writeFile(resolve(out,'report.json'),JSON.stringify(data,null,2),{mode:0o600});await writeFile(resolve(out,'summary.md'),markdown??`# ${dir}\n\n\`\`\`json\n${JSON.stringify(data,null,2)}\n\`\`\`\n`,{mode:0o600});}
export async function run(command:string,args:string[],env=process.env,onOutput?:(data:Buffer)=>void):Promise<number>{return new Promise((resolve,reject)=>{const child=spawn(command,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});child.stdout.on('data',(b:Buffer)=>onOutput?.(b));child.stderr.on('data',(b:Buffer)=>onOutput?.(b));child.once('error',reject);child.once('exit',code=>resolve(code??1));});}
