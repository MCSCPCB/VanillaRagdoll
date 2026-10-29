// Snapshot of .local/scripts/pose-cache.mjs; see SOURCE.json.
import {A,If,axes,quat,copy,vector,rotate,multiply,axisRotation,emit} from '../../../vendor/simple-ragdoll/src/core/expression.mjs';

// Selected rendered variants fail native bone lookup in game even though their
// shipped geometry contains those bones. Capture local animation channels on
// the drawn skeleton instead, then compose the hierarchy only at activation.
export function localPoseCache(geometry,rig,profileIndex,{activationOnly=false,entityRelative=new Set(),nativeRoots=new Set()}={}){
  const byName=new Map(geometry.bones.map(b=>[b.name.toLowerCase(),b])),ordered=[],seen=new Set();
  function visit(name){
    const key=name.toLowerCase();if(seen.has(key))return;
    const b=byName.get(key);if(!b)throw Error('Missing capture bone '+name);
    if(b.parent)visit(b.parent);seen.add(key);ordered.push(b);
  }
  for(const body of rig.bodies)visit(body.bone);
  const indexes=new Map(ordered.map((b,i)=>[b.name.toLowerCase(),i]));
  const prefix=i=>`v.vr_local_${profileIndex}_${i}_`,world=i=>`v.vr_world_${profileIndex}_${i}_`,record=i=>`v.vr_trs_${profileIndex}_${i}`;
  const initialize=[],nodes=[],bones={},baselineBones={},queries=new Map();
  const gate=`v.vr_enabled&&!v.ragdoll_active&&v.vr_profile==${profileIndex}`;
  for(const [i,b]of ordered.entries()){
    const local=prefix(i),out=world(i),trs=record(i),pivot=b.pivot??[0,0,0];
    const parent=b.parent===undefined?null:world(indexes.get(b.parent.toLowerCase()));
    if(nativeRoots.has(b.name)){
      if(parent)throw Error('Native capture override must be a root');
      nodes.push(A('t.native_root',`q.bone_orientation_trs('${b.name.toLowerCase()}')`));
      for(const channel of ['t','r','s'])for(const k of axes)nodes.push(A(trs+'.'+channel+'.'+k,`t.native_root.${channel}.${k}`));
      nodes.push(axisRotation('t.lx','x',`-${trs}.r.x`),axisRotation('t.ly','y',trs+'.r.y'),axisRotation('t.lz','z',`-${trs}.r.z`),multiply('t.lxy','t.ly','t.lx'),multiply(out+'q','t.lz','t.lxy'),copy(out+'s',trs+'.s.'));
      nodes.push(vector('t.p',pivot.map((p,k)=>`(${p})*${out}s${axes[k]}`)),rotate('t.p',out+'q','t.p'),axes.map(k=>A(out+'t'+k,`${trs}.t.${k}-t.p${k}`)));
      queries.set(b.name.toLowerCase(),trs);continue;
    }
    const channels={},baseline={};
    for(const [channel,key]of [['position','p'],['rotation','r'],['scale','s']]){
      const neutral=channel==='scale'?1:0;
      baseline[channel]=axes.map(axis=>`(${gate})?{${local}base_${key}${axis}=this;};return ${neutral};`);
      channels[channel]=axes.map((axis,k)=>{
        initialize.push(A(local+key+axis,channel==='rotation'?(b.rotation?.[k]??0):neutral));
        initialize.push(A(local+'base_'+key+axis,neutral));
        // Read changes relative to the engine's unanimated channel, which may
        // contain a bind translation. Never reinterpret that baseline as motion.
        const base=local+'base_'+key+axis;
        const value=channel==='scale'?`(math.abs(${base})>0.000001)?this/${base}:1`:
          channel==='rotation'?`this-${base}+(${b.rotation?.[k]??0})`:`this-${base}`;
        return `(${gate})?{${local+key+axis}=${value};};return ${neutral};`;
      });
    }
    bones[b.name]=channels;
    baselineBones[b.name]=baseline;
    nodes.push(axisRotation('t.lx','x',`-${local}rx`),axisRotation('t.ly','y',local+'ry'),axisRotation('t.lz','z',`-${local}rz`),multiply('t.lxy','t.ly','t.lx'),multiply('t.lq','t.lz','t.lxy'));
    if(parent){
      nodes.push(entityRelative.has(b.name.toLowerCase())?copy(out+'q','t.lq',quat):multiply(out+'q',parent+'q','t.lq'),axes.map(k=>A(out+'s'+k,`${parent}s${k}*${local}s${k}`)));
      nodes.push(vector('t.p',pivot.map((p,k)=>`((${p})+${local}p${axes[k]})*${parent}s${axes[k]}`)),rotate('t.p',parent+'q','t.p'));
      nodes.push(axes.map(k=>A(trs+'.t.'+k,`${parent}t${k}+t.p${k}`)));
    }else{
      nodes.push(copy(out+'q','t.lq',quat),copy(out+'s',local+'s'),vector(trs+'.t.',pivot.map((p,k)=>`(${p})+${local}p${axes[k]}`)));
    }
    nodes.push(vector('t.p',pivot.map((p,k)=>`(${p})*${out}s${axes[k]}`)),rotate('t.p',out+'q','t.p'),axes.map(k=>A(out+'t'+k,`${trs}.t.${k}-t.p${k}`)),copy(trs+'.s.',out+'s'));
    // Same Euler convention as the generator's q.bone_orientation_trs path.
    const q=out+'q';
    nodes.push(A('t.sy',`math.clamp(2*(${q}w*${q}y-${q}z*${q}x),-1,1)`),A(trs+'.r.y','math.asin(t.sy)'),If('math.abs(t.sy)<0.999999',[
      A(trs+'.r.x',`-math.atan2(2*(${q}w*${q}x+${q}y*${q}z),1-2*(${q}x*${q}x+${q}y*${q}y))`),
      A(trs+'.r.z',`-math.atan2(2*(${q}w*${q}z+${q}x*${q}y),1-2*(${q}y*${q}y+${q}z*${q}z))`),
    ],[A(trs+'.r.x',`-math.atan2(2*(${q}w*${q}x-${q}y*${q}z),1-2*(${q}x*${q}x+${q}z*${q}z))`),A(trs+'.r.z',0)]));
    queries.set(b.name.toLowerCase(),trs);
  }
  // Local channels must be recorded each rendered frame, but composing the
  // complete hierarchy is only needed when the saved pose enters simulation.
  const before=emit([If(activationOnly?gate+'&&v.vr_run':gate,nodes)]),init=emit(initialize);
  const reserved=[...new Set((init+before).match(/\bv\.\w+/g))];
  return {animation:{loop:true,bones},baselineAnimation:{loop:true,bones:baselineBones},initialize:init,before,queries,reserved};
}
