import { A, If, Loop, axes, quat, vector, rotate, cross, choose, dispatch } from '../../vendor/simple-ragdoll/src/core/expression.mjs';
import { worldRig } from '../../vendor/simple-ragdoll/src/core/space.mjs';
import { materials, fluids } from './materials.mjs';

// Choose on numeric geometry before native adapters introduce captured scale
// expressions. Sampling still uses the adapted, scaled shape at runtime.
export function waterLayout(rig) {
  return rig.bodies.map((_, i) => {
    const shapes = rig.shapes.map((s, index) => ({ s: rig.variants?.[0]?.bodies[i]?.shapes[s.part] ?? s, index })).filter(({ index }) => rig.shapes[index].body === i);
    const selected = shapes.sort((a, b) => b.s.half.reduce((x, y) => x * y, 1) - a.s.half.reduce((x, y) => x * y, 1))[0];
    if (!selected) throw Error('Water sampling requires a collider for each body');
    const { s, index } = selected;
    return { index, axis: s.half.indexOf(Math.max(...s.half)) };
  });
}

// Two interior points along the representative collider's longest axis.
// Displaced volume = reference mass / organic density, following the authored
// mass scale convention. Buoyancy = volume * fluid density * -gravity. Sample
// density and viscosity separately at each point, including mixed water/lava.
// Whole-cell tags approximate immersion; flowing surfaces are not reconstructed.
export function waterStep(model, { layout = waterLayout(model), absolute = false } = {}) {
  const rig = worldRig(model), dt = 1 / rig.simulation.frequency, bodies = rig.bodies;
  const pick = values => choose('t.water_body', values);
  const shapes = layout.map(item => rig.shapes[item.index]);
  const sample = axes.map((k, j) => A('t.water_local' + k,
    `(${pick(shapes.map((s, i) => layout[i].axis !== j ? 0 : s.half[j]))})*(t.water_sample==0?-1:1)/32`));
  // The player adapter already supplies a foot-based v.e position. Use absolute
  // block cells there, matching its collision queries instead of eye-relative Y.
  const query = absolute ? 'q.block_has_any_tag' : 'q.relative_block_has_any_tag';
  const coords = axes.map(k => `math.floor(v.o${k}+t.water_b${k}+t.water_offset${k})` + (absolute ? '' : `-math.floor(v.e${k})`));
  const sleep = Math.max(1, Math.round(rig.simulation.sleep.seconds * rig.simulation.frequency));
  const check = Math.max(1, Math.round(rig.simulation.sleep.checkInterval * rig.simulation.frequency));
  return [If(`v.sleep<${sleep}||math.mod(v.tick,${check})==0`, [
    A('t.water_body', 0), Loop(bodies.length, [
      axes.map(k => A('t.water_b' + k, pick(bodies.map((_, i) => `v.b${i}${k}`)))),
      quat.map(k => A('t.water_q' + k, pick(bodies.map((_, i) => `v.b${i}q${k}`)))),
      quat.map((k, j) => A('t.water_shapeq' + k, pick(shapes.map(s => s.quaternion[j])))),
      A('t.water_wet', 0), A('t.water_linear', 0), A('t.water_angular', 0),
      vector('t.water_lever', [0, 0, 0]), A('t.water_sample', 0),
      Loop(2, [sample, rotate('t.water_local', 't.water_shapeq', 't.water_local'),
        axes.map((k, j) => A('t.water_local' + k, `t.water_local${k}+(${pick(shapes.map(s => s.center[j]))})/16`)),
        rotate('t.water_offset', 't.water_q', 't.water_local'),
        If(`${query}(${coords.join(',')},'water','lava')`, [
          A('t.water_lava', `${query}(${coords.join(',')},'lava')`),
          A('t.water_density', `t.water_lava?${fluids.lava.density}:${fluids.water.density}`),
          A('t.water_wet', 't.water_wet+t.water_density'),
          A('t.water_linear', `t.water_linear+(t.water_lava?${fluids.lava.linearDrag}:${fluids.water.linearDrag})`),
          A('t.water_angular', `t.water_angular+(t.water_lava?${fluids.lava.angularDrag}:${fluids.water.angularDrag})`),
          axes.map(k => A('t.water_lever' + k, `t.water_lever${k}+t.water_offset${k}*t.water_density`)),
        ]), A('t.water_sample', 't.water_sample+1'),
      ]),
      If('t.water_wet>0', [
        A('v.sleep', 0), A('t.water_inverse_density', pick(bodies.map(b => .5 / (b.liquidDensity ?? materials.organic.density)))),
        A('t.water_fraction', 't.water_wet*t.water_inverse_density'),
        A('t.water_mass', pick(bodies.map(b => b.mass))),
        axes.map(k => A('t.water_force' + k, `-v.gravity_${k}*t.water_mass*t.water_inverse_density`)),
        cross('t.water_torque', 't.water_lever', 't.water_force'),
        axes.map(k => A('t.water_inverse' + k, `-t.water_q${k}`)), A('t.water_inversew', 't.water_qw'),
        rotate('t.water_spin', 't.water_inverse', 't.water_torque'),
        axes.map((k, j) => A('t.water_spin' + k, `t.water_spin${k}*(${pick(bodies.map(b => b.inverseInertia[j]))})*${256 * dt}`)),
        rotate('t.water_spin', 't.water_q', 't.water_spin'),
        A('t.water_drag', `math.pow(2.718281828459045,-${materials.organic.density * dt}*t.water_linear*t.water_inverse_density)`),
        A('t.water_angular_drag', `math.pow(2.718281828459045,-${materials.organic.density * dt}*t.water_angular*t.water_inverse_density)`),
        dispatch('t.water_body', bodies, (_, i) => axes.flatMap(k => [
          A(`v.b${i}v${k}`, `v.b${i}v${k}*t.water_drag-v.gravity_${k}*t.water_fraction*${dt}`),
          A(`v.b${i}w${k}`, `v.b${i}w${k}*t.water_angular_drag+t.water_spin${k}`),
        ])),
      ]), A('t.water_body', 't.water_body+1'),
    ]),
  ])];
}

// Insert before the solver's sleep decision, inside its active-step guards.
// Dry sleepers retain their normal polling interval; entering water wakes them.
export function waterProgram(program, rig, options) {
  const step = waterStep(rig, options);
  let inserted = 0;
  const visit = nodes => nodes.flat(Infinity).flatMap(node => {
    if (node.kind === 'if') return { ...node, yes: visit(node.yes), no: visit(node.no) };
    if (node.kind === 'loop') return { ...node, body: visit(node.body) };
    if (node.kind === 'set' && node.name === 'v.was_sleeping') {
      inserted++; return [...step, node];
    }
    return node;
  });
  const chunks = program.frameChunks.map(visit);
  if (inserted !== 3) throw Error('Water adapter requires one insertion per scheduled physics step');
  program.frameChunks = chunks;
}
