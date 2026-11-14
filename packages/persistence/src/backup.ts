import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
const keyBytes=(key:string)=>{if(!/^[a-f0-9]{64}$/i.test(key))throw new Error('BACKUP_KEY_MUST_BE_32_BYTES_HEX');return Buffer.from(key,'hex');};
export async function fileHash(path:string){const h=createHash('sha256');for await(const chunk of createReadStream(path))h.update(chunk);return h.digest('hex');}
export async function encryptBackup(source:string,destination:string,key:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyBytes(key),iv);await pipeline(createReadStream(source),cipher,createWriteStream(destination,{flags:'wx',mode:0o600}));await chmod(destination,0o600);const metadata={format:1,algorithm:'aes-256-gcm',iv:iv.toString('hex'),tag:cipher.getAuthTag().toString('hex'),sha256:await fileHash(destination)};await writeFile(destination+'.json',JSON.stringify(metadata),{mode:0o600});return metadata;}
export async function decryptBackup(source:string,destination:string,key:string){const m=JSON.parse(await readFile(source+'.json','utf8'));if(m.algorithm!=='aes-256-gcm'||await fileHash(source)!==m.sha256)throw new Error('BACKUP_INTEGRITY_FAILED');const decipher=createDecipheriv('aes-256-gcm',keyBytes(key),Buffer.from(m.iv,'hex'));decipher.setAuthTag(Buffer.from(m.tag,'hex'));await pipeline(createReadStream(source),decipher,createWriteStream(destination,{flags:'wx',mode:0o600}));}
