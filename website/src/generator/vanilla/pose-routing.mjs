// Snapshot of .local/scripts/pose-routing.mjs; see SOURCE.json.
// Alternate baby/small geometries can expose the default queryable skeleton:
// different names fail loudly, identical names can return the wrong transform.
// Treat this as a model category rather than waiting for each species to fail.
// Villager v2's native baby capture has already been verified in game.
export function needsLocalPose(entity, profile) {
  return entity.id === 'minecraft:copper_golem' ||
    entity.id !== 'minecraft:villager_v2' && ['baby','small'].includes(profile.geometry);
}

// These look-at animations are unconditional in the corresponding vanilla
// animation stack. Their final rotation is entity-relative, not parent-relative.
export function entityRelativeBones(entity,resources,client) {
  if(resources&&client)return new Set(Object.values(client.animations??{}).flatMap(id=>
    Object.entries(resources.animations.get(id)?.bones??{}).filter(([,b])=>b.relative_to?.rotation==='entity').map(([name])=>name.toLowerCase())));
  return new Set(entity.id === 'minecraft:strider' ? ['body'] :
    ['minecraft:sniffer', 'minecraft:copper_golem'].includes(entity.id) ? ['head'] : []);
}
