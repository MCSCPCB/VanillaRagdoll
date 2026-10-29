// Relative gameplay densities: water = 1. These are not kilograms or a claim
// about the composition of Minecraft's fictional creatures. Organic preserves
// the tested 1.2-times-weight buoyancy and the existing authored mass distribution.
import { choose } from '../../vendor/simple-ragdoll/src/core/expression.mjs';

export const materials = Object.freeze({
  organic: { density: 1 / 1.2 },
  iron: { density: 7.85, friction: .35 },
  copper: { density: 8.96, friction: .4 },
  snow: { density: .45, friction: .15 },
  wood: { density: .65, friction: .5 },
  bone: { density: 1.7, friction: .35 },
  gel: { density: 1.05, friction: .8 },
  magma: { density: 1.8, friction: .6 },
  sulfur: { density: 1.5, friction: .6 },
  fire: { density: 1.6, friction: .4 },
  wind: { density: .45, friction: .2 },
});

export const fluids = Object.freeze({
  water: { density: 1, linearDrag: 2, angularDrag: 3 },
  lava: { density: 2.6, linearDrag: 8, angularDrag: 12 },
});

const families = {
  iron_golem: 'iron', copper_golem: 'copper', creaking: 'wood',
  skeleton: 'bone', stray: 'bone', bogged: 'bone', parched: 'bone',
  wither_skeleton: 'bone', skeleton_horse: 'bone', wither: 'bone',
  slime: 'gel', magma_cube: 'magma', sulfur_cube: 'sulfur',
  blaze: 'fire', breeze: 'wind',
};

// Only use a known vanilla identity (or a verified vanilla geometry profile).
// Never infer the material of an uploaded custom model from names or textures.
export function bodyMaterial(entity, bone) {
  if (entity === 'minecraft:snow_golem') return /^arm[12]$/i.test(bone) ? 'wood' : 'snow';
  return entity?.startsWith('minecraft:') ? families[entity.slice(10)] ?? 'organic' : 'organic';
}

const times = (value, factor) => factor === 1 ? value : typeof value === 'number' ? value * factor : `(${value})*${factor}`;

// A body's effective displacement is defined by its authored reference mass,
// not by its collision envelope. Changing collision padding cannot independently
// change its density. Keep the established mass distribution and scale convention;
// material changes multiply mass and inertia together. No extra runtime solver.
export function materialRig(rig, entity) {
  const apply = body => {
    const material = bodyMaterial(entity, body.bone), preset = materials[material];
    const factor = preset.density / materials.organic.density;
    return { ...body, material, liquidDensity: preset.density,
      mass: times(body.mass, factor), inverseMass: times(body.inverseMass, 1 / factor),
      inverseInertia: body.inverseInertia.map(value => times(value, 1 / factor)),
      friction: preset.friction ?? body.friction,
    };
  };
  const massFactors = (rig.variants ?? [{ bodies: rig.bodies }]).map(variant => {
    if (variant.bodies.every(b => bodyMaterial(entity, b.bone) === 'organic')) return 1;
    const mass = variant.bodies.reduce((sum, body) => sum + body.mass, 0);
    return variant.bodies.reduce((sum, body) => sum + apply(body).mass, 0) / mass;
  });
  return { ...rig, bodies: rig.bodies.map(apply), materialMassFactor: massFactors.every(n => n === massFactors[0]) ? massFactors[0] : choose('v.variant', massFactors),
    ...(rig.variants ? { variants: rig.variants.map(variant => ({ ...variant, bodies: variant.bodies.map(apply) })) } : {}),
  };
}

// The solver's compliance has inverse-mass units. Scaling masses without it
// makes a heavy golem's joints softer. Normalize compliance by the rig's mass
// multiplier, and scale the fixed impulse ceilings in the opposite direction.
// This retains authored stiffness without increasing iteration counts.
export function materialProgram(program, rig) {
  const factor = rig.materialMassFactor ?? 1;
  if (factor === 1) return program;
  const visit = nodes => nodes.flat(Infinity).map(node => {
    if (node.kind === 'if') return { ...node, yes: visit(node.yes), no: visit(node.no) };
    if (node.kind === 'loop') return { ...node, body: visit(node.body) };
    if (node.kind === 'set' && node.name === 't.eps') {
      if (typeof node.value !== 'number') throw Error('Material compliance requires a constant solver coefficient');
      return { ...node, value: typeof factor === 'number' ? node.value / factor : `(${node.value})/(${factor})` };
    }
    if (node.kind === 'set' && ['t.lower', 't.upper'].includes(node.name) && Math.abs(node.value) === 1e6)
      return { ...node, value: typeof factor === 'number' ? node.value * factor : `(${node.value})*(${factor})` };
    return node;
  });
  return { ...program, frameChunks: program.frameChunks.map(visit) };
}
