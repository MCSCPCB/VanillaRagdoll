import villager from './presets/villager.json' with { type: 'json' };
import signatures from './presets/villager-models.json' with { type: 'json' };
import { normalizeModel } from './core/model.mjs';
import { descriptionOf, relatedAnimations } from './resources.js';
import { fail } from './i18n.js';
import { boneFrames, fitShape, defaultLimits, autoCollisionPairs, inspect, alignJoint, effective, shapePosition, quaternionEuler, SHARED_BODY, SHARED_JOINT } from './rig.js';
import { add, sub, rotate, multiply, modelRotation, conjugate } from './core/math.mjs';
import { automaticBones } from './auto.js';

export const clone=value=>JSON.parse(JSON.stringify(value));
export const modelSignature=g=>JSON.stringify(g.bones.map(b=>({name:b.name,parent:b.parent,pivot:b.pivot??[0,0,0],rotation:b.rotation??[0,0,0],cubes:b.cubes??[]})));
const excluded=/^minecraft:(?:arrow|snowball|egg|ender_pearl|eye_of_ender_signal|fireball|small_fireball|dragon_fireball|wither_skull(?:_dangerous)?|thrown_trident|xp_orb|xp_bottle|item|painting|item_frame|leash_knot|fishing_hook|lightning_bolt|area_effect_cloud|tnt|falling_block|fireworks_rocket|boat|chest_boat|.*minecart|armor_stand)$/;

export function builtInConfig(client,resources){
  if(client.identifier!=='minecraft:villager_v2')return null;
  const config=clone(villager);delete config.$schema;
  for(const variant of config.variants){const geometry=resources.geometries.get(client.geometry[variant.geometry]);if(!geometry||modelSignature(geometry)!==JSON.stringify(signatures[geometry.description.identifier]))return null;}
  return config;
}

export function entityRows(resources){
  return [...resources.clients].map(([id,record])=>{
    const client=descriptionOf(record),missing=Object.values(client.geometry??{}).filter(g=>!resources.geometries.has(g));
    let config=builtInConfig(client,resources),error;
    const unavailable=excluded.test(id)?'unsupported':missing.length||!Object.keys(client.geometry??{}).length?'missing':null;
    if(!config&&!unavailable)try{config=autoConfig(client,resources);}catch(e){error=e.message;}
    return {id,selected:!!config&&!unavailable,config,status:unavailable??(config?'ready':'unconfigured'),missing,...(error?{error}:{})};
  }).sort((a,b)=>a.id.localeCompare(b.id));
}

export function autoConfig(client,resources,variants){
  const aliases=Object.keys(client.geometry),defaultAlias=aliases.includes('default')?'default':aliases[0];
  const models=variants??[{geometry:defaultAlias}];
  const selected=models.map(({scale,...v})=>({...v}));
  const first=resources.geometries.get(client.geometry[selected.at(-1).geometry]);if(!first)fail('geometry',[selected.at(-1).geometry]);
  const bodies={},joints={},used=new Set(),byBone=new Map();
  const {chosen,largest,volume}=automaticBones(selected.map(v=>{const g=resources.geometries.get(client.geometry[v.geometry]);if(!g)fail('geometry',[v.geometry]);return g;}),relatedAnimations(resources,client));
  const byName=new Map(first.bones.map(b=>[b.name,b]));
  for(const bone of first.bones){
    if(!chosen.includes(bone))continue;
    let id=bone.name.replace(/\W/g,'_');if(!/^[a-zA-Z_]/.test(id))id='body_'+id;
    while(used.has(id))id+='_';used.add(id);byBone.set(bone.name,id);
    bodies[id]={bone:bone.name,density:1000};
  }
  const ancestors=bone=>{const result=[];let parent=bone.parent;while(parent){result.push(parent);parent=byName.get(parent)?.parent;}return result;};
  const root=chosen.filter(b=>!ancestors(b).some(name=>byBone.has(name))).sort((a,b)=>volume(b)-volume(a))[0];
  const rootId=byBone.get(root?.name);
  for(const [bone,id] of byBone){let parent=first.bones.find(b=>b.name===bone)?.parent;
    while(parent&&!byBone.has(parent))parent=first.bones.find(b=>b.name===parent)?.parent;
    const a=parent?byBone.get(parent):id===rootId?null:rootId;
    if(a)joints[id]={type:'coneTwist',a,b:id,...defaultLimits(bone)};
  }
  const owners=new Set(byBone.keys());
  const fitted=selected.map(v=>{
    const geometry=resources.geometries.get(client.geometry[v.geometry]),frames=boneFrames(geometry);
    return Object.fromEntries(Object.entries(bodies).map(([id,body])=>[id,[fitShape(geometry,frames,owners,body.bone,largest?.name)]]));
  });
  // The default model stores its boxes on the shared bodies; other models only store their own boxes.
  const config={formatVersion:1,bodies:Object.fromEntries(Object.entries(bodies).map(([id,body])=>[id,{...body,shapes:fitted.at(-1)[id]}])),joints,collisionPairs:[],
    variants:selected.map((v,i)=>i<selected.length-1?{...v,bodies:Object.fromEntries(Object.entries(fitted[i]).map(([id,shapes])=>[id,{shapes}]))}:{...v})};
  // Rotated bones would otherwise start their joints part way into the swing limit.
  const infos=inspect(config,{resources,client});for(const id of Object.keys(joints))alignJoint(config,infos,id);
  config.collisionPairs=autoCollisionPairs(config,{resources,client});
  normalizeModel(config,resources,client);return config;
}

export function variantConfig(config,index){
  const result=clone(config),variant=result.variants[index];
  for(const [id,overrides] of Object.entries(variant.bodies??{}))result.bodies[id]={...result.bodies[id],...overrides};
  for(const [id,overrides] of Object.entries(variant.joints??{}))result.joints[id]={...result.joints[id],...overrides};
  result.variants=[{geometry:variant.geometry}];return result;
}

// Multiple boxes retain their relative layout within the new bone bounds.
function fitBoxes(boxes,source,target){
  if(boxes.length===1)return [target];
  const ratio=target.size.map((n,i)=>n/source.size[i]),from=conjugate(modelRotation(source.rotation)),to=modelRotation(target.rotation);
  return boxes.map(box=>{
    const center=rotate(from,sub(shapePosition(box),source.center)),q=multiply(from,modelRotation(box.rotation??[0,0,0])),inverse=conjugate(q),half=[0,0,0];
    for(let mask=0;mask<8;mask++){
      const corner=rotate(q,box.size.map((n,i)=>n/2*((mask>>i&1)?1:-1)));
      const local=rotate(inverse,corner.map((n,i)=>n*ratio[i]));
      local.forEach((n,i)=>half[i]=Math.max(half[i],Math.abs(n)));
    }
    return {type:'box',center:add(target.center,rotate(to,center.map((n,i)=>n*ratio[i]))),size:half.map(n=>n*2),rotation:quaternionEuler(multiply(to,q))};
  });
}

export function selectModels(config,env,selected){
  if(!selected.length||selected.at(-1).when!==undefined||selected.filter(v=>v.when===undefined).length!==1)fail('variants');
  if(new Set(selected.map(v=>v.geometry)).size!==selected.length)fail('model_duplicate');
  const infos=inspect(config,env),result=clone(config),owners=new Set(Object.values(config.bodies).map(b=>b.bone));
  const local=(base,overrides,shared)=>({...Object.fromEntries(Object.entries(base).filter(([key])=>!shared.includes(key))),...overrides});
  const newIndices=[];
  result.variants=selected.map((selection,index)=>{
    const old=config.variants.findIndex(v=>v.geometry===selection.geometry);
    const geometry=env.resources.geometries.get(env.client.geometry[selection.geometry]??selection.geometry);
    if(!geometry)fail('geometry',[selection.geometry]);
    const variant={...selection,bodies:{},joints:{}};delete variant.scale;
    if(old>=0){
      for(const id of Object.keys(config.bodies))variant.bodies[id]=clone(local(config.bodies[id],config.variants[old].bodies?.[id],SHARED_BODY));
      for(const id of Object.keys(config.joints))variant.joints[id]=clone(local(config.joints[id],config.variants[old].joints?.[id],SHARED_JOINT));
      return variant;
    }
    const source=infos.at(-1),frames=boneFrames(geometry),sourceIndex=infos.length-1;
    for(const [id,body] of Object.entries(config.bodies)){
      if(!frames.has(body.bone))fail('bone_in_geometry',[geometry.description.identifier,body.bone]);
      const before=source.bodies[id],reference=fitShape(source.geometry,source.frames,owners,body.bone);
      const target=fitShape(geometry,frames,owners,body.bone),shapes=fitBoxes(before.shapes,reference,target);
      const values=effective(config,sourceIndex,'bodies',id);
      variant.bodies[id]={...Object.fromEntries(Object.entries(values).filter(([key])=>SHARED_BODY.includes(key)&&key!=='bone')),shapes};
      if(before.explicitMass){
        const volume=boxes=>boxes.reduce((sum,s)=>sum+s.size.reduce((a,b)=>a*b,1),0);
        variant.bodies[id].mass=before.mass*volume(shapes)/volume(before.shapes);
      }
    }
    newIndices.push(index);return variant;
  });
  for(const body of Object.values(result.bodies))for(const key of Object.keys(body))if(!SHARED_BODY.includes(key))delete body[key];
  for(const joint of Object.values(result.joints))for(const key of Object.keys(joint))if(!SHARED_JOINT.includes(key))delete joint[key];
  const after=inspect(result,env);
  for(const index of newIndices)for(const id of Object.keys(result.joints))alignJoint(result,after,id,index);
  const changed=selected.length!==config.variants.length||selected.some(v=>!config.variants.some(old=>old.geometry===v.geometry));
  if(changed){
    const key=p=>[...p].sort().join(),beforePairs=new Set(autoCollisionPairs(config,env).map(key)),existing=new Set((config.collisionPairs??[]).map(key));
    result.collisionPairs=autoCollisionPairs(result,env).filter(p=>!beforePairs.has(key(p))||existing.has(key(p)));
    const included=new Set(result.collisionPairs.map(key));
    for(const pair of config.collisionPairs??[])if(!beforePairs.has(key(pair))&&!included.has(key(pair)))result.collisionPairs.push([...pair]);
  }
  normalizeModel(result,env.resources,env.client);return result;
}
