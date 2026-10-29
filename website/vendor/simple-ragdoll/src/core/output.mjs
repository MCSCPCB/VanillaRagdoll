import { normalizeModel } from './model.mjs';

export function outputModel(config,resources,client){
  const rig=normalizeModel(config,resources,client),level=config.outputLevel??'standard';
  if(level==='standard')return rig;
  const s=rig.simulation;
  s.iterations=Math.max(1,Math.ceil(s.iterations/3));
  s.contactLimit=Math.min(s.contactLimit,Math.max(8,rig.shapes.length*4,Math.floor(s.contactLimit/2)));
  if(level==='medium'||level==='heavy')rig.shapePairs=[];
  if(level==='heavy'){
    s.iterations=1;
    s.contactLimit=Math.min(s.contactLimit,Math.max(8,rig.shapes.length*4));
    rig.contactFriction=false;
  }
  return rig;
}
