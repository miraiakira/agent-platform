import { createPool } from '../src/db';
const passwords={eap_web_runtime:process.env.APP_DB_PASSWORD,eap_worker_runtime:process.env.WORKER_DB_PASSWORD};
for(const password of Object.values(passwords))if(!password || password.length<32)throw new Error('APP_DB_PASSWORD and WORKER_DB_PASSWORD require 32+ characters');
const pool=createPool(process.env.MIGRATION_DATABASE_URL);
const literal=(value:string)=>`'${value.replaceAll("'","''")}'`;
try {
 for(const [role,password] of Object.entries(passwords)){
  const exists=await pool.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role]);
  if(!exists.rowCount)await pool.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`);
  await pool.query(`ALTER ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB PASSWORD ${literal(password!)}`);
 }
 await pool.query('GRANT eap_app,eap_auth TO eap_web_runtime');
 await pool.query('GRANT eap_worker TO eap_worker_runtime');
 console.log('Provisioned separate restricted Web and Worker identities; no credentials printed.');
}finally{await pool.end();}
