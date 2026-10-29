import { add, sub, scale, dot, cross, rotate, multiply, conjugate, modelRotation, compose, identity, boneTransform } from './core/math.mjs';
import { normalizeModel } from './core/model.mjs';
import { fail } from './i18n.js';

// Shared fields live on the base entry; geometry-dependent fields (center, mass, shapes, anchors, axes) are stored per model variant.
export const SHARED_BODY=['bone','density','friction','restitution','linearDamping','angularDamping'];
export const SHARED_JOINT=['type','a','b','swing','twist','minAngle','maxAngle'];
const AXES=['axisA','axisB','twistAxisA','twistAxisB'],DEFAULT_AXIS=[0,1,0],DEFAULT_TWIST=[-1,0,0];
const copy=value=>JSON.parse(JSON.stringify(value));
export const fine=v=>v.map(n=>Math.abs(n)<1e-10?0:Number(n.toFixed(10)));
const unit=v=>{const n=Math.hypot(...v);return n<1e-9?null:v.map(x=>x/n);};
const angle=(u,v)=>{const a=unit(u),b=unit(v);return a&&b?Math.acos(Math.max(-1,Math.min(1,dot(a,b))))*180/Math.PI:0;};

export const effective=(config,v,kind,id)=>({...config[kind][id],...config.variants[v][kind]?.[id]});
export function setShared(config,kind,id,key,value){config[kind][id][key]=value;for(const variant of config.variants)delete variant[kind]?.[id]?.[key];}
export function setJointType(config,id,type){
  if(!['coneTwist','hinge'].includes(type))fail('joint_type',[type]);
  const joint=config.joints[id];
  if(type==='hinge'){
    if(joint.minAngle===undefined)setShared(config,'joints',id,'minAngle',-(joint.twist??22.5));
    if(joint.maxAngle===undefined)setShared(config,'joints',id,'maxAngle',joint.twist??22.5);
  }
  setShared(config,'joints',id,'type',type);
}
export function setLocal(config,v,kind,id,key,value){const variant=config.variants[v];((variant[kind]??={})[id]??={})[key]=value;}
export function clearLocal(config,v,kind,id,key){
  const base=config[kind][id];
  if(key in base)config.variants.forEach((variant,i)=>{if(i!==v&&!(key in (variant[kind]?.[id]??{})))setLocal(config,i,kind,id,key,copy(base[key]));});
  delete base[key];delete config.variants[v][kind]?.[id]?.[key];
}
export function clearAll(config,kind,id,keys){for(const key of keys){delete config[kind][id][key];for(const variant of config.variants)delete variant[kind]?.[id]?.[key];}}
export function prune(config){
  for(const variant of config.variants)for(const kind of ['bodies','joints']){
    if(!variant[kind])continue;
    for(const id of Object.keys(variant[kind]))if(!config[kind]?.[id]||!Object.keys(variant[kind][id]).length)delete variant[kind][id];
    if(!Object.keys(variant[kind]).length)delete variant[kind];
  }
  config.collisionPairs=(config.collisionPairs??[]).filter(pair=>pair.every(id=>config.bodies[id]));
  if(config.jointOrder)config.jointOrder=[...config.jointOrder.filter(id=>config.joints[id]),...Object.keys(config.joints).filter(id=>!config.jointOrder.includes(id))];
  return config;
}

export function boneFrames(geometry){
  const bones=new Map(geometry.bones.map(b=>[b.name,b])),frames=new Map();
  const get=(name,trail=new Set())=>{
    if(frames.has(name))return frames.get(name);
    const bone=bones.get(name);if(!bone)fail('bone_missing',[name]);if(trail.has(name))fail('bone_cycle',[name]);trail.add(name);
    const frame=compose(bone.parent?get(bone.parent,trail):identity(),boneTransform(bone));frames.set(name,frame);return frame;
  };
  for(const name of bones.keys())get(name);
  return frames;
}
export const toWorld=(frame,p)=>add(frame.t,rotate(frame.q,p));
export const toLocal=(frame,p)=>rotate(conjugate(frame.q),sub(p,frame.t));
export const defaultShapes=bone=>(bone?.cubes??[]).filter(c=>c.size.every(n=>n+2*(c.inflate??0)>0)).map(c=>({type:'box',center:add(c.origin,scale(c.size,.5)),size:c.size.map(n=>n+2*(c.inflate??0)),rotation:c.rotation??[0,0,0],...(c.pivot?{pivot:c.pivot}:{})}));
export const shapePosition=box=>box.pivot?add(box.pivot,rotate(modelRotation(box.rotation??[0,0,0]),sub(box.center,box.pivot))):[...box.center];

// Derived per-variant values shown by the editor; the config itself keeps automatic fields absent.
export function inspect(config,{resources,client}){
  const rig=normalizeModel(config,resources,client);
  return rig.variants.map((variant,v)=>{
    const geometry=resources.geometries.get(variant.geometry),frames=boneFrames(geometry),bones=new Map(geometry.bones.map(b=>[b.name,b]));
    const bodies=Object.fromEntries(variant.bodies.map(body=>{
      const raw=effective(config,v,'bodies',body.id);
      return [body.id,{id:body.id,bone:body.bone,center:body.modelCenter,pivot:body.pivot,frame:frames.get(body.bone),mass:body.mass,
        shapes:raw.shapes?copy(raw.shapes):defaultShapes(bones.get(body.bone)),explicitMass:raw.mass!==undefined,explicitCenter:raw.center!==undefined,
        density:raw.density??config.defaults?.density??1,friction:body.friction,restitution:body.restitution,linearDamping:body.linearDamping,angularDamping:body.angularDamping}];
    }));
    return {geometry,frames,bones,bodies};
  });
}

export function jointEnds(config,info,v,id){
  const j=effective(config,v,'joints',id),a=info.bodies[j.a],b=info.bodies[j.b];
  if(!a||!b)return null;
  const end=(body,side,axis,twist)=>{
    const local=add(body.center,j['anchor'+side]??sub(b.pivot,body.center));
    return {body,local,world:toWorld(body.frame,local),axis,twist,worldAxis:rotate(body.frame.q,axis),worldTwist:rotate(body.frame.q,twist)};
  };
  return {joint:j,a:end(a,'A',j.axisA??DEFAULT_AXIS,j.twistAxisA??DEFAULT_TWIST),b:end(b,'B',j.axisB??j.axisA??DEFAULT_AXIS,j.twistAxisB??j.twistAxisA??DEFAULT_TWIST)};
}
function matrixQuaternion([x,y,z]){
  const [m00,m10,m20]=x,[m01,m11,m21]=y,[m02,m12,m22]=z,trace=m00+m11+m22;let q;
  if(trace>0){const s=.5/Math.sqrt(trace+1);q=[(m21-m12)*s,(m02-m20)*s,(m10-m01)*s,.25/s];}
  else if(m00>m11&&m00>m22){const s=2*Math.sqrt(1+m00-m11-m22);q=[.25*s,(m01+m10)/s,(m02+m20)/s,(m21-m12)/s];}
  else if(m11>m22){const s=2*Math.sqrt(1+m11-m00-m22);q=[(m01+m10)/s,.25*s,(m12+m21)/s,(m02-m20)/s];}
  else{const s=2*Math.sqrt(1+m22-m00-m11);q=[(m02+m20)/s,(m12+m21)/s,.25*s,(m10-m01)/s];}
  return unit(q);
}
// The joint frame uses the swing axis as +Y and the reversed twist reference as +X, so the default axes give the identity.
export function frameQuaternion(axis,twist){
  const y=unit(axis)??DEFAULT_AXIS;
  const x=unit(sub(scale(y,dot(twist,y)),twist))??unit(cross(y,Math.abs(y[2])<.9?[0,0,1]:[1,0,0]));
  return matrixQuaternion([x,y,cross(x,y)]);
}
// Inverse of modelRotation: q = Rz(-z) Ry(y) Rx(-x).
export function quaternionEuler([x,y,z,w]){
  const m20=2*(x*z-y*w),b=Math.asin(Math.max(-1,Math.min(1,-m20)));let a,c;
  if(Math.abs(m20)<.9999999){a=Math.atan2(2*(y*z+x*w),1-2*(x*x+y*y));c=Math.atan2(2*(x*y+z*w),1-2*(y*y+z*z));}
  else{a=0;c=Math.atan2(-2*(x*y-z*w),1-2*(x*x+z*z));}
  return fine([-a,b,-c].map(n=>n*180/Math.PI));
}
// Blockbench shows geometry with X mirrored; these conversions are their own inverses.
export const displayVector=p=>[-p[0],p[1],p[2]];
export const displayRotation=r=>[-r[0],-r[1],r[2]];

export function jointFrame(config,info,v,id){
  const ends=jointEnds(config,info,v,id);if(!ends)return null;
  const {a,b}=ends,quaternion=frameQuaternion(b.axis,b.twist);
  const mismatch=Math.hypot(...sub(a.world,b.world))>1e-3||angle(a.worldAxis,b.worldAxis)>.5||angle(a.worldTwist,b.worldTwist)>.5;
  return {ends,bone:b.body.bone,position:b.local,quaternion,rotation:quaternionEuler(quaternion),mismatch};
}
// Edits apply to the child end; the parent end keeps any existing offset from it.
export function setJointPosition(config,infos,v,id,position){
  const {a,b}=jointEnds(config,infos[v],v,id),offset=sub(a.world,b.world),world=toWorld(b.body.frame,position);
  setLocal(config,v,'joints',id,'anchorB',fine(sub(position,b.body.center)));
  setLocal(config,v,'joints',id,'anchorA',fine(sub(toLocal(a.body.frame,Math.hypot(...offset)<1e-6?world:add(world,offset)),a.body.center)));
}
export function setJointRotation(config,infos,v,id,target){
  const current=jointEnds(config,infos[v],v,id),delta=multiply(target,conjugate(frameQuaternion(current.b.axis,current.b.twist)));
  infos.forEach((info,i)=>{
    const ends=jointEnds(config,info,i,id);if(!ends)return;
    const {a,b}=ends,world=multiply(multiply(b.body.frame.q,delta),conjugate(b.body.frame.q)),inA=multiply(multiply(conjugate(a.body.frame.q),world),a.body.frame.q),offset=sub(a.world,b.world);
    setLocal(config,i,'joints',id,'axisB',fine(rotate(delta,b.axis)));setLocal(config,i,'joints',id,'twistAxisB',fine(rotate(delta,b.twist)));
    setLocal(config,i,'joints',id,'axisA',fine(rotate(inA,a.axis)));setLocal(config,i,'joints',id,'twistAxisA',fine(rotate(inA,a.twist)));
    if(Math.hypot(...offset)>1e-6)setLocal(config,i,'joints',id,'anchorA',fine(sub(toLocal(a.body.frame,add(b.world,rotate(world,offset))),a.body.center)));
  });
}
export const resetJointRotation=(config,id)=>clearAll(config,'joints',id,AXES);
export function resetJointPosition(config,v,id){clearLocal(config,v,'joints',id,'anchorA');clearLocal(config,v,'joints',id,'anchorB');}
export function alignJoint(config,infos,id,only){
  infos.forEach((info,i)=>{
    if(only!==undefined&&i!==only)return;
    const frame=jointFrame(config,info,i,id);if(!frame?.mismatch)return;
    const {a,b}=frame.ends,inverse=conjugate(a.body.frame.q);
    setLocal(config,i,'joints',id,'anchorA',fine(sub(toLocal(a.body.frame,b.world),a.body.center)));
    setLocal(config,i,'joints',id,'axisA',fine(rotate(inverse,b.worldAxis)));setLocal(config,i,'joints',id,'twistAxisA',fine(rotate(inverse,b.worldTwist)));
    // Missing child axes fall back to the parent axes, so the child end is written too.
    setLocal(config,i,'joints',id,'axisB',fine(b.axis));setLocal(config,i,'joints',id,'twistAxisB',fine(b.twist));
  });
}
// Explicit anchors are stored relative to the body center; keep their positions when an edit moves the center.
export function keepAnchors(config,before,after){
  after.forEach((info,i)=>{
    const old=before[i];if(!old)return;
    for(const id of Object.keys(config.joints??{})){
      const j=effective(config,i,'joints',id);
      for(const side of ['A','B']){
        const body=j[side.toLowerCase()],anchor=j['anchor'+side];if(!anchor||!old.bodies[body]||!info.bodies[body])continue;
        const delta=sub(info.bodies[body].center,old.bodies[body].center);
        if(Math.hypot(...delta)>1e-9)setLocal(config,i,'joints',id,'anchor'+side,fine(sub(anchor,delta)));
      }
    }
  });
}

export const defaultLimits=bone=>({swing:/head|neck/i.test(bone)?35:/leg|arm/i.test(bone)?60:45,twist:/leg|arm/i.test(bone)?15:22.5});
export function setBody(config,v,id,key,value){if(SHARED_BODY.includes(key))setShared(config,'bodies',id,key,value);else setLocal(config,v,'bodies',id,key,value);}
// Switching back to density keeps the current mass by deriving the density from it.
export function setMassMode(config,infos,v,id,mode){
  const body=infos[v].bodies[id];
  if(mode==='mass'){setLocal(config,v,'bodies',id,'mass',Number(body.mass.toPrecision(6)));return;}
  const volume=body.shapes.reduce((n,s)=>n+s.size.reduce((a,b)=>a*b,1),0)/16**3;
  clearLocal(config,v,'bodies',id,'mass');
  if(volume>0)setShared(config,'bodies',id,'density',Number((body.mass/volume).toPrecision(6)));
}
// Shape counts must match across variants, so the first shape edit gives every variant its own list.
function ownShapes(config,infos,id){
  infos.forEach((info,i)=>{if(!config.variants[i].bodies?.[id]?.shapes)setLocal(config,i,'bodies',id,'shapes',copy(info.bodies[id].shapes));});
  delete config.bodies[id].shapes;
}
export function setShape(config,infos,v,id,index,value){
  ownShapes(config,infos,id);
  const box=config.variants[v].bodies[id].shapes[index];
  if(value.position||value.rotation){const position=value.position??shapePosition(box);box.center=fine(position);box.rotation=fine(value.rotation??box.rotation??[0,0,0]);delete box.pivot;}
  if(value.size)box.size=fine(value.size.map(n=>Math.max(.01,n)));
}
export function addShape(config,infos,id){
  ownShapes(config,infos,id);
  infos.forEach((info,i)=>config.variants[i].bodies[id].shapes.push({type:'box',center:fine(info.bodies[id].center),size:[2,2,2],rotation:[0,0,0]}));
  return config.variants[0].bodies[id].shapes.length-1;
}
export function removeShape(config,infos,id,index){
  ownShapes(config,infos,id);
  if(config.variants[0].bodies[id].shapes.length===1)fail('last_shape');
  for(const variant of config.variants)variant.bodies[id].shapes.splice(index,1);
}
export function refitShapes(config,infos,id){
  const owners=new Set(Object.values(config.bodies).map(b=>b.bone));
  infos.forEach((info,i)=>setLocal(config,i,'bodies',id,'shapes',[fitShape(info.geometry,info.frames,owners,config.bodies[id].bone)]));
  delete config.bodies[id].shapes;
}
// One box around the cubes of a bone and of descendant bones without their own body.
export function fitShape(geometry,frames,owners,bone,fallback){
  const byName=new Map(geometry.bones.map(b=>[b.name,b])),dest=frames.get(bone),points=[];
  let dominant=[0,0,0,1],largestVolume=0;
  for(const source of geometry.bones){
    let owner=source.name;while(owner&&!owners.has(owner))owner=byName.get(owner)?.parent;
    if((owner??fallback)!==bone)continue;
    const frame=frames.get(source.name);
    for(const cube of source.cubes??[]){
      if(!cube.size.every(n=>n+2*(cube.inflate??0)>0))continue;
      const center=add(cube.origin,scale(cube.size,.5)),pivot=cube.pivot??center,q=modelRotation(cube.rotation??[0,0,0]);
      const volume=cube.size.reduce((n,size)=>n*Math.max(0,size+2*(cube.inflate??0)),1);
      if(volume>largestVolume){largestVolume=volume;dominant=multiply(conjugate(dest.q),multiply(frame.q,q));}
      for(let mask=0;mask<8;mask++){const corner=center.map((n,i)=>n+((mask>>i&1)?1:-1)*(cube.size[i]/2+(cube.inflate??0)));points.push(toLocal(dest,toWorld(frame,add(pivot,rotate(q,sub(corner,pivot))))));}
    }
  }
  if(!points.length)return {type:'box',center:[...(byName.get(bone)?.pivot??[0,0,0])],size:[2,2,2],rotation:[0,0,0]};
  const min=[0,1,2].map(i=>Math.min(...points.map(p=>p[i]))),max=[0,1,2].map(i=>Math.max(...points.map(p=>p[i])));
  const box={type:'box',center:min.map((n,i)=>(n+max[i])/2),size:min.map((n,i)=>Math.max(.1,max[i]-n)),rotation:[0,0,0]};
  // A rotated cube should not become a much larger axis-aligned collider. Try its
  // dominant cube's orientation while still enclosing every owned cube in one box.
  const rotation=quaternionEuler(dominant),q=modelRotation(rotation),aligned=points.map(p=>rotate(conjugate(q),p));
  const lo=[0,1,2].map(i=>Math.min(...aligned.map(p=>p[i]))),hi=[0,1,2].map(i=>Math.max(...aligned.map(p=>p[i])));
  const size=lo.map((n,i)=>Math.max(.1,hi[i]-n));
  if(size.reduce((a,b)=>a*b,1)<box.size.reduce((a,b)=>a*b,1)*.99)return {type:'box',center:rotate(q,lo.map((n,i)=>(n+hi[i])/2)),size,rotation};
  return box;
}
const uniqueId=(base,taken)=>{let id=base.replace(/\W/g,'_');if(!/^[a-zA-Z_]/.test(id))id='body_'+id;while(taken[id])id+='_';return id;};
const isAncestor=(bones,ancestor,name)=>{let b=bones.get(name)?.parent;while(b){if(b===ancestor)return true;b=bones.get(b)?.parent;}return false;};
export function nearestBody(config,bones,name){let b=bones.get(name)?.parent;while(b){const id=Object.keys(config.bodies).find(k=>config.bodies[k].bone===b);if(id)return id;b=bones.get(b)?.parent;}return null;}
const PARENT_END=['anchorA','axisA','twistAxisA','transitionAnchorA'],ENDS=[...PARENT_END,'anchorB','axisB','twistAxisB','transitionAnchorB'];
// A new body joins its nearest body ancestor and takes over the joints of bodies below its bone.
export function addBody(config,env,bone){
  if(Object.keys(config.bodies).length>=32)fail('body_count');
  if(Object.values(config.bodies).some(b=>b.bone===bone))fail('duplicate_bone',[bone]);
  const infos=inspect(config,env),bones=infos.at(-1).bones;if(!bones.has(bone))fail('bone_missing',[bone]);
  const id=uniqueId(bone,config.bodies),parent=nearestBody(config,bones,bone),owners=new Set([...Object.values(config.bodies).map(b=>b.bone),bone]),moved=[];
  for(const [jid,j] of Object.entries(config.joints))if(parent&&j.a===parent&&isAncestor(bones,bone,config.bodies[j.b].bone)){setShared(config,'joints',jid,'a',id);clearAll(config,'joints',jid,PARENT_END);moved.push(jid);}
  config.bodies[id]={bone,density:Object.values(config.bodies).find(b=>b.density!==undefined)?.density??1000};
  infos.forEach((info,i)=>setLocal(config,i,'bodies',id,'shapes',[fitShape(info.geometry,info.frames,owners,bone)]));
  if(parent){const jid=uniqueId(bone,config.joints);config.joints[jid]={type:'coneTwist',a:parent,b:id,...defaultLimits(bone)};moved.push(jid);}
  prune(config);
  const after=inspect(config,env);for(const jid of moved)alignJoint(config,after,jid);
  config.collisionPairs=[...(config.collisionPairs??[]),...autoCollisionPairs(config,env).filter(p=>p.includes(id))];
  return id;
}
// Joints below a removed body are reconnected to its parent body.
export function removeBody(config,env,id){
  if(Object.keys(config.bodies).length===1)fail('last_body');
  const parent=Object.values(config.joints).find(j=>j.b===id)?.a,moved=[];
  for(const [jid,j] of Object.entries(config.joints)){
    if(j.b===id||j.a===id&&(!parent||parent===j.b)){delete config.joints[jid];continue;}
    if(j.a===id){setShared(config,'joints',jid,'a',parent);clearAll(config,'joints',jid,PARENT_END);moved.push(jid);}
  }
  delete config.bodies[id];prune(config);
  const after=inspect(config,env);for(const jid of moved)alignJoint(config,after,jid);
}
export function dropBodies(config,ids){
  for(const id of ids)delete config.bodies[id];
  for(const [jid,j] of Object.entries(config.joints))if(!config.bodies[j.a]||!config.bodies[j.b])delete config.joints[jid];
  return prune(config);
}
// Changing either body resets both ends to the automatic frame at the child bone pivot.
export function setJointBody(config,infos,id,side,value){
  const j=config.joints[id],a=side==='a'?value:j.a,b=side==='b'?value:j.b;
  if(a===b||!config.bodies[value])fail('joint_body',[id]);
  if(Object.entries(config.joints).some(([other,x])=>other!==id&&[x.a,x.b].sort().join()===[a,b].sort().join()))fail('joint_duplicate');
  setShared(config,'joints',id,side,value);clearAll(config,'joints',id,ENDS);alignJoint(config,infos,id);
}
export function addJoint(config,infos,a,b){
  if(a===b||!config.bodies[a]||!config.bodies[b])fail('joint_body',[b]);
  if(Object.values(config.joints).some(j=>[j.a,j.b].sort().join()===[a,b].sort().join()))fail('joint_duplicate');
  const id=uniqueId(b,config.joints);config.joints[id]={type:'coneTwist',a,b,...defaultLimits(config.bodies[b].bone)};
  alignJoint(config,infos,id);return id;
}
export function removeJoint(config,id){delete config.joints[id];prune(config);}
export function setCollision(config,a,b,enabled){
  config.collisionPairs=(config.collisionPairs??[]).filter(p=>!(p.includes(a)&&p.includes(b)));
  if(enabled)config.collisionPairs.push([a,b]);
}

function worldBoxes(info,id){
  const body=info.bodies[id];
  return body.shapes.map(s=>{const q=multiply(body.frame.q,modelRotation(s.rotation??[0,0,0]));return {center:toWorld(body.frame,shapePosition(s)),half:scale(s.size,.5),axes:[[1,0,0],[0,1,0],[0,0,1]].map(e=>rotate(q,e))};});
}
// Largest projected gap over the separating axes; negative values are penetration depths.
function separation(a,b){
  const d=sub(b.center,a.center),axes=[...a.axes,...b.axes];
  for(const u of a.axes)for(const w of b.axes)axes.push(cross(u,w));
  const radius=(box,n)=>box.axes.reduce((s,u,k)=>s+Math.abs(dot(u,n))*box.half[k],0);
  let gap=-Infinity;
  for(const axis of axes){const n=unit(axis);if(n)gap=Math.max(gap,Math.abs(dot(d,n))-radius(a,n)-radius(b,n));}
  return gap;
}
// Shared pairs must avoid initial overlap in every model. Resting distance does not limit later contact.
export function autoCollisionPairs(config,env){
  const infos=inspect({...config,collisionPairs:[]},env),ids=Object.keys(config.bodies);
  const models=infos.map(info=>Object.fromEntries(ids.map(id=>[id,worldBoxes(info,id)])));
  const jointed=new Set(Object.values(config.joints??{}).map(j=>[j.a,j.b].sort().join()));
  const pairs=[];
  for(let i=0;i<ids.length;i++)for(let k=i+1;k<ids.length;k++){
    const threshold=jointed.has([ids[i],ids[k]].sort().join())?.05:-.05;
    if(models.every(boxes=>boxes[ids[i]].every(a=>boxes[ids[k]].every(b=>separation(a,b)>threshold))))pairs.push([ids[i],ids[k]]);
  }
  return pairs;
}
