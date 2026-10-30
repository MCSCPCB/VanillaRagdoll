// Camera-derived interaction, calibrated for ordinary first-person walking.
// Camera queries describe the view, not the player's collider. Other camera
// modes are not detected: third-person contact follows the camera position.
import {A,If,Loop,axes,quat,choose,dispatch,rotate,multiply,copy,vector,cross,dot} from '../../vendor/simple-ragdoll/src/core/expression.mjs';
import {worldRig} from '../../vendor/simple-ragdoll/src/core/space.mjs';

export function cameraPushProgram(program,model,{player=false}={}){
  const rig=worldRig(model),hz=rig.simulation.frequency,dt=1/hz;
  const bodyBounds=model.bodies.map(b=>b.shapes.map(s=>'('+[...s.center,...s.half].map(n=>`math.abs(${n})`).join('+')+')/16').reduce((a,b)=>`math.max(${a},${b})`,'0'));
  const initialize={ready:0,time:0,range:64,moving:0,hits:0,...Object.fromEntries(axes.flatMap(k=>[['p'+k,0],['v'+k,0]]))};
  program.initialize.push(...Object.entries(initialize).map(([k,v])=>A('v.push_'+k,v)));
  const bounds=[A('t.push_body',0),A('v.push_range',2.5),Loop(rig.bodies.length,[
    A('v.push_range',`math.max(v.push_range,${axes.map(k=>`math.abs(${choose('t.push_body',rig.bodies.map((_,i)=>'v.b'+i+k))})`).join('+')}+(${choose('t.push_body',bodyBounds)})*v.body_units+2.5)`),
    A('t.push_body','t.push_body+1'),
  ])];
  program.frameChunks[0].push(If('v.activated',[A('v.push_ready',0),bounds]));
  program.frameChunks[0].push(If(`v.active&&v.steps>0${player?'&&!q.is_local_player':''}`,[
    A('v.push_moving',0),A('t.push_distance','q.distance_from_camera'),
    If(`t.push_distance>0.0001&&t.push_distance<v.push_range+${axes.map(k=>`math.abs(v.e${k}-v.o${k})`).join('+')}`,[
      A('t.push_pitch','q.rotation_to_camera(0)'),A('t.push_yaw','q.rotation_to_camera(1)'),
      A('t.push_horizontal','t.push_distance*math.cos(t.push_pitch)'),
      // Camera vector in world axes, added relative to the fixed physics origin.
      A('t.push_cx','v.ex-v.ox-t.push_horizontal*math.sin(t.push_yaw)'),
      A('t.push_cy',`v.ey-v.oy-t.push_distance*math.sin(t.push_pitch)${player?'+1.62':''}`),
      A('t.push_cz','v.ez-v.oz+t.push_horizontal*math.cos(t.push_yaw)'),
      A('t.push_dt','q.life_time-v.push_time'),
      ...axes.map(k=>A('t.push_delta'+k,`t.push_c${k}-v.push_p${k}`)),
      If('v.push_ready&&t.push_dt>0.0001&&t.push_dt<=0.16&&q.delta_time<=0.16',[
        ...axes.map(k=>A('v.push_v'+k,`t.push_delta${k}/t.push_dt`)),
        A('t.push_speed2','v.push_vx*v.push_vx+v.push_vz*v.push_vz'),
        A('v.push_moving','t.push_speed2>0.0225&&t.push_speed2<144&&math.abs(v.push_vy)<12'),
      ]),copy('v.push_p','t.push_c'),A('v.push_time','q.life_time'),A('v.push_ready',1),
    ],A('v.push_ready',0)),
  ],If(`!v.active${player?'||q.is_local_player':''}`,[A('v.push_ready',0),A('v.push_moving',0)])));
  const pick=values=>choose('t.push_shape',values),ids=rig.bodies.map((_,i)=>i);
  const shapeTest=[
    A('t.push_shape',0),A('t.push_best',0),Loop(rig.shapes.length,[
      A('t.push_body',pick(rig.shapes.map(s=>s.body))),
      ...axes.map(k=>A('t.push_b'+k,choose('t.push_body',ids.map(i=>'v.b'+i+k)))),
      ...axes.map((k,j)=>A('t.push_offset'+k,`(${pick(rig.shapes.map(s=>s.center[j]))})/16`)),
      ...axes.map((k,j)=>A('t.push_half'+k,`(${pick(rig.shapes.map(s=>s.half[j]))})/16`)),
      A('t.push_radius','t.push_halfx+t.push_halfy+t.push_halfz+math.abs(t.push_offsetx)+math.abs(t.push_offsety)+math.abs(t.push_offsetz)+0.3'),
      // Reject distant shapes before loading or transforming any quaternion.
      If('math.abs(v.push_px-t.push_bx)<t.push_radius&&math.abs(v.push_pz-t.push_bz)<t.push_radius&&v.push_py-1.32<t.push_by+t.push_radius&&v.push_py-0.12>t.push_by-t.push_radius',[
      ...quat.map(k=>A('t.push_bq'+k,choose('t.push_body',ids.map(i=>'v.b'+i+'q'+k)))),
      rotate('t.push_offset','t.push_bq','t.push_offset'),
      ...axes.map(k=>A('t.push_s'+k,`t.push_b${k}+t.push_offset${k}`)),
      A('t.push_radius','t.push_halfx+t.push_halfy+t.push_halfz+0.3'),
      If('math.abs(v.push_px-t.push_sx)<t.push_radius&&math.abs(v.push_pz-t.push_sz)<t.push_radius&&v.push_py-1.32<t.push_sy+t.push_radius&&v.push_py-0.12>t.push_sy-t.push_radius',[
        ...quat.map((k,j)=>A('t.push_lq'+k,pick(rig.shapes.map(s=>s.quaternion[j])))),multiply('t.push_q','t.push_bq','t.push_lq'),
        ...axes.map(k=>A('t.push_iq'+k,'-t.push_q'+k)),A('t.push_iqw','t.push_qw'),
        vector('t.push_delta',['v.push_px-t.push_sx','math.clamp(t.push_sy,v.push_py-1.32,v.push_py-0.12)-t.push_sy','v.push_pz-t.push_sz']),
        rotate('t.push_local','t.push_iq','t.push_delta'),
        ...axes.map(k=>A('t.push_point'+k,`math.clamp(t.push_local${k},-t.push_half${k},t.push_half${k})`)),
        ...axes.map(k=>A('t.push_n'+k,`t.push_point${k}-t.push_local${k}`)),
        A('t.push_dist2',dot('t.push_n','t.push_n')),
        If('t.push_dist2<0.09',[
          If('t.push_dist2>0.00000001',[
            A('t.push_depth','0.3-math.sqrt(t.push_dist2)'),A('t.push_norm','1/math.sqrt(t.push_dist2)'),
            ...axes.map(k=>A('t.push_n'+k,`t.push_n${k}*t.push_norm`)),
          ],[
            // If the capsule axis already entered the box, use the upstream
            // face along walking velocity. A zero closest-point vector must
            // neither divide by zero nor make large bodies unpushable.
            vector('t.push_walk',['v.push_vx',0,'v.push_vz']),rotate('t.push_walk','t.push_iq','t.push_walk'),
            A('t.push_axis','math.abs(t.push_walkx)>math.abs(t.push_walky)?0:1'),
            A('t.push_axis',`math.abs(t.push_walkz)>math.abs(${choose('t.push_axis',['t.push_walkx','t.push_walky'])})?2:t.push_axis`),
            A('t.push_depth',.3),
            ...axes.map((k,i)=>A('t.push_n'+k,`t.push_axis==${i}?(t.push_walk${k}>0?1:-1):0`)),
            ...axes.map((k,i)=>If(`t.push_axis==${i}`,A('t.push_point'+k,`-t.push_n${k}*t.push_half${k}`))),
          ]),
          rotate('t.push_n','t.push_q','t.push_n'),
          A('t.push_closing','v.push_vx*t.push_nx+v.push_vz*t.push_nz'),
          If('t.push_closing>0.1&&t.push_depth>t.push_best',[
            A('t.push_best','t.push_depth'),A('t.push_hit','t.push_body'),copy('t.push_hitn','t.push_n'),
            rotate('t.push_point','t.push_q','t.push_point'),
            ...axes.map(k=>A('t.push_hitr'+k,`t.push_point${k}+t.push_offset${k}`)),
          ]),
        ]),
      ]),]),A('t.push_shape','t.push_shape+1'),
    ]),
    If('t.push_best>0',[
      ...quat.map(k=>A('t.push_q'+k,choose('t.push_hit',ids.map(i=>'v.b'+i+'q'+k)))),
      ...axes.flatMap(k=>['v','w'].map(p=>A('t.push_b'+p+k,choose('t.push_hit',ids.map(i=>'v.b'+i+p+k))))),
      cross('t.push_spin','t.push_bw','t.push_hitr'),
      A('t.push_closing','v.push_vx*t.push_hitnx+v.push_vz*t.push_hitnz-('+axes.map(k=>`(t.push_bv${k}+t.push_spin${k})*t.push_hitn${k}`).join('+')+')'),
      cross('t.push_torque','t.push_hitr','t.push_hitn'),
      ...axes.map(k=>A('t.push_iq'+k,'-t.push_q'+k)),A('t.push_iqw','t.push_qw'),
      rotate('t.push_response','t.push_iq','t.push_torque'),
      ...axes.map((k,j)=>A('t.push_response'+k,`t.push_response${k}*(${choose('t.push_hit',rig.bodies.map(b=>b.inverseInertia[j]))})*256`)),
      rotate('t.push_response','t.push_q','t.push_response'),
      A('t.push_im',choose('t.push_hit',rig.bodies.map(b=>b.inverseMass))),
      // Mass uses this project's authored units, not kilograms. 542 is the
      // rounded total mass of the standard player rig (541.9006).
      A('t.push_impulse',`math.min(math.max(0,t.push_closing*0.8+math.min(t.push_best*${.2/dt},0.5)),3)/(t.push_im+(${dot('t.push_torque','t.push_response')})+${1/542})`),
      A('t.push_impulse','math.min(t.push_impulse,2/t.push_im)'),
      A('t.push_impulse',`math.min(t.push_impulse,8/math.max(0.000001,math.sqrt(${dot('t.push_response','t.push_response')})))`),
      If('t.push_impulse>0.00001',[
        dispatch('t.push_hit',ids,i=>axes.flatMap(k=>[
          A(`v.b${i}v${k}`,`v.b${i}v${k}+t.push_hitn${k}*t.push_impulse*t.push_im`),
          A(`v.b${i}w${k}`,`v.b${i}w${k}+t.push_response${k}*t.push_impulse`),
        ])),A('v.sleep',0),A('v.push_hits','v.push_hits+1'),
      ]),
    ]),
  ];
  // Contact wakes ordinary sleep. It never clears recovery_blocked/time: a
  // player continuously pressing into a wall must not bypass stuck protection.
  let steps=0,finishes=0;
  const walk=nodes=>nodes.flat(Infinity).flatMap(n=>{
    if(n.kind==='loop')return {...n,body:walk(n.body)};
    if(n.kind==='if'){
      if(n.test==='v.awake'){finishes++;return {...n,yes:[...walk(n.yes),bounds],no:walk(n.no)};}
      return {...n,yes:walk(n.yes),no:walk(n.no)};
    }
    if(n.name==='v.was_sleeping'){steps++;return [If('v.push_moving&&!v.recovery_blocked',shapeTest),n];}
    return n;
  });
  program.frameChunks=program.frameChunks.map(walk);
  if(steps!==3||finishes!==3)throw Error('Camera push requires the three physics steps');
  return program;
}
