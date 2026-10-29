// Runtime adapter extracted from .local/scripts/contact-performance.mjs; see SOURCE.json.
import {If} from '../../../vendor/simple-ragdoll/src/core/expression.mjs';
export function coreTerrainOnly(entity,profile){
  // The sample's separate baby squid rigs collide with terrain normally.
  return ['minecraft:ghast','minecraft:happy_ghast','minecraft:squid','minecraft:glow_squid'].includes(entity.id)&&profile?.geometry!=='baby';
}
export function contactProgram(program,rig,entity,profile){
  if(coreTerrainOnly(entity,profile)){
    // Authored sample: only the core contacts blocks. Tentacles retain mass,
    // joints and inter-body contacts, but must not act as legs supporting it.
    const allowed=rig.shapes.flatMap((s,i)=>rig.bodies[s.body].bone==='body'?[i]:[]);
    if(!allowed.length)throw Error('Missing sample terrain-contact core');
    let sites=0;
    const walk=nodes=>nodes.flat(Infinity).flatMap(n=>{
      if(n.kind==='if')return [{...n,yes:walk(n.yes),no:walk(n.no)}];
      if(n.kind==='loop'){
        const body=walk(n.body),last=body.at(-1);
        if(last?.kind==='set'&&last.name==='t.shape'&&last.value==='t.shape+1'){
          const combined=String(n.count).includes('t.contact_mode');
          // Check both the loop count and branch; inter-body contacts must
          // never inherit the terrain-only filter.
          const bodyPairs=body.some(x=>x.kind==='if'&&x.test==='!t.contact_mode');
          sites++;return [{...n,body:[If((combined||bodyPairs?'!t.contact_mode||':'')+allowed.map(i=>'t.shape=='+i).join('||'),body.slice(0,-1)),last]}];
        }
        return [{...n,body}];
      }
      return [n];
    });
    const result={...program,frameChunks:program.frameChunks.map(walk)};
    if(sites!==3)throw Error('Review sample terrain-body routing after generator changes');
    return result;
  }
  return program;
}
