import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {generate} from '../src/generator/index.mjs';
import {testMath} from '../vendor/simple-ragdoll/src/core/program.mjs';
import {vanillaCatalog} from '../src/generator/vanilla.mjs';
import {script} from './molangeval.mjs';
import {pack,client,vanillaClient,geometry} from './fixtures.mjs';

test('downloaded custom and native patches watch sleeping terrain and suspend persistent entrapment',async()=>{
  const result=await generate(await pack({clients:[client(),vanillaClient('witch')]}),'recovery.mcpack');
  assert.equal(result.successful,2,JSON.stringify(result.reports));
  const zip=await JSZip.loadAsync(result.download.data),animations={};
  for(const f of Object.values(zip.files))if(!f.dir&&f.name.startsWith('animations/'))Object.assign(animations,JSON.parse(await f.async('string')).animations);
  for(const i of [0,1]){
    const c=JSON.parse(await zip.file(`entity/demo${i}.entity.json`).async('string'))['minecraft:client_entity'].description;
    const model=i?vanillaCatalog.geometries[c.geometry.default]:geometry,bones=new Map(model.bones.map(b=>[b.name,b]));
    let mode='floor',name='',solid=0,liquid=0;
    const v=new Proxy({},{get:(o,k)=>k in o?o[k]:0});
    const q={is_name_any:n=>+(name===n),is_in_ui:0,is_alive:1,is_baby:0,life_time:0,delta_time:1/20,death_ticks:0,body_y_rotation:0,frame_alpha:1,model_scale:.0625,
      position:a=>a===1?0:.5,
      bone_orientation_trs:n=>{const b=bones.get(n);assert(b,n);return {t:Object.fromEntries(['x','y','z'].map((k,j)=>[k,(b.pivot??[0,0,0])[j]])),r:{x:0,y:0,z:0},s:{x:1,y:1,z:1}};},
      relative_block_has_any_tag:(x,y,z,...tags)=>{
        if(tags.includes('water')||tags.includes('lava')){
          // Terrain fingerprints also exclude liquid blocks at integer cells.
          // Buoyancy samples the body's interior at fractional coordinates.
          if([x,y,z].some(n=>!Number.isInteger(n)))liquid++;
          return 0;
        }
        solid++;return +(mode==='buried'?y<5:mode==='removed'?y< -5:y<0);
      },
    };
    const math={...testMath,random:(a,b)=>(a+b)/2},run=s=>script(s)(v,{},q,math,{});
    c.scripts.initialize.forEach(run);
    const frame=()=>{q.life_time+=q.delta_time;c.scripts.pre_animation.forEach(run);for(const call of c.scripts.animate)for(const alias of typeof call==='string'?[call]:Object.keys(call)){
      const code=animations[c.animations[alias]]?.anim_time_update;if(code)run(code);
    }};
    const step=seconds=>{solid=0;liquid=0;for(let j=0;j<seconds*20;j++)frame();return {solid,liquid};};
    const output=()=>{
      const id=c.animations.ragdoll_generated??c.animations['vr_pose_'+v.vr_profile];
      return Object.values(animations[id].bones).flatMap(b=>['position','rotation'].flatMap(ch=>(b[ch]??[]).map(s=>typeof s==='number'?s:run(s.includes(';')?s:'return '+s+';'))));
    };
    step(1);assert.equal(solid+liquid,0,'Live entities do not execute recovery queries');
    name='ragdoll';step(6);const rest=output();step(1);assert.deepEqual(output(),rest);
    mode='buried';step(3);const frozen=output(),poll=step(2);
    assert.deepEqual(output(),frozen,'Persistent overlap must stop moving');assert(poll.solid>0,'Protected body still watches terrain');
    assert.equal(poll.liquid,0,'Protected body stops liquid forces too');assert(frozen.every(Number.isFinite));
    mode='removed';step(3);assert.notDeepEqual(output(),frozen,'Removing remote support resumes motion');
    name='';step(.1);const released=step(1);assert.equal(released.solid+released.liquid,0);
  }
});
