import { beforeEach,afterEach,describe,it,expect } from 'vitest';
import { securityDatabase } from '../../../../packages/persistence/tests/security-database';
import { createAuth } from './auth';

describe('Better Auth with real PostgreSQL',()=>{
 let db:Awaited<ReturnType<typeof securityDatabase>>,auth:ReturnType<typeof createAuth>;
 const secret='test-only-secret-32-characters-no-production';const url='https://auth.example.test';
 const request=(path:string,body?:unknown,cookie?:string)=>auth.handler(new Request(`${url}/api/auth/${path}`,{method:body===undefined?'GET':'POST',headers:{Origin:url,...(body===undefined?{}:{'Content-Type':'application/json'}),...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)}));
 async function signup(){const response=await request('sign-up/email',{name:'Alice',email:'alice@example.test',password:'test-password-at-least-12'});expect(response.status).toBe(200);return response;}
 beforeEach(async()=>{db=await securityDatabase();auth=createAuth(db.auth,{secret,url,production:true});});
 afterEach(async()=>{await db?.close();});
 it('registers, sets secure HttpOnly SameSite cookies, signs out and revokes the persisted session',async()=>{
  const response=await signup();const cookies=response.headers.getSetCookie();
  const sessionCookie=cookies.find(c=>c.includes('session_token='))!;
  expect(sessionCookie).toMatch(/HttpOnly/i);expect(sessionCookie).toMatch(/Secure/i);expect(sessionCookie).toMatch(/SameSite=Lax/i);
  const cookie=sessionCookie.split(';')[0];
  expect((await (await request('get-session',undefined,cookie)).json()).user.email).toBe('alice@example.test');
  expect((await request('sign-out',{},cookie)).status).toBe(200);
  expect(await (await request('get-session',undefined,cookie)).json()).toBeNull();
  expect((await db.auth.query('SELECT * FROM "session"')).rowCount).toBe(0);
  const audits=(await db.admin.query('SELECT action FROM audit_logs')).rows.map(r=>r.action);expect(audits).toContain('auth.session.created');expect(audits).toContain('auth.session.revoked');
  const login=await request('sign-in/email',{email:'alice@example.test',password:'test-password-at-least-12'});expect(login.status).toBe(200);
  expect(await (await request('get-session',undefined,cookie)).json()).toBeNull();
 });
 it('rejects forged and expired sessions without cookie-cache authentication',async()=>{
  expect(await (await request('get-session',undefined,'__Secure-better-auth.session_token=forged')).json()).toBeNull();
  const response=await signup();const cookie=response.headers.getSetCookie().find(c=>c.includes('session_token='))!.split(';')[0];
  await db.auth.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 second\'');
  expect(await (await request('get-session',undefined,cookie)).json()).toBeNull();
 });
 it('checks CSRF origins and never stores a plaintext password',async()=>{
  await signup();
  const response=await auth.handler(new Request(`${url}/api/auth/sign-in/email`,{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:JSON.stringify({email:'alice@example.test',password:'test-password-at-least-12'})}));
  expect(response.status).toBe(403);
  const account=(await db.auth.query('SELECT password FROM account')).rows[0];expect(account.password).not.toBe('test-password-at-least-12');
  const audit=JSON.stringify((await db.admin.query('SELECT * FROM audit_logs')).rows);expect(audit).not.toContain('test-password-at-least-12');expect(audit).not.toContain(account.password);
 });
});
