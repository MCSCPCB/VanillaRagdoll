import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain' };
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'), prefix = '/VanillaRagdoll/';
    if (!url.pathname.startsWith(prefix)) throw new Error();
    const file = path.resolve(root, decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html');
    if (file !== root && !file.startsWith(root + path.sep)) throw new Error();
    const data = await readFile(file); res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' }); res.end(data);
  } catch { res.writeHead(404); res.end('Not found'); }
}).listen(4173, '127.0.0.1');
