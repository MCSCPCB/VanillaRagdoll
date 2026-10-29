// Snapshot of .local/scripts/decorations.mjs; see SOURCE.json.
// Preserve the final local pose of animated decorations when ordinary animation
// stops. `this` reads the accumulated channel after the original animations;
// no extra geometry, renderer or world/bone query is needed.
export function decorationPlan(resources,client,rig,profileIndex){
  const geometry=resources.geometries.get(rig.variants[0].geometry);
  const bones=new Map(geometry.bones.map(b=>[b.name.toLowerCase(),b]));
  const physical=new Set(rig.bodies.map(b=>b.bone.toLowerCase())),ancestors=new Set();
  for(const name of physical){let parent=bones.get(name)?.parent;while(parent){ancestors.add(parent.toLowerCase());parent=bones.get(parent.toLowerCase())?.parent;}}
  const channels=new Map();
  for(const id of Object.values(client.animations??{}))for(const [name,values]of Object.entries(resources.animations.get(id)?.bones??{})){
    const key=name.toLowerCase(),bone=bones.get(key);
    if(!bone||physical.has(key)||ancestors.has(key))continue;
    let parent=bone.parent;while(parent&&!physical.has(parent.toLowerCase()))parent=bones.get(parent.toLowerCase())?.parent;
    if(!parent)continue;
    if(!channels.has(key))channels.set(key,new Set());
    for(const channel of ['position','rotation','scale'])if(values[channel]!==undefined)channels.get(key).add(channel);
  }
  const fields=[];
  for(const [name,selected]of channels)for(const channel of selected)for(let axis=0;axis<3;axis++)fields.push({bone:bones.get(name).name,channel,axis,name:`v.vr_dec_${profileIndex}_${channels.size}_${fields.length}`});
  return fields;
}

export function decorationAnimation(fields,profileIndex){
  const bones={};
  for(const f of fields){
    const neutral=f.channel==='scale'?1:0;
    const output=f.channel==='scale'?`(math.abs(this)>0.000001)?(${f.name}/this):${f.name}`:`${f.name}-this`;
    ((bones[f.bone]??={})[f.channel]??=[])[f.axis]=`(!v.vr_enabled||v.vr_profile!=${profileIndex})?{return ${neutral};};(!v.ragdoll_active)?{${f.name}=this;return ${neutral};};return ${output};`;
  }
  return {loop:true,bones};
}
