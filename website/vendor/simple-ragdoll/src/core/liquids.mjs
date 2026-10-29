import { A, If, Loop, axes, vector, scale, cross, rotate, choose, dispatch } from './expression.mjs';
import { MAX_LIQUIDS, liquidFields } from './input.mjs';
import { materialValue, inverseInertia } from './control.mjs';

export function createLiquids(rig) {
  const bodies=rig.bodies,shapes=rig.shapes,dt=1/rig.simulation.frequency;
  const volume=s=>`((${s.half[0]})*(${s.half[1]})*(${s.half[2]})/512)`;
  const totalVolume=i=>'('+shapes.filter(s=>s.body===i).map(volume).join('+')+')';
  const initialize=bodies.map((_,i)=>[A(`v.liquid_fraction_${i}`,0),A(`v.liquid_region_${i}`,-1)]);
  const step=[
    bodies.map((_,i)=>[A(`v.liquid_fraction_${i}`,0),A(`v.liquid_region_${i}`,-1),A(`v.liquid_mass_${i}`,0),
      A(`v.liquid_drag_${i}`,0),A(`v.liquid_angular_drag_${i}`,0),vector(`v.liquid_torque_${i}_`,[0,0,0])]),
    If('v.ragdoll_liquid_count>0',[
      A('t.fluid_shape',0),Loop(shapes.length,[
        A('t.fluid_body',choose('t.fluid_shape',shapes.map(s=>s.body))),
        axes.map(k=>A('t.fluid_b'+k,choose('t.fluid_body',bodies.map((_,i)=>`v.b${i}${k}`)))),
        [...axes,'w'].map(k=>A('t.fluid_bq'+k,choose('t.fluid_body',bodies.map((_,i)=>`v.b${i}q${k}`)))),
        A('t.fluid_volume',choose('t.fluid_shape',shapes.map(s=>`${volume(s)}/8`))),
        A('t.fluid_body_volume',choose('t.fluid_body',bodies.map((_,i)=>totalVolume(i)))),
        A('t.fluid_sample',0),Loop(8,[
          ...axes.map((k,j)=>A('t.fluid_local'+k,choose('t.fluid_shape',shapes.map(s=>`(${s.half[j]})*(math.mod(math.floor(t.fluid_sample/${2**j}),2)-0.5)/16`)))),
          ...[...axes,'w'].map((k,j)=>A('t.fluid_sq'+k,choose('t.fluid_shape',shapes.map(s=>s.quaternion[j])))),
          rotate('t.fluid_local','t.fluid_sq','t.fluid_local'),
          ...axes.map((k,j)=>A('t.fluid_local'+k,`t.fluid_local${k}+(${choose('t.fluid_shape',shapes.map(s=>s.center[j]))})/16`)),
          rotate('t.fluid_offset','t.fluid_bq','t.fluid_local'),
          ...axes.map(k=>A('t.fluid_point'+k,`v.o${k}+t.fluid_b${k}+t.fluid_offset${k}`)),
          A('t.fluid_index',0),A('t.fluid_found',0),Loop(`math.clamp(v.ragdoll_liquid_count,0,${MAX_LIQUIDS})`,[
            If('!t.fluid_found',[
              dispatch('t.fluid_index',Array.from({length:MAX_LIQUIDS},(_,i)=>i),i=>liquidFields.map(k=>A('t.fluid_'+k,`v.ragdoll_liquid_${i}_${k}`))),
              If(axes.map(k=>`t.fluid_point${k}>=t.fluid_min${k}&&t.fluid_point${k}<t.fluid_max${k}`).join('&&'),[
                A('t.fluid_found',1),A('v.sleep',0),
                axes.map(k=>A('t.fluid_force'+k,`-v.gravity_${k}*t.fluid_density*t.fluid_volume`)),cross('t.fluid_torque','t.fluid_offset','t.fluid_force'),
                dispatch('t.fluid_body',bodies,(_,i)=>[
                  A(`v.liquid_fraction_${i}`,`v.liquid_fraction_${i}+t.fluid_volume/t.fluid_body_volume`),A(`v.liquid_region_${i}`,'t.fluid_index'),
                  A(`v.liquid_mass_${i}`,`v.liquid_mass_${i}+t.fluid_density*t.fluid_volume`),
                  A(`v.liquid_drag_${i}`,`v.liquid_drag_${i}+t.fluid_drag*t.fluid_volume/t.fluid_body_volume`),
                  A(`v.liquid_angular_drag_${i}`,`v.liquid_angular_drag_${i}+t.fluid_angulardrag*t.fluid_volume/t.fluid_body_volume`),
                  axes.map(k=>A(`v.liquid_torque_${i}_${k}`,`v.liquid_torque_${i}_${k}+t.fluid_torque${k}`)),
                ]),
              ]),
            ]),A('t.fluid_index','t.fluid_index+1'),
          ]),A('t.fluid_sample','t.fluid_sample+1'),
        ]),A('t.fluid_shape','t.fluid_shape+1'),
      ]),
      bodies.map((_,i)=>If(`v.liquid_fraction_${i}>0`,[
        ...axes.map(k=>A(`v.b${i}v${k}`,`v.b${i}v${k}*math.pow(2.718281828459045,-v.liquid_drag_${i}*${dt})-v.gravity_${k}*v.liquid_mass_${i}/${materialValue(rig,i,'mass')}*${dt}`)),
        scale('t.fluid_inverse',`v.b${i}q`,-1),A('t.fluid_inversew',`v.b${i}qw`),rotate('t.fluid_spin','t.fluid_inverse',`v.liquid_torque_${i}_`),
        ...axes.map((k,j)=>A('t.fluid_spin'+k,`t.fluid_spin${k}*${inverseInertia(rig,i,j)}*256*${dt}`)),rotate('t.fluid_spin',`v.b${i}q`,'t.fluid_spin'),
        ...axes.map(k=>A(`v.b${i}w${k}`,`v.b${i}w${k}*math.pow(2.718281828459045,-v.liquid_angular_drag_${i}*${dt})+t.fluid_spin${k}`)),
      ])),
    ]),
  ];
  return {initialize,step};
}
