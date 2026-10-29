// Client-observed motion, in world blocks/second. This estimates movement;
// it cannot read the damage impulse, attacker or hit location from an RP.
import {A,If,axes,copy,vector,emit} from '../../vendor/simple-ragdoll/src/core/expression.mjs';
import { GeneratorError } from './messages.mjs';

export const motionLimits={sample:0.05,window:0.2,deadline:0.25,gap:0.25,jump:8,rejectSpeed:80,maxSpeed:24,minChange:0.25,relativeChange:0.4};
const p='v.vr_motion_',v=k=>p+k;
const fields=['valid','active','done','pending','time','a_time','b_time','start','candidate_valid','candidate_span',...['last','a','b','speed','seed','reference','kick','candidate'].flatMap(s=>axes.map(k=>s+k))];
export const motionReserved=fields.map(v);
export const motionInitialize=emit(fields.map(k=>A(v(k),0)));
const square=(s,keys=axes)=>keys.map(k=>`${s}${k}*${s}${k}`).join('+');

export function motionFrame(){
  const c=motionLimits;
  const reset=[...['a','b'].map(s=>copy(v(s),'t.motion_p')),
    ...['time','a_time','b_time'].map(k=>A(v(k),'q.life_time')),
    vector(v('speed'),[0,0,0]),A(v('valid'),1),A(v('candidate_valid'),0),If('v.vr_run',A(v('done'),1))];
  const estimate=[
    A('t.motion_recent',`q.life_time-${v('a_time')}>=${c.sample-1e-6}`),
    // Two completed samples avoid a 30 FPS frame straddling two 20 Hz
    // position updates being mistaken for a sudden 50% increase in speed.
    A('t.motion_span',`q.life_time-${v('b_time')}`),
    ...axes.map(k=>A('t.motion_speed'+k,`(t.motion_p${k}-${v('b'+k)})/math.max(t.motion_span,${c.sample})`)),
    A('t.motion_speed2',square('t.motion_speed')),
    If(`t.motion_speed2>${c.rejectSpeed**2}`,reset,[
      A('t.motion_factor',`${c.maxSpeed}/math.max(${c.maxSpeed},math.sqrt(t.motion_speed2))`),
      axes.map(k=>A(v('speed'+k),`t.motion_speed${k}*t.motion_factor`)),
      If('t.motion_recent',[copy(v('b'),v('a')),A(v('b_time'),v('a_time')),copy(v('a'),'t.motion_p'),A(v('a_time'),'q.life_time')]),
    ]),
  ];
  const correction=[
    vector(v('kick'),[0,0,0]),
    axes.map(k=>A('t.motion_delta'+k,`${v('speed'+k)}-${v('seed'+k)}`)),
    axes.map(k=>A('t.motion_change'+k,`${v('speed'+k)}-${v('reference'+k)}`)),
    A('t.motion_old2',square(v('seed'),['x','z'])),A('t.motion_new2',square(v('speed'),['x','z'])),
    A('t.motion_delta2',square('t.motion_delta',['x','z'])),
    A('t.motion_reference2',square(v('reference'),['x','z'])),A('t.motion_change2',square('t.motion_change',['x','z'])),
    A('t.motion_dot',`${v('speedx')}*${v('seedx')}+${v('speedz')}*${v('seedz')}`),
    // Ordinary drag in the same direction is not another impact. Direction
    // changes can still qualify even when the speed does not increase.
    If(`t.motion_delta2>${c.minChange**2}&&t.motion_delta2>${c.relativeChange**2}*math.max(t.motion_old2,t.motion_new2)&&t.motion_change2>${c.minChange**2}&&t.motion_change2>${c.relativeChange**2}*math.max(t.motion_reference2,t.motion_new2)&&!(t.motion_new2<=t.motion_old2*1.05&&t.motion_dot>=0&&t.motion_dot*t.motion_dot>=0.81*t.motion_old2*t.motion_new2)`,
      ['x','z'].map(k=>A(v('kick'+k),'t.motion_delta'+k))),
    // A later downward velocity is indistinguishable from gravity. Only add
    // new upward motion; the initial falling velocity is already inherited.
    If(`${v('speedy')}>${c.minChange}&&t.motion_deltay>math.max(${c.minChange},${c.relativeChange}*math.abs(${v('seedy')}))&&t.motion_changey>math.max(${c.minChange},${c.relativeChange}*math.abs(${v('referencey')}))`,A(v('kicky'),'t.motion_deltay')),
    A('t.motion_factor',`${c.maxSpeed}/math.max(${c.maxSpeed},math.sqrt(${square(v('kick'))}))`),
    axes.map(k=>A(v('kick'+k),`${v('kick'+k)}*t.motion_factor`)),
  ];
  const lateEstimate=[
    // Every interval starts at the previous sample, so waiting for a network
    // update does not dilute the next interval's observed movement.
    A('t.motion_span',`q.life_time-${v('time')}`),
    axes.map(k=>A('t.motion_speed'+k,`(t.motion_p${k}-${v('last'+k)})/math.max(t.motion_span,${c.sample})`)),
    A('t.motion_speed2',square('t.motion_speed')),
    If(`t.motion_speed2<=${c.rejectSpeed**2}`,[
      A('t.motion_factor',`${c.maxSpeed}/math.max(${c.maxSpeed},math.sqrt(t.motion_speed2))`),
      axes.map(k=>A(v('speed'+k),`t.motion_speed${k}*t.motion_factor`)),
      A('t.motion_confirm',v('candidate_valid')),
      If(v('candidate_valid'),[
        // Confirm with the next interval. Average coherent samples by elapsed
        // time to suppress tick stair steps. Include a following idle sample:
        // a double tick followed by zero must not become a velocity spike.
        // Only these two intervals count, not the earlier waiting time.
        A('t.motion_dot',axes.map(k=>`${v('speed'+k)}*${v('candidate'+k)}`).join('+')),
        If(`(t.motion_dot>0&&t.motion_dot*t.motion_dot>=0.49*(${square(v('speed'))})*(${square(v('candidate'))}))||(${square(v('speed'))})<${c.minChange**2}`,
          axes.map(k=>A(v('speed'+k),`(${v('candidate'+k)}*${v('candidate_span')}+${v('speed'+k)}*t.motion_span)/math.max(${v('candidate_span')}+t.motion_span,${c.sample})`))),
        // A real reversal uses the latest direction. Do not replay an older
        // same-direction tick spike after the actor has been struck back.
      ]),correction,
      If('t.motion_confirm',[
        A(v('pending'),`(${square(v('kick'))})>0`),A(v('done'),v('pending')),A(v('candidate_valid'),0),
      ],[
        If(`(${square(v('kick'))})>0`,[copy(v('candidate'),v('speed')),A(v('candidate_span'),'t.motion_span'),A(v('candidate_valid'),1)]),
      ]),
      If(`q.life_time-${v('start')}>=${c.window-1e-6}`,[A(v('pending'),`${v('pending')}||${v('candidate_valid')}`),A(v('done'),1)]),
    ],[A(v('candidate_valid'),0),A(v('done'),1)]),
  ];
  return emit([
    A(v('pending'),0),
    If('!v.vr_enabled||v.vr_switch',[A(v('valid'),0),A(v('active'),0),A(v('done'),0),A(v('candidate_valid'),0),vector(v('seed'),[0,0,0])]),
    If('!v.vr_run',[A(v('active'),0),A(v('done'),0),A(v('candidate_valid'),0)]),
    // Stop sampling after the handoff window. While alive, collect only at
    // 20 Hz; activation and the final late sample can also run between ticks.
    If(`v.vr_enabled&&(!v.vr_run||!${v('done')})&&(!${v('valid')}||q.life_time<${v('time')}||q.delta_time>${c.gap}||q.life_time-${v('time')}>=${c.sample-1e-6}||(v.vr_run&&(!${v('active')}||q.life_time-${v('start')}>=${c.window-1e-6})))`,[
      axes.map((k,i)=>A('t.motion_p'+k,`q.position(${i})`)),
      axes.map(k=>A('t.motion_move'+k,`t.motion_p${k}-${v('last'+k)}`)),
      // Activation can fall between tick updates and underestimate velocity.
      // Require a change against the last complete live sample as well, so
      // recovery from that underestimation is not reported as another impact.
      If(`v.vr_run&&!${v('active')}`,copy(v('reference'),v('speed'))),
      If(`!${v('valid')}||q.life_time<${v('time')}||q.life_time-${v('time')}>${c.gap}||q.delta_time>${c.gap}||(${square('t.motion_move')})>${c.jump**2}`,reset,[
        If(`v.vr_run&&${v('active')}`,[
          If(`q.life_time-${v('start')}<=${c.deadline}`,lateEstimate,[A(v('done'),1),A(v('candidate_valid'),0)]),
        ],estimate),
      ]),
      If('v.vr_run',[
        If(`!${v('active')}`,[A(v('active'),1),A(v('start'),'q.life_time'),copy(v('seed'),v('speed'))]),
      ]),
      copy(v('last'),'t.motion_p'),A(v('time'),'q.life_time'),
    ]),
  ]);
}

// Apply once in the begin block, before any of the three possible physics
// substeps. Add a velocity delta, preserving gravity/contact response already
// accumulated by the solver. No public BP API or angular impulse is enabled.
export function motionProgram(program,rig){
  let count=0;
  function visit(nodes){for(const n of nodes.flat(Infinity)){
    if(n.kind==='set'&&axes.some(k=>n.name==='v.input_'+k)){n.value=v('seed'+n.name.at(-1));count++;}
    else if(n.kind==='if'){visit(n.yes);visit(n.no);}
    else if(n.kind==='loop')visit(n.body);
  }}
  visit(program.frameChunks[0]);
  if(count!==3)throw new GeneratorError('motion_assignments', { count });
  // Keep sampler variables read-only here so compilation recognizes them as
  // external inputs and neither renames nor zero-initializes live history.
  program.initialize.push(A('v.motion_consumed',0));
  program.frameChunks[0].push(If('v.activated',A('v.motion_consumed',0)));
  program.frameChunks[0].push(If(`${v('pending')}&&v.active&&!v.motion_consumed`,[
    ...rig.bodies.map((_,i)=>axes.map((k,j)=>A(`v.b${i}v${k}`,`v.b${i}v${k}+${v('kick'+k)}*${rig.simulation.initialVelocity[j]}`))),
    A('v.sleep',0),A('v.motion_consumed',1),
  ]));
  return program;
}
