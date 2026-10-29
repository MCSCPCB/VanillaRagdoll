import { A, If, Loop, axes, quat, vector, copy, scale, add, sub, cross, rotate, multiply, choose, dispatch } from './expression.mjs';
import { apiSettings } from './api.mjs';

export const materialName = (i, key) => `v.material_${i}_${key.toLowerCase()}`;
export const materialValue = (rig, i, key) => `(v.has_material?${materialName(i,key)}:(${rig.bodies[i][key]}))`;
export const inverseMass = (rig, i) => `(v.has_material?1/${materialName(i,'mass')}:(${rig.bodies[i].inverseMass}))`;
export const inverseInertia = (rig, i, k) => `(v.has_material?(${rig.bodies[i].inverseInertia[k]})*(${rig.bodies[i].mass})/${materialName(i,'mass')}:(${rig.bodies[i].inverseInertia[k]}))`;
const states = [...axes,...axes.map(k=>'v'+k),...axes.map(k=>'w'+k),...quat.map(k=>'q'+k)];
const tensorKeys = ['xx','yy','zz','xy','xz','yz'];

export function controls(rig, ids) {
  const api=apiSettings(rig.api);
  const bodies=rig.bodies, indices=bodies.map((_,i)=>i);
  const pick=(values,index='t.input_body_index')=>choose(index,values);
  const load=(out,index='t.input_body_index')=>states.map(k=>A(out+k,pick(indices.map(i=>'v.b'+i+k),index)));
  const save=(prefix,keys=states)=>dispatch('t.input_body_index',indices,i=>keys.map(k=>A('v.b'+i+k,prefix+k)));
  const mass=index=>pick(indices.map(i=>materialValue(rig,i,'mass')),index);
  const inertia=(prefix,index)=>[
    ...axes.map((k,j)=>[vector('t.rigid_axis',axes.map((_,i)=>Number(i===j))),rotate(prefix+'u'+j,prefix+'q','t.rigid_axis'),
      A(prefix+'inertia'+j,`1/((${pick(indices.map(i=>inverseInertia(rig,i,j)),index)})*256)`)]),
    ...tensorKeys.map(pair=>A(prefix+'i'+pair,[0,1,2].map(j=>`${prefix}u${j}${pair[0]}*${prefix}u${j}${pair[1]}*${prefix}inertia${j}`).join('+'))),
  ];
  const matrix=(out,prefix,vec)=>axes.map((k,i)=>A(out+k,axes.map((l,j)=>`${prefix}${tensorKeys.find(s=>s===k+l||s===l+k)}*${vec}${l}`).join('+')));
  const aggregate=()=>[
    A('t.total_mass',0),vector('t.center',[0,0,0]),vector('t.meanv',[0,0,0]),
    A('t.rigid_index',0),Loop(bodies.length,[A('t.rigid_mass',mass('t.rigid_index')),load('t.rigid_','t.rigid_index'),
      A('t.total_mass','t.total_mass+t.rigid_mass'),...axes.flatMap(k=>[
        A('t.center'+k,`t.center${k}+t.rigid_${k}*t.rigid_mass`),A('t.meanv'+k,`t.meanv${k}+t.rigid_v${k}*t.rigid_mass`)]),A('t.rigid_index','t.rigid_index+1')]),
    scale('t.center','t.center','1/t.total_mass'),scale('t.meanv','t.meanv','1/t.total_mass'),
    ...tensorKeys.map(k=>A('t.total_i'+k,0)),vector('t.angular_momentum',[0,0,0]),
    A('t.rigid_index',0),Loop(bodies.length,[load('t.rigid_','t.rigid_index'),A('t.rigid_mass',mass('t.rigid_index')),
      inertia('t.rigid_','t.rigid_index'),sub('t.rigid_r','t.rigid_','t.center'),
      ...tensorKeys.map(pair=>A('t.total_i'+pair,`t.total_i${pair}+t.rigid_i${pair}+t.rigid_mass*(${pair[0]===pair[1]?axes.filter(k=>k!==pair[0]).map(k=>'t.rigid_r'+k+'*t.rigid_r'+k).join('+'):'-t.rigid_r'+pair[0]+'*t.rigid_r'+pair[1]})`)),
      sub('t.rigid_momentum','t.rigid_v','t.meanv'),scale('t.rigid_momentum','t.rigid_momentum','t.rigid_mass'),cross('t.rigid_orbital','t.rigid_r','t.rigid_momentum'),
      matrix('t.rigid_spin','t.rigid_i','t.rigid_w'),...axes.map(k=>A('t.angular_momentum'+k,`t.angular_momentum${k}+t.rigid_spin${k}+t.rigid_orbital${k}`)),
      A('t.rigid_index','t.rigid_index+1')]),
    A('t.inertia_scale','math.max(0.000000000000000000000000000001,math.max(t.total_ixx,math.max(t.total_iyy,t.total_izz)))'),
    ...tensorKeys.map(k=>A('t.total_i'+k,`t.total_i${k}/t.inertia_scale`)),
    A('t.cofactorxx','t.total_iyy*t.total_izz-t.total_iyz*t.total_iyz'),
    A('t.cofactoryy','t.total_ixx*t.total_izz-t.total_ixz*t.total_ixz'),
    A('t.cofactorzz','t.total_ixx*t.total_iyy-t.total_ixy*t.total_ixy'),
    A('t.cofactorxy','t.total_ixz*t.total_iyz-t.total_ixy*t.total_izz'),
    A('t.cofactorxz','t.total_ixy*t.total_iyz-t.total_ixz*t.total_iyy'),
    A('t.cofactoryz','t.total_ixy*t.total_ixz-t.total_ixx*t.total_iyz'),
    A('t.determinant','math.max(0.000000000000000000000001,t.total_ixx*t.cofactorxx+t.total_ixy*t.cofactorxy+t.total_ixz*t.cofactorxz)'),
    ...tensorKeys.map(k=>A('t.total_inverse'+k,`t.cofactor${k}/t.determinant/t.inertia_scale`)),matrix('t.meanw','t.total_inverse','t.angular_momentum'),
  ];
  const angularResponse=(out,prefix,index,torque)=>[
    scale('t.response_q',prefix+'q',-1),A('t.response_qw',prefix+'qw'),rotate('t.response_local','t.response_q',torque),
    ...axes.map((k,j)=>A('t.response_local'+k,`t.response_local${k}*(${pick(indices.map(i=>inverseInertia(rig,i,j)),index)})*256`)),rotate(out,prefix+'q','t.response_local'),
  ];
  function apply(kind,factor=1) {
    const force=kind==='force',root=rig.bodies.findIndex(b=>b.parent<0);
    const velocity=[
      If('t.input_linear',If('!t.input_part&&!t.input_angular',axes.map(k=>A('t.body_v'+k,`t.body_v${k}+t.input_${k}-t.meanv${k}`)),copy('t.body_v','t.input_'))),
      If('t.input_angular',[
        If('!t.input_part',[sub('t.body_r','t.body_','t.center'),
          If('t.input_linear',copy('t.change_w','t.input_a'),sub('t.change_w','t.input_a','t.meanw')),
          cross('t.orbital_velocity','t.change_w','t.body_r'),add('t.body_v','t.body_v','t.orbital_velocity')]),
        copy('t.body_w','t.input_a')]),
    ];
    const transform=[
      If('t.input_part',[
        If('t.input_linear',axes.map(k=>A('t.body_'+k,`t.input_${k}-v.o${k}`))),
        If('t.input_rotation',copy('t.body_q','t.input_q',quat)),
      ],[
        sub('t.body_r','t.body_','t.center'),If('t.input_rotation',[rotate('t.body_r','t.transform_q','t.body_r'),multiply('t.body_q','t.transform_q','t.body_q')]),
        ...axes.map(k=>A('t.body_'+k,`t.body_r${k}+(t.input_linear?t.input_${k}-v.o${k}:t.center${k})`)),
      ]),
    ];
    const impulse=[
      If('t.input_part',[
        ...axes.map(k=>A('t.body_v'+k,`t.body_v${k}+t.input_${k}*(${pick(indices.map(i=>inverseMass(rig,i)))})*${factor}`)),
        copy('t.action_torque','t.input_a'),If('t.input_point',[
          ...axes.map(k=>A('t.action_r'+k,`t.input_p${k}-v.o${k}-t.body_${k}`)),cross('t.action_offset','t.action_r','t.input_'),add('t.action_torque','t.action_torque','t.action_offset')]),
        angularResponse('t.action_spin','t.body_','t.input_body_index','t.action_torque'),
        ...axes.map(k=>A('t.body_w'+k,`t.body_w${k}+t.action_spin${k}*${factor}`)),
      ],[
        sub('t.body_r','t.body_','t.center'),cross('t.orbital_velocity','t.action_spin','t.body_r'),
        ...axes.flatMap(k=>[A('t.body_v'+k,`t.body_v${k}+t.input_${k}/t.total_mass*${factor}+t.orbital_velocity${k}`),A('t.body_w'+k,`t.body_w${k}+t.action_spin${k}`)]),
      ]),
    ];
    return [
      If('!t.input_part',[
        aggregate(),
        ...(!force&&api.setTransform?[If('t.input_kind==3&&t.input_rotation',[
          ...axes.map(k=>A('t.transform_inverse'+k,`-v.b${root}q${k}`)),A('t.transform_inversew',`v.b${root}qw`),multiply('t.transform_q','t.input_q','t.transform_inverse')])]:[]),
        ...(force||api.applyImpulse?[If(force?'t.input_force_index>=0':'t.input_kind==2',[
          copy('t.action_torque','t.input_a'),If('t.input_point',[
            ...axes.map(k=>A('t.action_r'+k,`t.input_p${k}-v.o${k}-t.center${k}`)),cross('t.action_offset','t.action_r','t.input_'),add('t.action_torque','t.action_torque','t.action_offset')]),
          matrix('t.action_spin','t.total_inverse','t.action_torque'),scale('t.action_spin','t.action_spin',factor),
        ])]:[]),
      ]),
      A('t.input_body_index',0),Loop(bodies.length,[If(`t.input_part==0||t.input_part==(${pick(ids)})`,[
        load('t.body_'),force?impulse:[
          ...(api.setVelocity?[If('t.input_kind==1',velocity)]:[]),
          ...(api.setTransform?[If('t.input_kind==3',transform)]:[]),
          ...(api.applyImpulse?[If('t.input_kind==2',impulse)]:[]),
        ],save('t.body_'),
        ...(!force&&api.setTransform?[If('t.input_kind==3',dispatch('t.input_body_index',indices,i=>[...axes,...quat.map(k=>'q'+k)].flatMap(k=>[A(`v.b${i}prev${k}`,'t.body_'+k),A(`v.b${i}old${k}`,'t.body_'+k)])))]:[]),
      ]),A('t.input_body_index','t.input_body_index+1')]),
    ];
  }
  return {apply,aggregate,angularResponse,load,save};
}
