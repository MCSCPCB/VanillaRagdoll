import { OUTPUT_LEVELS } from './core/model.mjs';
import { outputModel } from './core/output.mjs';
import { createProgram } from './core/program.mjs';
import { compilePrograms, compileSpecializedPrograms, sharingKey, structureKey } from './core/compute.mjs';
import { INPUT_ANIMATION } from './core/input.mjs';
import { parseJson } from './resources.js';
import { clone } from './config.js';
import { fail } from './i18n.js';
import { apiSettings, apiMask } from './core/api.mjs';

export function adaptClient(original,rig,program,id){
  const result=clone(original),c=result['minecraft:client_entity'].description,s=c.scripts??={};
  const animations={...c.animations},animate=[...(s.animate??[])];
  for(const [i,entry] of (c.animation_controllers??[]).entries())for(const [name,value] of Object.entries(entry)){
    const alias=`ragdoll_original_${i}_${name}`;animations[alias]=value;animate.push(alias);
  }
  const key='ragdoll_generated';if(key in animations)fail('alias',[key]);
  const hasApi=apiMask(apiSettings(rig.api))>0;
  if(hasApi&&'ragdoll_input' in animations)fail('alias',['ragdoll_input']);
  animations[key]=id;if(hasApi)animations.ragdoll_input=INPUT_ANIMATION;delete c.animation_controllers;c.animations=animations;
  const atLeast=(version,min)=>version.split('.').map(Number).reduce((a,n,i)=>a||Math.sign(n-(min[i]??0)),0)<0?min.join('.'):version;
  result.format_version=atLeast(String(result.format_version??'1.10.0'),[1,20,60]);c.min_engine_version=atLeast(String(c.min_engine_version??'1.10.0'),[1,26,0]);
  const alias=g=>Object.entries(c.geometry).find(([,value])=>value===g)?.[0];
  // This field takes a geometry alias, not a Molang geometry expression.
  const queryModels=new Set(rig.variants.map(v=>v.geometry));
  if(queryModels.size===1)c.queryable_geometry=alias(rig.variants[0].geometry);
  // Multiple models retain a valid original alias, or use the engine's rendered geometry.
  else if(!queryModels.has(c.geometry[c.queryable_geometry]))delete c.queryable_geometry;
  const condition=entry=>typeof entry==='string'?{[entry]:'!v.ragdoll_active'}:Object.fromEntries(Object.entries(entry).map(([name,value])=>[name,`(!v.ragdoll_active)*(${typeof value==='boolean'?Number(value):value})`]));
  const compute=program.computeOrder.map((id,i)=>{
    const alias='ragdoll_compute_'+i;if(alias in animations)fail('alias',[alias]);
    animations[alias]=id;return alias;
  });
  c.scripts={...s,initialize:[...(s.initialize??[]),...program.initializeSources],pre_animation:[...(s.pre_animation??[]),...program.preAnimationSources],animate:[...compute,...animate.map(condition),{[key]:'v.ragdoll_active'}],should_update_bones_and_effects_offscreen:true};
  if(!c.scripts.pre_animation.length)delete c.scripts.pre_animation;
  return result;
}

export function resourceVariables(resources,original){
  const names=new Set(resources.reservedVariables??[]);
  for(const value of [...(resources.json?.values()??[]),original].filter(Boolean))for(const [name] of JSON.stringify(value).matchAll(/\b(?:v|variable)\.\w+/gi))names.add(name.toLowerCase().replace(/^variable\./,'v.'));
  return [...names];
}

const animationFile=animations=>JSON.stringify({format_version:'1.20.60',animations});
const inputFile=JSON.stringify({format_version:'1.8.0',animations:{[INPUT_ANIMATION]:{loop:true,animation_length:1}}});
const byteLength=text=>new TextEncoder().encode(text).byteLength;

function* generateGroups(resources,entities){
  const reservedNames=[...new Set([...resourceVariables(resources),...entities.flatMap(e=>resourceVariables({},e.original))])];
  const entries=entities.map(({config,original},index)=>{
    const client=original['minecraft:client_entity'].description,rig=outputModel(config,resources,client);
    return {index,original,rig,name:client.identifier.replaceAll(':','_')};
  });
  const inputEntries=entries.filter(e=>apiMask(e.rig.api)),inputIndex=new Map(inputEntries.map((e,i)=>[e.index,i]));
  const finish=(entry,program)=>{
    const {original,rig,name}=entry,animationId=`animation.ragdoll.${name}`;
    const definition=JSON.stringify(adaptClient(original,rig,program,animationId));
    const animation=animationFile({[animationId]:program.animation()});
    return {index:entry.index,rig,program,name,animationId,definition,animation,bytes:byteLength(definition)+byteLength(animation)};
  };
  const compile=(entries,compiler=compilePrograms)=>compiler(entries,{reservedNames}).map((program,i)=>finish(entries[i],program));
  const size=records=>records.reduce((n,r)=>n+r.bytes,0)+byteLength(animationFile(records[0].program.computeAnimations));
  const total=groups=>groups.reduce((n,records)=>n+size(records),0);
  // Release rejected programs between batches. Retaining every candidate for
  // a large addon costs far more memory than the final resource files.
  const ordered=[...entries].sort((a,b)=>a.rig.bodies.length-b.rig.bodies.length);
  for(let start=0;start<ordered.length;start+=32)yield* generateBatch(ordered.slice(start,start+32),start);

  function* generateBatch(entries,start){
    const prepared=[],independent=new Map(),sharedCache=new Map();
    for(const [i,entry]of entries.entries()){
      yield {progress:[entry.original['minecraft:client_entity'].description.identifier,start+i,entities.length,'generating']};
      const ready={...entry,...createProgram(entry.rig,{preview:true,reservedNames})};
      prepared.push(ready);independent.set(ready,compile([ready],compileSpecializedPrograms));
    }
    const groupBy=(entries,key,limit=200)=>{
      const groups=new Map();
      for(const entry of entries){const k=key(entry);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(entry);}
      // Bound profile selectors and merge work even for very large resource packs.
      return [...groups.values()].flatMap(group=>Array.from({length:Math.ceil(group.length/limit)},(_,i)=>group.slice(i*limit,(i+1)*limit)));
    };
    const share=entries=>{
      const key=entries.map(e=>e.index).join(',');
      if(sharedCache.has(key))return sharedCache.get(key);
      let result;
      try{result=[compile(entries)];}
      catch(error){
        if(error.key!=='chunk')throw error;
        if(entries.length===1)return [independent.get(entries[0])];
        // An oversized variable loop cannot be split inside Molang. Smaller
        // profile groups regain constant loops and stay below the expression cap.
        const middle=Math.ceil(entries.length/2);
        result=[...share(entries.slice(0,middle)),...share(entries.slice(middle))];
      }
      sharedCache.set(key,result);return result;
    };
    let results=[];
    for(const group of groupBy(prepared,e=>e.rig.bodies.length)){
      yield {progress:[group[0].original['minecraft:client_entity'].description.identifier,group[0].index,entities.length,'sharing']};
      // Keep the previous specialized strategy as a size baseline. Sharing is an
      // automatic export optimization, not a change to the user's physics model.
      let baseline=groupBy(group,e=>sharingKey(e.rig)).flatMap(entries=>{
        const separate=entries.map(e=>independent.get(e));
        if(entries.length===1)return separate;
        try{const shared=compile(entries,compileSpecializedPrograms);return size(shared)<total(separate)?[shared]:separate;}
        catch(error){if(error.key!=='chunk')throw error;return separate;}
      });
      const shared=share(group);
      if(total(shared)<total(baseline))baseline=shared;
      results.push(...baseline);
    }
    const structural=[];
    for(const group of groupBy(prepared,structureKey)){
      yield {progress:[group[0].original['minecraft:client_entity'].description.identifier,group[0].index,entities.length,'sharing']};
      const separate=group.map(e=>independent.get(e)),shared=share(group);
      structural.push(...(total(shared)<total(separate)?shared:separate));
    }
    // Compare actual emitted bytes, including each entity's parameter bindings.
    // A structure-based kernel is useful only when the complete pack is smaller.
    if(total(structural)<total(results))results=structural;
    // BP inputs contain per-body operations, so their exact statement skeletons
    // can differ even when the solver is compatible. Alignment also lets these
    // profiles share; retain it only when its guarded operations cost fewer bytes.
    const combined=[];
    for(const group of groupBy(prepared,()=>0,16)){
      yield {progress:[group[0].original['minecraft:client_entity'].description.identifier,group[0].index,entities.length,'sharing']};
      combined.push(...share(group));
    }
    if(total(combined)<total(results))results=combined;
    const inputBytes=inputEntries.length?byteLength(inputFile):0;
    for(const records of results){
      const bytes=byteLength(animationFile(records[0].program.computeAnimations));
      records.forEach((record,i)=>{record.bytes+=Math.floor(bytes/records.length)+(i<bytes%records.length?1:0)
        +(inputIndex.has(record.index)?Math.floor(inputBytes/inputEntries.length)+(inputIndex.get(record.index)<inputBytes%inputEntries.length?1:0):0);});
      yield {records};
    }
  }
}

export function generateEntities(resources,entities){
  const result=[];
  for(const {records} of generateGroups(resources,entities))for(const record of records??[])result[record.index]=record;
  return result;
}

export function generateEntity(resources,config,original){
  return generateEntities(resources,[{config,original}])[0];
}

export async function estimateOutputLevels(resources,config,original,{cancelled=()=>false,update=()=>{}}={}){
  const levels=[],seen=new Map();
  for(const level of [...OUTPUT_LEVELS].reverse()){
    await new Promise(resolve=>setTimeout(resolve,0));if(cancelled())return;
    const model={...config,outputLevel:level},rig=outputModel(model,resources,original['minecraft:client_entity'].description);
    const signature=JSON.stringify([rig.simulation,rig.shapePairs,rig.contactFriction]);
    if(seen.has(signature)){seen.get(signature).levels.push(level);update(levels.map(entry=>({...entry,levels:[...entry.levels]})).reverse());continue;}
    const {bytes}=generateEntity(resources,model,original);
    const entry={level,bytes,levels:[level]};seen.set(signature,entry);
    levels.push(entry);update(levels.map(entry=>({...entry,levels:[...entry.levels]})).reverse());
  }
  return levels.reverse();
}

export async function generatePack(resources,rows,options,Zip,onProgress=()=>{}){
  const selected=rows.filter(r=>r.selected);if(!selected.length)fail('selection');
  const zip=new Zip(),reports=[],updates=new Map();
  const set=(path,value)=>updates.set(path,JSON.stringify(value));
  if(selected.some(row=>apiMask(apiSettings(row.config?.api))))updates.set('animations/simple_ragdoll_input.animation.json',inputFile);
  const entities=[];
  for(const row of selected){
    if(!row.config)fail('not_configured',[row.id]);
    const record=resources.clients.get(row.id);if(!record)fail('entity_missing',[row.id]);
    if(/v\.(ragdoll_|rg[a-z0-9]+\b)/.test(JSON.stringify(record.value)))fail('already_generated',[row.id]);
    entities.push({config:row.config,original:record.value,record,row});
  }
  for(const {progress,records} of generateGroups(resources,entities)){
    if(progress){onProgress(...progress);await new Promise(resolve=>setTimeout(resolve,0));continue;}
    for(const {index,rig,program,name,animationId,definition,animation,bytes} of records){
      const {record,row}=entities[index];
      if(resources.animations.has(animationId))fail('alias',[animationId]);
      for(const id of Object.keys(program.computeAnimations))if(resources.animations.has(id))fail('alias',[id]);
      updates.set(record.file,definition);
      updates.set(`animations/ragdoll_${name}.animation.json`,animation);
      const computeFile=`animations/ragdoll_${program.computeName}.compute.json`;
      if(!updates.has(computeFile))updates.set(computeFile,animationFile(program.computeAnimations));
      reports[index]={id:row.id,bodies:rig.bodies.length,boxes:rig.shapes.length,joints:rig.joints.length,bytes};
    }
  }
  onProgress('',0,100,'packing');await new Promise(resolve=>setTimeout(resolve,0));
  const manifest=clone(resources.json.get('manifest.json')??{format_version:2,header:{},modules:[]});
  const originalMinimum=manifest.header?.min_engine_version??[0,0,0];
  const minimum=originalMinimum.reduce((comparison,n,i)=>comparison||Math.sign(n-([1,26,0][i]??0)),0)>0?originalMinimum:[1,26,0];
  manifest.header={...manifest.header,name:options.name,description:options.name,uuid:options.uuid??crypto.randomUUID(),version:[1,0,0],min_engine_version:minimum};
  manifest.modules=[{type:'resources',uuid:crypto.randomUUID(),version:[1,0,0]}];
  set('manifest.json',manifest);
  const decoder=new TextDecoder();
  for(const [path,bytes] of resources.files)if(/\.json$/i.test(path)&&!updates.has(path)){
    try{set(path,resources.json.get(path)??parseJson(typeof bytes==='string'?bytes:decoder.decode(bytes),path));}catch{}
  }
  for(const [path,bytes] of resources.files)zip.file(path,bytes);
  for(const [path,text] of updates)zip.file(path,text);
  let percent=-1;
  const data=await zip.generateAsync({type:'uint8array',compression:'DEFLATE',compressionOptions:{level:6}},status=>{
    const next=Math.floor(status.percent);if(next!==percent){percent=next;onProgress('',percent,100,'packing');}
  });
  return {data,reports,updates};
}
