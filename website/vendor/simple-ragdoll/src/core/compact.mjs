import {A,If,Loop,choose,dispatch,axes,quat} from './expression.mjs';
import {mergeGroups} from './merge.mjs';
function rewrite(nodes,replace){
 return [nodes].flat(Infinity).map(n=>n.kind==='set'?A(replace(n.name),typeof n.value==='string'?replace(n.value):n.value):n.kind==='if'?If(replace(n.test),rewrite(n.yes,replace),rewrite(n.no,replace)):Loop(typeof n.count==='string'?replace(n.count):n.count,rewrite(n.body,replace)));
}
export function compactBegin(rig,original,capture,act,fallback=[]){
 const index='t.activation_index',bodies=rig.bodies,bodyIds=bodies.map((_,i)=>i),joints=rig.joints,jointIds=joints.map((_,i)=>i);
 const captureGroups=capture.at(-1).map((g,i)=>rewrite(g,s=>s.replace(new RegExp('v\\.pose'+i+'([a-z]\\w*)','g'),'v.capture_pose.$1')));
 const newCapture=[capture.slice(0,-1),A(index,0),Loop(bodies.length,[A('v.capture_pose',0),mergeGroups(captureGroups,index),dispatch(index,bodyIds,i=>A('v.pose'+i,'v.capture_pose')),A(index,index+'+1')])];
 const bodyGroup=(groups,readPose)=>{
  const transformed=groups.map((g,i)=>rewrite(g,s=>s.replace(new RegExp('v\\.b'+i+'([a-z]\\w*)','g'),'v.activate_body.$1').replace(new RegExp('v\\.pose'+i+'([a-z]\\w*)','g'),'v.activate_pose.$1')));
  return [A(index,0),Loop(bodies.length,[
   A('v.activate_body',choose(index,bodyIds.map(i=>'v.b'+i))),...(readPose?[A('v.activate_pose',choose(index,bodyIds.map(i=>'v.pose'+i)))]:[]),
   mergeGroups(transformed,index),dispatch(index,bodyIds,i=>A('v.b'+i,'v.activate_body')),A(index,index+'+1'),
  ])];
 };
 act[4]=bodyGroup(act[4],true);
 const jointGroups=act[5].map((g,i)=>rewrite(g,s=>s.replace(new RegExp('v\\.j'+i+'([a-z]\\w*)','g'),'v.activate_joint.$1').replace(new RegExp('v\\.b'+joints[i].a+'([a-z]\\w*)','g'),'v.activate_ja.$1').replace(new RegExp('v\\.b'+joints[i].b+'([a-z]\\w*)','g'),'v.activate_jb.$1')));
 act[5]=joints.length?[A(index,0),Loop(joints.length,[
  A('v.activate_joint',choose(index,jointIds.map(i=>'v.j'+i))),A('v.activate_ja',choose(index,joints.map(j=>'v.b'+j.a))),A('v.activate_jb',choose(index,joints.map(j=>'v.b'+j.b))),
  mergeGroups(jointGroups,index),dispatch(index,jointIds,i=>A('v.j'+i,'v.activate_joint')),A(index,index+'+1'),
 ])]:[];
 act[act.length-1]=bodyGroup(act.at(-1),false);
 const begin=structuredClone(original);
 const inactive=begin.find(n=>n.kind==='if'&&n.test==='!v.active');
 inactive.yes.find(n=>n.kind==='if'&&n.test==='v.frames>0').yes=[newCapture,fallback].flat(Infinity);
 inactive.yes.find(n=>n.kind==='if'&&n.test!=='v.frames>0').yes=act.flat(Infinity);
 return begin;
}

export function compactOutput(rig,boneOutput){
const children=rig.bodies.flatMap((b,i)=>b.parent>=0?[i]:[]);
 if(!children.length)return [];
const merge=values=>{
 if(Array.isArray(values[0]))return values[0].map((_,i)=>merge(values.map(v=>v[i])));
 if(values[0]&&typeof values[0]==='object')return Object.fromEntries(Object.keys(values[0]).map(k=>[k,merge(values.map(v=>v[k]))]));
 return choose('t.output_index',values);
};
const fields=['modelCenter','pivot','parentTransform','bindRotation'];
const pick=body=>Object.fromEntries(fields.map(k=>[k,body[k]]));
const fakeBodies=[merge(children.map(i=>pick(rig.bodies[i]))),merge(children.map(i=>pick(rig.bodies[rig.bodies[i].parent])))];fakeBodies[0].parent=1;
const mapNodes=(nodes,replace)=>[nodes].flat(Infinity).map(n=>n.kind==='set'?{...n,name:replace(n.name),value:typeof n.value==='string'?replace(n.value):n.value}:n.kind==='if'?{...n,test:replace(n.test),yes:mapNodes(n.yes,replace),no:mapNodes(n.no,replace)}:{...n,count:typeof n.count==='string'?replace(n.count):n.count,body:mapNodes(n.body,replace)});
const genericOutput=mapNodes(boneOutput({bodies:fakeBodies},0),s=>s.replace(/v\.render([01])(\w+)/g,'v.output_render$1$2').replace(/v\.out0(\w+)/g,'t.output_result$1'));
const outputFields=axes.map(k=>'p'+k).concat(axes.map(k=>'r'+k));
const output=[A('t.output_index',0),Loop(children.length,[
 ...[0,1].flatMap(p=>[...axes,...quat.map(k=>'q'+k)].map(k=>A('v.output_render'+p+k,choose('t.output_index',children.map(i=>'v.render'+(p?rig.bodies[i].parent:i)+k))))),
 genericOutput,dispatch('t.output_index',children,i=>outputFields.map(k=>A('v.out'+i+k,'t.output_result'+k))),A('t.output_index','t.output_index+1'),
])];

 return output;
}
