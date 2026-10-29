import { A, If, axes, quat, vector, rotate } from './expression.mjs';
import { materialValue } from './control.mjs';

export function createResults(rig, names=[]) {
  const requested=new Set(rig.outputs??[]),references=names.filter(n=>n.startsWith('v.ragdoll_out_'));
  const bodyReferences=new Set(references.flatMap(n=>/^v\.ragdoll_out_body_(\d+)_/.exec(n)?.slice(1).map(Number)??[]));
  if(references.some(n=>/^v\.ragdoll_out_(active|paused|sleeping|time|center_|min_|max_|body_count)/.test(n)))requested.add('state');
  if(references.some(n=>n.startsWith('v.ragdoll_out_contact_')))requested.add('contacts');
  if(references.some(n=>n.includes('liquid')||n.includes('submerged')))requested.add('liquids');
  const initialize=[],frame=[],contacts=[],liquids=[],prefix='v.ragdoll_out_';
  const declare=(name,value=0)=>initialize.push(A(prefix+name,value));
  const seq=name=>A(prefix+name,`math.mod(${prefix+name},16777214)+1`);
  if(requested.has('state')) {
    for(const key of ['active','paused','sleeping','time','body_count',...axes.flatMap(k=>['center_'+k,'min_'+k,'max_'+k])])declare(key,key==='body_count'?rig.bodies.length:0);
    frame.push(A(prefix+'active','v.active'),A(prefix+'paused','v.active&&(v.ragdoll_control_mode==3||v.ragdoll_simulation_time_scale==0)'),
      A(prefix+'sleeping',`v.active&&v.sleep>=${Math.max(1,Math.round(rig.simulation.sleep.seconds*rig.simulation.frequency))}`),A(prefix+'time','v.age'),If('v.active',[
        A('t.result_mass',rig.bodies.map((_,i)=>materialValue(rig,i,'mass')).join('+')),
        axes.map(k=>A(prefix+'center_'+k,`v.o${k}+(${rig.bodies.map((_,i)=>`v.b${i}${k}*${materialValue(rig,i,'mass')}`).join('+')})/t.result_mass`)),
        vector(prefix+'min_',[1e6,1e6,1e6]),vector(prefix+'max_',[-1e6,-1e6,-1e6]),
        rig.shapes.map(s=>[
          vector('t.result_local',s.center,1/16),rotate('t.result_offset',`v.b${s.body}q`,'t.result_local'),
          ...Array.from({length:8},(_,i)=>[
            vector('t.result_corner',s.half.map((n,k)=>`(${n})*${(i&(1<<k)?1:-1)/16}`)),
            vector('t.result_sq',s.quaternion.slice(0,3)),A('t.result_sqw',s.quaternion[3]),rotate('t.result_corner','t.result_sq','t.result_corner'),rotate('t.result_corner',`v.b${s.body}q`,'t.result_corner'),
            ...axes.flatMap(k=>[A('t.result_world'+k,`v.o${k}+v.b${s.body}${k}+t.result_offset${k}+t.result_corner${k}`),
              A(prefix+'min_'+k,`math.min(${prefix}min_${k},t.result_world${k})`),A(prefix+'max_'+k,`math.max(${prefix}max_${k},t.result_world${k})`)]),
          ]),
        ]),
      ]));
  }
  rig.bodies.forEach((_,i)=>{
    if(!requested.has('bodies')&&!bodyReferences.has(i))return;
    const out=prefix+`body_${i}_`;
    const fields=[...axes.flatMap(k=>['position_'+k,'velocity_'+k,'angular_velocity_'+k]),...quat.map(k=>'rotation_'+k)];
    fields.forEach(k=>declare(`body_${i}_`+k,k==='rotation_w'?1:0));
    frame.push(If('v.active',[
      ...axes.flatMap(k=>[A(out+'position_'+k,`v.o${k}+v.b${i}${k}`),A(out+'velocity_'+k,`v.b${i}v${k}`),A(out+'angular_velocity_'+k,`v.b${i}w${k}`)]),
      ...quat.map(k=>A(out+'rotation_'+k,`v.b${i}q${k}`)),
    ]));
  });
  if(requested.has('contacts')) {
    for(const key of ['contact_seq','contact_count','contact_overflow','contact_capacity'])declare(key,key==='contact_capacity'?rig.simulation.contactLimit:0);
    contacts.push(A(prefix+'contact_count','v.contact_count'),A(prefix+'contact_overflow','v.contact_overflow'),If('v.contact_count>0',seq('contact_seq')));
    for(let i=0;i<rig.simulation.contactLimit;i++) {
      const out=prefix+`contact_${i}_`,c=rig.simulation.contactLimit>128?`v.contact_sorted_${i}_`:`v.c${i}`;
      for(const k of ['body_a','body_b','impulse',...axes.flatMap(k=>['position_'+k,'normal_'+k])])declare(`contact_${i}_`+k,k.startsWith('body')?-1:0);
      const bodyPosition=(which,k)=>rig.bodies.reduceRight((rest,_,j)=>`(${which}==${j}?v.d${j}${k}:${rest})`,'0');
      contacts.push(If(`v.contact_count>${i}`,[A(out+'body_a',`${c}hi<${rig.bodies.length}?${c}hi:-1`),A(out+'body_b',`${c}lo<${rig.bodies.length}?${c}lo:-1`),
        A(out+'impulse',`${c}l2/16`),...axes.flatMap(k=>[A(out+'normal_'+k,`${c}n${k}`),A(out+'position_'+k,`v.o${k}+((${bodyPosition(c+'hi',k)})+${c}ra${k}+(${bodyPosition(c+'lo',k)})+${c}rb${k})/32`)]),
      ]));
    }
    frame.push(If('!v.active',A(prefix+'contact_count',0)));
  }
  if(requested.has('liquids')) {
    declare('liquid_seq');declare('liquid_body',-1);declare('liquid_entered');
    rig.bodies.forEach((_,i)=>{
      declare(`body_${i}_submerged`);declare(`body_${i}_liquid_region`,-1);declare(`body_${i}_liquid_seq`);declare(`body_${i}_liquid_entered`);
      liquids.push(If(`(${prefix}body_${i}_submerged>0)!=(v.liquid_fraction_${i}>0)`,[
        seq('liquid_seq'),A(prefix+'liquid_body',i),A(prefix+'liquid_entered',`v.liquid_fraction_${i}>0`),seq(`body_${i}_liquid_seq`),A(prefix+`body_${i}_liquid_entered`,`v.liquid_fraction_${i}>0`)]),
        A(prefix+`body_${i}_submerged`,`v.liquid_fraction_${i}`),A(prefix+`body_${i}_liquid_region`,`v.liquid_region_${i}`));
    });
  }
  return {initialize,frame,contacts,liquids};
}
