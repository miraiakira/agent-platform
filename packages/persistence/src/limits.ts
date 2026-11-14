/** Server configuration only; API requests cannot override resource budgets. */
export function boundedInteger(name:string,fallback:number,min:number,max:number){const value=Number(process.env[name]??fallback);if(!Number.isInteger(value)||value<min||value>max)throw new Error(`Invalid ${name}`);return value;}
export function retryDelay(attempt:number,baseMs=1000,random=Math.random){return Math.min(30000,Math.min(30000,baseMs*2**Math.min(5,attempt))* (0.75+random()*0.5));}
