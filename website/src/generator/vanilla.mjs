import catalog from './vanilla/catalog.mjs';
import { lifecycle } from './lifecycle.mjs';
import { BP_API_METHODS } from '../../vendor/simple-ragdoll/src/core/api.mjs';
import { autoConfig } from '../../vendor/simple-ragdoll/src/config.js';

export { catalog as vanillaCatalog };
export const renderersOf = resources => new Map([...resources.json.values()].flatMap(v => Object.entries(v.render_controllers ?? {})));

// Fallback by resource identifier, never by filename. Uploaded resources always
// win; only the upload contributes client entities and output paths.
export function withVanillaResources(resources) {
  const declared = new Set([...resources.geometries.keys()].map(id => id.split(':')[0]));
  const fallback = Object.entries(catalog.geometries).filter(([id]) => !declared.has(id));
  const nativeGeometry = new Set(fallback.map(([id]) => id));
  return { ...resources, nativeGeometry,
    geometries: new Map([...fallback, ...resources.geometries]),
    animations: new Map([...Object.entries(catalog.animations), ...resources.animations]),
    controllers: new Map([...Object.entries(catalog.controllers), ...resources.controllers]),
    json: new Map([['@vanilla', { animations: catalog.animations, animation_controllers: catalog.controllers, render_controllers: catalog.renderers }], ...resources.json]),
  };
}

export function configure(config) {
  config.trigger = lifecycle.trigger; config.release = lifecycle.release;
  config.api = Object.fromEntries(BP_API_METHODS.map(k => [k, false]));
  config.simulation = { ...config.simulation, initialVelocity: [1, 1, 1], initialSpin: 0 };
  config.outputLevel = 'standard'; return config;
}

export function vanillaProfiles(client, variants, resources, bp) {
  if (!variants.some(v => resources.nativeGeometry.has(client.geometry[v.geometry]))) return null;
  const selected = new Set(variants.map(v => client.geometry[v.geometry])), runtime = bp?.description?.runtime_identifier;
  const result = [];
  for (const variant of variants) {
    const id = client.geometry[variant.geometry];
    if (!resources.nativeGeometry.has(id)) {
      result.push({ profile: variant, config: configure(autoConfig(client, resources, [{ geometry: variant.geometry }])) });
      continue;
    }
    const candidates = catalog.profiles.filter(p => p.geometry === id && !p.folded);
    // Shared baby geometries inherit the family selected by the adult model.
    const score = p => (p.entity === runtime ? 100 : 0) + Object.values(p.familyGeometry).filter(g => selected.has(g)).length * 2 + (p.key === 'default' ? 1 : 0);
    candidates.sort((a, b) => score(b) - score(a) || a.entity.localeCompare(b.entity));
    const match = candidates[0];
    if (!match || match.special) throw Error('此原版模型依赖专用原生渲染行为，暂未自动套用：' + id);
    const use = (template, when) => {
      const config = configure(structuredClone(template.config));
      config.variants = config.variants.map(v => ({ ...v, geometry: variant.geometry }));
      delete config.variants[0].when;
      return { native: { entity: template.entity, key: template.key, alias: template.alias },
        profile: { key: template.key, geometry: variant.geometry, when }, config };
    };
    const folded = catalog.profiles.find(p => p.entity === match.entity && p.geometry === id && p.folded);
    if (folded) {
      const renderers = renderersOf(resources), expressions = [];
      for (const call of client.render_controllers ?? []) for (const ref of typeof call === 'string' ? [call] : Object.keys(call)) {
        const visibility = renderers.get(ref)?.part_visibility ?? [];
        for (const item of visibility) for (const [bone, condition] of Object.entries(item)) if (bone.toLowerCase() === 'rightarm') expressions.push(String(typeof condition === 'boolean' ? Number(condition) : condition));
      }
      if (!expressions.length || new Set(expressions.map(s => s.replace(/\s/g, '').replace(/query\./g, 'q.'))).size !== 1) throw Error('刌民模型的手臂可见性无法可靠确定');
      const a = use(folded, variant.when ? `(${variant.when})&&!v.vr_arms_open` : '!v.vr_arms_open');
      a.armsOpen = expressions[0]; result.push(a);
    }
    result.push(use(match, variant.when));
  }
  // Renderer geometry does not determine native runtime death rotation.
  for (const p of result) p.deathRoll = runtime === 'minecraft:spider' ? 180 : 90;
  return result;
}
