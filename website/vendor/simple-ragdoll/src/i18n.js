import en from '../lang/en.json' with { type: 'json' };
import zh from '../lang/zh.json' with { type: 'json' };

export const languages = { en, zh };
const format = (text, values) => text.replace(/%(\d+)/g, (_, index) => String(values[index] ?? ''));

export function registerTranslations() {
  for (const [code, strings] of Object.entries(languages)) Language.addTranslations(code, strings);
}

export function t(key, values = []) {
  const id = `ragdoll.${key}`;
  if (typeof globalThis.tl === 'function') return globalThis.tl(id, values, format(en[id] ?? id, values));
  return format(en[id] ?? id, values);
}

export class RagdollError extends Error {
  constructor(key, values = []) {
    super(t(`error.${key}`, values));
    this.key = key;
    this.values = values;
  }
}

export const fail = (key, values = []) => { throw new RagdollError(key, values); };
export const errorText = error => error instanceof RagdollError ? t(`error.${error.key}`, error.values) : t('error.unexpected', [error?.message ?? String(error)]);
