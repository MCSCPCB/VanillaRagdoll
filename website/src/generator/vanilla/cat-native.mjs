// Snapshot of .local/scripts/cat-native.mjs; see SOURCE.json.
// Adult cat tail2 has a native attachment not described by its JSON pivot alone.
// Preserve the verified live local position throughout simulation. Independent
// solver translation must not pull this rendered child away from that attachment.
// Rotation still comes from the separately colliding, jointed physical tail.
import {A,If,axes,vector,axisRotation,multiply,rotate,emit} from '../../../vendor/simple-ragdoll/src/core/expression.mjs';

export const needsNativeCatTail=(entity,profile)=>['minecraft:cat','minecraft:ocelot'].includes(entity.id)&&profile.key==='default';
const local='v.vr_cat_tail_local_';
const inverse=(out,q)=>[...axes.map(k=>A(out+k,`-${q}${k}`)),A(out+'w',q+'w')];
const modelQuaternion=(out,r)=>[
  axisRotation('t.cat_x','x',`-(${r[0]})`),axisRotation('t.cat_y','y',r[1]),axisRotation('t.cat_z','z',`-(${r[2]})`),
  multiply('t.cat_xy','t.cat_y','t.cat_x'),multiply(out,'t.cat_z','t.cat_xy'),
];
const modelEuler=(out,q)=>[
  A('t.cat_sy',`math.clamp(2*(${q}w*${q}y-${q}z*${q}x),-1,1)`),A(out+'y','math.asin(t.cat_sy)'),
  If('math.abs(t.cat_sy)<0.999999',[
    A(out+'x',`-math.atan2(2*(${q}w*${q}x+${q}y*${q}z),1-2*(${q}x*${q}x+${q}y*${q}y))`),
    A(out+'z',`-math.atan2(2*(${q}w*${q}z+${q}x*${q}y),1-2*(${q}y*${q}y+${q}z*${q}z))`),
  ],[A(out+'x',`-math.atan2(2*(${q}w*${q}x-${q}y*${q}z),1-2*(${q}x*${q}x+${q}z*${q}z))`),A(out+'z',0)]),
];

export function catTailPose(rig,profileIndex){
  const index=rig.bodies.findIndex(b=>b.bone==='tail2');
  if(index<0||rig.bodies[rig.bodies[index].parent]?.bone!=='tail1')throw Error('Expected cat tail1 -> tail2 hierarchy');
  const gate=`v.vr_enabled&&!v.ragdoll_active&&v.vr_profile==${profileIndex}`;
  const initialize=[],baseline={},capture={};
  for(const [channel,key]of [['position','p'],['rotation','r']]){
    baseline[channel]=axes.map(k=>`(${gate})?{${local}base_${key}${k}=this;};return 0;`);
    capture[channel]=axes.map(k=>{
      initialize.push(A(local+key+k,0),A(local+'base_'+key+k,0));
      return `(${gate})?{${local+key+k}=this-${local}base_${key}${k};};return 0;`;
    });
  }
  const source=emit(initialize);
  return {nativeTail:true,captureOnly:true,index,local,initialize:source,before:'',
    animation:{loop:true,bones:{tail2:capture}},baselineAnimation:{loop:true,bones:{tail2:baseline}},
    queries:new Map(rig.bodies.map(b=>[b.bone.toLowerCase(),`q.bone_orientation_trs('${b.bone.toLowerCase()}')`])),
    reserved:[...new Set(source.match(/\bv\.\w+/g))]};
}

export function catTailOutput(program,rig,cache){
  const i=cache.index,parent=rig.bodies[i].parent,basis='v.cat_tail_basis';
  const relation=(q,pq)=>[
    inverse('t.cat_inv',pq),multiply('t.cat_relq','t.cat_inv',q),
  ];
  const calibration=[
    relation(`v.pose${i}q`,`v.pose${parent}q`),
    modelQuaternion('t.cat_localq',axes.map(k=>cache.local+'r'+k)),inverse('t.cat_local_inv','t.cat_localq'),
    multiply(basis,'t.cat_relq','t.cat_local_inv'),
  ];
  program.frameChunks[0].push(If('v.activated',calibration));
  program.initialize.push(vector(basis,[0,0,0]),A(basis+'w',1));
  program.initialize.push(vector('v.cat_tail_origin',[0,0,0]));
  // Convert the two simulated pivots to parent-local model space. Calibrate
  // the renderer's native origin once, so Blocky preserves the first pose but
  // can then translate tail2 independently instead of pinning it to tail1.
  const pivot=(j,out)=>[
    vector('t.cat_offset',rig.bodies[j].modelCenter.map((n,k)=>`(${n-rig.bodies[j].pivot[k]})*v.body_to_world*${k===2?-1:1}`)),
    rotate('t.cat_offset',`v.render${j}q`,'t.cat_offset'),
    ...axes.map(k=>A(out+k,`v.render${j}${k}-t.cat_offset${k}`)),
  ];
  const detached=[pivot(i,'t.cat_child'),pivot(parent,'t.cat_parent'),
    ...axes.map(k=>A('t.cat_delta'+k,`t.cat_child${k}-t.cat_parent${k}`)),
    inverse('t.cat_inv',`v.render${parent}q`),rotate('t.cat_position','t.cat_inv','t.cat_delta'),
    ...axes.map(k=>A('t.cat_position'+k,`t.cat_position${k}*${k==='z'?-1:1}/v.body_to_world`)),
    If('v.activated',axes.map(k=>A('v.cat_tail_origin'+k,`t.cat_position${k}-${cache.local}p${k}`))),
    ...axes.map(k=>A(`v.out${i}p${k}`,`t.cat_position${k}-v.cat_tail_origin${k}`)),
  ];
  // Parent-relative output inherits the existing root death-roll compensation;
  // entity yaw also cancels between the two world-space orientations. Reflect
  // their relative quaternion back into model space once, then remove the basis.
  // This is a render attachment constraint, not a change to solver positions or
  // collider centers. Do not claim exact rendered/physical center agreement.
  const output=[relation(`v.render${i}q`,`v.render${parent}q`),
    A('t.cat_relqx','-t.cat_relqx'),A('t.cat_relqy','-t.cat_relqy'),
    If('v.vr_blocky',detached,axes.map(k=>A(`v.out${i}p${k}`,cache.local+'p'+k))),
    inverse('t.cat_basis_inv',basis),multiply('t.cat_outputq','t.cat_basis_inv','t.cat_relq'),
    modelEuler(`v.out${i}r`,'t.cat_outputq')];
  program.frameChunks.at(-1).push(If('v.active',output));
  return program;
}
