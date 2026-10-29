export const nameTrigger = "q.is_name_any('ragdoll')";

// Keep native pre-death entry points when adding the built-in name-tag trigger.
export function withNameTrigger({ trigger = '!q.is_alive', release = 'q.is_alive', ...rest } = {}) {
  return {
    ...rest,
    trigger: `${trigger === '!q.is_alive' ? trigger : '(' + trigger + ')'}||${nameTrigger}`,
    release: `${release === 'q.is_alive' ? release : '(' + release + ')'}&&!${nameTrigger}`,
  };
}

export const lifecycle = withNameTrigger();
