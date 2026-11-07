import {handleMemory} from '@/lib/knowledge-api';
export const runtime='nodejs';
async function handle(r:Request,c:{params:Promise<{operation?:string[]}>}){return handleMemory(r,(await c.params).operation??[]);}
export {handle as GET,handle as POST,handle as DELETE};
