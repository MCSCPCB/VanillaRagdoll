import { apiSettings, apiMask } from './api.mjs';
import { parseExpression } from './parse.mjs';
import { printExpression } from './syntax.mjs';

const flat = nodes => [nodes].flat(Infinity);
function walk(nodes, visit) {
  for (const n of flat(nodes)) {
    visit(n);
    if (n.kind === 'if') { walk(n.yes, visit); walk(n.no, visit); }
    if (n.kind === 'loop') walk(n.body, visit);
  }
}
const literal = value => ({kind:'value', value});
const numeric = n => n.kind === 'value' && typeof n.value === 'number';

// Fold feature conditions, not physical arithmetic. Retain operation order and
// runtime rounding for all numeric solver expressions, including literal math.
function fold(n, constants) {
  if (n.kind === 'value') return n;
  if (n.kind === 'read') return constants.has(n.path.join('.')) ? literal(constants.get(n.path.join('.'))) : n;
  if (n.kind === 'call') return {...n, args:n.args.map(a => fold(a, constants))};
  if (n.kind === 'unary') {
    const value=fold(n.value, constants);
    if (numeric(value)) return literal(n.op === '!' ? +!value.value : n.op === '-' ? -value.value : value.value);
    return {...n, value};
  }
  if (n.kind === 'if') {
    const test=fold(n.test, constants);
    if (numeric(test)) return fold(test.value ? n.yes : n.no, constants);
    return {...n, test, yes:fold(n.yes, constants), no:fold(n.no, constants)};
  }
  const left=fold(n.left, constants),right=fold(n.right, constants),op=n.op;
  if (numeric(left) && numeric(right)) {
    const a=Math.fround(left.value),b=Math.fround(right.value);
    const compare={'<':()=>a<b,'>':()=>a>b,'<=':()=>a<=b,'>=':()=>a>=b,'==':()=>a===b,'!=':()=>a!==b,'&&':()=>!!a&&!!b,'||':()=>!!a||!!b};
    if (compare[op]) return literal(+compare[op]());
  }
  if (op === '&&' && (numeric(left) && !left.value || numeric(right) && !right.value)) return literal(0);
  if (op === '||' && (numeric(left) && left.value || numeric(right) && right.value)) return literal(1);
  if (op === '??' && numeric(left)) return left;
  return {...n, left, right};
}

export function specializeApi(program, settings) {
  const api=apiSettings(settings),mask=apiMask(api);
  if (mask === 255) return program;
  const motion=api.applyImpulse || api.setVelocity || api.setTransform;
  const terrain=api.setTerrain || api.setEnvironment;
  const keep=name=>{
    if (/^v\.ragdoll_(out_|active$|variant$)/.test(name)) return true;
    if (!mask) return false;
    if (/^v\.ragdoll_(protocol$|api_mask$|session_|revision$|control_mode$|simulation_)/.test(name)) return true;
    if (/^v\.ragdoll_motion_/.test(name)) return motion;
    if (/^v\.ragdoll_terrain_/.test(name)) return terrain;
    if (/^v\.ragdoll_liquid_/.test(name)) return api.setEnvironment;
    if (/^v\.ragdoll_property_/.test(name)) return api.setProperties;
    if (/^v\.ragdoll_joint_/.test(name)) return api.setJointsEnabled;
    if (/^v\.ragdoll_force_/.test(name)) return api.setForce;
    return false;
  };
  const constants=new Map();
  walk(program.initialize, n=>{
    if (n.kind === 'set' && /^v\.ragdoll_/.test(n.name) && !keep(n.name) && Number.isFinite(Number(n.value))) constants.set(n.name, Number(n.value));
  });
  if (!mask) {
    for (const [key,value] of Object.entries({simulation_gravity:-1,simulation_iterations:0,simulation_collisions:1,simulation_friction:1,simulation_joints:1,input_revision:0,input_session_high:0,input_session_low:0})) constants.set('v.'+key,value);
    walk(program.initialize,n=>{if(n.kind==='set'&&/^v\.joint_enabled_/.test(n.name))constants.set(n.name,1);});
  }
  if (!api.setProperties) constants.set('v.has_material',0);
  walk([program.initialize,program.frameChunks],n=>{
    if(n.kind!=='set')return;
    if(!terrain&&/^v\.external_terrain_/.test(n.name))constants.set(n.name,0);
    if(!api.setProperties&&/^v\.material_\d+_/.test(n.name))constants.set(n.name,0);
  });
  const cache=new Map();
  const expression=value=>{
    if(typeof value!=='string')return value;
    if(cache.has(value))return cache.get(value);
    const node=fold(parseExpression(value),constants),result=numeric(node)?node.value:printExpression(node);
    cache.set(value,result);return result;
  };
  const nodes=list=>flat(list).flatMap(n=>{
    if(n.kind==='set')return constants.has(n.name)?[]:[{...n,value:expression(n.value)}];
    if(n.kind==='if'){
      const test=expression(n.test);
      if(typeof test==='number')return nodes(test?n.yes:n.no);
      const yes=nodes(n.yes),no=nodes(n.no);
      return yes.length||no.length?[{...n,test,yes,no}]:[];
    }
    const count=expression(n.count);
    if(typeof count==='number'&&count<=0)return [];
    const body=nodes(n.body);return body.length?[{...n,count,body}]:[];
  });
  const output={...program,initialize:nodes(program.initialize),frameChunks:program.frameChunks.map(nodes),rootOutputs:program.rootOutputs.map(nodes)};
  const reads=new Set();
  walk([output.initialize,output.frameChunks,output.rootOutputs],n=>{
    for(const [name]of String(n.kind==='set'?n.value:n.kind==='if'?n.test:n.count).matchAll(/\bv\.\w+/g))reads.add(name);
  });
  output.initialize=output.initialize.filter(n=>n.kind!=='set'||reads.has(n.name)||/^v\.(out\d+|active$|variant$|ragdoll_out_)/.test(n.name)||mask&&/^v\.ragdoll_(protocol|api_mask|session_high|session_low|revision|motion_ack)$/.test(n.name));
  return output;
}
