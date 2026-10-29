// Serializable messages cross the Worker boundary without choosing a language.
// Nested causes retain their code/parameters so existing results can be translated.
export const message = (code, params = {}) => ({ code, params });
export class GeneratorError extends Error {
  constructor(code, params = {}) { super(code); this.code = code; this.params = params; }
}
export const reject = (code, params) => { throw new GeneratorError(code, params); };
// The maintained vanilla snapshots still throw technical English diagnostics.
// Normalize them at this boundary without changing the pinned source snapshots.
const snapshotErrors = new Map([
  ['Expected cat tail1 -> tail2 hierarchy', 'native_cat_hierarchy'],
  ['Missing sample terrain-contact core', 'native_contact_core'],
  ['Review sample terrain-body routing after generator changes', 'native_contact_routing'],
  ['Missing captured head-scale variable', 'native_head_scale'],
  ['Native capture override must be a root', 'native_capture_root'],
]);
export function errorMessage(error) {
  if (typeof error?.code === 'string' && error.params && typeof error.params === 'object') return message(error.code, error.params);
  if (typeof error?.key === 'string' && Array.isArray(error.values)) return message('core_error', { key: error.key, values: error.values });
  if (snapshotErrors.has(error?.message)) return message(snapshotErrors.get(error.message));
  if (error?.message?.startsWith('Missing capture bone ')) return message('native_capture_bone', { bone: error.message.slice('Missing capture bone '.length) });
  return error?.message ? message('unexpected', { detail: error.message }) : message('processing_failed');
}
