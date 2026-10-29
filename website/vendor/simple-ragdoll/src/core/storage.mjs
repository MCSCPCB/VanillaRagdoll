import {A,If,Loop} from './expression.mjs';
import {parseExpression} from './parse.mjs';

const flatten=nodes=>[nodes].flat(Infinity);
const walk=(nodes,visit)=>{for(const n of flatten(nodes)){visit(n);if(n.kind==='if'){walk(n.yes,visit);walk(n.no,visit);}if(n.kind==='loop')walk(n.body,visit);}};
const print=n=>n.kind==='read'?n.path.join('.'):n.kind==='value'?JSON.stringify(n.value):n.kind==='call'?n.path.join('.')+'('+n.args.map(print).join(',')+')':n.kind==='unary'?'('+n.op+print(n.value)+')':n.kind==='binary'?'('+print(n.left)+n.op+print(n.right)+')':'('+print(n.test)+'?'+print(n.yes)+':'+print(n.no)+')';
const roots=n=>n.kind==='read'&&n.path.length===2&&n.path[0]==='v'?[print(n)]:n.kind==='if'?[...roots(n.yes),...roots(n.no)]:[];

function prepareRecords(program){
 const schemas=new Map(),assignments=[];
 const all=[program.initialize,program.frame,program.rootOutputs];
 walk(all,n=>{
  if(n.kind!=='set')return;
  assignments.push({...n,expression:parseExpression(n.value)});
  const match=/^(v\.\w+)\.(\w+)$/.exec(n.name);
  if(match){if(!schemas.has(match[1]))schemas.set(match[1],new Set());schemas.get(match[1]).add(match[2]);}
 });
 let changed=true;
 while(changed){
  changed=false;
  for(const n of assignments){
   if(!/^v\.\w+$/.test(n.name))continue;
   const linked=[n.name,...roots(n.expression)];
   if(linked.length<2||!linked.some(k=>schemas.has(k)))continue;
   const fields=new Set(linked.flatMap(k=>[...(schemas.get(k)??[])]));
   for(const k of linked){
    if(!schemas.has(k)){schemas.set(k,new Set());changed=true;}
    for(const f of fields)if(!schemas.get(k).has(f)){schemas.get(k).add(f);changed=true;}
   }
  }
 }
 const condition=n=>['binary','unary','if'].includes(n.kind)?print(n).slice(1,-1):print(n);
 const direct=(name,n)=>n.kind==='if'?If(condition(n.test),direct(name,n.yes),direct(name,n.no)):A(name,print(n));
 const transform=nodes=>flatten(nodes).map(n=>n.kind==='set'&&schemas.has(n.name)&&parseExpression(n.value).kind==='if'?direct(n.name,parseExpression(n.value)):n.kind==='if'?If(n.test,transform(n.yes),transform(n.no)):n.kind==='loop'?Loop(n.count,transform(n.body)):n);
 const defaults=[...schemas].flatMap(([root,fields])=>[A(root,0),...[...fields].map(field=>A(root+'.'+field,0))]);
 const initialized=new Set();walk(program.initialize,n=>{if(n.kind==='set')initialized.add(n.name);});
 for(const n of assignments)if(/^v\.\w+$/.test(n.name)&&!schemas.has(n.name)&&!initialized.has(n.name)){defaults.push(A(n.name,0));initialized.add(n.name);}
 return {...program,initialize:[...defaults,...transform(program.initialize)],frame:program.frame.map(transform),rootOutputs:program.rootOutputs.map(transform)};
}


const scalarName=value=>typeof value==='string'?value.replace(/\bv\.(\w+)\.(\w+)/g,(_,root,field)=>'v.'+root+(/^(?:[bcdsj]|pose)\d+$/.test(root)?'':'_')+field):value;

export function lowerRecords(input){
 // 记录仅用于生成阶段，运行时状态展开为独立数值变量。
 const program=prepareRecords(input);
 const fields=new Map();
 walk(program.initialize,n=>{
  const match=n.kind==='set'&&/^(v\.\w+)\.(\w+)$/.exec(n.name);
  if(match){if(!fields.has(match[1]))fields.set(match[1],[]);if(!fields.get(match[1]).includes(match[2]))fields.get(match[1]).push(match[2]);}
 });
 const transform=nodes=>[nodes].flat(Infinity).flatMap(n=>{
  if(n.kind==='if'){
   const yes=transform(n.yes),no=transform(n.no);
   if(!yes.length&&!no.length)return [];
   return yes.length?If(scalarName(n.test),yes,no):If('!('+scalarName(n.test)+')',no);
  }
  if(n.kind==='loop'){const body=transform(n.body);return body.length&&Number(n.count)!==0?Loop(scalarName(n.count),body):[];}
  if(fields.has(n.name)){
   if(Number(n.value)===0)return fields.get(n.name).map(f=>A(scalarName(n.name+'.'+f),0));
   if(!fields.has(n.value))throw new Error('Unsupported record assignment: '+n.name+'='+n.value);
   return fields.get(n.name).map(f=>A(scalarName(n.name+'.'+f),scalarName(n.value+'.'+f)));
  }
  return A(scalarName(n.name),scalarName(n.value));
 });
 const initialize=transform(program.initialize),last=new Map();
 initialize.forEach((n,i)=>{if(n.kind==='set')last.set(n.name,i);});
 return {initialize:initialize.filter((n,i)=>n.kind!=='set'||last.get(n.name)===i),frame:program.frame.map(transform),rootOutputs:program.rootOutputs.map(transform)};
}

export function groupVariables(nodes){
 const convert=value=>typeof value==='string'?value.replace(/\bv\.((?:[bcdsj]|pose)\d+)([a-z]\w*)/g,'v.$1.$2'):value;
 return [nodes].flat(Infinity).map(n=>n.kind==='set'?A(convert(n.name),convert(n.value)):n.kind==='if'?If(convert(n.test),groupVariables(n.yes),groupVariables(n.no)):Loop(convert(n.count),groupVariables(n.body)));
}
