import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {watch} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('.',import.meta.url));
const port = Number(process.env.PORT ?? 5173);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error('PORT must be an integer between 0 and 65535.');
  process.exit(1);
}

const assets = new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/index.html', ['index.html','text/html; charset=utf-8']],
  ['/style.css', ['style.css','text/css; charset=utf-8']],
  ['/game.js', ['game.js','text/javascript; charset=utf-8']],
  ['/data.js', ['data.js','text/javascript; charset=utf-8']],
  ['/daily.js', ['daily.js','text/javascript; charset=utf-8']],
  ['/site-config.js', ['site-config.js','text/javascript; charset=utf-8']],
  ['/LICENSE.txt', ['LICENSE.txt','text/plain; charset=utf-8']],
]);
const watched = new Set([...assets.values()].map(([file]) => file));
const clients = new Set();
const reloadScript = `<script src="/__dev/reload.js"></script>`;
const reloadClient = `(() => {
  const events = new EventSource('/__dev/events');
  let disconnected = false;
  events.addEventListener('reload', () => window.location.reload());
  events.addEventListener('error', () => { disconnected = true; });
  events.addEventListener('open', () => {
    if (disconnected) window.location.reload();
  });
})();`;

const server = createServer(async (request,response) => {
  response.setHeader('Cache-Control','no-store');
  response.setHeader('X-Content-Type-Options','nosniff');
  const send = (status,content,type = 'text/plain; charset=utf-8') => {
    response.writeHead(status,{'Content-Type':type,'Content-Length':Buffer.byteLength(content)});
    response.end(request.method === 'HEAD' ? undefined : content);
  };
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url,'http://localhost').pathname); }
  catch { return send(400,'Invalid URL.'); }
  if (!['GET','HEAD'].includes(request.method)) {
    response.setHeader('Allow',pathname === '/__dev/events' ? 'GET' : 'GET, HEAD');
    return send(405,'Method not allowed.');
  }

  if (pathname === '/__dev/reload.js') return send(200,reloadClient,'text/javascript; charset=utf-8');
  if (pathname === '/__dev/events') {
    if (request.method !== 'GET') {
      response.setHeader('Allow','GET');
      return send(405,'Method not allowed.');
    }
    response.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Connection':'keep-alive'});
    response.write('retry: 500\nevent: ready\ndata: connected\n\n');
    clients.add(response);
    request.on('close',() => clients.delete(response));
    return;
  }
  let asset = assets.get(pathname);
  const play = pathname.match(/^\/play\/([a-f0-9]{16})(\/|\/index\.html)?$/);
  const preview = pathname.match(/^\/previews\/([a-f0-9]{16})\.png$/);
  if (play) {
    if (!play[2]) {
      const url = new URL(request.url,'http://localhost');
      response.setHeader('Location',`${pathname}/${url.search}`);
      return send(301,'Redirecting to the puzzle.');
    }
    asset = [`dist/play/${play[1]}/index.html`,'text/html; charset=utf-8'];
  } else if (preview) asset = [`dist/previews/${preview[1]}.png`,'image/png'];
  if (!asset) return send(404,'Not found.');
  const [file,type] = asset;
  try {
    let content = await readFile(new URL(file,import.meta.url));
    if (type.startsWith('text/html')) {
      const html = content.toString('utf8');
      content = html.includes('</body>') ? html.replace('</body>',`${reloadScript}\n</body>`) : html+reloadScript;
    }
    send(200,content,type);
  } catch (error) {
    send(error.code === 'ENOENT' ? 404 : 500,error.code === 'ENOENT' ? 'Not found.' : 'Could not read the file.');
  }
});

let reloadTimer;
let buildQueue = Promise.resolve();
const rebuildSources = new Set(['index.html','data.js','daily.js','site-config.js']);
let rebuildNeeded = false;
const execFileAsync = promisify(execFile);
const watcher = watch(root,(_event,filename) => {
  if (filename && !watched.has(String(filename))) return;
  if (rebuildSources.has(String(filename))) rebuildNeeded = true;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    const rebuild = rebuildNeeded;
    rebuildNeeded = false;
    buildQueue = buildQueue.then(async () => {
      if (rebuild) await execFileAsync(process.execPath,['scripts/build-pages.mjs'],{cwd:root});
      const message = `event: reload\ndata: ${filename ? String(filename) : '*'}\n\n`;
      for (const client of clients) client.write(message);
    }).catch(error => console.error(`Preview rebuild: ${error.message}`));
  },50);
});
watcher.on('error',error => console.error(`Live reload: ${error.message}`));
const heartbeat = setInterval(() => {
  for (const client of clients) client.write(': keep-alive\n\n');
},15000);

server.on('error',error => {
  console.error(error.code === 'EADDRINUSE'
    ? `Port ${port} is busy. Try PORT=${port+1} npm run dev.`
    : `Dev server: ${error.message}`);
  shutdown(1);
});

function shutdown(code = 0) {
  watcher.close();
  clearTimeout(reloadTimer);
  clearInterval(heartbeat);
  for (const client of clients) client.end();
  clients.clear();
  server.closeAllConnections();
  server.close(() => process.exit(code));
}
process.on('SIGINT',() => shutdown());
process.on('SIGTERM',() => shutdown());
server.listen(port,'127.0.0.1',() => {
  console.log(`lut game dev server: http://127.0.0.1:${server.address().port}`);
  console.log('Live reload enabled. Stop with Ctrl+C.');
});
