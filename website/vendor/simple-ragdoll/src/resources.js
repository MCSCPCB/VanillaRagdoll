import { fail } from './i18n.js';

export function parseJson(source, label='JSON') {
  let text='',quoted=false,escaped=false;
  for(let i=0;i<source.length;i++) {
    const c=source[i],next=source[i+1];
    if(quoted){text+=c;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;text+=c;continue;}
    if(c==='/'&&next==='/'){while(i<source.length&&source[i]!=='\n')i++;text+='\n';continue;}
    if(c==='/'&&next==='*'){i+=2;while(i<source.length&&!(source[i]==='*'&&source[i+1]==='/'))i++;i++;text+=' ';continue;}
    text+=c;
  }
  try{return JSON.parse(text.replace(/^\uFEFF/,''));}catch{fail('json',[label]);}
}

export function indexResources(files) {
  const resources={files,clients:new Map(),geometries:new Map(),geometryFiles:new Map(),animations:new Map(),controllers:new Map(),json:new Map()};
  const decoder=new TextDecoder();
  for(const [path,bytes] of files){
    if(!/\.json$/i.test(path)||! /^(entity|models|animations|animation_controllers|render_controllers)\//.test(path)&&path!=='manifest.json')continue;
    const value=parseJson(typeof bytes==='string'?bytes:decoder.decode(bytes),path);resources.json.set(path,value);
    const client=value['minecraft:client_entity']?.description;
    if(client){if(resources.clients.has(client.identifier))fail('client_duplicate',[client.identifier]);resources.clients.set(client.identifier,{file:path,value});}
    const geometries=[...(value['minecraft:geometry']??[]),...Object.entries(value).filter(([id])=>id.startsWith('geometry.')).map(([id,g])=>({description:{identifier:id},...g}))];
    for(const geometry of geometries){const id=geometry.description.identifier;resources.geometries.set(id,geometry);resources.geometryFiles.set(id,path);}
    for(const [id,a] of Object.entries(value.animations??{}))resources.animations.set(id,a);
    for(const [id,c] of Object.entries(value.animation_controllers??{}))resources.controllers.set(id,c);
  }
  return resources;
}

export async function importPack(data, Zip) {
  const zip=await Zip.loadAsync(data),entries=Object.values(zip.files).filter(f=>!f.dir),files=new Map();
  let total=0;
  for(const entry of entries){
    const path=entry.unsafeOriginalName??entry.name;
    if(path.includes('\\')||path.startsWith('/')||path.includes(':')||path.split('/').some(p=>p==='..'||p===''))fail('archive_path',[path]);
    const size=entry._data?.uncompressedSize??0;total+=size;
    if(total>256*1024*1024||entries.length>20000)fail('archive_size');
  }
  const manifests=entries.filter(e=>e.name.endsWith('manifest.json'));
  const prefix=zip.file('manifest.json')?'':manifests.length===1?manifests[0].name.slice(0,-'manifest.json'.length):'';
  for(const entry of entries){if(!entry.name.startsWith(prefix))continue;files.set(entry.name.slice(prefix.length),await entry.async('uint8array'));}
  const resources=indexResources(files);if(!resources.clients.size)fail('no_entities');return resources;
}

export const descriptionOf=record=>record.value['minecraft:client_entity'].description;

export function relatedAnimations(resources, client) {
  const ids=new Set(Object.values(client.animations??{}));
  for(const entry of client.animation_controllers??[])for(const id of Object.values(entry))ids.add(id);
  const seen=new Set(),animations={};
  const visit=id=>{
    if(seen.has(id))return;seen.add(id);
    if(resources.animations.has(id)){animations[id]=resources.animations.get(id);return;}
    const controller=resources.controllers.get(id);if(!controller)return;
    for(const state of Object.values(controller.states??{}))for(const entry of state.animations??[]){for(const alias of typeof entry==='string'?[entry]:Object.keys(entry))visit(client.animations?.[alias]??alias);}
  };
  for(const id of ids)visit(id);return animations;
}
