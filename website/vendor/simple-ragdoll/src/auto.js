import { boneFrames, toLocal, toWorld } from './rig.js';
import { add, sub, scale, rotate, modelRotation } from './core/math.mjs';

// Inflate also builds outlines and glow shells. Use authored volume to select
// bodies; the fitted collider accounts for inflate after the selection.
const volume=bone=>(bone.cubes??[]).reduce((n,c)=>n+(c.size.every(s=>s>0&&s+2*(c.inflate??0)>0)?c.size.reduce((a,b)=>a*b,1):0),0);
const decorative=/(?:nose|hat|brim|eyebrow|eyelash|teeth|tooth|finger|thumb|decoration|accessory)/i;

function modelInfo(geometry){
  const frames=boneFrames(geometry),bones=new Map(geometry.bones.map(b=>[b.name,b]));
  const volumes=new Map(geometry.bones.map(b=>[b.name,volume(b)])),totals=new Map(volumes),parents=new Map();
  for(const bone of geometry.bones){
    let parent=bone.parent;
    while(parent){totals.set(parent,totals.get(parent)+volumes.get(bone.name));parent=bones.get(parent).parent;}
    parent=bone.parent;while(parent&&!volumes.get(parent))parent=bones.get(parent).parent;
    parents.set(bone.name,parent);
  }
  return {frames,bones,volumes,totals,parents,largest:Math.max(0,...volumes.values())};
}

// Compare actual cube bounds in the parent's frame. Inflate is deliberately ignored:
// a skin or clothing layer often repeats the same cube with a different inflate.
function bounds(info,name,dest){
  const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(const cube of info.bones.get(name).cubes??[]){
    if(!cube.size.every(n=>n+2*(cube.inflate??0)>0))continue;
    const center=add(cube.origin,scale(cube.size,.5)),pivot=cube.pivot??center,q=modelRotation(cube.rotation??[0,0,0]);
    for(let mask=0;mask<8;mask++){
      const corner=center.map((n,i)=>n+((mask>>i&1)?1:-1)*cube.size[i]/2);
      const point=toLocal(dest,toWorld(info.frames.get(name),add(pivot,rotate(q,sub(corner,pivot)))));
      for(let i=0;i<3;i++){min[i]=Math.min(min[i],point[i]);max[i]=Math.max(max[i],point[i]);}
    }
  }
  return {size:sub(max,min),center:scale(add(min,max),.5)};
}
function overlapsParent(info,name){
  const parent=info.parents.get(name);if(!parent)return false;
  const dest=info.frames.get(parent),a=bounds(info,parent,dest),b=bounds(info,name,dest);
  return a.size.every((size,i)=>Math.min(size,b.size[i])>=Math.max(size,b.size[i])*.8&&Math.abs(a.center[i]-b.center[i])<=Math.max(size,b.size[i])*.1);
}
function smallBranch(info,name){
  const parent=info.parents.get(name);if(!parent)return false;
  const total=info.totals.get(name),parentVolume=info.volumes.get(parent);
  // Judge the whole branch, so a thin connector to a large limb is retained.
  // Empty grouping bones must not make a tiny ear or fingertip escape this check.
  return total<parentVolume*.04||total<info.largest*.01&&total<parentVolume*.2;
}

function changesChannel(value,rest){
  if(value===undefined)return false;
  if(Array.isArray(value))return value.some(v=>changesChannel(v,rest));
  if(value&&typeof value==='object')return Object.entries(value).some(([k,v])=>(k==='pre'||k==='post'||Number.isFinite(Number(k)))&&changesChannel(v,rest));
  return !Number.isFinite(Number(value))||Number(value)!==rest;
}

export function automaticBones(geometries,animations={}){
  const infos=geometries.map(modelInfo),info=infos.at(-1),geometry=geometries.at(-1);
  const candidates=geometry.bones.filter(b=>infos.every(i=>i.volumes.get(b.name)>0));
  // Coincident geometry can also be a retractable mechanism or an opening jaw.
  // Retain such bones when the pack actually animates them independently.
  const animated=new Set();
  for(const animation of Object.values(animations))for(const [name,channels]of Object.entries(animation.bones??{})){
    if(changesChannel(channels.position,0)||changesChannel(channels.rotation,0)||changesChannel(channels.scale,1))animated.add(name.toLowerCase());
  }
  const distinct=candidates.filter(b=>animated.has(b.name.toLowerCase())||!infos.every(i=>overlapsParent(i,b.name)));
  const largest=distinct.slice().sort((a,b)=>info.volumes.get(b.name)-info.volumes.get(a.name))[0];
  const chosen=new Set(distinct.filter(b=>b===largest||!decorative.test(b.name)&&!infos.every(i=>smallBranch(i,b.name))).map(b=>b.name));
  const connectors=new Set(distinct.filter(b=>!decorative.test(b.name)).map(b=>b.name));
  for(const name of [...chosen]){let p=info.bones.get(name).parent;while(p){if(connectors.has(p))chosen.add(p);p=info.bones.get(p).parent;}}

  // Reduce distal branches before their supporting ancestors. Removing equal-size
  // tips together avoids taking arbitrary left/right bones at the 32-body boundary.
  const protectedBones=new Set();let ancestor=largest?.name;
  while(ancestor){protectedBones.add(ancestor);ancestor=info.bones.get(ancestor).parent;}
  const priorities=new Map(),identity={q:[0,0,0,1],t:[0,0,0]};
  const centerX=largest?bounds(info,largest.name,identity).center[0]:0;
  const priority=name=>{
    if(!priorities.has(name)){
      let depth=0,p=info.bones.get(name).parent;while(p){depth++;p=info.bones.get(p).parent;}
      const [x,y,z]=bounds(info,name,identity).center;
      priorities.set(name,[-depth,Math.abs(x-centerX),y,z].map(n=>Math.round(n*1e6)/1e6));
    }
    return priorities.get(name);
  };
  while(chosen.size>32){
    const parents=new Set();
    for(const name of chosen){let p=info.bones.get(name).parent;while(p&&!chosen.has(p))p=info.bones.get(p).parent;if(p)parents.add(p);}
    const tips=[...chosen].filter(name=>!parents.has(name)&&!protectedBones.has(name));
    if(!tips.length){
      // A single long chain can exceed the budget by itself; merge its smallest
      // intermediate connection while retaining the largest body.
      const tip=[...chosen].filter(name=>name!==largest?.name).sort((a,b)=>info.totals.get(a)-info.totals.get(b))[0];
      if(!tip)break;chosen.delete(tip);continue;
    }
    const smallest=Math.min(...tips.map(name=>info.totals.get(name)));
    const tied=tips.filter(name=>info.totals.get(name)<=smallest*(1+1e-8));
    tied.sort((a,b)=>{const x=priority(a),y=priority(b);for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]-y[i];return a.localeCompare(b);});
    const group=priority(tied[0]).join();
    // Match mirrored tips, rather than discarding every equal-volume limb at once.
    for(const name of tied)if(priority(name).join()===group)chosen.delete(name);
  }
  return {chosen:geometry.bones.filter(b=>chosen.has(b.name)),largest,volume:b=>info.volumes.get(b.name)};
}
