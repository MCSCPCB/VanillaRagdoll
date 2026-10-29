// Runtime adapter extracted from .local/scripts/articulation.mjs; see SOURCE.json.
import {A,If,axes,vector,copy,rotate as rotateNodes,add as addNodes,sub as subNodes,scale as scaleNodes} from '../../../vendor/simple-ragdoll/src/core/expression.mjs';
export function articulationRig(rig,entity,profile){
  if(entity.id==='minecraft:wolf'&&profile.key==='default'){
    const i=rig.joints.findIndex(j=>j.id==='body');
    rig.joints[i].axisA=axes.map(k=>`v.vr_torso_axis_${k}`);
    rig.joints[i].twistAxisA=axes.map(k=>`v.vr_torso_twist_${k}`);
  }
  if(entity.id==='minecraft:ender_dragon'){
    // The engine assembles these real bones into a hierarchy absent from the
    // legacy JSON. This is compiler metadata; no geometry is written to the RP.
    for(const list of [rig.bodies,...rig.variants.map(v=>v.bodies)])for(const b of list)if(b.bone!=='root'){
      const parent=b.bone.startsWith('wingtip')?(b.bone.endsWith('1')?'wing1':'wing'):b.bone.includes('legtip')?b.bone.replace('legtip','leg'):'root';
      b.parent=rig.bodies.findIndex(p=>p.bone===parent);
    }
    // Native dragon assembly rotates the tail backwards and bends the legs.
    // Limits must be relative to that assembled pose, not the raw JSON axes.
    for(const [i,j]of rig.joints.entries()){
      j.axisA=axes.map(k=>`v.vr_dragon_${i}_axis_${k}`);
      j.twistAxisA=axes.map(k=>`v.vr_dragon_${i}_twist_${k}`);
    }
  }
  return rig;
}

export function articulationProgram(program,rig,entity,profile){
  const name=entity.id.slice(10);
  // Keep the verified villager contract. Other vanilla rigs can assemble their
  // connected parts through native setup or animate a child around a pivot
  // different from the sample's attachment. Resolve A from the captured B
  // landmark once, instead of pulling a correct living pose toward bind space.
  if(['villager','villager_v2'].includes(name)||!rig.joints.length)return program;
  const joints=rig.joints;
  const nodes=joints.flatMap(j=>{
    const i=rig.joints.indexOf(j),a=`v.b${j.a}`,b=`v.b${j.b}`,out=`v.j${i}`;
    // Keep B at the actual anatomical joint on the child. Locate that point
    // in A using the last rendered pose, including vanilla setup translations.
    // Freeze it once: the solver subsequently enforces a real point constraint.
    return [vector('t.attach_b',j.anchorB.map(n=>`(${n})*v.body_units`)),rotateNodes('t.attach_offset',b+'q','t.attach_b'),addNodes('t.attach_point',b,'t.attach_offset'),subNodes('t.attach_delta','t.attach_point',a),
      scaleNodes('t.attach_inverse',a+'q',-1),A('t.attach_inversew',a+'qw'),rotateNodes(out+'base_a','t.attach_inverse','t.attach_delta'),copy(out+'a',out+'base_a')];
  });
  if(name==='wolf'&&profile.key==='default'){
    const i=rig.joints.findIndex(j=>j.id==='body'),j=rig.joints[i];
    for(const [kind,value]of [['axis',j.axisB],['twist',j.twistAxisB]])nodes.push(vector('t.attach_axis',value),rotateNodes('t.attach_world',`v.b${j.b}q`,'t.attach_axis'),scaleNodes('t.attach_inverse',`v.b${j.a}q`,-1),A('t.attach_inversew',`v.b${j.a}qw`),rotateNodes('v.vr_torso_'+kind+'_','t.attach_inverse','t.attach_world'));
    nodes.push(A(`v.j${i}swing`,0),A(`v.j${i}twist`,0));
    program.initialize.push(...axes.flatMap((k,i)=>[A('v.vr_torso_axis_'+k,i===1?1:0),A('v.vr_torso_twist_'+k,i===0?-1:0)]));
  }
  if(name==='ender_dragon')for(const [i,j]of rig.joints.entries()){
    for(const [kind,value]of [['axis',j.axisB],['twist',j.twistAxisB]]){
      program.initialize.push(vector(`v.vr_dragon_${i}_${kind}_`,value));
      nodes.push(vector('t.attach_axis',value),rotateNodes('t.attach_world',`v.b${j.b}q`,'t.attach_axis'),scaleNodes('t.attach_inverse',`v.b${j.a}q`,-1),A('t.attach_inversew',`v.b${j.a}qw`),rotateNodes(`v.vr_dragon_${i}_${kind}_`,'t.attach_inverse','t.attach_world'));
    }
    nodes.push(A(`v.j${i}swing`,0),A(`v.j${i}twist`,0));
  }
  program.frameChunks[0].push(If('v.activated',nodes));
  return program;
}
