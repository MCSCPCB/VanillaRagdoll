import { A, If } from './expression.mjs';
import { fail } from '../i18n.js';

const temporaries = value => String(value).match(/(?<![\w.])t\.\w+/g) ?? [];
const union = (...sets) => new Set(sets.flatMap(set => [...set]));

function liveBefore(nodes, after = new Set()) {
  let live = new Set(after);
  for (const node of nodes.flat(Infinity).reverse()) {
    if (node.kind === 'set') {
      live.delete(node.name);
      live = union(live, temporaries(node.value));
    } else if (node.kind === 'if') {
      live = union(liveBefore(node.yes, live), liveBefore(node.no, live), temporaries(node.test));
    } else {
      let previous;
      do {
        previous = live;
        live = union(live, liveBefore(node.body, live));
      } while (live.size !== previous.size);
      live = union(live, temporaries(node.count));
    }
  }
  return live;
}

function replaceTemporaries(nodes, replacements) {
  const replace = value => typeof value === 'string' ? value.replace(/(?<![\w.])t\.\w+/g, name => replacements.get(name) ?? name) : value;
  return nodes.flat(Infinity).map(node => node.kind === 'set'
    ? {...node, name: replace(node.name), value: replace(node.value)}
    : node.kind === 'if'
      ? {...node, test: replace(node.test), yes: replaceTemporaries(node.yes, replacements), no: replaceTemporaries(node.no, replacements)}
      : {...node, count: replace(node.count), body: replaceTemporaries(node.body, replacements)});
}

export function splitStatements(nodes, source, {limit = 64000, target = limit - 2000, prefix = 'chunk'} = {}) {
  let gate = 0, temporary = 0;
  const partition = (nodes, budget = limit) => {
    const result = [];
    let batch = [], estimate = 0;
    const flush = () => {
      if (!batch.length) return;
      const current = batch;
      batch = []; estimate = 0;
      if (source(current).length <= budget) result.push(current);
      else if (current.length > 1) {
        const middle = Math.floor(current.length / 2);
        result.push(...partition(current.slice(0, middle), budget), ...partition(current.slice(middle), budget));
      } else fail('chunk', [source(current).length, budget]);
    };
    for (const node of nodes.flat(Infinity)) {
      const size = source([node]).length;
      if (size > budget) {
        flush();
        if (node.kind === 'loop' && Number.isInteger(Number(node.count)) && Number(node.count) >= 0 && Number(node.count) <= 4096) {
          // 循环体只分段一次，重复引用同一组计算段，供导出时复用动画。
          const body = partition(node.body,budget);
          for(let i=0;i<Number(node.count);i++)result.push(...body);
          continue;
        }
        if (node.kind !== 'if') fail('chunk', [size, budget]);
        // 条件只求值一次，分支内的状态修改不影响后续分段。
        const flag = `v.${prefix}_gate${gate++}`;
        result.push([A(flag, `(${node.test})?1:0`)]);
        for (const [test, branch] of [[flag, node.yes], [`!${flag}`, node.no]]) {
          const overhead = source([If(test, [])]).length;
          const guarded = new Map();
          result.push(...partition(branch, budget - overhead).map(part => {
            if(!guarded.has(part))guarded.set(part,[If(test,part)]);
            return guarded.get(part);
          }));
        }
      } else {
        if (batch.length && estimate + size > Math.min(target, budget)) flush();
        batch.push(node); estimate += size;
      }
    }
    flush();
    return result;
  };
  let chunks = partition(nodes);
  while (chunks.length > 1) {
    const shared = union(...chunks.slice(1).map(chunk => liveBefore(chunk)));
    if (!shared.size) break;
    // t 变量不跨表达式保留；仅提升后续计算段仍会读取的临时值。
    const replacements = new Map([...shared].map(name => [name, `v.${prefix}_temp${temporary++}`]));
    const cache = new Map();
    chunks = chunks.flatMap(chunk => {
      if(!cache.has(chunk))cache.set(chunk,partition(replaceTemporaries(chunk,replacements)));
      return cache.get(chunk);
    });
  }
  return chunks;
}
