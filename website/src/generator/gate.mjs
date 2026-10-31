import { animationFile, validateMolang } from './program-validation.mjs';
import { GeneratorError } from './messages.mjs';
import { modeName, modeResource } from './blocky.mjs';

export const gateLifecycle = { trigger: 'v.vr_trigger', release: 'v.vr_release' };
export const gateNames = ['v.vr_trigger', 'v.vr_release', 'v.vr_native_trigger', 'v.vr_native_release', modeName];

export function gateDefinition(id) {
  return animationFile({ [id]: {
    loop: true,
    animation_length: 1,
    anim_time_update: [
      'v.vr_trigger = v.vr_native_trigger || q.is_name_any(\'ragdoll\');',
      'v.vr_release = v.vr_native_release && !q.is_name_any(\'ragdoll\');',
      'return 0;',
    ].join('\n'),
  } });
}

export function patchGate(token) {
  return { id: `animation.ragdoll.${token}.gate`, path: `animations/sr_patch_${token}_gate.json` };
}

// pre_animation runs before every animation. Put only native input detection
// there, then execute the shared policy and all dependent preparation in order.
// This preserves same-frame activation, pose handoff and motion sampling.
export function installGate(client, { gate, scope, path, setup, files, enabled = '!q.is_in_ui', native = { trigger: '!q.is_alive', release: 'q.is_alive' } }) {
  const scripts = client.scripts;
  scripts.initialize.push('v.vr_trigger=0;v.vr_release=1;v.vr_native_trigger=0;v.vr_native_release=1;');
  scripts.initialize.push(`${modeName}=0;`);
  scripts.pre_animation.push(`v.vr_enabled=${enabled};v.vr_native_trigger=v.vr_enabled?(${native.trigger}):0;v.vr_native_release=v.vr_enabled?(${native.release}):1;`);
  const gateAlias = `vr_gate_${scope}`;
  if (Object.hasOwn(client.animations, gateAlias)) throw new GeneratorError('resource_collision');
  client.animations[gateAlias] = gate.id;
  const modeAlias = `vr_mode_${scope}`;
  if (Object.hasOwn(client.animations, modeAlias)) throw new GeneratorError('resource_collision');
  client.animations[modeAlias] = modeResource(gate).id;
  const calls = [{ [gateAlias]: 'v.vr_enabled' }, { [modeAlias]: 'v.vr_enabled' }], definitions = {};
  // Keep whole expressions together, especially temporary variables. Existing
  // compiler chunks already fit the expression limit before their guard.
  let source = '';
  const flush = () => {
    if (!source) return;
    const index = Object.keys(definitions).length, alias = `vr_prepare_${scope}_${index}`, id = `animation.ragdoll.${scope}.prepare_${index}`;
    if (Object.hasOwn(client.animations, alias)) throw new GeneratorError('resource_collision');
    const code = source + 'return 0;';
    validateMolang(code);
    definitions[id] = { loop: true, animation_length: 1, anim_time_update: code };
    client.animations[alias] = id;
    calls.push({ [alias]: 1 });
    source = '';
  };
  for (const statement of setup) {
    if (statement.length + 9 >= 64000) throw new GeneratorError('script_length');
    if (source.length + statement.length + 9 >= 64000) flush();
    source += statement;
  }
  flush();
  files.set(path, animationFile(definitions));
  scripts.animate.unshift(...calls);
}
