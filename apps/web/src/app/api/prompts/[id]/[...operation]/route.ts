import {promptOperation} from '@/lib/prompt-api';
export async function GET(r:Request,c:{params:Promise<{id:string;operation:string[]}>}){return promptOperation(r,c.params);}
export async function POST(r:Request,c:{params:Promise<{id:string;operation:string[]}>}){return promptOperation(r,c.params);}
