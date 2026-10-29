import JSZip from 'jszip';

export const rpUUID = 'bbbbbbbb-1111-4111-a111-111111111111';
export const bpUUID = 'cccccccc-1111-4111-a111-111111111111';
export const geometry = { description: { identifier: 'geometry.demo', texture_width: 64, texture_height: 64 }, bones: [
  { name: 'body', pivot: [0, 12, 0], cubes: [{ origin: [-4, 8, -3], size: [8, 12, 6], uv: [0, 0] }] },
  { name: 'head', parent: 'body', pivot: [0, 20, 0], cubes: [{ origin: [-4, 20, -4], size: [8, 8, 8], uv: [0, 0] }] },
] };
export function client(id = 'demo:mob') { return { format_version: '1.10.0', 'minecraft:client_entity': { description: { identifier: id, geometry: { default: 'geometry.demo' }, textures: { default: 'textures/entity/demo' }, materials: { default: 'entity_alphatest' }, render_controllers: ['controller.render.default'], scripts: { scale: 'q.is_baby?0.5:1', initialize: ['v.original=2;'], pre_animation: ['v.original=v.original+1;'], animate: ['idle'] }, animations: { idle: 'animation.demo.idle' } } } }; }
export function vanillaClient(family = 'zombie') {
  const value = client('demo:' + family), c = value['minecraft:client_entity'].description;
  c.geometry = family === 'zombie' ? { default: 'geometry.zombie.v1.8', baby: 'geometry.zombie.baby' } : { default: family === 'witch' ? 'geometry.villager.witch.v1.8' : 'geometry.evoker.v1.8' };
  c.render_controllers = ['controller.render.' + (family === 'zombie' ? 'zombie.v2' : family === 'witch' ? 'witch' : 'evoker')];
  c.scripts.scale = family === 'zombie' ? 'q.is_baby?2:1' : '.9375';
  c.animations.unused_big_head = 'controller.animation.humanoid.baby_big_head';
  c.animation_controllers = [{ unused_legacy: 'controller.animation.humanoid.baby_big_head' }];
  return value;
}
export function manifest(type = 'resources', name = 'pack.name', uuid = rpUUID) { return { format_version: 2, header: { name, description: 'Original description', uuid, version: [2, 3, 4], min_engine_version: [1, 21, 0] }, modules: [{ type, uuid: type === 'resources' ? 'dddddddd-1111-4111-a111-111111111111' : 'eeeeeeee-1111-4111-a111-111111111111', version: [2, 3, 4] }] }; }
export async function pack({ name, uuid, clients = [client()], model = geometry, extra = {} } = {}) {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest('resources', name, uuid)));
  zip.file('texts/en_US.lang', 'pack.name=Test Creatures\n');
  zip.file('models/entity/demo.geo.json', JSON.stringify({ format_version: '1.12.0', 'minecraft:geometry': [model] }));
  zip.file('animations/demo.json', JSON.stringify({ format_version: '1.8.0', animations: { 'animation.demo.idle': { loop: true, bones: { head: { rotation: [0, 'math.sin(q.life_time)*10', 0] } } } } }));
  for (const [i, c] of clients.entries()) zip.file('entity/demo' + i + '.entity.json', JSON.stringify(c));
  for (const [path, value] of Object.entries(extra)) zip.file(path, typeof value === 'string' || value instanceof Uint8Array ? value : JSON.stringify(value));
  return zip.generateAsync({ type: 'uint8array' });
}
