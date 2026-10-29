export const add = (a, b) => a.map((n, i) => n + b[i]);
export const sub = (a, b) => a.map((n, i) => n - b[i]);
export const scale = (a, s) => a.map(n => n * s);
export const dot = (a, b) => a.reduce((s, n, i) => s + n * b[i], 0);
export const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
export const conjugate = q => [-q[0], -q[1], -q[2], q[3]];
export const multiply = (a, b) => [...add(add(scale(b.slice(0,3), a[3]), scale(a.slice(0,3), b[3])), cross(a,b)), a[3]*b[3]-dot(a.slice(0,3),b.slice(0,3))];
export const rotate = (q, p) => add(p, add(scale(cross(q,p),q[3]*2), scale(cross(q,cross(q,p)),2)));
export const axis = (i, angle) => [...[0,1,2].map(k => i===k ? Math.sin(angle*Math.PI/360) : 0), Math.cos(angle*Math.PI/360)];
export const modelRotation = ([x,y,z]) => multiply(axis(2,-z),multiply(axis(1,y),axis(0,-x)));
export const reflect = p => [p[0],p[1],-p[2]];
export const reflectRotation = q => [-q[0],-q[1],q[2],q[3]];
export const identity = () => ({ q:[0,0,0,1], t:[0,0,0] });
export const compose = (a,b) => ({q:multiply(a.q,b.q),t:add(a.t,rotate(a.q,b.t))});
export function boneTransform(bone) {
  const pivot=bone.pivot??[0,0,0], q=modelRotation(bone.rotation??[0,0,0]);
  return {q,t:sub(pivot,rotate(q,pivot))};
}
