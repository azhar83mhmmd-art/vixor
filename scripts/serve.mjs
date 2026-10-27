// Server lokal yang meniru vercel.json (cleanUrls + /join/:code + header sw.js). Jalankan: node scripts/serve.mjs [port]
// Pakai ini, BUKAN python -m http.server (itu membuat /chat, /calls, /updates jadi 404 dan klik notifikasi gagal).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(fileURLToPath(import.meta.url), '..', '..'), port = +process.argv[2] || 8323;
const T = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json; charset=utf-8', '.json': 'application/json' };
const exists = async (f) => { try { return (await stat(f)).isFile(); } catch { return false; } };
createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.startsWith('/join/')) p = '/join';
  if (p.endsWith('/')) p += 'index';
  let f = normalize(join(root, p)); if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (!(await exists(f)) && (await exists(f + '.html'))) f += '.html';
  if (!(await exists(f))) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  const h = { 'Content-Type': T[extname(f)] || 'application/octet-stream' };
  if (p === '/sw.js') { h['Cache-Control'] = 'no-store'; h['Service-Worker-Allowed'] = '/'; }
  res.writeHead(200, h); res.end(await readFile(f));
  console.log(req.method, req.url, 200);
}).listen(port, () => console.log('ORVIX lokal: http://localhost:' + port));
