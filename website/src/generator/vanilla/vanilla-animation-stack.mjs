// Snapshot of .local/scripts/vanilla-animation-stack.mjs; see SOURCE.json.
// A modern scripts.animate list is the execution entry point, including an
// explicitly empty list. Legacy declarations are not additional live calls.
// Only old clients without that entry point need their old list migrated.
export function vanillaAnimationStack(client){
  const animations={...client.animations};
  const modern=Object.hasOwn(client.scripts??{},'animate');
  const normal=modern?structuredClone(client.scripts.animate):[];
  if(!modern)for(const [i,item]of (client.animation_controllers??[]).entries()){
    for(const [alias,id]of Object.entries(item)){
      const key='vr_original_'+i+'_'+alias;
      animations[key]=id;normal.push(key);
    }
  }
  return {animations,normal,modern};
}

export function activeVanillaIds(client){
  const {animations,normal}=vanillaAnimationStack(client);
  return normal.flatMap(item=>(typeof item==='string'?[item]:Object.keys(item)).map(alias=>animations[alias]));
}
