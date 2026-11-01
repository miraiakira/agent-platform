import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { assertRuntimeRole } from '@eap/persistence';
/** Same config is exercised against real PostgreSQL in authentication tests. */
export function createAuth(database:Pool,config:{secret:string;url:string;production?:boolean;google?:{clientId:string;clientSecret:string}}) {
 const audit=async(action:string,userId?:string)=>{
  await database.query(`INSERT INTO audit_logs(event_id,actor_user_id,action,resource_type,decision,reason_code)
   VALUES($1,$2,$3,'session','allow','AUTH_FRAMEWORK_EVENT')`,[randomUUID(),userId??null,action]);
 };
 return betterAuth({
  database,secret:config.secret,baseURL:config.url,trustedOrigins:[config.url],
  emailAndPassword:{enabled:true,minPasswordLength:12},
  socialProviders:config.google?{google:config.google}:{},
  session:{cookieCache:{enabled:false},expiresIn:60*60*24*7},
  advanced:{disableOriginCheck:false,disableCSRFCheck:false,useSecureCookies:config.production??false,defaultCookieAttributes:{httpOnly:true,sameSite:'lax'},ipAddress:{ipAddressHeaders:[]}},
  rateLimit:{enabled:true,storage:'database',window:60,max:60,customRules:{'/sign-in/email':{window:60,max:10},'/sign-up/email':{window:60,max:5}}},
  databaseHooks:{
   session:{create:{after:async(session)=>{await audit('auth.session.created',session.userId);}},delete:{after:async(session)=>{await audit('auth.session.revoked',session.userId);}}},
   user:{create:{after:async(user)=>{await audit('auth.user.created',user.id);}}},
  },
  logger:{disabled:true},plugins:[nextCookies()],
 });
}
let singleton:ReturnType<typeof createAuth>|undefined;
let checked:Promise<void>|undefined;
let authPool:Pool|undefined;
export async function getAuth() {
 if(!singleton){
  const secret=process.env.BETTER_AUTH_SECRET;
  const url=process.env.BETTER_AUTH_URL;
  if(!secret || secret.length<32 || !url) throw new Error('BETTER_AUTH_SECRET (32+ characters) and BETTER_AUTH_URL required');
  if(process.env.NODE_ENV==='production' && new URL(url).protocol!=='https:') throw new Error('Authentication requires HTTPS in production');
  const raw=new Pool({connectionString:process.env.DATABASE_URL});
  checked=assertRuntimeRole(raw).finally(()=>raw.end());
  authPool=new Pool({connectionString:process.env.DATABASE_URL,options:'-c role=eap_auth',max:5});
  singleton=createAuth(authPool,{secret,url,production:process.env.NODE_ENV==='production',
   google:process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET?{clientId:process.env.GOOGLE_CLIENT_ID,clientSecret:process.env.GOOGLE_CLIENT_SECRET}:undefined});
 }
 await checked;
 return singleton;
}

export async function auditAuthFailure() {
 if(authPool) await authPool.query(`INSERT INTO audit_logs(event_id,action,resource_type,decision,reason_code) VALUES($1,'auth.request.denied','session','deny','AUTH_REQUEST_REJECTED')`,[randomUUID()]);
}
