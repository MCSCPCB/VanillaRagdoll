import { choose } from "./expression.mjs";
import { clientSize } from './space.mjs';
import { apiSettings } from './api.mjs';
import { add, sub, scale, dot, rotate, modelRotation, reflect, reflectRotation, identity, compose, boneTransform } from "./math.mjs";

import { fail } from "../i18n.js";
const number=(v,label,min=-Infinity,max=Infinity)=>typeof v==="number"&&Number.isFinite(v)&&v>=min&&v<=max?v:fail("number",[label,min,max]);
const vec=(v,label)=>Array.isArray(v)&&v.length===3?v.map((n,i)=>number(n,`${label}[${i}]`)):fail("vector",[label]);
const keys=(o,allowed,label)=>{for(const k of Object.keys(o))if(!allowed.includes(k))fail("field",[label,k]);};
const expression=(s,label)=>typeof s==="string"&&s.trim()&&!/[;{}]/.test(s)?s:fail("molang",[label]);
const select=values=>values.every(v=>v===values[0])?values[0]:choose("v.variant",values);
export const OUTPUT_LEVELS=['heavy','medium','light','standard'];
const normalizeAxis=(v,label)=>{const p=vec(v,label),n=Math.hypot(...p);if(n<1e-9)fail("zero_axis",[label]);return p.map(x=>x/n);};

export function settings(input={}) {
  keys(input,["frequency","iterations","contactLimit","gravity","poseTransition","sleep","terrain","initialVelocity","initialSpin"],"simulation");
  const result={frequency:20,iterations:6,contactLimit:128,gravity:9.82,poseTransition:0.4,
    initialVelocity:[0.3,0.1,0.3],initialSpin:0,
    sleep:{speed:0.3125,seconds:0.5,checkInterval:0.5},
    terrain:{includeTags:["minecraft:is_axe_item_destructible","minecraft:is_hoe_item_destructible","minecraft:is_pickaxe_item_destructible","minecraft:is_shovel_item_destructible","not_feature_replaceable"],excludeTags:["water","lava"],friction:0.3,restitution:0},...input};
  result.sleep={speed:0.3125,seconds:0.5,checkInterval:0.5,...input.sleep};
  result.terrain={includeTags:["minecraft:is_axe_item_destructible","minecraft:is_hoe_item_destructible","minecraft:is_pickaxe_item_destructible","minecraft:is_shovel_item_destructible","not_feature_replaceable"],excludeTags:["water","lava"],friction:0.3,restitution:0,...input.terrain};
  keys(result.sleep,["speed","seconds","checkInterval"],"sleep");
  keys(result.terrain,["includeTags","excludeTags","friction","restitution"],"terrain");
  for(const [k,min,max] of [["frequency",5,60],["iterations",1,12],["contactLimit",8,256],["gravity",0,100],["poseTransition",0.001,10],["initialSpin",0,100]])number(result[k],k,min,max);
  for(const k of ["iterations","contactLimit"])if(!Number.isInteger(result[k]))fail("integer",[k]);
  vec(result.initialVelocity,"initialVelocity");
  for(const k of ["speed","seconds","checkInterval"])number(result.sleep[k],`sleep.${k}`,0.001,100);
  for(const key of ["includeTags","excludeTags"]){if(!Array.isArray(result.terrain[key])||result.terrain[key].some(t=>typeof t!=="string"||!/^[\w:.-]+$/.test(t)))fail("tags",[key]);}
  if(!result.terrain.includeTags.length)fail("include_tags");
  number(result.terrain.friction,"terrain.friction",0,10);number(result.terrain.restitution,"terrain.restitution",0,1);
  return result;
}

export function normalizeModel(config,resources,client) {
  keys(config,["$schema","formatVersion","trigger","release","defaults","simulation","bodies","joints","collisionPairs","jointOrder","variants","outputLevel","outputs","api"],"physics");
  const api=apiSettings(config.api);
  if(config.outputs!==undefined&&(!Array.isArray(config.outputs)||config.outputs.some(key=>!['state','bodies','contacts','liquids'].includes(key))))fail('unexpected',[config.outputs]);
  if(config.formatVersion!==1)fail("format");
  if(!OUTPUT_LEVELS.includes(config.outputLevel??'standard'))fail('unexpected',[config.outputLevel]);
  const sim=settings(config.simulation), bodyIds=Object.keys(config.bodies??{});
  if(!bodyIds.length||bodyIds.length>32)fail("body_count");
  if(bodyIds.some(id=>!/^[a-zA-Z_]\w*$/.test(id)))fail("body_id");
  const defaults={friction:0.3,restitution:0,linearDamping:0.01,angularDamping:0.01,density:1,...config.defaults};
  keys(defaults,["friction","restitution","linearDamping","angularDamping","density"],"defaults");
  const variants=config.variants??[{geometry:"default"}];
  if(!variants.length||variants.filter(v=>v.when===undefined).length!==1||variants.at(-1).when!==undefined)fail("variants");
  const bones=bodyIds.map(id=>config.bodies[id].bone), bodyByBone=new Map();
  for(const [i,bone] of bones.entries()){if(typeof bone!=="string"||!bone||bone.includes("'"))fail("bone_name",[bodyIds[i]]);if(bodyByBone.has(bone))fail("duplicate_bone",[bone]);bodyByBone.set(bone,i);}
  const normalized=variants.map((variant,vi)=>{
    keys(variant,["when","geometry","scale","bodies","joints"],`variants[${vi}]`);
    if(variant.when!==undefined)expression(variant.when,"variant.when");
    const geometryId=client.geometry?.[variant.geometry]??variant.geometry,geometry=resources.geometries.get(geometryId);
    if(!geometry)fail("geometry",[geometryId]);
    if(!Object.values(client.geometry??{}).includes(geometryId))fail("geometry_reference",[geometryId]);
    // Legacy variant.scale is accepted for loading, but never changes geometry.
    const boneMap=new Map(geometry.bones.map(b=>[b.name,b]));
    if(boneMap.size!==geometry.bones.length)fail("duplicate_geometry_bone",[geometryId]);
    const visit=(name,trail=[])=>{if(trail.includes(name))fail("bone_cycle",[name]);const b=boneMap.get(name);if(!b)fail("bone_missing",[name]);if(b.parent)visit(b.parent,[...trail,name]);};
    for(const name of boneMap.keys())visit(name);
    for(const key of Object.keys(variant.bodies??{}))if(!bodyIds.includes(key))fail("variant_body",[key]);
    const bodies=bodyIds.map((id,i)=>{
      const input={...config.bodies[id],...variant.bodies?.[id]},bone=boneMap.get(bones[i]);
      if(!bone)fail("bone_in_geometry",[geometryId,bones[i]]);
      keys(input,["bone","center","mass","density","friction","restitution","linearDamping","angularDamping","shapes"],id);
      if(input.bone!==bones[i])fail("variant_binding",[id]);
      const material={...defaults,...input};
      for(const k of ["friction","density"])number(material[k],`${id}.${k}`,k==="density"?0.000001:0,1e9);
      for(const k of ["restitution","linearDamping","angularDamping"])number(material[k],`${id}.${k}`,0,k==="restitution"?1:0.999999);
      const rawShapes=input.shapes??(bone.cubes??[]).filter(c=>c.size.every(n=>n+2*(c.inflate??0)>0)).map(c=>({type:"box",center:add(c.origin,scale(c.size,0.5)),size:c.size.map(n=>n+2*(c.inflate??0)),rotation:c.rotation,pivot:c.pivot}));
      if(!rawShapes.length)fail("empty_shapes",[id]);
      const boxes=rawShapes.map((s,j)=>{
        keys(s,["type","center","size","rotation","pivot"],`${id}.shapes[${j}]`);
        if(s.type!=="box")fail("shape_type",[s.type]);
        const center=vec(s.center,`${id}.shape.center`),size=vec(s.size,`${id}.shape.size`),rotation=vec(s.rotation??[0,0,0],`${id}.shape.rotation`);
        if(size.some(n=>n<=0))fail("shape_size",[id]);
        const q=modelRotation(rotation),pivot=s.pivot?vec(s.pivot,`${id}.shape.pivot`):center;
        return {center:add(pivot,rotate(q,sub(center,pivot))),size,q,volume:size.reduce((a,b)=>a*b,1)};
      });
      const volume=boxes.reduce((n,b)=>n+b.volume,0),center=input.center?vec(input.center,`${id}.center`):[0,1,2].map(k=>boxes.reduce((n,b)=>n+b.center[k]*b.volume,0)/volume);
      const mass=number(input.mass??material.density*volume/16**3,`${id}.mass`,1e-12,1e12);
      const shapes=boxes.map(s=>({center:reflect(sub(s.center,center)),half:scale(s.size,1/2),quaternion:reflectRotation(s.q)}));
      const extents=shapes.map(s=>[0,1,2].map(k=>[0,1,2].reduce((n,a)=>n+Math.abs(rotate(s.quaternion,[0,1,2].map(x=>x===a?1:0))[k])*s.half[a],0)));
      const half=[0,1,2].map(k=>(Math.max(...shapes.map((s,j)=>s.center[k]+extents[j][k]))-Math.min(...shapes.map((s,j)=>s.center[k]-extents[j][k])))/2);
      let parent=bone.parent,parentTransform=identity(),chain=[];
      while(parent&&!bodyByBone.has(parent)){chain.unshift(boneMap.get(parent));parent=boneMap.get(parent).parent;}
      for(const b of chain)parentTransform=compose(parentTransform,boneTransform(b));
      return {id,name:id,bone:bones[i],modelCenter:center,pivot:bone.pivot??[0,0,0],bindRotation:bone.rotation??[0,0,0],parent:parent?bodyByBone.get(parent):-1,parentTransform,
        mass,massFromDensity:Number(input.mass===undefined),inverseMass:1/mass,inverseInertia:half.map((_,k)=>3/(mass*(half[(k+1)%3]**2+half[(k+2)%3]**2))),shapes,
        ...Object.fromEntries(["friction","restitution","linearDamping","angularDamping"].map(k=>[k,material[k]]))};
    });
    const joints=Object.entries(config.joints??{}).map(([id,base])=>{
      const j={...base,...variant.joints?.[id]};
      keys(j,["type","a","b","anchorA","anchorB","axisA","axisB","twistAxisA","twistAxisB","swing","twist","minAngle","maxAngle","transitionAnchorA","transitionAnchorB"],`joint.${id}`);
      if(!["coneTwist","hinge"].includes(j.type))fail("joint_type",[j.type]);
      const a=bodyIds.indexOf(j.a),b=bodyIds.indexOf(j.b);if(a<0||b<0||a===b)fail("joint_body",[id]);
      const anchor=(side,index)=>scale(reflect(j['anchor'+side]?vec(j['anchor'+side],id):sub(bodies[b].pivot,bodies[index].modelCenter)),1/16);
      const axisA=reflect(normalizeAxis(j.axisA??[0,1,0],id)),axisB=reflect(normalizeAxis(j.axisB??j.axisA??[0,1,0],id));
      let twistAxisA=reflect(normalizeAxis(j.twistAxisA??[-1,0,0],id)),twistAxisB=reflect(normalizeAxis(j.twistAxisB??j.twistAxisA??[-1,0,0],id));
      const hinge=Number(j.type==='hinge'),minAngle=number(j.minAngle??-(j.twist??22.5),`${id}.minAngle`,-180,180),maxAngle=number(j.maxAngle??(j.twist??22.5),`${id}.maxAngle`,-180,180);
      if(minAngle>maxAngle)fail('joint_limits',[id]);
      if(hinge){
        const perpendicular=(ref,axis)=>{const p=sub(ref,scale(axis,dot(ref,axis)));if(Math.hypot(...p)<1e-6)fail('joint_axis',[id]);return normalizeAxis(p,id);};
        twistAxisA=perpendicular(twistAxisA,axisA);twistAxisB=perpendicular(twistAxisB,axisB);
      }
      return {id,a,b,anchorA:anchor("A",a),anchorB:anchor("B",b),axisA,axisB,twistAxisA,twistAxisB,
        transitionAnchorA:scale(reflect(vec(j.transitionAnchorA??[0,0,0],id)),1/16),transitionAnchorB:scale(reflect(vec(j.transitionAnchorB??[0,0,0],id)),1/16),
        swing:number(j.swing??45,id,0,180),twist:number(j.twist??22.5,id,0,180),hinge,minAngle,maxAngle};
    });
    for(const key of Object.keys(variant.joints??{}))if(!joints.some(j=>j.id===key))fail("variant_joint",[key]);
    return {geometry:geometryId,when:variant.when,bodies,joints};
  });
  for(const v of normalized.slice(1))for(let i=0;i<bodyIds.length;i++)if(v.bodies[i].shapes.length!==normalized[0].bodies[i].shapes.length||v.bodies[i].parent!==normalized[0].bodies[i].parent)fail("topology");
  const merge=values=>{
    if(Array.isArray(values[0]))return values[0].map((_,i)=>merge(values.map(v=>v[i])));
    if(values[0]&&typeof values[0]==="object")return Object.fromEntries(Object.keys(values[0]).map(k=>[k,merge(values.map(v=>v[k]))]));
    return select(values);
  };
  const bodies=merge(normalized.map(v=>v.bodies)),joints=merge(normalized.map(v=>v.joints));
  const shapes=bodies.flatMap((b,body)=>b.shapes.map((s,part)=>({...s,body,part})));
  const collisionPairs=(config.collisionPairs??[]).map(p=>{
    if(!Array.isArray(p)||p.length!==2)fail("pairs");
    const pair=p.map(id=>bodyIds.indexOf(id));if(pair.some(i=>i<0)||pair[0]===pair[1])fail("pair_reference",[p]);return pair;
  });
  if(new Set(collisionPairs.map(p=>p.slice().sort().join(','))).size!==collisionPairs.length)fail("pair_duplicate");
  const shapePairs=collisionPairs.flatMap(([a,b])=>shapes.flatMap((s,i)=>s.body===a?shapes.flatMap((t,j)=>t.body===b?[[i,j]]:[]):[]));
  const jointOrder=(config.jointOrder??joints.map(j=>j.id)).map(id=>joints.findIndex(j=>j.id===id));
  if(jointOrder.some(i=>i<0)||new Set(jointOrder).size!==joints.length||jointOrder.length!==joints.length)fail("joint_order");
  return {bodies,joints,shapes,shapePairs,jointOrder,variants:normalized,clientSize:clientSize(client),simulation:sim,outputs:config.outputs??[],api,
    trigger:expression(config.trigger??"q.max_health>0&&q.health<q.max_health","trigger"),release:expression(config.release??"q.health>=q.max_health","release")};
}
