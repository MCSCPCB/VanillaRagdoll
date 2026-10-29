import {A,If,axes,emit} from './expression.mjs';
import {mergeGroups,parameterMerger} from './merge.mjs';
import {minifier} from './minify.mjs';
import {splitStatements} from './chunks.mjs';
import {expressionCompactor} from './syntax.mjs';

const profile='v.compute_profile',slot='v.compute_step';
const flatten=nodes=>[nodes].flat(Infinity);
const boneSize=(body,i)=>body.parent<0?`(1-v.pose${i}hidden)*v.body_to_world/v.frame_to_world`:`1-v.pose${i}hidden`;
function prepareOutputs(entries){
  return entries.map(entry=>{
    const roots=entry.rig.bodies.flatMap((body,i)=>body.parent<0?entry.rootOutputs[i]:[]);
    // Physics and interpolation finish before any bone channel reads the result.
    // Keep raw programs unchanged: the preview already evaluates each root once.
    return {...entry,frameChunks:[...entry.frameChunks.slice(0,-1),[
      ...entry.frameChunks.at(-1),...(roots.length?[If('v.active',roots)]:[]),
    ]]};
  });
}
function assigned(nodes){
  const names=new Set();
  const visit=nodes=>{for(const n of flatten(nodes)){
    if(n.kind==='set')names.add(n.name);
    else if(n.kind==='if'){visit(n.yes);visit(n.no);}
    else visit(n.body);
  }};
  visit(nodes);return names;
}

export function sharingKey(rig){
  return JSON.stringify([
    rig.bodies.map(b=>[b.parent,b.shapes.length]),rig.shapes.map(s=>s.body),
    rig.joints.map(j=>[j.a,j.b]),rig.jointOrder,rig.shapePairs,
    rig.simulation,rig.contactFriction??true,[...rig.outputs].sort(),rig.api,
  ]);
}

// Loop bounds and physical constants become per-entity parameters. Entities
// with different body counts can still use the same ordered step operations.
export function structureKey(entry){
  const skeleton=nodes=>flatten(nodes).map(n=>n.kind==='set'?['set',n.name]
    :n.kind==='if'?['if',skeleton(n.yes),skeleton(n.no)]:['loop',skeleton(n.body)]);
  return JSON.stringify(skeleton(entry.frameChunks[1]));
}

// Specialized schedules remain useful when a shared kernel would be larger.
export function compileSpecializedPrograms(entries,{reservedNames=[]}={}){
  entries=prepareOutputs(entries);
  const step=mergeGroups(entries.map(e=>e.frameChunks[1][0].yes),profile);
  const resets=[A(slot,0)];
  const all=[entries.map(e=>[e.initialize,e.frameChunks[0],e.frameChunks.at(-1)]),
    step,resets,A(profile,0)];
  const frequencyText=emit(all),written=assigned(all);
  const external=[...frequencyText.matchAll(/(?<![\w.])v\.\w+/g)].map(m=>m[0]).filter(n=>!written.has(n));
  const namespace=minifier({frequencyText,reservedNames,externalNames:external});
  const compact=expressionCompactor();
  const source=(nodes,target='molang')=>target==='molang'?namespace(emit(nodes,target,{expression:compact})):emit(nodes,target);
  const split=(nodes,prefix)=>splitStatements(nodes,source,{limit:63900,target:61500,prefix});
  const computeAnimations={};
  const prefix=`animation.ragdoll.${entries[0].name}.compute`;
  const carrier=(chunks,name)=>{
    const definitions=new Map();
    return chunks.map(nodes=>{
      const text=source(nodes)+'return 0;';
      let id=definitions.get(text);
      if(!id){
        id=`${prefix}.${name}.${definitions.size}`;definitions.set(text,id);
        computeAnimations[id]={loop:true,animation_length:1,anim_time_update:text};
      }
      return {id,nodes,source:text};
    });
  };
  const stepChunks=split([If('v.active&&v.steps>'+slot,step)],'step');
  // 每轮最后一段推进计数；同一组动画按顺序执行三次。
  stepChunks[stepChunks.length-1]=[...stepChunks.at(-1),A(slot,slot+'+1')];
  const computation=carrier(stepChunks,'step');
  const initialNodes=flatten(entries.map(e=>e.initialize)),initialLast=new Map();
  initialNodes.forEach((n,i)=>{if(n.kind==='set')initialLast.set(n.name,i);});
  const sharedInitial=initialNodes.filter((n,i)=>n.kind!=='set'||initialLast.get(n.name)===i);
  const declared=assigned(sharedInitial);
  const programs=entries.map((entry,index)=>{
    const {rig,rootOutputs}=entry;
    const begin=split([entry.frameChunks[0],resets],'begin'+index);
    const counts=new Map(),texts=begin.map(nodes=>source(nodes));
    for(const text of texts)counts.set(text,(counts.get(text)??0)+1);
    const repeated=texts.findIndex(text=>counts.get(text)>1);
    // 姿态采集等前置计算留在 pre_animation；超长循环及其后续计算按顺序交给动画。
    const before=repeated<0?begin:begin.slice(0,repeated);
    const pending=repeated<0?[]:carrier(begin.slice(repeated),'begin'+index);
    const finish=carrier(split(entry.frameChunks.at(-1),'output'+index),'output'+index);
    const execution=[...pending,...computation,...computation,...computation,...finish];
    const extra=[...assigned([begin,execution.map(c=>c.nodes),rootOutputs])]
      .filter(n=>n.startsWith('v.')&&!declared.has(n)).map(n=>A(n,0));
    const initialize=flatten([extra,sharedInitial,entry.initialize,A(profile,index),resets]);
    const last=new Map();initialize.forEach((n,i)=>{if(n.kind==='set')last.set(n.name,i);});
    const initial=initialize.filter((n,i)=>n.kind!=='set'||last.get(n.name)===i);
    const initializeChunks=split(initial,'init'+index);
    const frameChunks=[...before,...execution.map(c=>c.nodes)];
    const animation=(target='molang')=>({loop:true,override_previous_animation:true,bones:Object.fromEntries(rig.bodies.map((body,i)=>[body.bone,{
      ...Object.fromEntries([['position','p'],['rotation','r']].map(([channel,kind])=>[channel,axes.map(k=>{
        const name=`v.out${i}${kind}${k}`,value=target==='molang'?namespace(name):name;
        return value;
      })])),scale:axes.map(()=>target==='molang'?namespace(compact(boneSize(body,i))):boneSize(body,i)),
    }]))});
    return {initialize:initializeChunks.flat(),frameChunks,rootOutputs,source,animation,names:namespace.roots,
      initializeSources:initializeChunks.map(nodes=>source(nodes)),preAnimationSources:before.map(nodes=>source(nodes)),
      frameSources:[...before.map(nodes=>source(nodes)),...execution.map(c=>c.source)],
      computeOrder:execution.map(c=>c.id),computeAnimations,computeName:entries[0].name};
  });
  return programs;
}

// All actors use the same ordered animations, but keep their own parameters and
// simulation state. Only the per-bone render expressions stay entity specific.
export function compilePrograms(entries,{reservedNames=[]}={}){
  entries=prepareOutputs(entries);
  const merger=parameterMerger(profile),ready='v.compute_ready';
  const maps=entries.map(e=>new Map(flatten(e.initialize).map(n=>{
    if(n.kind!=='set')throw new Error('Expected assignment-only physics initialization');
    return [n.name,n.value];
  })));
  const initialNames=new Set(maps.flatMap(m=>[...m.keys()]));
  let initial=[...initialNames].map(name=>A(name,merger.value(maps.map(m=>m.get(name)??0))));
  const begin=[merger.merge(entries.map(e=>e.frameChunks[0])),A(slot,0)];
  const step=[If('v.active&&v.steps>'+slot,merger.merge(entries.map(e=>e.frameChunks[1][0].yes))),A(slot,slot+'+1')];
  const output=merger.merge(entries.map(e=>e.frameChunks.at(-1)));
  const perInitial=entries.map((_,i)=>[A(profile,i),A(ready,0),A('v.active',0),
    ...merger.parameters.map(p=>A(p.name,p.values[i]))]);
  const all=[initial,begin,step,output,entries.map(e=>e.rootOutputs),perInitial];
  const frequencyText=emit(all),written=assigned(all);
  const external=[...frequencyText.matchAll(/(?<![\w.])v\.\w+/g)].map(m=>m[0]).filter(n=>!written.has(n));
  const namespace=minifier({frequencyText,reservedNames,externalNames:external});
  const compact=expressionCompactor();
  const source=(nodes,target='molang')=>target==='molang'?namespace(emit(nodes,target,{expression:compact})):emit(nodes,target);
  const split=(nodes,name)=>splitStatements(nodes,source,{limit:63900,target:61500,prefix:'compute_'+name});
  const computeAnimations={},prefix=`animation.ragdoll.${entries[0].name}.compute`;
  const carrier=(nodes,name)=>{
    const definitions=new Map();
    return split(nodes,name).map(nodes=>{
      const text=source(nodes)+'return 0;';let id=definitions.get(text);
      if(!id){id=`${prefix}.${name}.${definitions.size}`;definitions.set(text,id);
        computeAnimations[id]={loop:true,animation_length:1,anim_time_update:text};}
      return {id,nodes,source:text};
    });
  };
  const declared=new Set([...initialNames,...merger.parameters.map(p=>p.name),profile,ready]);
  initial=[...written].filter(n=>n.startsWith('v.')&&!declared.has(n)).map(n=>A(n,0)).concat(initial);
  const initialize=carrier([If('!'+ready,[initial,A(ready,1)])],'initialize');
  const start=carrier(begin,'begin'),steps=carrier(step,'step'),finish=carrier(output,'output');
  const execution=[...initialize,...start,...steps,...steps,...steps,...finish];
  return entries.map((entry,index)=>{
    const {rig,rootOutputs}=entry,initializeChunks=split(perInitial[index],'parameters'+index);
    const animation=(target='molang')=>({loop:true,override_previous_animation:true,bones:Object.fromEntries(rig.bodies.map((body,i)=>[body.bone,{
      ...Object.fromEntries([['position','p'],['rotation','r']].map(([channel,kind])=>[channel,axes.map(k=>{
        const name=`v.out${i}${kind}${k}`,value=target==='molang'?namespace(name):name;
        return value;
      })])),scale:axes.map(()=>target==='molang'?namespace(compact(boneSize(body,i))):boneSize(body,i)),
    }]))});
    return {initialize:initializeChunks.flat(),frameChunks:execution.map(c=>c.nodes),rootOutputs,source,animation,names:namespace.roots,
      initializeSources:initializeChunks.map(nodes=>source(nodes)),preAnimationSources:[],
      frameSources:execution.map(c=>c.source),computeOrder:execution.map(c=>c.id),
      computeAnimations,computeName:entries[0].name};
  });
}
