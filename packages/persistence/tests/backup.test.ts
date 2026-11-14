import {it,expect} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {encryptBackup,decryptBackup} from '../src/backup';
it('authenticates encrypted backups and rejects corrupted ciphertext or keys',async()=>{const dir=await mkdtemp(resolve(tmpdir(),'backup-test-'));try{const source=resolve(dir,'source'),encrypted=resolve(dir,'encrypted'),key='ab'.repeat(32);await writeFile(source,'private fixture',{mode:0o600});await encryptBackup(source,encrypted,key);expect((await readFile(encrypted)).includes(Buffer.from('private fixture'))).toBe(false);await decryptBackup(encrypted,resolve(dir,'restored'),key);expect(await readFile(resolve(dir,'restored'),'utf8')).toBe('private fixture');await expect(decryptBackup(encrypted,resolve(dir,'wrong-key'),'cd'.repeat(32))).rejects.toThrow();await writeFile(encrypted,'tampered');await expect(decryptBackup(encrypted,resolve(dir,'corrupted'),key)).rejects.toThrow('INTEGRITY');}finally{await rm(dir,{recursive:true,force:true});}});
