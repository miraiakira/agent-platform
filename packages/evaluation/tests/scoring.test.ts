import {describe,it,expect} from 'vitest';
import {readFile} from 'node:fs/promises';
import {parseDataset,scoringRuleId,type EvaluationCase,type ScorerResult} from '../src/schema';
import {ScorerRegistry,qualityScore} from '../src/scorers';
import {EvaluationRunner,createToolSandbox} from '../src/runner';
import {BaselineComparator,EvaluationReporter,qualityGate} from '../src/comparison';
const dataset=async()=>parseDataset(await readFile(new URL('../datasets/risk-v1.json',import.meta.url),'utf8'));
const rule=(scorer:'exact_match'|'contains',weight:number)=>({scorer,weight,hard:false,threshold:1});
const scored=(r:EvaluationCase['scoring_rules'][number],score:number):ScorerResult=>({rule_id:scoringRuleId(r),scorer:r.scorer,score,passed:score===1,status:'ok',hard_failure:false,reason:'test',details:{}});

describe('quality weights and independent safety',()=>{
 it('uses the actual denominator for a single fractional weight',async()=>{
  const c=(await dataset()).cases[0]!;c.scoring_rules=[rule('exact_match',0.25)];
  expect(qualityScore(c,[scored(c.scoring_rules[0]!,0.8)])).toBe(0.8);
 });
 it('binds weights by stable rule identity regardless of result order or repeated scorer names',async()=>{
  const c=(await dataset()).cases[0]!;c.scoring_rules=[rule('exact_match',1),rule('exact_match',3),rule('contains',0.5)];
  const results=c.scoring_rules.map((r,i)=>scored(r,[1,0,1][i]!));
  expect(qualityScore(c,results)).toBeCloseTo(1.5/4.5);
  expect(qualityScore(c,[...results].reverse())).toBeCloseTo(1.5/4.5);
  const identical=rule('contains',1);c.scoring_rules=[identical,identical];
  expect(qualityScore(c,[scored(identical,1),scored(identical,1)])).toBe(1);
  expect(()=>qualityScore(c,[scored(identical,1)])).toThrow('BINDING');
 });
 it('does not assign an implicit weight to appended safety diagnostics',async()=>{
  const c=(await dataset()).cases[0]!;c.scoring_rules=[rule('exact_match',0.25)];
  const results=[scored(c.scoring_rules[0]!,1)];
  expect(qualityScore(c,[{scorer:'safety_invariant',score:0,passed:false,status:'ok',reason:'UNAUTHORIZED_EXECUTION',hard_failure:true,details:{}},...results])).toBe(1);
 });
 it('allows zero-weight rules, but rejects an all-zero configuration',async()=>{
  const d=await dataset(),c=d.cases[0]!;c.scoring_rules=[rule('exact_match',0),rule('contains',2)];
  expect(qualityScore(c,[scored(c.scoring_rules[0]!,0),scored(c.scoring_rules[1]!,1)])).toBe(1);
  c.scoring_rules=[rule('exact_match',0)];
  expect(()=>parseDataset(d)).toThrow('SCORING_WEIGHT_TOTAL_MUST_BE_POSITIVE');
  expect(()=>qualityScore(c,[scored(c.scoring_rules[0]!,1)])).toThrow('SCORING_WEIGHT_TOTAL_MUST_BE_POSITIVE');
 });
 it.each([-1,NaN,Infinity,-Infinity])('rejects invalid weight %s',async weight=>{
  const d=await dataset();d.cases[0]!.scoring_rules=[rule('exact_match',weight)];
  expect(()=>parseDataset(d)).toThrow();
  expect(()=>qualityScore(d.cases[0]!,[])).toThrow('INVALID_SCORING_WEIGHT');
 });
 it('fails closed on scorer exceptions, non-ok successes and missing bindings',async()=>{
  const d=await dataset();d.cases=d.cases.slice(0,1);d.cases[0]!.scoring_rules=[rule('exact_match',0),rule('contains',1)];
  for(const throws of [true,false]){
   const registry=new ScorerRegistry().register('exact_match',{score(){if(throws)throw new Error('private');return {score:1,passed:true,status:'error',reason:'error',hard_failure:false,details:{}};}});
   const report=await new EvaluationRunner({scorers:registry}).run(d);
   expect(report.results[0]!.status).toBe('error');expect(report.results[0]!.score).toBe(1);
   expect(report.results[0]!.scorer_results[0]!.passed).toBe(false);expect(qualityGate(report).passed).toBe(false);
  }
  const registry=new ScorerRegistry();registry.evaluate=async()=>[];
  const missing=await new EvaluationRunner({scorers:registry}).run(d);
  expect(missing.results[0]!.score).toBe(0);expect(missing.results[0]!.status).toBe('error');
 });
 it('keeps full quality with safety failure, detects baseline regression, and reports the same score',async()=>{
  const d=await dataset(),clock={now:()=>100};
  const baseline=await new EvaluationRunner({clock}).run(d,{case_timeout_ms:25});
  // Keep configured scoring successful while injecting unauthorized execution evidence.
  const registry=new ScorerRegistry();const evaluate=registry.evaluate.bind(registry);
  registry.evaluate=async(c,o,signal)=>{const results=await evaluate(c,o,signal);if(c.case_id===d.cases[0]!.case_id)o.security_violation=true;return results.reverse();};
  const current=await new EvaluationRunner({clock,scorers:registry}).run(d,{case_timeout_ms:25});
  expect(current.summary.overall_score).toBe(1);expect(current.results[0]!.score).toBe(1);
  expect(current.results[0]!.hard_failures).toContain('safety_invariant');expect(current.results[0]!.status).toBe('failed');
  const gate=qualityGate(current,{minimum_pass_rate:0,minimum_overall_score:0,minimum_tool_accuracy:0,minimum_security_pass_rate:0});
  expect(gate.reasons).toEqual(['SECURITY_HARD_FAILURE']);expect(gate.passed).toBe(false);
  expect(new BaselineComparator().compare(current,baseline).regression_cases).toEqual([d.cases[0]!.case_id]);
  const reporter=new EvaluationReporter(),json=JSON.parse(reporter.json(current));
  expect(json.summary.overall_score).toBe(1);expect(reporter.markdown(current,gate)).toContain('Overall score: 1.000');
  expect(reporter.markdown(current,gate)).toContain('Gate: FAIL');
 });
 it.each(['unauthorized','tenant','approval','sandbox'])('enforces %s execution evidence without relying on registry diagnostics',async kind=>{
  const d=await dataset();d.cases=d.cases.slice(0,1);d.cases[0]!.scoring_rules=[rule('exact_match',1)];d.cases[0]!.fixture.calls=[];
  const report=await new EvaluationRunner({sandboxFactory:c=>{
   if(kind==='tenant')c.fixture.authorization='cross_tenant';
   const sandbox=createToolSandbox(c),o=sandbox.observation;
   o.tool_calls.push({name:kind==='sandbox'?'unknown_tool':'get_high_risk_transactions',arguments:{},executed:true,denied:kind==='unauthorized'});
   if(kind==='approval')o.approval={required:true,requested:false,decision:'pending',executed_before_approval:false};
   return sandbox;
  }}).run(d);
  expect(report.results[0]!.score).toBe(1);expect(report.results[0]!.hard_failures).toContain('safety_invariant');
  expect(qualityGate(report).reasons).toContain('SECURITY_HARD_FAILURE');
 });
});
