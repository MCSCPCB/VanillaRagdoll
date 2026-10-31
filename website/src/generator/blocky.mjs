import { A, If, Loop, axes, choose, dispatch, vector, dot, cross, normalize } from '../../vendor/simple-ragdoll/src/core/expression.mjs';
import { worldRig } from '../../vendor/simple-ragdoll/src/core/space.mjs';
import { animationFile } from './program-validation.mjs';

export const modeName = 'v.vr_blocky';

export const vanillaModeGate = { id: 'animation.vanilla_ragdoll.gate', path: 'animations/vanilla_ragdoll_gate.json' };

export function modeSettingName(gate) {
  return gate.id === vanillaModeGate.id ? 'vanilla_ragdoll:mode' : `simple_ragdoll:${gate.id.replace(/^animation\.ragdoll\./, '').replace(/\.gate$/, '')}_mode`;
}

const textPrefix = gate => 'text.' + modeSettingName(gate).replace(':', '.');
export function modeSettings(gate) {
  const key = textPrefix(gate);
  return [{ type: 'dropdown', text: key + '.title', name: modeSettingName(gate), default: 'ragdoll', options: [
    { name: 'ragdoll', text: key + '.ragdoll' },
    { name: 'blocky', text: key + '.blocky' },
  ] }];
}

export function modeTextFiles(gate) {
  const key = textPrefix(gate);
  const labels = {
    en_US: ['Mob Settings', 'Ragdoll §7Turns mobs into ragdolls.', 'Blocky §7Splits each mob in its individual parts.'],
    zh_CN: ['生物设置', '布娃娃 §7将生物变成布娃娃', '方块化 §7将每个生物拆分为独立部件'],
  };
  return new Map([
    ['texts/languages.json', JSON.stringify(Object.keys(labels))],
    ...Object.entries(labels).map(([lang, values]) => [`texts/${lang}.lang`, ['title', 'ragdoll', 'blocky'].map((name, i) => `${key}.${name}=${values[i]}\n`).join('')]),
  ]);
}

export function modeResource(gate) {
  return { id: gate.id + '.mode', path: gate.path.replace(/_gate\.json$/, '_mode.json') };
}

export function installModes(files, gate) {
  const { id, path } = modeResource(gate);
  files.set(path, animationFile({ [id]: {
    loop: true, animation_length: 1,
    anim_time_update: `${modeName}=q.is_pack_setting_selected('${modeSettingName(gate)}','blocky');return 0;`,
  } }));
}

// Add breakup motion once, after pose capture and inherited velocity. Radial
// speed is proportional to distance from the mass center, so its total linear
// momentum is zero. Positions and orientations stay at the captured first pose.
function breakup(rig) {
  const bodies = worldRig(rig).bodies, ids = bodies.map((_, i) => i);
  const index = 't.breakup_body', pick = values => choose(index, values);
  const loop = nodes => [A(index, 0), Loop(ids.length, [nodes, A(index, index + '+1')])];
  const offset = axes.map(k => A('t.breakup_r' + k, `(${pick(ids.map(i => 'v.b' + i + k))})-t.breakup_center${k}`));
  const radii = rig.bodies.map(b => b.shapes.map(s => '(' + [...s.center, ...s.half].map(n => `math.abs(${n})`).join('+') + ')/16').reduce((a, b) => `math.max(${a},${b})`, '0'));
  return If(`v.activated&&${modeName}`, [
    A('t.breakup_mass', 0), vector('t.breakup_center', [0, 0, 0]), vector('t.breakup_velocity', [0, 0, 0]),
    loop([
      A('t.breakup_m', pick(bodies.map(b => b.mass))), A('t.breakup_mass', 't.breakup_mass+t.breakup_m'),
      ...axes.flatMap(k => [
        A('t.breakup_center' + k, `t.breakup_center${k}+(${pick(ids.map(i => 'v.b' + i + k))})*t.breakup_m`),
        A('t.breakup_velocity' + k, `t.breakup_velocity${k}+(${pick(ids.map(i => 'v.b' + i + 'v' + k))})*t.breakup_m`),
      ]),
    ]),
    ...['center', 'velocity'].flatMap(p => axes.map(k => A('t.breakup_' + p + k, `t.breakup_${p}${k}/t.breakup_mass`))),
    A('t.breakup_speed', `math.sqrt(${dot('t.breakup_velocity', 't.breakup_velocity')})`),
    ...axes.map(k => A('t.breakup_direction' + k, `t.breakup_velocity${k}/math.max(1,t.breakup_speed)`)),
    A('t.breakup_radius2', .0625),
    loop([offset, A('t.breakup_radius2', `math.max(t.breakup_radius2,${dot('t.breakup_r', 't.breakup_r')})`)]),
    A('t.breakup_radius', 'math.sqrt(t.breakup_radius2)'),
    // Blocks/second and radians/second. Quiet triggers still tumble gently;
    // strong knockback is capped, and large pieces rotate more slowly.
    A('t.breakup_spread', '.15+math.min(t.breakup_speed,6)*.075'),
    A('t.breakup_spin', '.8+math.min(t.breakup_speed,6)*.5'),
    loop([
      offset, ...axes.map(k => A('t.breakup_r' + k, `t.breakup_r${k}/t.breakup_radius`)),
      cross('t.breakup_turn', 't.breakup_r', 't.breakup_direction'),
      ...axes.map(k => A('t.breakup_noise' + k, 'math.random(-1,1)')),
      If(`${dot('t.breakup_noise', 't.breakup_noise')}<0.000001`, vector('t.breakup_noise', [1, 0, 0])),
      normalize('t.breakup_noise'),
      A('t.breakup_size', `math.max(1,(${pick(radii)})*v.body_units)`),
      ...axes.map(k => A('t.breakup_w' + k, `(t.breakup_turn${k}*1.5+t.breakup_noise${k}*.65)*t.breakup_spin/t.breakup_size`)),
      A('t.breakup_limit', `6/math.max(6,math.sqrt(${dot('t.breakup_w', 't.breakup_w')}))`),
      dispatch(index, ids, i => axes.flatMap(k => [
        A(`v.b${i}v${k}`, `v.b${i}v${k}+t.breakup_r${k}*t.breakup_spread`),
        A(`v.b${i}w${k}`, `v.b${i}w${k}+t.breakup_w${k}*t.breakup_limit`),
      ])),
    ]),
  ]);
}

// Apply after API specialization: this internal switch does not restore any BP
// API inputs or duplicate the solver. Keep all body and contact work shared.
export function blockyProgram(program, rig, { terrainShapeIndices } = {}) {
  let joints = 0, watchers = 0, manifolds = 0;
  const core = terrainShapeIndices ? [...new Set(terrainShapeIndices.map(i => rig.shapes[i].body))] : [];
  // A large core resting on many blocks otherwise consumes the entire contact
  // buffer, starving its detached tentacles. Keep one central contact per block
  // for that core only. The small parts keep their full contact polygons.
  const largeCore = side => `(${core.map(i => `t.${side}body==${i}`).join('||')})&&(t.${side}hx>16||t.${side}hy>16||t.${side}hz>16)`;
  const coreContact = core.length ? `(${largeCore('a')})&&t.bbody==${rig.bodies.length}||(${largeCore('b')})&&t.abody==${rig.bodies.length}` : '0';
  // A pile of detached tentacles can also consume all slots with body contacts.
  // Keep most slots available for terrain so remote parts cannot fall through.
  const ids = rig.bodies.map((_, i) => i), limit = rig.simulation.contactLimit;
  const pairLimit = rig.shapePairs.length ? Math.floor(limit / 4) : 0;
  const weights = rig.bodies.map(b => Math.cbrt(b.shapes.reduce((sum, s) => sum + s.half.reduce((a, n) => a * Number(n), 1), 0)));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const remaining = Math.max(0, limit - pairLimit - ids.length * 4);
  const budgets = weights.map(w => 4 + Math.floor(remaining * w / totalWeight));
  const count = i => `v.blocky_contacts_${i}`;
  const reset = [A('v.blocky_pair_contacts', 0), ...ids.map(i => A(count(i), 0))];
  if (core.length) program.initialize.push(...reset);
  const centralContact = [
    ...axes.map(k => A('t.blocky_center' + k, 0)), A('t.blocky_vertex', 0),
    Loop('t.count', [
      ...axes.map(k => A('t.blocky_center' + k, `t.blocky_center${k}+(${choose('t.blocky_vertex', Array.from({ length: 8 }, (_, i) => `t.poly${i}${k}`))})`)),
      A('t.blocky_vertex', 't.blocky_vertex+1'),
    ]),
    ...axes.map(k => A('t.poly0' + k, `t.blocky_center${k}/t.count`)), A('t.count', 1),
  ];
  const visit = nodes => nodes.flat(Infinity).map(n => {
    if (core.length && n.name === 'v.contact_count' && n.value === 0) return [n, If(modeName, reset)];
    if (n.kind === 'if') {
      const node = { ...n, yes: visit(n.yes).flat(Infinity), no: visit(n.no).flat(Infinity) };
      if (core.length && n.test === `v.contact_count<${limit}`) return [
        If(modeName, [A('t.blocky_ground', `t.cia==${ids.length}||t.cib==${ids.length}`), A('t.blocky_body', 'math.min(t.cia,t.cib)')]),
        If(`!${modeName}||(t.blocky_ground?(${choose('t.blocky_body', ids.map(count))})<(${choose('t.blocky_body', budgets)}):v.blocky_pair_contacts<${pairLimit})`, {
          ...node, yes: [...node.yes, If(modeName, If('t.blocky_ground', dispatch('t.blocky_body', ids, i => A(count(i), count(i) + '+1')), A('v.blocky_pair_contacts', 'v.blocky_pair_contacts+1')))],
        }),
      ];
      return node;
    }
    if (n.kind !== 'loop') return n;
    const body = visit(n.body).flat(Infinity), last = body.at(-1), loop = { ...n, body };
    if (last?.name === 't.joint_id') {
      joints++;
      return If('!' + modeName, loop);
    }
    if (terrainShapeIndices && last?.name === 't.watch_shape') {
      watchers++;
      return { ...loop, body: [If(`${modeName}||${terrainShapeIndices.map(i => `t.watch_shape==${i}`).join('||')}`, body.slice(0, -1)), last] };
    }
    if (core.length && n.count === 't.count' && body.some(x => x.kind === 'if' && x.yes.some(y => y.name === 't.cia'))) {
      manifolds++;
      return [If(`${modeName}&&t.count>0&&(${coreContact})`, centralContact), loop];
    }
    return loop;
  });
  program.frameChunks = program.frameChunks.map(n => visit(n).flat(Infinity));
  if (rig.joints.length && joints < 3) throw new Error('Blocky requires all three scheduled joint solvers');
  if (terrainShapeIndices && watchers !== 6) throw new Error('Blocky requires both sleeping terrain snapshots in all three steps');
  const separateContacts = rig.shapes.length > 24 || limit > 128;
  const expectedManifolds = separateContacts && rig.shapePairs.length ? 6 : 3;
  if (core.length && manifolds !== expectedManifolds) throw new Error('Blocky requires every native contact manifold in all three steps');
  program.frameChunks[0].push(breakup(rig));
  return program;
}
