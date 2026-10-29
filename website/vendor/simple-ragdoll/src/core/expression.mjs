export const axes = ["x", "y", "z"], quat = [...axes, "w"];
export const A = (name, value) => ({ kind: "set", name, value });
export const If = (test, yes, no = []) => ({ kind: "if", test, yes: [yes].flat(Infinity), no: [no].flat(Infinity) });
export const Loop = (count, body) => ({ kind: "loop", count, body: body.flat(Infinity) });
export const set = (prefix, values) => Object.entries(values).map(([key, value]) => A(prefix + key, value));
export const dot = (a, b, keys = axes) => keys.map(k => `${a}${k}*${b}${k}`).join("+");
export const copy = (out, src, keys = axes) => keys.map(k => A(out + k, src + k));
export const add = (out, a, b) => axes.map(k => A(out + k, `${a}${k}+${b}${k}`));
export const sub = (out, a, b) => axes.map(k => A(out + k, `${a}${k}-${b}${k}`));
export const scale = (out, src, factor, keys = axes) => keys.map(k => A(out + k, `${src}${k}*(${factor})`));
export const cross = (out, a, b) => axes.map((k, i) => A(out + k, `${a}${axes[(i + 1) % 3]}*${b}${axes[(i + 2) % 3]}-${a}${axes[(i + 2) % 3]}*${b}${axes[(i + 1) % 3]}`));
export const vector = (out, values, factor = "1") => axes.map((k, i) => A(out + k, `(${values[i]})*(${factor})`));
export function normalize(prefix, keys = axes) {
  return [A("t.norm", `math.max(math.sqrt(${dot(prefix, prefix, keys)}),0.000001)`), scale(prefix, prefix, "1/t.norm", keys)];
}

function emitNodes(nodes, target, expression, depth = 0) {
  return nodes.flat(Infinity).map(n => {
    if (n.kind === "set") return `${n.name}=${expression(n.value)};`;
    if (n.kind === "if") return target === "molang"
      ? `(${expression(n.test)})?{${emitNodes(n.yes, target, expression, depth)}}${n.no.length ? `:{${emitNodes(n.no, target, expression, depth)}}` : ""};`
      : `if(${n.test}){${emitNodes(n.yes, target, expression, depth)}}${n.no.length ? `else{${emitNodes(n.no, target, expression, depth)}}` : ""}`;
    return target === "molang" ? `loop(${expression(n.count)},{${emitNodes(n.body, target, expression, depth + 1)}});`
      : `for(let i${depth}=0,n${depth}=${n.count};i${depth}<n${depth};i${depth}++){${emitNodes(n.body, target, expression, depth + 1)}}`;
  }).join("");
}
export function emit(nodes, target = "molang", {expression = value => value} = {}) {
  const source = emitNodes(nodes, target, expression), names = new Map();
  const identifier = index => (index >= 26 ? identifier(Math.floor(index / 26) - 1) : "") + String.fromCharCode(97 + index % 26);
  return source.replace(/'[^']*'|(?<![\w.])t\.\w+/g, name => {
    if (name.startsWith("'")) return name;
    if (!names.has(name)) names.set(name, `t.${identifier(names.size)}`);
    return names.get(name);
  });
}
export function choose(index, values, start = 0) {
  if (Number.isInteger(Number(index))) return String(values[Number(index) - start]);
  if (values.every(value => value === values[0])) return String(values[0]);
  const half = Math.floor(values.length / 2);
  return `(${index}<${start + half}?${choose(index, values.slice(0, half), start)}:${choose(index, values.slice(half), start + half)})`;
}
export function dispatch(index, values, action, start = 0) {
  if (Number.isInteger(Number(index))) return action(values[Number(index) - start], Number(index));
  if (values.length === 1) return action(values[0], start);
  const half = Math.floor(values.length / 2);
  return [If(`${index}<${start + half}`, dispatch(index, values.slice(0, half), action, start), dispatch(index, values.slice(half), action, start + half))];
}
export function multiply(out, a, b) {
  return [A("t.mx", `${a}w*${b}x+${a}x*${b}w+${a}y*${b}z-${a}z*${b}y`),
    A("t.my", `${a}w*${b}y-${a}x*${b}z+${a}y*${b}w+${a}z*${b}x`),
    A("t.mz", `${a}w*${b}z+${a}x*${b}y-${a}y*${b}x+${a}z*${b}w`),
    A("t.mw", `${a}w*${b}w-${a}x*${b}x-${a}y*${b}y-${a}z*${b}z`), copy(out, "t.m", quat)];
}
export function rotate(out, q, p) {
  return [cross("t.rc", q, p), scale("t.rc", "t.rc", 2), cross("t.rd", q, "t.rc"),
    axes.map(k => A(out + k, `${p}${k}+${q}w*t.rc${k}+t.rd${k}`))];
}
export function axisRotation(out, axis, angle) {
  return [vector(out, axes.map(k => k === axis ? `math.sin((${angle})*0.5)` : 0)), A(out + "w", `math.cos((${angle})*0.5)`)];
}

