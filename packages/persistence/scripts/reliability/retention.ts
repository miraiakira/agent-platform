import {readdir,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {artifacts} from './common';
const days=Number(process.env.BACKUP_RETENTION_DAYS??7);if(!Number.isInteger(days)||days<1)throw new Error('INVALID_RETENTION');const dir=resolve(process.env.BACKUP_DIRECTORY??resolve(artifacts,'backup-restore'));let eligible=0;for(const f of await readdir(dir)){if(/^backup-.*\.dump\.enc(?:\.json)?$/.test(f)&&Date.now()-(await stat(resolve(dir,f))).mtimeMs>days*86400000)eligible++;}console.log(JSON.stringify({mode:'dry-run',retention_days:days,eligible_files:eligible,deleted:0,action:'Review verified offsite copies and legal retention before operator-authorized deletion.'}));
