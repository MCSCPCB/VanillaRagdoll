import { parseExpression } from '../../vendor/simple-ragdoll/src/core/parse.mjs';

// Validate only generated code. Uploaded expressions are never executed in JavaScript.
export function validateExpression(source) {
  // The core expression parser has no animation-channel context. `this` is a
  // valid Molang channel value used by vanilla pose/decorations capture.
  const tree = parseExpression(typeof source === 'string' ? source.replace(/\bthis\b/g, 'v.__channel_value') : source);
  const visit = node => {
    if (node.kind === 'binary' && node.op === '??' && (node.left.kind !== 'read' || !['v', 't', 'c'].includes(node.left.path[0]))) throw new Error('Molang ?? requires a direct variable');
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(v => v && typeof v === 'object' && visit(v));
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(tree);
}

export function validateScript(source) {
  if (!/[;{}]/.test(source)) { validateExpression(source); return; }
  let at = 0;
  const expect = text => {
    if (!source.startsWith(text, at)) throw new Error('Invalid generated Molang at ' + at + ': ' + source.slice(at, at + 60));
    at += text.length;
  };
  const until = stop => {
    const start = at; let depth = 0, quote = false;
    while (at < source.length) {
      const c = source[at];
      if (c === "'") quote = !quote;
      if (!quote) {
        if (!depth && c === stop) return source.slice(start, at);
        if (c === '(') depth++;
        if (c === ')') depth--;
      }
      at++;
    }
    throw new Error('Unterminated generated Molang');
  };
  const sequence = end => {
    while (at < source.length && source[at] !== end) {
      if (source.startsWith('return ', at)) {
        at += 7; validateExpression(until(';')); expect(';');
      } else if (source.startsWith('loop(', at)) {
        expect('loop('); validateExpression(until(',')); expect(',{'); sequence('}'); expect('});');
      } else if (source[at] === '(') {
        expect('('); validateExpression(until(')')); expect(')?{'); sequence('}'); expect('}');
        if (source.startsWith(':{', at)) { expect(':{'); sequence('}'); expect('}'); }
        expect(';');
      } else {
        const statement = until(';'); expect(';');
        const assignment = /^(?:v|t)\.\w+(?:\.\w+)*=([^=][\s\S]*)$/.exec(statement);
        if (!assignment) throw new Error('Invalid generated Molang assignment: ' + statement.slice(0, 60));
        validateExpression(assignment[1]);
      }
    }
  };
  sequence(null);
  if (at !== source.length) throw new Error('Trailing generated Molang');
}
