import { A, If, axes, cross, dot, scale, copy, rotate } from './expression.mjs';

// World-space frames: h_axis_a/b are unit hinge axes, h_ref_a/b are their
// perpendicular zero-angle directions. Swing is separated before measuring twist.
export function hingeFrame(){
  return [
    cross('t.h_cross','t.h_axis_a','t.h_axis_b'),
    A('t.h_sin',`math.sqrt(${dot('t.h_cross','t.h_cross')})`),
    A('t.h_cos',`math.clamp(${dot('t.h_axis_a','t.h_axis_b')},-1,1)`),
    A('t.h_swing','math.atan2(t.h_sin,t.h_cos)'),
    If('t.h_sin>0.000001',scale('t.h_direction','t.h_cross','1/t.h_sin'),copy('t.h_direction','t.h_ref_a')),
    scale('t.h_error','t.h_direction','t.h_swing*0.017453292519943295'),
    scale('t.h_alignq','t.h_direction','-math.sin(t.h_swing*0.5)'),A('t.h_alignqw','math.cos(t.h_swing*0.5)'),
    rotate('t.h_aligned_ref','t.h_alignq','t.h_ref_b'),
    cross('t.h_cross','t.h_ref_a','t.h_aligned_ref'),
    A('t.h_angle',`math.atan2(${dot('t.h_axis_a','t.h_cross')},${dot('t.h_ref_a','t.h_aligned_ref')})`),
  ];
}

// Keep the signed angle continuous across atan2's -180/180 seam.
export const nearestAngle=(angle,reference)=>`(${angle})-360*math.floor(((${angle})-(${reference})+180)/360)`;

export function hingeActivation(j,i){
  return [
    ...['a','b'].flatMap(side=>[
      ...axes.map((k,n)=>A('t.h_local'+k,j['axis'+side.toUpperCase()][n])),
      rotate('t.h_axis_'+side,`v.b${j[side]}q`,'t.h_local'),
      ...axes.map((k,n)=>A('t.h_local'+k,j['twistAxis'+side.toUpperCase()][n])),
      rotate('t.h_ref_'+side,`v.b${j[side]}q`,'t.h_local'),
    ]),hingeFrame(),
    A(`v.j${i}hinge_angle`,nearestAngle('t.h_angle',`((${j.minAngle})+(${j.maxAngle}))*0.5`)),
    A(`v.j${i}hinge_initial`,`v.j${i}hinge_angle`),
  ];
}
