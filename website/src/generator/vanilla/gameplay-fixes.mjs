// Runtime adapter extracted from .local/scripts/gameplay-fixes.mjs; see SOURCE.json.
import {boneOutput} from '../../../vendor/simple-ragdoll/src/core/program.mjs';
import {A,If,axes} from '../../../vendor/simple-ragdoll/src/core/expression.mjs';
import {activeVanillaIds} from './vanilla-animation-stack.mjs';
export function bigHeadFactor(client){
  const ids=activeVanillaIds(client);
  return ids.includes('controller.animation.humanoid.baby_big_head')?'(q.is_baby?1.4:1)':null;
}
export function headBodies(rig){
  const head=rig.bodies.findIndex(b=>b.bone.toLowerCase()==='head'),ids=new Set();
  if(head<0)return ids;
  for(let i=0;i<rig.bodies.length;i++)for(let j=i;j>=0;j=rig.bodies[j].parent)if(j===head){ids.add(i);break;}
  return ids;
}
export function gameplayRig(rig,client){
  if(!bigHeadFactor(client))return rig;const factor='v.vr_head_scale';
  const ids=headBodies(rig);if(!ids.size)return rig;
  const enlarge=s=>({...s,center:s.center.map(n=>`(${n})*${factor}`),half:s.half.map(n=>`(${n})*${factor}`)});
  for(const i of ids){const b=rig.bodies[i];b.shapes=b.shapes.map(enlarge);b.inverseInertia=b.inverseInertia.map(n=>`(${n})/(${factor}*${factor})`);}
  rig.shapes=rig.shapes.map(s=>ids.has(s.body)?enlarge(s):s);
  for(const j of rig.joints)for(const side of ['A','B'])if(ids.has(j[side.toLowerCase()]))j['anchor'+side]=j['anchor'+side].map(n=>`(${n})*${factor}`);
  return rig;
}
export function gameplayProgram(program,rig,entity,client){
  if(!bigHeadFactor(client))return program;const factor='v.vr_head_scale';
  const i=rig.bodies.findIndex(b=>b.bone.toLowerCase()==='head');if(i<0)return program;
  // The selected live appearance stays fixed throughout this ragdoll, just as
  // its geometry profile does. Set before any shape or inertia initialization.
  program.initialize.unshift(A(factor,bigHeadFactor(client)));
  // Capture already used the animated scale to place the center of mass. The
  // visual output must use the same scaled center offset, not shrink it to bind.
  const visual={...rig,bodies:rig.bodies.map((b,j)=>j===i?{...b,modelCenter:b.modelCenter.map((n,k)=>`(${b.pivot[k]})+((${n})-(${b.pivot[k]}))*${factor}`)}:b)};
  const output=boneOutput(visual,i).flat(Infinity);
  program.rootOutputs[i]=output;
  if(rig.bodies[i].parent>=0)program.frameChunks.at(-1).push(If('v.active',output));
  // Physical children such as a piglin's ear or a baby zombie villager's nose
  // inherit the head's visual scale. Convert their centers back through that
  // parent scale, while retaining independent world-space physics.
  for(const child of headBodies(rig))if(child!==i){
    const b=rig.bodies[child],visual={...rig,bodies:rig.bodies.map((v,k)=>k===b.parent?{...v,modelCenter:v.modelCenter.map(n=>`(${n})*${factor}`)}:k===child?{...v,parentTransform:{...v.parentTransform,t:v.parentTransform.t.map(n=>`(${n})*${factor}`)}}:v)};
    const output=boneOutput(visual,child).flat(Infinity).flatMap(n=>n.kind==='set'&&n.name==='t.pivotx'?[...axes.map(k=>A('t.local_center'+k,`t.local_center${k}/${factor}`)),n]:[n]);
    program.frameChunks.at(-1).push(If('v.active',output));
  }
  return program;
}
export function gameplayAnimation(animation,client,names){
  if(!bigHeadFactor(client))return animation;const factor=names.get('v.vr_head_scale');
  if(!factor)throw Error('Missing captured head-scale variable');
  for(const [name,b]of Object.entries(animation.bones))if(name.toLowerCase()==='head')b.scale=b.scale.map(s=>`(${s})*${factor}`);
  return animation;
}
