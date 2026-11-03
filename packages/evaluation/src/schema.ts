import {z} from 'zod';
import {createHash} from 'node:crypto';
export function canonical(value:unknown):string {
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
 if(value&&typeof value==='object')return `{${Object.keys(value).filter(k=>(value as Record<string,unknown>)[k]!==undefined).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string,unknown>)[k])}`).join(',')}}`;
 throw new Error('INVALID_JSON');
}
export const contentHash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export const scorerNames=['exact_match','contains','json_schema','tool_selection','tool_arguments','tool_sequence','error_code','security_behavior','approval_compliance','model_based'] as const;
export const scoringRule=z.object({scorer:z.enum(scorerNames),weight:z.number().positive().max(100).default(1),hard:z.boolean().default(false),threshold:z.number().min(0).max(1).default(1),schema:z.record(z.string(),z.unknown()).optional(),rubric:z.string().min(1).max(4000).optional()}).strict();
const call=z.object({name:z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),arguments:z.record(z.string(),z.unknown())}).strict();
export const evaluationCaseSchema=z.object({
 case_id:z.string().regex(/^[\w-]{1,80}$/),name:z.string().min(1).max(160),
 input_messages:z.array(z.object({role:z.enum(['system','user','assistant']),content:z.string().max(16000)}).strict()).min(1).max(30),
 expected_tool_calls:z.array(z.string().max(80)).max(16).default([]),expected_tool_arguments:z.array(call).max(16).default([]),
 expected_output:z.string().max(32000).optional(),expected_error_code:z.string().max(80).nullable().optional(),
 expected_approval_behavior:z.enum(['not_required','pending','approved','rejected']).default('not_required'),
 expected_security_behavior:z.enum(['allowed','denied','tenant_isolated']).default('allowed'),
 scoring_rules:z.array(scoringRule).min(1).max(16),tags:z.array(z.string().regex(/^[\w-]{1,40}$/)).max(12).default([]),
 tool_order_matters:z.boolean().default(true),
 fixture:z.object({calls:z.array(call).max(8).default([]),output:z.string().max(16000).default('风险分析完成'),stall:z.boolean().default(false),authorization:z.enum(['allow','deny','cross_tenant']).default('allow'),approval:z.enum(['not_required','pending','approved','rejected']).default('not_required')}).strict(),
}).strict();
export const evaluationDatasetSchema=z.object({schema_version:z.literal(1),name:z.string().min(1).max(120),description:z.string().max(1000).default(''),version:z.number().int().positive(),cases:z.array(evaluationCaseSchema).min(1).max(200)}).strict().superRefine((d,c)=>{if(new Set(d.cases.map(v=>v.case_id)).size!==d.cases.length)c.addIssue({code:'custom',message:'Duplicate case_id'});});
export type EvaluationCase=z.infer<typeof evaluationCaseSchema>;
export type EvaluationDataset=z.infer<typeof evaluationDatasetSchema>;
export const MAX_DATASET_BYTES=1_000_000;
export function parseDataset(input:unknown):EvaluationDataset {
 const serialized=typeof input==='string'?input:JSON.stringify(input);if(!serialized)throw new Error('INVALID_DATASET');
 if(Buffer.byteLength(serialized)>MAX_DATASET_BYTES)throw new Error('DATASET_TOO_LARGE');
 let nodes=0;const walk=(v:unknown,depth:number)=>{if(++nodes>20000||depth>32)throw new Error('DATASET_COMPLEXITY_LIMIT');if(Array.isArray(v))for(const x of v)walk(x,depth+1);else if(v&&typeof v==='object')for(const x of Object.values(v))walk(x,depth+1);};
 const parsed=typeof input==='string'?JSON.parse(input):input;walk(parsed,0);
 return evaluationDatasetSchema.parse(parsed);
}
export const runConfigSchema=z.object({provider:z.enum(['mock','deepseek']).default('mock'),model:z.string().max(120).default('mock-model'),model_version:z.string().max(120).default('unreported'),prompt_version:z.string().max(120).default('risk-agent-v1'),code_revision:z.string().max(80).default('unknown'),seed:z.number().int().nonnegative().optional(),concurrency:z.number().int().min(1).max(8).default(2),max_duration_ms:z.number().int().min(10).max(300000).default(60000),case_timeout_ms:z.number().int().min(5).max(60000).default(1000),max_tokens:z.number().int().min(1).max(100000).default(10000),max_tool_calls:z.number().int().min(0).max(32).default(8),judge_enabled:z.boolean().default(false)}).strict().transform(c=>c.provider==='mock'?{...c,model:'mock-model',model_version:'mock-fixture-v1'}:c);
export type RunConfig=z.infer<typeof runConfigSchema>;
export interface ToolObservation {name:string;arguments:unknown;executed:boolean;denied:boolean;error_code?:string}
export interface Observation {output:string;tool_calls:ToolObservation[];error_code?:string;approval:{required:boolean;requested:boolean;decision:string;executed_before_approval:boolean};security_violation:boolean;security_reason?:'POLICY_DENIED'|'TENANT_ISOLATED';usage:{input_tokens:number;output_tokens:number};cost:number|null;cost_price?:unknown;usage_source?:'reported'|'partial'|'unavailable';latency_ms:number}
export interface ScorerResult {scorer:string;score:number;passed:boolean;reason:string;details:Record<string,unknown>;hard_failure:boolean;status:'ok'|'error'|'inconclusive';judge_usage?:{input_tokens:number;output_tokens:number;cost:number|null;price?:unknown}}
export interface EvaluationResult {case_id:string;status:'passed'|'failed'|'error'|'cancelled'|'skipped'|'inconclusive';score:number;scorer_results:ScorerResult[];observation:Observation;hard_failures:string[];result_hash:string}
export interface EvaluationReport {schema_version:1;dataset_hash:string;dataset_version:number;dataset_name:string;config:RunConfig;results:EvaluationResult[];summary:Summary;report_hash:string}
export interface Summary {total:number;overall_score:number;pass_rate:number;tool_accuracy:number|null;security_pass_rate:number|null;approval_compliance:number|null;p50_latency_ms:number;p95_latency_ms:number;input_tokens:number;output_tokens:number;estimated_cost:number|null;judge_tokens:number;judge_cost:number|null;hard_failures:number;missing:number}
