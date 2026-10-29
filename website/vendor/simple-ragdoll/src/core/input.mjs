import { A, If, Loop, axes, set, choose, dispatch } from './expression.mjs';
import { controls, materialName } from './control.mjs';
import { apiSettings, apiMask } from './api.mjs';
import { MAX_TERRAIN_BOXES, MAX_MOTIONS, MAX_FORCES, MAX_PROPERTIES, MAX_JOINTS, MAX_LIQUIDS, PROPERTY_FIELDS, MOTION_FIELDS, FORCE_FIELDS, partKey } from '../../simple_ragdoll/BP/scripts/ragdoll.js';

export { INPUT_ANIMATION, MAX_TERRAIN_BOXES, MAX_LIQUIDS } from '../../simple_ragdoll/BP/scripts/ragdoll.js';
const terrainFields = ['minx','miny','minz','maxx','maxy','maxz','friction','restitution'];
export const liquidFields = ['minx','miny','minz','maxx','maxy','maxz','density','drag','angulardrag'];
const slots = size => Array.from({length:size},(_,i)=>i);
export function terrainValue(index,field) { return choose(index,slots(MAX_TERRAIN_BOXES).map(i=>`v.external_terrain_${i}_${field}`)); }
export function liquidValue(index,field) { return choose(index,slots(MAX_LIQUIDS).map(i=>`v.ragdoll_liquid_${i}_${field}`)); }

export function createInputs(rig) {
  const api=apiSettings(rig.api),mask=apiMask(api);
  const kinds=[[1,'setVelocity'],[2,'applyImpulse'],[3,'setTransform']].filter(([,method])=>api[method]).map(([kind])=>kind);
  const motionFields=MOTION_FIELDS.filter(key=>{
    if(['point','px','py','pz'].includes(key))return api.applyImpulse;
    if(['rotation','qx','qy','qz','qw'].includes(key))return api.setTransform;
    if(['ax','ay','az'].includes(key))return api.applyImpulse||api.setVelocity;
    if(key==='angular')return api.setVelocity;
    if(key==='linear')return api.setVelocity||api.setTransform;
    return true;
  });
  const bodies=rig.bodies,ids=bodies.map(b=>partKey(b.id)),jointIds=rig.joints.map(j=>partKey(j.id)),control=controls(rig,ids);
  if(new Set(ids).size!==ids.length||new Set(jointIds).size!==jointIds.length)throw new Error('Ragdoll identifiers have conflicting input keys');
  const initialize=[
    set('v.ragdoll_', {protocol:mask?1:0,api_mask:mask,session_high:0,session_low:0,revision:0,control_mode:0,simulation_gravity:-1,simulation_gravity_vector:0,
      simulation_gx:0,simulation_gy:0,simulation_gz:0,simulation_time_scale:1,simulation_iterations:0,simulation_collisions:1,simulation_friction:1,
      simulation_joints:1,terrain_mode:0,terrain_count:0,liquid_count:0,property_count:0,joint_count:0,force_count:0,motion_first:1,motion_last:0,motion_ack:0,motion_dropped:0}),
    set('v.ragdoll_terrain_bounds_',Object.fromEntries(['min','max'].flatMap(side=>axes.map(k=>[side+k,0])))),
    A('v.input_revision',0),A('v.input_session_high',0),A('v.input_session_low',0),A('v.material_variant',-1),A('v.material_revision',-1),
    slots(MAX_TERRAIN_BOXES).map(i=>set(`v.ragdoll_terrain_${i}_`,Object.fromEntries(terrainFields.map(k=>[k,['friction','restitution'].includes(k)?-1:0])))),
    slots(MAX_LIQUIDS).map(i=>set(`v.ragdoll_liquid_${i}_`,Object.fromEntries(liquidFields.map(k=>[k,0])))),
    slots(MAX_MOTIONS).map(i=>set(`v.ragdoll_motion_${i}_`,Object.fromEntries(motionFields.map(k=>[k,k==='qw'?1:0])))),
    slots(MAX_FORCES).map(i=>set(`v.ragdoll_force_${i}_`,Object.fromEntries(FORCE_FIELDS.map(k=>[k,0])))),
    slots(MAX_PROPERTIES).map(i=>set(`v.ragdoll_property_${i}_`,{part:0,...Object.fromEntries(PROPERTY_FIELDS.map(k=>[k.toLowerCase(),-1]))})),
    slots(MAX_JOINTS).map(i=>set(`v.ragdoll_joint_${i}_`,{id:0,enabled:1})),
    bodies.map((_,i)=>PROPERTY_FIELDS.map(key=>A(materialName(i,key),0))),rig.joints.map((_,i)=>A(`v.joint_enabled_${i}`,1)),
  ];
  const frame=[
    A('v.has_material','v.ragdoll_property_count>0'),
    ['gravity','iterations','collisions','friction','joints'].map(key=>A('v.simulation_'+key,'v.ragdoll_simulation_'+key)),
    A('v.gravity_pixels',`v.simulation_gravity<0?${rig.simulation.gravity*16}:math.clamp(v.simulation_gravity,0,100)*16`),
    A('v.gravity_step',`v.simulation_gravity<0?${(1/rig.simulation.frequency)*(rig.simulation.gravity*16)}:math.clamp(v.simulation_gravity,0,100)*${16/rig.simulation.frequency}`),
    axes.map(k=>A('v.gravity_'+k,`v.ragdoll_simulation_gravity_vector?v.ragdoll_simulation_g${k}:${k==='y'?'-v.gravity_pixels/16':'0'}`)),
    axes.map(k=>A('v.gravity_step_'+k,`v.gravity_${k}*${16/rig.simulation.frequency}`)),
    If('v.input_revision!=v.ragdoll_revision||v.input_session_high!=v.ragdoll_session_high||v.input_session_low!=v.ragdoll_session_low',[
      A('v.input_revision','v.ragdoll_revision'),A('v.input_session_high','v.ragdoll_session_high'),A('v.input_session_low','v.ragdoll_session_low'),A('v.sleep',0),A('v.material_revision',-1),
      slots(MAX_TERRAIN_BOXES).map(i=>terrainFields.map(key=>A(`v.external_terrain_${i}_${key}`,['friction','restitution'].includes(key)?`v.ragdoll_terrain_${i}_${key}<0?${rig.simulation.terrain[key]}:v.ragdoll_terrain_${i}_${key}`:`v.ragdoll_terrain_${i}_${key}`))),
    ]),
    If('v.ragdoll_motion_ack<v.ragdoll_motion_first-1',[
      A('v.ragdoll_motion_dropped','v.ragdoll_motion_dropped+v.ragdoll_motion_first-1-v.ragdoll_motion_ack'),A('v.ragdoll_motion_ack','v.ragdoll_motion_first-1')]),
  ];
  const property=key=>choose('t.property_index',slots(MAX_PROPERTIES).map(i=>`v.ragdoll_property_${i}_${key.toLowerCase()}`));
  const totalBase='('+bodies.map(b=>'('+b.mass+')').join('+')+')';
  const properties=[If('v.material_revision!=v.ragdoll_revision||v.material_variant!=v.variant',[
    A('v.material_revision','v.ragdoll_revision'),A('v.material_variant','v.variant'),
    bodies.map((body,i)=>PROPERTY_FIELDS.map(key=>A(materialName(i,key),body[key]))),
    ...[false,true].map(targeted=>[A('t.property_index',0),Loop('v.ragdoll_property_count',[
      A('t.property_target',property('part')),
      PROPERTY_FIELDS.map(key=>A('t.property_'+key.toLowerCase(),property(key))),
      bodies.map((body,i)=>If(targeted?`t.property_target==${ids[i]}`:'t.property_target==0',PROPERTY_FIELDS.map(key=>[
        A('t.property_value','t.property_'+key.toLowerCase()),If('t.property_value>=0',A(materialName(i,key),key==='mass'&&!targeted?`t.property_value*(${body.mass})/${totalBase}`:'t.property_value'))]))),
      A('t.property_index','t.property_index+1'),
    ])]),
    rig.joints.map((_,i)=>A(`v.joint_enabled_${i}`,'v.simulation_joints')),
    ...(rig.joints.length?[A('t.joint_input_index',0),Loop('v.ragdoll_joint_count',[
      A('t.joint_input_id',choose('t.joint_input_index',slots(MAX_JOINTS).map(i=>`v.ragdoll_joint_${i}_id`))),
      A('t.joint_input_enabled',choose('t.joint_input_index',slots(MAX_JOINTS).map(i=>`v.ragdoll_joint_${i}_enabled`))),
      rig.joints.map((_,i)=>If(`t.joint_input_id==${jointIds[i]}`,A(`v.joint_enabled_${i}`,'t.joint_input_enabled'))),A('t.joint_input_index','t.joint_input_index+1'),
    ])]:[]),
  ])];
  const motion=kinds.length?[If('v.active&&v.ragdoll_motion_ack<v.ragdoll_motion_last',[
    Loop(MAX_MOTIONS,[If('v.ragdoll_motion_ack<v.ragdoll_motion_last',[
      A('t.input_slot',`math.mod(v.ragdoll_motion_ack,${MAX_MOTIONS})`),
      motionFields.map(key=>A('t.input_'+key,choose('t.input_slot',slots(MAX_MOTIONS).map(i=>`v.ragdoll_motion_${i}_${key}`)))),
      If('t.input_seq==v.ragdoll_motion_ack+1',[
        If(kinds.map(kind=>'t.input_kind=='+kind).join('||'),[control.apply('motion'),A('v.sleep',0)]),
        A('v.ragdoll_motion_ack','t.input_seq'),
      ]),
    ])]),
  ])]:[];
  const forces=[If('v.ragdoll_force_count>0',[
    A('v.sleep',0),A('t.input_force_index',0),Loop(`math.clamp(v.ragdoll_force_count,0,${MAX_FORCES})`,[
      FORCE_FIELDS.map(key=>A('t.input_'+key,choose('t.input_force_index',slots(MAX_FORCES).map(i=>`v.ragdoll_force_${i}_${key}`)))),
      control.apply('force',1/rig.simulation.frequency),A('t.input_force_index','t.input_force_index+1'),
    ]),
  ])];
  return {initialize,frame,properties,motion,forces};
}
