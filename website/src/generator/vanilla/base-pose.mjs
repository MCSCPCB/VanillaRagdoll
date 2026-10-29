// Snapshot of .local/scripts/base-pose.mjs; see SOURCE.json.
// These animations assemble the authored model. Keep their original references;
// the final physics animation overrides only the simulated bones. Do not treat
// every animation containing "default" as a setup (look-at is ordinary motion).
const setup = /\.(?:setup(?:\.v[\d.]+)?|base|base_pose(?:\.v[\d.]+)?|default_leg_pose)$/;

export function basePoseAnimations(resources, client, normal) {
  const controllers = new Map([...resources.json.values()].flatMap(v => Object.entries(v.animation_controllers ?? {})));
  const base = new Set(Object.entries(client.animations ?? {}).filter(([, id]) =>
    resources.animations.has(id) && setup.test(id) && !id.includes('first_person')).map(([alias]) => alias));
  const extras = new Map(), direct = new Set();
  const entries = item => typeof item === 'string' ? [[item, '1']] : Object.entries(item);
  for (const item of normal) for (const [alias] of entries(item)) if (base.has(alias)) direct.add(alias);
  // A single-state controller is also used as a list of animations in old
  // vanilla definitions (for example spider.move). Retain its setup entries
  // without keeping the walk/look-at controller running during simulation.
  function visit(alias, weight, seen = new Set()) {
    const id = client.animations?.[alias];
    if (!id || seen.has(id)) return;
    if (base.has(alias)) {
      if (!direct.has(alias)) extras.set(alias, weight);
      return;
    }
    const states = Object.values(controllers.get(id)?.states ?? {});
    if (states.length !== 1) return;
    for (const item of states[0].animations ?? []) for (const [child, condition] of entries(item)) {
      visit(child, `(${weight})*(${condition})`, new Set([...seen, id]));
    }
  }
  for (const item of normal) for (const [alias, weight] of entries(item)) visit(alias, weight);
  return {direct, extras: [...extras].map(([alias, weight]) => ({[alias]: `v.ragdoll_active*(${weight})`}))};
}
