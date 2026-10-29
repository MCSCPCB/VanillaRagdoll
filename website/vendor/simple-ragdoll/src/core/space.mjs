import { A, set } from './expression.mjs';
import { parseExpression } from './parse.mjs';

const print = n => n.kind==='value' ? typeof n.value==='string'?"'"+n.value+"'":String(n.value)
  : n.kind==='read' ? n.path.join('.')
  : n.kind==='call' ? n.path.join('.')+'('+n.args.map(print).join(',')+')'
  : n.kind==='unary' ? '('+n.op+print(n.value)+')'
  : n.kind==='binary' ? '('+print(n.left)+n.op+print(n.right)+')'
  : '('+print(n.test)+'?'+print(n.yes)+':'+print(n.no)+')';

// Read the authored expression without changing the client definition. There is
// no independent physical scale: geometry remains in its original model units.
export function clientSize(client) {
  const value=client.scripts?.scale??1;
  return print(parseExpression(typeof value==='string'?value.trim().replace(/^return\s+/i,'').replace(/;\s*$/,''):value));
}

// Conversion boundary. q.model_scale supplies actor model units (1/16 block at
// ordinary actor size); scripts.scale is a separate client transform. Never
// assume that the query is a dimensionless, complete replacement for scripts.scale.
// frame_to_world is live; body_to_world is frozen with the captured pose. Keeping
// them separate lets an actor change size without moving an existing ragdoll.
export function worldSpace(rig) {
  return {
    initialize:set('v.',{frame_to_world:1/16,previous_to_world:1/16,pose_to_world:1/16,body_to_world:1/16,body_units:1,body_units2:1,body_units3:1}),
    frame:[A('v.previous_to_world','v.frame_to_world'),A('t.actor_units','q.model_scale'),A('t.actor_units','t.actor_units??0.0625'),
      A('t.actor_units','t.actor_units>0?t.actor_units:0.0625'),
      A('t.client_size',rig.clientSize??1),
      A('v.frame_to_world','t.actor_units*(t.client_size>0?t.client_size:1)')],
    capture:[A('v.body_to_world','v.pose_to_world'),A('v.body_units','v.body_to_world*16'),
      A('v.body_units2','v.body_units*v.body_units'),A('v.body_units3','v.body_units2*v.body_units'),A('v.material_revision',-1)],
  };
}

// The narrow-phase solver measures distances in fixed 1/16-block units; body
// positions and joint anchors use blocks. These are fixed unit conversions, not
// another user-controlled size. All dimensions derive from the same pose snapshot.
export function worldRig(rig) {
  const length=n=>n===0?0:`(${n})*v.body_units`,shape=s=>({...s,center:s.center.map(length),half:s.half.map(length)});
  return {...rig,shapes:rig.shapes.map(shape),bodies:rig.bodies.map(b=>{
    const volume=b.massFromDensity===1?'v.body_units3':b.massFromDensity===0||b.massFromDensity===undefined?'1':`((${b.massFromDensity})?v.body_units3:1)`;
    return {...b,mass:volume==='1'?b.mass:`(${b.mass})*${volume}`,inverseMass:volume==='1'?b.inverseMass:`(${b.inverseMass})/${volume}`,
      inverseInertia:b.inverseInertia.map(n=>`(${n})/(v.body_units2*${volume})`),shapes:b.shapes.map(shape)};
  }),joints:rig.joints.map(j=>({...j,...Object.fromEntries(['anchorA','anchorB','transitionAnchorA','transitionAnchorB'].map(k=>[k,j[k].map(length)]))}))};
}
