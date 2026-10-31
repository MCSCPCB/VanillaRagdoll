import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {generate} from '../src/generator/index.mjs';
import {testMath} from '../vendor/simple-ragdoll/src/core/program.mjs';
import {vanillaCatalog} from '../src/generator/vanilla.mjs';
import {script} from './molangeval.mjs';
import {pack,client,vanillaClient,geometry} from './fixtures.mjs';

test('downloaded custom and native patches push sleeping bodies and preserve entrapment and UI guards',async()=>{
  const result=await generate(await pack({clients:[client(),vanillaClient('witch')]}),'walking.mcpack');
  assert.equal(result.successful,2,JSON.stringify(result.reports));
  const zip=await JSZip.loadAsync(result.download.data),animations={};
  for(const f of Object.values(zip.files))if(!f.dir&&f.name.startsWith('animations/'))Object.assign(animations,JSON.parse(await f.async('string')).animations);
  for(const index of [0,1]){
    const c=JSON.parse(await zip.file(`entity/demo${index}.entity.json`).async('string'))['minecraft:client_entity'].description;
    const model=index?vanillaCatalog.geometries[c.geometry.default]:geometry,bones=new Map(model.bones.map(b=>[b.name.toLowerCase(),b]));
    let camera=[100,1.62,.5],name='',buried=false,removed=false,cameraReads=0,angleReads=0,terrainReads=0;
    const v=new Proxy({},{get:(o,k)=>k in o?o[k]:0});
    const q={ is_pack_setting_selected: () => 0,is_in_ui:0,is_alive:1,is_baby:0,life_time:0,delta_time:1/60,death_ticks:0,body_y_rotation:0,frame_alpha:1,model_scale:.0625,
      is_name_any:n=>+(name===n),position:a=>a===1?0:.5,
      get distance_from_camera(){cameraReads++;assert.equal(q.is_in_ui,0);return Math.hypot(camera[0]-.5,camera[1],camera[2]-.5);},
      rotation_to_camera:axis=>{angleReads++;const d=[camera[0]-.5,camera[1],camera[2]-.5];return axis?Math.atan2(-d[0],d[2])*180/Math.PI:-Math.atan2(d[1],Math.hypot(d[0],d[2]))*180/Math.PI;},
      bone_orientation_trs:n=>{const b=bones.get(n);assert(b,n);return {t:Object.fromEntries(['x','y','z'].map((k,i)=>[k,(b.pivot??[0,0,0])[i]])),r:{x:0,y:0,z:0},s:{x:1,y:1,z:1}};},
      relative_block_has_any_tag:(x,y,z,...tags)=>{terrainReads++;return +(!tags.includes('water')&&!tags.includes('lava')&&(buried?y<8:removed?y< -5:y<0));},
    };
    const math={...testMath,random:(a,b)=>(a+b)/2},run=s=>script(s)(v,{},q,math,{}),value=s=>typeof s==='number'?s:run(s.includes(';')?s:'return '+s+';');
    c.scripts.initialize.forEach(run);
    const frame=()=>{
      q.life_time+=q.delta_time;c.scripts.pre_animation.forEach(run);
      // Eagerly run even zero-weight updates to verify their internal guards.
      for(const call of c.scripts.animate)for(const alias of typeof call==='string'?[call]:Object.keys(call)){
        const source=animations[c.animations[alias]]?.anim_time_update;if(source)run(source);
      }
    };
    const step=seconds=>{for(let i=0;i<Math.round(seconds*60);i++)frame();};
    const output=()=>{
      const id=c.animations.ragdoll_generated??c.animations['vr_pose_'+v.vr_profile];
      return Object.fromEntries(Object.entries(animations[id].bones).map(([bone,b])=>[bone,Object.fromEntries(['position','rotation'].map(ch=>[ch,(b[ch]??[]).map(value)]))]));
    };
    step(1);assert.equal(cameraReads+angleReads+terrainReads,0,'Live entities must not perform interaction or terrain work');
    name='ragdoll';step(6);const rest=output();step(1);assert.deepEqual(output(),rest,'Fixture must have reached ordinary sleep');assert(cameraReads>0);assert.equal(angleReads,0,'Distant camera must not request angles');
    const units=index?.9375/16:1/16;
    const root=rest.body.position,center=[.5+(root[0]??0)*units,1.62,.5+(root[2]??0)*units];
    camera=[center[0]-2,1.62,center[2]];step(.2);const still=output();step(1);assert.deepEqual(output(),still,'Stationary viewer must not push');assert(angleReads>0);
    for(let i=0;i<75;i++){camera=[center[0]-2+4*i/60,1.62,center[2]];frame();}
    const moved=output();assert.notDeepEqual(moved,still,'Walking must push the packaged '+(index?'native':'custom')+' rig');
    assert(Object.values(moved).flatMap(b=>Object.values(b).flat()).every(Number.isFinite));
    camera=[100,1.62,.5];step(8);const settled=output();step(1);assert.deepEqual(output(),settled,'Pushed ragdoll must sleep again');
    buried=true;step(3);const frozen=output();
    for(let i=0;i<180;i++){camera=[center[0]+Math.sin(i/30)*.4,1.62,center[2]];frame();}
    assert.deepEqual(output(),frozen,'Walking must not bypass stuck protection');
    camera=[100,1.62,.5];buried=false;removed=true;step(2);assert.notDeepEqual(output(),frozen,'Terrain changes must release protection');
    name='';frame();const released=cameraReads;step(1);assert.equal(cameraReads,released,'Renaming must stop camera queries');
    q.is_in_ui=1;name='ragdoll';step(1);assert.equal(cameraReads,released,'UI previews must not run interaction');
  }
});
