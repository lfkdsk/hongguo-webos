// Desktop debugging: runs the media service and serves the app without a TV.
// Open the printed URL at 1920x1080; arrow keys, Enter and Esc act as the remote.
// HONGGUO_FFMPEG must name an ffmpeg for this machine (service/ffmpeg is for the TV).
import { createReadStream, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const app = resolve(root, 'app');
process.env.HONGGUO_DATA_DIR ||= resolve(root, '.devdata');
process.env.HONGGUO_FFMPEG ||= 'ffmpeg';

const { HongguoServer } = createRequire(import.meta.url)('../service/server.js');
const service = new HongguoServer();
const servicePort = await service.listen();

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const port = Number(process.env.PORT || 5173);
createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = resolve(app, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(app) || !existsSync(file)) {
    res.writeHead(404);
    return res.end('not found');
  }
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`http://localhost:${port}/?base=${encodeURIComponent(`http://127.0.0.1:${servicePort}`)}&token=${service.token}`);
});
