import { BP_API_METHODS } from '../../simple_ragdoll/BP/scripts/ragdoll.js';
import { fail } from '../i18n.js';

export { BP_API_METHODS };

// Missing settings retain the complete API used by existing configurations.
export function apiSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('unexpected', ['api']);
  for (const [key, enabled] of Object.entries(value)) {
    if (!BP_API_METHODS.includes(key)) fail('field', ['api', key]);
    if (typeof enabled !== 'boolean') fail('unexpected', ['api.' + key]);
  }
  return Object.fromEntries(BP_API_METHODS.map(key => [key, value[key] ?? true]));
}

export const apiMask = settings => BP_API_METHODS.reduce((mask, key, i) => mask + (settings[key] ? 2 ** i : 0), 0);
