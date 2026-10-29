import {A,If,Loop,choose,dispatch} from './expression.mjs';
import {parseExpression} from './parse.mjs';
const expr=e=>e.kind==='value'?typeof e.value==='string'?"'"+e.value+"'":String(e.value):e.kind==='read'?e.path.join('.'):e.kind==='call'?e.path.join('.')+'('+e.args.map(expr).join(',')+')':e.kind==='unary'?'('+e.op+expr(e.value)+')':e.kind==='binary'?'('+expr(e.left)+e.op+expr(e.right)+')':'('+expr(e.test)+'?'+expr(e.yes)+':'+expr(e.no)+')';
const same=a=>a.every(x=>JSON.stringify(x)===JSON.stringify(a[0]));
function mergeExpr(values,index,parameter){
 if(same(values))return expr(values[0]);
 if(parameter&&values.every(v=>v.kind==='value'&&typeof v.value==='number'))return parameter(values.map(v=>v.value));
 const first=values[0],kind=first.kind;
 if(values.some(v=>v.kind!==kind))return choose(index,values.map(expr));
 // Bedrock requires a direct variable to the left of ??, never a selector.
 if(kind==='binary'&&first.op==='??'&&!same(values.map(v=>v.left)))return choose(index,values.map(expr));
 const merge=values=>mergeExpr(values,index,parameter);
 if(kind==='binary'&&values.every(v=>v.op===first.op))return '('+merge(values.map(v=>v.left))+first.op+merge(values.map(v=>v.right))+')';
 if(kind==='unary'&&values.every(v=>v.op===first.op))return '('+first.op+merge(values.map(v=>v.value))+')';
 if(kind==='call'&&values.every(v=>v.path.join('.')===first.path.join('.')&&v.args.length===first.args.length))return first.path.join('.')+'('+first.args.map((_,i)=>merge(values.map(v=>v.args[i]))).join(',')+')';
 if(kind==='if')return '('+merge(values.map(v=>v.test))+'?'+merge(values.map(v=>v.yes))+':'+merge(values.map(v=>v.no))+')';
 return choose(index,values.map(expr));
}
export function mergeGroups(groups,index,parameter){
 if(!groups.length)return [];
 groups=groups.map(g=>[g].flat(Infinity));
 if(same(groups))return groups[0];
 if(groups.some(g=>g.length!==groups[0].length))return alignedMerge(groups,index,parameter);
 const merge=values=>same(values)?values[0]:mergeExpr(values.map(parseExpression),index,parameter);
 return groups[0].map((first,i)=>{
  const nodes=groups.map(g=>g[i]);if(same(nodes))return first;
  if(nodes.some(n=>n.kind!==first.kind)||first.kind==='set'&&!nodes.every(n=>n.name===first.name))return dispatch(index,nodes,n=>n);
  if(first.kind==='set'){
   return A(first.name,merge(nodes.map(n=>n.value)));
  }
  if(first.kind==='if')return If(merge(nodes.map(n=>n.test)),mergeGroups(nodes.map(n=>n.yes),index,parameter),mergeGroups(nodes.map(n=>n.no),index,parameter));
  return Loop(merge(nodes.map(n=>n.count)),mergeGroups(nodes.map(n=>n.body),index,parameter));
 });
}

// Align ordered statements instead of duplicating an entire block when one
// profile has extra work. Missing statements are guarded by the profile index.
function alignedMerge(groups,index,parameter){
 const key=n=>n.kind==='set'?'set:'+n.name:n.kind;
 let columns=groups[0].map(n=>[n]),budget=16000000;
 for(let g=1;g<groups.length;g++){
  const a=columns,b=groups[g],m=a.length,n=b.length,w=n+1,cells=(m+1)*w;
  // Unusually large authored models must not make export allocate an
  // unbounded alignment matrix. Whole-block dispatch is always valid.
  if(cells>4000000||(budget-=cells)<0)return dispatch(index,groups,g=>g);
  const left=a.map(c=>key(c.find(Boolean))),right=b.map(key),dp=new Uint32Array(cells);
  for(let i=m-1;i>=0;i--)for(let j=n-1;j>=0;j--)
   dp[i*w+j]=left[i]===right[j]?1+dp[(i+1)*w+j+1]:Math.max(dp[(i+1)*w+j],dp[i*w+j+1]);
  const next=[];let i=0,j=0;
  while(i<m||j<n){
   if(i<m&&j<n&&left[i]===right[j])next.push([...a[i++],b[j++]]);
   else if(i<m&&(j>=n||dp[(i+1)*w+j]>=dp[i*w+j+1]))next.push([...a[i++],null]);
   else next.push([...Array(g).fill(null),b[j++]]);
  }
  columns=next;
 }
 return columns.flatMap(column=>{
  const present=column.flatMap((n,i)=>n?[i]:[]),fallback=column.find(Boolean);
  const merged=mergeGroups(column.map(n=>[n??fallback]),index,parameter);
  return present.length===column.length?merged:If(present.map(i=>index+'=='+i).join('||'),merged);
 });
}

export function parameterMerger(index){
 const parameters=[],byValues=new Map();
 const parameter=values=>{
  const key=JSON.stringify(values);
  if(!byValues.has(key)){
   const name='v.compute_parameter_'+parameters.length;
   byValues.set(key,name);parameters.push({name,values});
  }
  return byValues.get(key);
 };
 return {parameters,
  value:values=>same(values)?values[0]:mergeExpr(values.map(parseExpression),index,parameter),
  merge:groups=>mergeGroups(groups,index,parameter),
 };
}
