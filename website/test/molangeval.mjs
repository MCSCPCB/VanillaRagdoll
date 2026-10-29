// Test-only interpreter for trusted generated fixtures. Never imported by the website.
import assert from 'node:assert/strict';
import {parseExpression} from '../vendor/simple-ragdoll/src/core/parse.mjs';
function js(node){
  const emit=js;
  if(node.kind==='value')return JSON.stringify(node.value);
  if(node.kind==='read')return node.path.join('.');
  if(node.kind==='call')return node.path.join('.')+'('+node.args.map(emit).join(',')+')';
  if(node.kind==='if')return `(${emit(node.test)}?${emit(node.yes)}:${emit(node.no)})`;
  if(node.kind==='unary')return node.op==='!'?`+(!${emit(node.value)})`:`(${node.op}${emit(node.value)})`;
  if(node.op==='&&')return `(${emit(node.left)}?+(!!${emit(node.right)}):0)`;
  if(node.op==='||')return `(${emit(node.left)}?1:+(!!${emit(node.right)}))`;
  return `(${emit(node.left)}${node.op}${emit(node.right)})`;
}
export const expr=s=>js(parseExpression(typeof s==='string'?s.replace(/\bthis\b/g,'v.test_this'):s));
const compiled=new Map();
export function script(source){
  if(compiled.has(source))return compiled.get(source);
  let at=0,loop=0;
  const eat=s=>{assert(source.startsWith(s,at),`Expected ${s}: ${source.slice(at,at+80)}`);at+=s.length;};
  const until=end=>{const start=at;let depth=0,quote=false;for(;at<source.length;at++){const c=source[at];if(c==="'")quote=!quote;if(!quote){if(depth===0&&c===end)return source.slice(start,at);if(c==='(')depth++;if(c===')')depth--;}}throw Error('Unterminated expression');};
  const sequence=end=>{let result='';while(at<source.length&&source[at]!==end){
    if(source.startsWith('return ',at)){eat('return ');result+='return '+expr(until(';'))+';';eat(';');}
    else if(source.startsWith('loop(',at)){eat('loop(');const n=expr(until(',')),i=loop++;eat(',{');const body=sequence('}');eat('});');result+=`for(let l${i}=0,n${i}=Math.min(1024,Math.max(0,Math.floor(${n})));l${i}<n${i};l${i}++){${body}}`;}
    else if(source[at]==='('){eat('(');const condition=expr(until(')'));eat(')?{');const yes=sequence('}');eat('}');let no='';if(source.startsWith(':{',at)){eat(':{');no=sequence('}');eat('}');}eat(';');result+=`if(${condition}){${yes}}else{${no}}`;}
    else{const statement=until(';');eat(';');const equals=statement.indexOf('=');assert(equals>0,statement);const target=statement.slice(0,equals),parts=target.split('.');for(let i=2;i<parts.length;i++)result+=parts.slice(0,i).join('.')+'??={};';result+=target+'='+expr(statement.slice(equals+1))+';';}
  }return result;};
  const code=sequence(null);assert.equal(at,source.length);
  const run=new Function('v','t','q','math','c',code);compiled.set(source,run);return run;
}
