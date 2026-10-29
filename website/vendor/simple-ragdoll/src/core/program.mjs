import { compactBegin, compactOutput } from "./compact.mjs";
import { groupVariables, lowerRecords } from "./storage.mjs";
import { compilePrograms } from "./compute.mjs";
import { A, If, axes, quat, set, vector, copy, add, sub, scale, dot, rotate, multiply, normalize, axisRotation } from "./expression.mjs";
import { createDynamics } from "./dynamics.mjs";
import { hingeActivation } from "./hinge.mjs";
import { createInputs } from "./input.mjs";
import { createLiquids } from "./liquids.mjs";
import { createResults } from "./results.mjs";
import { worldSpace, worldRig } from './space.mjs';
import { specializeApi } from './api-specialize.mjs';

const quaternion=(out,values)=>quat.map((k,i)=>A(out+k,values[i]));
const inverse=(out,q)=>[scale(out,q,-1),A(out+"w",q+"w")];
const reflected=(out,q)=>[A(out+"x",`-${q}x`),A(out+"y",`-${q}y`),A(out+"z",q+"z"),A(out+"w",q+"w")];

function modelQuaternion(out,angles) {
  return [axisRotation("t.euler_x","x",`-(${angles[0]})`),axisRotation("t.euler_y","y",angles[1]),axisRotation("t.euler_z","z",`-(${angles[2]})`),
    multiply("t.euler_xy","t.euler_y","t.euler_x"),multiply(out,"t.euler_z","t.euler_xy")];
}
function modelEuler(out,q) {
  return [A("t.sy",`math.clamp(2*(${q}w*${q}y-${q}z*${q}x),-1,1)`),A(out+"y","math.asin(t.sy)"),
    If("math.abs(t.sy)<0.999999",[
      A(out+"x",`-math.atan2(2*(${q}w*${q}x+${q}y*${q}z),1-2*(${q}x*${q}x+${q}y*${q}y))`),
      A(out+"z",`-math.atan2(2*(${q}w*${q}z+${q}x*${q}y),1-2*(${q}y*${q}y+${q}z*${q}z))`),
    ],[A(out+"x",`-math.atan2(2*(${q}w*${q}x-${q}y*${q}z),1-2*(${q}x*${q}x+${q}z*${q}z))`),A(out+"z",0)])];
}

export function anchorPrograms() {
  return {
    initialize:[set("v.anchor_",{ready:0,tick:-1}),...["p","c","r"].map(key=>vector("v.anchor_"+key,[0,0,0]))],
    frame:[
      A("v.anchor_now","math.floor(q.life_time*20+0.001)"),A("v.anchor_alpha","math.clamp(q.frame_alpha,0,1)"),
      A("v.anchor_reset","!v.anchor_ready||v.anchor_now<v.anchor_tick||v.anchor_now-v.anchor_tick>1||q.delta_time>0.25||math.abs(v.ex-v.anchor_cx)+math.abs(v.ey-v.anchor_cy)+math.abs(v.ez-v.anchor_cz)>4"),
      If("v.anchor_reset",[copy("v.anchor_p","v.e"),copy("v.anchor_c","v.e"),A("v.anchor_tick","v.anchor_now"),A("v.anchor_ready",1)]),
      If("v.anchor_now!=v.anchor_tick",[copy("v.anchor_p","v.anchor_c"),A("v.anchor_tick","v.anchor_now")]),
      copy("v.anchor_c","v.e"),axes.map(k=>A("v.anchor_r"+k,`math.lerp(v.anchor_p${k},v.anchor_c${k},v.anchor_alpha)`)),
    ],
  };
}

export function deathPrograms() {
  return {
    initialize:set("v.death_",{ready:0,previous:0,current:0}),
    frame:[
      A("t.death_tick","q.is_alive?0:math.max(0,q.death_ticks)"),
      A("t.death_reset","!v.death_ready||t.death_tick<v.death_current||t.death_tick-v.death_current>1||q.delta_time>0.25"),
      If("q.is_alive",set("v.death_",{previous:0,current:0,ready:1}),[
        If("t.death_reset",[
          A("v.death_previous","math.max(0,t.death_tick-1)"),A("v.death_current","t.death_tick"),A("v.death_ready",1),
        ],[
          If("t.death_tick!=v.death_current",A("v.death_previous","v.death_current")),A("v.death_current","t.death_tick"),
        ]),
      ]),
    ],
  };
}

export function poseCapture(rig) {
  // Native bone queries expose the last evaluated pose, so use that frame's
  // model-to-world conversion rather than a size expression changed by damage.
  return [A("v.pose_valid",1),A("v.pose_to_world","v.previous_to_world"),A("v.pose_yaw","q.body_y_rotation"),
    rig.bodies.map((body,i)=>[
      A("t.bone",`q.bone_orientation_trs('${body.bone.toLowerCase()}')`),
      // Zero scale hides bones, but its singular matrix has no usable rotation.
      // Do not read that rotation until all three scale axes are nonzero.
      A(`v.pose${i}hidden`,`!(${axes.map(k=>`math.abs(t.bone.s.${k})>=0.000001`).join("&&")})`),
      If(`!v.pose${i}hidden`,[
        axes.map(k=>A(`v.pose${i}t${k}`,`t.bone.t.${k}`)),
        axes.map(k=>A(`v.pose${i}s${k}`,`t.bone.s.${k}`)),
        modelQuaternion(`v.pose${i}q`,axes.map(k=>`t.bone.r.${k}`)),
      ]),
    ])];
}

export function hiddenPoseFallback(rig) {
  const order=[],seen=new Set();
  const visit=i=>{if(seen.has(i))return;seen.add(i);const parent=rig.bodies[i].parent;if(parent>=0)visit(parent);order.push(i);};
  rig.bodies.forEach((_,i)=>visit(i));
  // Resolve parents first, even when configuration body order differs from bone order.
  return order.map(i=>{
    const body=rig.bodies[i],p=`v.pose${i}`,parent=body.parent,ancestor=rig.bodies[parent];
    return If(p+'hidden',[
      ...(parent>=0?[copy('t.fallback_q',`v.pose${parent}q`,quat),copy('t.fallback_t',`v.pose${parent}t`),copy(p+'s',`v.pose${parent}s`)]:[
        quaternion('t.fallback_q',[0,0,0,1]),vector('t.fallback_t',[0,0,0]),vector(p+'s',[1,1,1]),
      ]),
      quaternion('t.fallback_chain',body.parentTransform.q),vector('t.fallback_pivot',body.pivot),
      rotate('t.fallback_pivot','t.fallback_chain','t.fallback_pivot'),
      axes.map((k,j)=>A('t.fallback_pivot'+k,`(t.fallback_pivot${k}+(${body.parentTransform.t[j]})-(${ancestor?.pivot[j]??0}))*${p}s${k}`)),
      rotate('t.fallback_pivot','t.fallback_q','t.fallback_pivot'),add(p+'t','t.fallback_t','t.fallback_pivot'),
      modelQuaternion('t.fallback_local',body.bindRotation),multiply('t.fallback_local','t.fallback_chain','t.fallback_local'),
      multiply(p+'q','t.fallback_q','t.fallback_local'),
    ]);
  });
}

function gaussian(out,amount) {
  return [A("t.random_a","math.max(0.000001,1-math.random(0,1))"),A("t.random_b","math.random(0,360)"),A(out,`math.sqrt(-2*math.ln(t.random_a))*math.cos(t.random_b)*${amount}`)];
}
export function activate(rig) {
  const {bodies,joints,simulation:s}=rig,poseKeys=[...axes,...quat.map(k=>"q"+k)];
  return [set("v.",{active:1,activated:1,accum:0,sleep:0,tick:0,age:0,steps:0,alpha:0}),copy("v.o","v.e"),worldSpace(rig).capture,axisRotation("t.entityq","y","-v.pose_yaw"),
    bodies.map((body,i)=>{
      const b=`v.b${i}`,p=`v.pose${i}`;
      // 查询位移是动画后的枢轴位置，质心偏移以骨骼枢轴为原点。
      return [vector("t.center",body.modelCenter.map((n,k)=>`((${n})-(${body.pivot[k]}))*${p}s${axes[k]}`)),rotate("t.center",p+"q","t.center"),add("t.center","t.center",p+"t"),
        A("t.centerz","-t.centerz"),scale("t.center","t.center","v.pose_to_world"),rotate(b,"t.entityq","t.center"),
        reflected("t.physicalq",p+"q"),multiply(b+"q","t.entityq","t.physicalq"),
      ];
    }),
    joints.map((j,i)=>[
      vector(`v.j${i}base_a`,j.anchorA),vector(`v.j${i}base_b`,j.anchorB),
      vector("t.offset",j.transitionAnchorA),add(`v.j${i}a`,`v.j${i}base_a`,"t.offset"),
      vector("t.offset",j.transitionAnchorB),add(`v.j${i}b`,`v.j${i}base_b`,"t.offset"),
      ...[false,true].map(twist=>[
        vector("t.axis",twist?j.twistAxisA:j.axisA),rotate("t.axis_a",`v.b${j.a}q`,"t.axis"),
        vector("t.axis",twist?j.twistAxisB:j.axisB),rotate("t.axis_b",`v.b${j.b}q`,"t.axis"),
        A(`v.j${i}${twist?"twist":"swing"}`,`math.acos(math.clamp(${dot("t.axis_a","t.axis_b")},-1,1))`),
      ]),
      ...(j.hinge===0?[]:j.hinge===1?hingeActivation(j,i):[If(j.hinge,hingeActivation(j,i))]),
    ]),
    gaussian("t.spin_xa",s.initialSpin),gaussian("t.spin_ya",s.initialSpin),gaussian("t.spin_xb",s.initialSpin),gaussian("t.spin_yb",s.initialSpin),
    vector("v.spin",["(t.spin_xa+t.spin_xb)*3.141592653589793","(t.spin_ya+t.spin_yb)*3.141592653589793",0]),
    bodies.map((body,i)=>{const b=`v.b${i}`;return [copy(b+"prev",b,poseKeys),copy(b+"old",b,poseKeys),
      axes.map((k,j)=>A(b+"v"+k,`v.input_${k}*${s.initialVelocity[j]}`)),scale(b+"w","v.spin",i===0?2:`math.min(1,(${body.mass})/(${bodies[0].mass}))`)];}),
  ];
}

function interpolatedBodies(rig) {
  return rig.bodies.map((_,i)=>{
    const b=`v.b${i}`;
    return [axes.map(k=>A(`v.render${i}${k}`,`${b}prev${k}+(${b}${k}-${b}prev${k})*v.alpha`)),
      A("t.sign",`(${dot(b+"q",b+"prevq",quat)})<0?-1:1`),
      quat.map(k=>A("t.q"+k,`${b}prevq${k}+(${b}q${k}*t.sign-${b}prevq${k})*v.alpha`)),normalize("t.q",quat),copy(`v.render${i}q`,"t.q",quat)];
  });
}

export function boneOutput(rig,index) {
  const body=rig.bodies[index],parent=body.parent;
  const units=parent<0?'v.frame_to_world':'v.body_to_world',size=parent<0?'v.body_to_world/v.frame_to_world':'1';
  const transform=(i,out)=>[
    axisRotation("t.entity_inverse","y","q.body_y_rotation"),
    // Origin, interpolated actor position and simulated body position are all
    // blocks. Convert the complete displacement, never only the actor movement.
    axes.map(k=>A("t.center"+k,`v.o${k}-v.anchor_r${k}+v.render${i}${k}`)),
    rotate(out+"c","t.entity_inverse","t.center"),scale(out+"c",out+"c",`1/(${units})`),A(out+"cz",`-${out}cz`),
    multiply("t.physicalq","t.entity_inverse",`v.render${i}q`),reflected(out+"q","t.physicalq"),
    // 死亡侧翻是模型外层变换，由物理根骨骼同时补偿位置和朝向，子骨骼继承。
    ...(parent<0?[If("!q.is_alive",[
      axisRotation("t.death_inverse","z","math.min(math.sqrt(math.max(0,math.lerp(v.death_previous,v.death_current,math.clamp(q.frame_alpha,0,1)))/20*1.6),1)*90"),
      rotate(out+"c","t.death_inverse",out+"c"),multiply(out+"q","t.death_inverse",out+"q"),
    ])]:[]),
    vector("t.bind_center",rig.bodies[i].modelCenter,size),rotate("t.bind_center",out+"q","t.bind_center"),sub(out+"t",out+"c","t.bind_center"),
  ];
  return [transform(index,"t.body_"),
    ...(parent>=0?transform(parent,"t.parent_"):[quaternion("t.parent_q",[0,0,0,1]),vector("t.parent_t",[0,0,0])]),
    vector("t.chain_t",body.parentTransform.t),rotate("t.chain_t","t.parent_q","t.chain_t"),add("t.parent_t","t.parent_t","t.chain_t"),
    quaternion("t.chain_q",body.parentTransform.q),multiply("t.parent_q","t.parent_q","t.chain_q"),inverse("t.parent_inverse","t.parent_q"),
    sub("t.local_center","t.body_c","t.parent_t"),rotate("t.local_center","t.parent_inverse","t.local_center"),multiply("t.local_q","t.parent_inverse","t.body_q"),
    vector("t.pivot",body.pivot),vector("t.offset",body.modelCenter.map((n,k)=>`(${n})-(${body.pivot[k]})`),size),rotate("t.offset","t.local_q","t.offset"),
    axes.map(k=>A(`v.out${index}p${k}`,`t.local_center${k}-t.pivot${k}-t.offset${k}`)),
    modelEuler(`v.out${index}r`,"t.local_q"),axes.map((k,j)=>A(`v.out${index}r${k}`,`v.out${index}r${k}-(${body.bindRotation[j]})`)),
  ];
}

export function createProgram(model, {preview=false,reservedNames=[],id="generated"}={}) {
  const rig=worldRig(model),space=worldSpace(model);
  const s=rig.simulation,dt=1/s.frequency,anchor=anchorPrograms(),death=deathPrograms(),d=createDynamics(rig,s),input=createInputs(rig),liquids=createLiquids(rig),results=createResults(rig,reservedNames),poseKeys=[...axes,...quat.map(k=>"q"+k)];
  let variant=String(rig.variants.length-1);
  for(let i=rig.variants.length-2;i>=0;i--)variant=`(${rig.variants[i].when})?${i}:(${variant})`;
  let initialize=[set("v.",{active:0,activated:0,variant:0,accum:0,sleep:0,tick:0,age:0,steps:0,alpha:0,has_position:0,pose_valid:0,frames:0}),space.initialize,
    vector("v.last_",[0,0,0]),anchor.initialize,death.initialize,input.initialize,liquids.initialize,results.initialize,
    rig.bodies.map((_,i)=>[set(`v.b${i}`,Object.fromEntries([...poseKeys,...poseKeys.map(k=>"prev"+k),...poseKeys.map(k=>"old"+k),...axes.flatMap(k=>["v"+k,"w"+k])].map(k=>[k,k.endsWith("qw")?1:0]))),
      vector(`v.render${i}`,[0,0,0]),quaternion(`v.render${i}q`,[0,0,0,1])]),d.initializeDynamics()];
  const begin=[space.frame,death.frame,axes.map((k,i)=>A("v.e"+k,`q.position(${i})`)),anchor.frame,A("v.steps",0),A("v.activated",0),
    axes.map(k=>A("v.input_"+k,`v.has_position?(v.e${k}-v.last_${k})/math.max(q.delta_time,0.001):0`)),copy("v.last_","v.e"),A("v.has_position",1),
    input.frame,
    If(`v.active&&(v.ragdoll_control_mode==2||(v.ragdoll_control_mode==0&&(${rig.release})))`,[A("v.active",0),A("v.accum",0),A("v.pose_valid",0),A("v.frames",0)]),
    If("!v.active",[A("v.variant",variant),If("v.frames>0",[poseCapture(rig),hiddenPoseFallback(rig)]),
      If(`(v.ragdoll_control_mode==1||v.ragdoll_control_mode==3||(v.ragdoll_control_mode==0&&(${rig.trigger})))&&v.pose_valid`,activate(rig)),A("v.frames","v.frames+1")]),
    input.properties,input.motion,
    If("v.active&&!v.activated&&v.ragdoll_control_mode!=3&&v.ragdoll_simulation_time_scale>0",[A("v.accum",`math.min(v.accum+math.max(q.delta_time,0)*math.clamp(v.ragdoll_simulation_time_scale,0,2),${dt*3})`),A("v.steps",`math.floor(v.accum*${s.frequency}+0.00001)`),A("v.accum",`math.max(0,v.accum-v.steps*${dt})`),A("v.alpha",`math.clamp(v.accum*${s.frequency},0,1)`)]),
  ];
  const sleepTicks=Math.max(1,Math.round(s.sleep.seconds*s.frequency)),checkTicks=Math.max(1,Math.round(s.sleep.checkInterval*s.frequency));
  const tick=[A("v.tick","v.tick+1"),A("v.age",`v.age+${dt}`),rig.bodies.map((_,i)=>copy(`v.b${i}prev`,`v.b${i}`,poseKeys)),
    input.forces,liquids.step,results.liquids,A("v.was_sleeping",`v.sleep>=${sleepTicks}`),A("v.awake",`v.sleep<${sleepTicks}||math.mod(v.tick,${checkTicks})==0`)];
  const finish=[A("t.motion",rig.bodies.map((_,i)=>`(${dot(`v.b${i}v`,`v.b${i}v`)})`).reduce((a,b)=>`math.max(${a},${b})`)),
    A("v.sleep",`v.support&&t.motion<${s.sleep.speed**2}?math.min(${sleepTicks},v.sleep+1):math.max(0,v.sleep-1/3)`),
    If(`v.sleep>=${sleepTicks}`,rig.bodies.map((_,i)=>[vector(`v.b${i}v`,[0,0,0]),vector(`v.b${i}w`,[0,0,0]),If("v.was_sleeping",copy(`v.b${i}`,`v.b${i}prev`,poseKeys),copy(`v.b${i}prev`,`v.b${i}`,poseKeys))]))];
  const anchors=rig.joints.map((j,i)=>[...["A","B"].map(side=>axes.map((k,n)=>A(`v.j${i}${side.toLowerCase()}${k}`,`v.j${i}base_${side.toLowerCase()}${k}+(${j['transitionAnchor'+side][n]})*math.max(0,1-v.age/${s.poseTransition})`)))]);
  const dynamics=[[anchors,d.prepareBodies()],d.bodyContacts(),d.terrainContacts(),d.sortContacts(),...d.solverChunks(),results.contacts,d.integrateBodies(),finish];
  let frameBlocks=[compactBegin(rig,begin,poseCapture(rig),activate(rig),hiddenPoseFallback(rig)),
    ...Array.from({length:3},(_,i)=>[If('v.active&&v.steps>'+i,[tick,If('v.awake',dynamics)])]),
    [If('v.active',[interpolatedBodies(rig),compactOutput(rig,boneOutput)]),results.frame]];
  let rootOutputs=rig.bodies.map((_,i)=>boneOutput(rig,i));
  const lowered=lowerRecords({initialize:groupVariables(initialize),frame:frameBlocks.map(groupVariables),rootOutputs:rootOutputs.map(groupVariables)});
  const specialized=specializeApi({initialize:lowered.initialize,frameChunks:lowered.frame,rootOutputs:lowered.rootOutputs},rig.api);
  initialize=specialized.initialize;frameBlocks=specialized.frameChunks;rootOutputs=specialized.rootOutputs;
  if(preview)return {initialize,frameChunks:frameBlocks,rootOutputs};
  return compilePrograms([{name:id,rig:model,initialize,frameChunks:frameBlocks,rootOutputs}],{reservedNames})[0];
}

export const testMath={...Object.fromEntries(["sqrt","abs","min","max","floor","ln","pow"].map(k=>[k,k==="ln"?Math.log:Math[k]])),random:(a,b)=>a+(b-a)*Math.random(),
  sin:x=>Math.sin(x*Math.PI/180),cos:x=>Math.cos(x*Math.PI/180),acos:x=>Math.acos(x)*180/Math.PI,asin:x=>Math.asin(x)*180/Math.PI,atan2:(y,x)=>Math.atan2(y,x)*180/Math.PI,
  clamp:(v,a,b)=>Math.min(b,Math.max(a,v)),mod:(a,b)=>a%b,lerp:(a,b,t)=>a+(b-a)*t};
