// Sleeping bodies watch all contacting shapes, including detached accessories.
// This adapter runs before API specialization so disabled inputs still fold out.
import {A,If,Loop,axes,quat,choose,rotate,multiply,vector} from './expression.mjs';
import {worldRig} from './space.mjs';

function terrainSnapshot(model,{absolute=false,shapeIndices}={}){
  const rig=worldRig(model),shapes=shapeIndices?shapeIndices.map(i=>rig.shapes[i]):rig.shapes;
  if(!shapes.length||shapes.some(s=>!s))throw new Error('Terrain recovery requires contacting shapes');
  const pick=values=>choose('t.watch_shape',values),query=absolute?'q.block_has_any_tag':'q.relative_block_has_any_tag';
  const coords=axes.map(k=>'t.watch_cell'+k+(absolute?'':'-math.floor(v.e'+k+')')).join(',');
  const tags=values=>values.map(t=>`'${t}'`).join(',');
  const solid=`${query}(${coords},${tags(rig.simulation.terrain.includeTags)})`+(rig.simulation.terrain.excludeTags.length?`&&!${query}(${coords},${tags(rig.simulation.terrain.excludeTags)})`:'');
  return [A('v.watch_new_a',0),A('v.watch_new_b',0),A('v.watch_new_n',0),If('v.ragdoll_terrain_mode!=1',[A('t.watch_shape',0),Loop(shapes.length,[
    ...axes.map(k=>A('t.watch_body'+k,pick(shapes.map(s=>'v.b'+s.body+k)))),
    ...quat.map(k=>A('t.watch_bodyq'+k,pick(shapes.map(s=>'v.b'+s.body+'q'+k)))),
    ...axes.map((k,i)=>A('t.watch_local'+k,pick(shapes.map(s=>s.center[i])))),
    ...quat.map((k,i)=>A('t.watch_localq'+k,pick(shapes.map(s=>s.quaternion[i])))),
    rotate('t.watch_center','t.watch_bodyq','t.watch_local'),multiply('t.watch_q','t.watch_bodyq','t.watch_localq'),
    ...axes.map((_,i)=>[vector('t.watch_unit',axes.map((_,j)=>Number(i===j))),rotate('t.watch_axis'+i,'t.watch_q','t.watch_unit')]),
    ...axes.flatMap(k=>[
      A('t.watch_extent'+k,axes.map((l,j)=>`math.abs(t.watch_axis${j}${k})*(${pick(shapes.map(s=>s.half[j]))})`).join('+')),
      // Include touching support cells on exact integer boundaries.
      A('t.watch_min'+k,`math.floor(v.o${k}+t.watch_body${k}+(t.watch_center${k}-t.watch_extent${k})/16-0.001)`),
      A('t.watch_max'+k,`math.floor(v.o${k}+t.watch_body${k}+(t.watch_center${k}+t.watch_extent${k})/16+0.001)`),
    ]),
    A('t.watch_cellx','t.watch_minx'),Loop('t.watch_maxx-t.watch_minx+1',[
      A('t.watch_celly','t.watch_miny'),Loop('t.watch_maxy-t.watch_miny+1',[
        A('t.watch_cellz','t.watch_minz'),Loop('t.watch_maxz-t.watch_minz+1',[
          A('t.watch_solid',0),
          If('v.ragdoll_terrain_mode!=2||'+axes.map(k=>`t.watch_cell${k}<v.ragdoll_terrain_bounds_min${k}||t.watch_cell${k}>=v.ragdoll_terrain_bounds_max${k}`).join('||'),A('t.watch_solid',solid)),
          // Two bounded rolling fingerprints retain exact integer arithmetic in
          // float Molang. Enumerate every cell, not only the solid-cell count.
          A('v.watch_new_a','math.mod(v.watch_new_a*31+t.watch_solid,65521)'),
          A('v.watch_new_b','math.mod(v.watch_new_b*37+t.watch_solid,65519)'),
          A('v.watch_new_n','v.watch_new_n+1'),A('t.watch_cellz','t.watch_cellz+1'),
        ]),A('t.watch_celly','t.watch_celly+1'),
      ]),A('t.watch_cellx','t.watch_cellx+1'),
    ]),A('t.watch_shape','t.watch_shape+1'),
  ])])];
}

// Callers with native renderer adapters may defer this pass and provide the
// same terrain-contact shape subset / coordinate system used by their solver.
export function terrainRecoveryProgram(program,rig,options={}){
  const frequency=rig.simulation.frequency,sleep=Math.max(1,Math.round(rig.simulation.sleep.seconds*frequency)),check=Math.max(1,Math.round(rig.simulation.sleep.checkInterval*frequency));
  const snapshot=terrainSnapshot(rig,options),hold=Math.max(2,Math.round(.25*frequency));
  const initial={watch_a:0,watch_b:0,watch_n:0,watch_valid:0,recovery_blocked:0,recovery_armed:0,recovery_hold:0,recovery_deep:0,recovery_best:0,recovery_time:0};
  const reset=()=>Object.entries(initial).map(([k,v])=>A('v.'+k,v));
  const remember=[A('v.watch_a','v.watch_new_a'),A('v.watch_b','v.watch_new_b'),A('v.watch_n','v.watch_new_n'),A('v.watch_valid',1)];
  const freeze=rig.bodies.flatMap((_,i)=>[
    ...axes.flatMap(k=>[A(`v.b${i}v${k}`,0),A(`v.b${i}w${k}`,0)]),
    ...[...axes,...quat.map(k=>'q'+k)].map(k=>A(`v.b${i}${k}`,`v.b${i}prev${k}`)),
  ]);
  const poll=If(`(v.recovery_blocked||v.sleep>=${sleep})&&math.mod(v.tick,${check})==0`,[
    snapshot,
    If('!v.watch_valid||v.watch_new_a!=v.watch_a||v.watch_new_b!=v.watch_b||v.watch_new_n!=v.watch_n',[
      A('v.sleep',0),A('v.recovery_blocked',0),A('v.recovery_armed',1),A('v.recovery_time',0),A('v.recovery_best',0),A('v.recovery_hold',hold),A('v.watch_valid',0),
    ]),
  ]);
  const finish=[
    // A witnessed terrain edit permits prompt suspension. Without that
    // evidence, grant ordinary landings a much longer convergence window and
    // reset it as soon as the solver starts approaching ordinary sleep.
    If('v.recovery_deep>2&&(v.recovery_armed||v.sleep<1)',[
      If('v.recovery_best==0||v.recovery_deep<v.recovery_best*0.8',[
        A('v.recovery_best','v.recovery_deep'),A('v.recovery_time',0),
      ],A('v.recovery_time',`v.recovery_time+${1/frequency}`)),
    ],[A('v.recovery_best',0),A('v.recovery_time',0)]),
    If('v.recovery_time>=(v.recovery_armed?0.75:4)',[
      A('v.recovery_blocked',1),A('v.sleep',sleep),freeze,
    ]),
    // Save only on entry. Unchanged sleepers never invoke SAT/sorting/solving.
    If(`(v.sleep>=${sleep}&&!v.was_sleeping)||(!v.watch_valid&&v.recovery_blocked)`,[snapshot,remember,A('v.recovery_armed',0)]),
  ];
  // API commands already restart the complete ordinary sleep countdown. Keep
  // that timing; only observed block edits need the additional settling hold.
  const wake=[A('v.sleep',0),A('v.recovery_blocked',0),A('v.recovery_armed',0),A('v.recovery_time',0),A('v.recovery_best',0),A('v.recovery_hold',0),A('v.watch_valid',0)];
  let polls=0,finishes=0,depths=0,caps=0;
  const contactRhs=(nodes)=>nodes.flat(Infinity).map(n=>{
    if(n.kind==='if')return {...n,yes:contactRhs(n.yes),no:contactRhs(n.no)};
    if(n.kind==='loop')return {...n,body:contactRhs(n.body)};
    if(n.name==='t.rhs'&&String(n.value).startsWith('-t.g*t.stiff')){
      caps++;
      const ground=options.groundOnly?'1':`t.cia==${rig.bodies.length}||t.cib==${rig.bodies.length}`;
      return {...n,value:String(n.value).replace('-t.g*t.stiff',`(v.recovery_armed&&v.recovery_time>=0.25&&(${ground})?math.min(-t.g*t.stiff,48):-t.g*t.stiff)`)};
    }
    return n;
  });
  const visit=nodes=>nodes.flat(Infinity).flatMap(n=>{
    if(n.kind==='loop'){
      const mapped=n.body.at(-1)?.name==='t.phase'?{...n,body:contactRhs(n.body)}:n;
      return {...mapped,body:visit(mapped.body)};
    }
    if(n.kind==='if'){
      // Revision/session changes cover properties, joints, terrain, liquids,
      // simulation options and persistent forces. Ordered motion packets also
      // wake once when accepted; replaying a packet must not keep waking.
      if(n.test.startsWith('v.input_revision!=')||n.test.startsWith('t.input_kind==')){
        return {...n,yes:visit(n.yes).flatMap(x=>x.name==='v.sleep'&&x.value===0?wake:x),no:visit(n.no)};
      }
      // An unchanged force or fluid can keep a free body awake, but must not
      // bypass protection or accumulate velocity while geometrically blocked.
      if(n.test==='v.ragdoll_force_count>0'||n.test==='v.ragdoll_liquid_count>0')return {...n,test:`!v.recovery_blocked&&(${n.test})`,yes:visit(n.yes),no:visit(n.no)};
      // Frozen bodies must not accumulate unapplied liquid velocity. Terrain
      // changes release the freeze, then the next step resumes liquid forces.
      if(n.yes[0]?.name==='t.water_body')return {...n,test:`!v.recovery_blocked&&(v.sleep<${sleep}||math.mod(v.tick,${check})==0)`,yes:visit(n.yes),no:visit(n.no)};
      if(n.test==='t.depth>=0'&&n.yes.some(x=>x.name==='t.count')){
        depths++;
        return {...n,yes:[If(`t.abody==${rig.bodies.length}||t.bbody==${rig.bodies.length}`,A('v.recovery_deep','math.max(v.recovery_deep,t.depth)')),...visit(n.yes)],no:visit(n.no)};
      }
      return {...n,yes:visit(n.yes),no:visit(n.no)};
    }
    if(n.name==='v.active'&&n.value===1)return [n,reset()];
    if(n.name==='v.was_sleeping'){polls++;return [poll,If('v.recovery_blocked',A('v.sleep',sleep)),n];}
    if(n.name==='v.awake')return {...n,value:`!v.recovery_blocked&&v.sleep<${sleep}`};
    if(n.name==='v.contact_count'&&n.value===0)return [n,A('v.recovery_deep',0)];
    if(n.name==='v.sleep'&&String(n.value).includes('v.support&&t.motion')){
      return [A('v.recovery_hold','math.max(0,v.recovery_hold-1)'),{...n,value:`v.recovery_hold>0?0:(${n.value})`}];
    }
    return n;
  });
  program.initialize.push(...reset());
  program.frameChunks=program.frameChunks.map(visit);
  // The awake branch ends with the original sleep pose/velocity preservation.
  const append=nodes=>nodes.flat(Infinity).map(n=>{
    if(n.kind==='if'){
      if(n.test==='v.awake'){finishes++;return {...n,yes:[...n.yes,...finish]};}
      return {...n,yes:append(n.yes),no:append(n.no)};
    }
    if(n.kind==='loop')return {...n,body:append(n.body)};
    return n;
  });
  program.frameChunks=program.frameChunks.map(append);
  if(polls!==3||finishes!==3||depths<3||caps<3)throw new Error('Terrain recovery requires the three scheduled solver steps and their contact equations');
  return program;
}
