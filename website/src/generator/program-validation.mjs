import { validateScript } from './validate.mjs';

export const animationFile = animations => ({ format_version: '1.20.60', animations });
export function validateMolang(source) {
  if (typeof source !== 'string') return;
  if (source.length >= 64000) throw new Error('生成的 Molang 超出引擎表达式长度限制');
  validateScript(source);
}
export function validateProgram(program, checked = new Set()) {
  const check = source => { if (!checked.has(source)) { validateMolang(source); checked.add(source); } };
  for (const code of [...program.initializeSources, ...program.preAnimationSources]) check(code);
  for (const a of Object.values(program.computeAnimations)) check(a.anim_time_update);
  for (const b of Object.values(program.animation().bones)) for (const ch of Object.values(b)) for (const code of Array.isArray(ch) ? ch : [ch]) check(code);
}
export function guardOutput(animation, gate) {
  for (const b of Object.values(animation.bones)) for (const ch of ['position', 'rotation', 'scale']) if (b[ch] !== undefined) {
    const neutral = ch === 'scale' ? 1 : 0;
    const wrap = s => typeof s === 'string' && s.includes('return ') ? `(!(${gate}))?{return ${neutral};};${s}` : `(${gate})?(${s}):${neutral}`;
    b[ch] = Array.isArray(b[ch]) ? b[ch].map(wrap) : wrap(b[ch]);
  }
  return animation;
}
