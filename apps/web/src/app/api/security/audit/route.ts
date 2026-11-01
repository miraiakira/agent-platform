import { protectedApi } from '@/lib/security';
import { pool } from '@/lib/persistence';
export async function GET(r:Request){return protectedApi(r,'audit:read',async()=>Response.json({events:(await pool.query('SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 100')).rows}));}
