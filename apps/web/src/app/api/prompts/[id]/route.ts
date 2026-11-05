import {promptOperation} from '@/lib/prompt-api';
export async function GET(r:Request,c:{params:Promise<{id:string}>}){return promptOperation(r,c.params);}
