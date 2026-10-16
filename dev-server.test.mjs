import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as vm from 'node:vm';
import { inflateSync } from 'node:zlib';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const serverSource = path.join(testDirectory, 'dev-server.mjs');
const publishedDist = path.join(testDirectory, 'dist');
const execFileAsync = promisify(execFile);

const fixture = {
  index: `<!doctype html>\n<html><head><title>Fixture game</title></head><body><main id="app">fixture index</main></body></html>\n`,
  style: 'body { color: rgb(1, 2, 3); }\n',
  game: 'window.fixtureGame = "game-fixture";\n',
  data: 'window.fixtureData = "data-fixture";\n',
  daily: 'window.fixtureDaily = true;\n',
  siteConfig: 'window.fixtureSiteConfig = true;\n',
  license: 'Fixture license text\n',
  privateFile: 'this private helper must not be served\n',
};

let fixtureDirectory;
let child;
let baseUrl;
let childStderr = '';

function fixturePath(name) {
  return path.join(fixtureDirectory, name);
}

function assertNoStore(response) {
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
}

async function responseText(url, init) {
  const response = await fetch(url, init);
  const body = await response.text();
  return { response, body };
}

function waitForReady(processHandle, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      finish(
        new Error(
          `server did not announce a ready URL within ${timeoutMs}ms; stdout=${JSON.stringify(output)} stderr=${JSON.stringify(childStderr)}`,
        ),
      );
    }, timeoutMs);

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      processHandle.stdout.off('data', onStdout);
      processHandle.off('exit', onExit);
      processHandle.off('error', onError);
      if (error) reject(error);
      else resolve(value);
    };

    const onStdout = (chunk) => {
      output += chunk.toString();
      const lines = output.split(/\r?\n/);
      output = lines.pop() ?? '';
      for (const line of lines) {
        const readyMatch = line.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (readyMatch) {
          finish(null, readyMatch[0]);
          return;
        }
      }
    };
    const onExit = (code, signal) => {
      finish(
        new Error(
          `server exited before announcing a ready URL (code=${code}, signal=${signal}); stderr=${JSON.stringify(childStderr)}`,
        ),
      );
    };
    const onError = (error) => finish(error);

    processHandle.stdout.on('data', onStdout);
    processHandle.once('exit', onExit);
    processHandle.once('error', onError);
  });
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return;
  }

  await new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      processHandle.off('exit', finish);
      resolve();
    };
    const killTimer = setTimeout(() => {
      processHandle.kill('SIGKILL');
    }, 2_000);

    processHandle.once('exit', finish);
    processHandle.kill('SIGTERM');
  });
}

function parseSseEvent(rawEvent) {
  let event = 'message';
  const data = [];
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
  }
  return { event, data: data.join('\n') };
}

function createSseReader(streamReader) {
  let buffer = '';
  const decoder = new TextDecoder();

  async function readWithTimeout(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`SSE read timed out after ${timeoutMs}ms`)), timeoutMs);
      streamReader.read().then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  return {
    async next(timeoutMs = 8_000) {
      while (true) {
        const separator = buffer.match(/\r?\n\r?\n/);
        if (separator) {
          const eventText = buffer.slice(0, separator.index);
          buffer = buffer.slice(separator.index + separator[0].length);
          return parseSseEvent(eventText);
        }

        const { done, value } = await readWithTimeout(timeoutMs);
        if (done) throw new Error('SSE stream closed before a complete event arrived');
        buffer += decoder.decode(value, { stream: true });
      }
    },
  };
}

function assertReloadScriptInjected(body) {
  const expectedScript = '<script src="/__dev/reload.js"></script>';
  assert.equal(
    (body.match(/<script\s+src=["']\/__dev\/reload\.js["'][^>]*><\/script>/g) ?? []).length,
    1,
    'landing HTML should contain exactly one reload script tag',
  );
  const bodyClose = body.lastIndexOf('</body>');
  assert.notEqual(bodyClose, -1, 'fixture should retain its body close tag');
  assert.ok(body.indexOf(expectedScript) < bodyClose, 'reload script should be inserted before </body>');
}

before(
  async () => {
    const source = await readFile(serverSource, 'utf8');
    fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'lut-dev-server-'));

    await writeFile(fixturePath('dev-server.mjs'), source);
    await writeFile(fixturePath('index.html'), fixture.index);
    await writeFile(fixturePath('style.css'), fixture.style);
    await writeFile(fixturePath('game.js'), fixture.game);
    await writeFile(fixturePath('data.js'), fixture.data);
    await writeFile(fixturePath('daily.js'), fixture.daily);
    await writeFile(fixturePath('site-config.js'), fixture.siteConfig);
    await writeFile(fixturePath('LICENSE.txt'), fixture.license);
    await writeFile(fixturePath('.private-helper'), fixture.privateFile);
    await execFileAsync(process.execPath, ['scripts/build-pages.mjs'], {cwd: testDirectory});
    await cp(publishedDist, fixturePath('dist'), {recursive: true});
    const published = await loadPublishedModel();
    const rebuildId = published.LUT_DAILY.shareId(published.MOVIES[0]);
    await mkdir(fixturePath('scripts'), {recursive: true});
    await writeFile(
      fixturePath('scripts/build-pages.mjs'),
      `import {readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const sources = await Promise.all(['index.html', 'data.js', 'daily.js', 'site-config.js']
  .map((filename) => readFile(path.join(root, filename), 'utf8')));
const marker = sources.map((source) => source.match(/data-rebuild-marker="([^"]+)"/)?.[1] ?? 'missing').join('|');
const pagePath = path.join(root, 'dist', 'play', '${rebuildId}', 'index.html');
const page = await readFile(pagePath, 'utf8');
const clean = page.replace(/<!-- dev-rebuild:[^>]* -->/g, '');
const replacement = '<!-- dev-rebuild:' + marker + ' -->\\n</body>';
await writeFile(pagePath, clean.replace('</body>', replacement));
`,
    );

    child = spawn(process.execPath, ['dev-server.mjs'], {
      cwd: fixtureDirectory,
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      childStderr += chunk;
    });

    baseUrl = await waitForReady(child);
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:[1-9]\d*$/);
  },
  { timeout: 15_000 },
);

after(
  async () => {
    await stopProcess(child);
    await rm(fixtureDirectory, { recursive: true, force: true });
  },
  { timeout: 8_000 },
);

test('serves landing HTML and injects the reload client without changing source files', async () => {
  const sourceBefore = await readFile(fixturePath('index.html'), 'utf8');
  const root = await responseText(`${baseUrl}/`);
  const index = await responseText(`${baseUrl}/index.html`);

  assert.equal(root.response.status, 200);
  assert.equal(index.response.status, 200);
  assertNoStore(root.response);
  assertNoStore(index.response);
  assert.match(root.response.headers.get('content-type') ?? '', /text\/html/i);
  assert.equal(root.body, index.body, 'root and /index.html should serve the same rendered document');
  assert.match(root.body, /fixture index/);
  assertReloadScriptInjected(root.body);
  assert.equal(await readFile(fixturePath('index.html'), 'utf8'), sourceBefore);
});

test('serves each allowlisted static asset with its content type and no-store caching', async () => {
  const assets = [
    ['/style.css', fixture.style, /text\/css/i],
    ['/game.js', fixture.game, /javascript/i],
    ['/data.js', fixture.data, /javascript/i],
    ['/daily.js', fixture.daily, /javascript/i],
    ['/site-config.js', fixture.siteConfig, /javascript/i],
    ['/LICENSE.txt', fixture.license, /text\/plain/i],
  ];

  for (const [route, expectedBody, expectedType] of assets) {
    const { response, body } = await responseText(`${baseUrl}${route}`);
    assert.equal(response.status, 200, route);
    assertNoStore(response);
    assert.match(response.headers.get('content-type') ?? '', expectedType, route);
    assert.equal(body, expectedBody, route);
  }
});

async function loadPublishedModel() {
  const context = vm.createContext({window: {}});
  for (const filename of ['site-config.js', 'daily.js', 'data.js']) {
    const source = await readFile(path.join(testDirectory, filename), 'utf8');
    vm.runInContext(source, context, {filename});
  }
  return context.window;
}

function previewDimensions(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
}

function decodePreview(bytes) {
  const {width, height} = previewDimensions(bytes);
  const idat = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
    if (type === 'IEND') break;
  }
  assert.ok(idat.length, 'preview should contain image data');
  const raw = inflateSync(Buffer.concat(idat));
  const rowSize = width * 3 + 1;
  assert.equal(raw.length, rowSize * height);
  for (let row = 0; row < height; row += 1) assert.equal(raw[row * rowSize], 0, `row ${row} uses a filter`);
  return {
    pixel(x, y) {
      assert.ok(Number.isInteger(x) && x >= 0 && x < width);
      assert.ok(Number.isInteger(y) && y >= 0 && y < height);
      const index = y * rowSize + 1 + x * 3;
      return [...raw.subarray(index, index + 3)];
    },
  };
}

function colorRgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function assertPreviewBarcode(preview, movie, shareId) {
  const pixels = decodePreview(preview);
  const colors = Array.from(movie.colors);
  const barcodeX = 40;
  const barcodeY = 110;
  const barcodeWidth = 1120;
  for (let sourceIndex = 0; sourceIndex < colors.length; sourceIndex += 1) {
    const outputColumn = Math.min(
      barcodeWidth - 1,
      sourceIndex === 0 ? 0 : Math.ceil(sourceIndex * barcodeWidth / colors.length),
    );
    const renderedIndex = Math.min(
      colors.length - 1,
      Math.floor(outputColumn * colors.length / barcodeWidth),
    );
    assert.equal(renderedIndex, sourceIndex, `${shareId} remapped source color ${sourceIndex}`);
    assert.deepEqual(
      pixels.pixel(barcodeX + outputColumn, barcodeY + 100),
      colorRgb(colors[sourceIndex]),
      `${shareId} barcode color ${sourceIndex}`,
    );
  }
}

function previewChunkTypes(bytes) {
  const types = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    types.push(bytes.toString('ascii', offset + 4, offset + 8));
    offset += size + 12;
    if (types.at(-1) === 'IEND') break;
  }
  return types;
}

test('serves published helper assets and private generated share routes safely', async () => {
  const published = await loadPublishedModel();
  const movies = published.MOVIES;
  const daily = published.LUT_DAILY;

  const shareIds = movies.map((movie) => daily.shareId(movie));
  assert.equal(new Set(shareIds).size, movies.length);
  assert.ok(shareIds.every((id) => /^[0-9a-f]{16}$/.test(id)));

  for (const [movie, shareId] of movies.map((movie, index) => [movie, shareIds[index]])) {
    const page = await responseText(`${baseUrl}/play/${shareId}/`);
    assert.equal(page.response.status, 200, `play page ${shareId}`);
    assertNoStore(page.response);
    assert.match(page.response.headers.get('content-type') ?? '', /text\/html/i);
    assert.match(page.body, new RegExp(`property="og:url" content="[^"]*play/${shareId}/"`));
    assert.match(page.body, new RegExp(`property="og:image" content="[^"]*previews/${shareId}\.png"`));
    assert.match(page.body, /<base href="\.\.\/\.\.\/">/);
    for (const answerValue of [movie.title, String(movie.year), movie.hint, ...movie.genres]) {
      if (answerValue) assert.equal(page.body.includes(answerValue), false, `${shareId} leaks ${answerValue}`);
    }

    const previewResponse = await fetch(`${baseUrl}/previews/${shareId}.png`);
    assert.equal(previewResponse.status, 200, `preview ${shareId}`);
    assertNoStore(previewResponse);
    assert.match(previewResponse.headers.get('content-type') ?? '', /image\/png/i);
    const preview = Buffer.from(await previewResponse.arrayBuffer());
    assert.deepEqual(previewDimensions(preview), {width: 1200, height: 630});
    assertPreviewBarcode(preview, movie, shareId);
    assert.equal(
      previewChunkTypes(preview).some((type) => /^(?:tEXt|zTXt|iTXt|eXIf)$/i.test(type)),
      false,
      `${shareId} embeds answer metadata`,
    );
  }

  const firstId = shareIds[0];
  const query = '?day=2026-10-16&source=test';
  const slashless = await fetch(`${baseUrl}/play/${firstId}${query}`, {redirect: 'manual'});
  assert.ok([301, 302, 307, 308].includes(slashless.status));
  const redirect = new URL(slashless.headers.get('location'), baseUrl);
  assert.equal(redirect.pathname, `/play/${firstId}/`);
  assert.equal(redirect.search, query);

  for (const invalidRoute of [
    `/play/${firstId.slice(0, 15)}/`,
    `/play/${firstId.toUpperCase()}/`,
    `/play/${firstId}/extra/`,
    `/play/${firstId}/%252e%252e/%252e%252e/index.html`,
    `/previews/${firstId.slice(0, 15)}.png`,
    `/previews/${firstId.toUpperCase()}.png`,
    `/previews/${firstId}.png/`,
    `/dist/play/${firstId}/`,
    `/dist/previews/${firstId}.png`,
  ]) {
    const response = await fetch(`${baseUrl}${invalidRoute}`);
    assert.equal(response.status, 404, invalidRoute);
    assertNoStore(response);
  }
});

test('rebuilds generated share HTML before broadcasting watched source reloads', {timeout: 15_000}, async () => {
  const published = await loadPublishedModel();
  const shareId = published.LUT_DAILY.shareId(published.MOVIES[0]);
  const controller = new AbortController();
  let streamReader;
  try {
    const response = await fetch(`${baseUrl}/__dev/events`, {signal: controller.signal});
    assert.equal(response.status, 200);
    assert.ok(response.body);
    streamReader = response.body.getReader();
    const events = createSseReader(streamReader);
    assert.deepEqual(await events.next(), {event: 'ready', data: 'connected'});

    for (const [filename, marker] of [
      ['index.html', 'index-20261016'],
      ['data.js', 'data-20261016'],
      ['daily.js', 'daily-20261016'],
      ['site-config.js', 'config-20261016'],
    ]) {
      const source = await readFile(fixturePath(filename), 'utf8');
      await writeFile(fixturePath(filename), `${source}\n<!-- data-rebuild-marker="${marker}" -->\n`);
      assert.deepEqual(await events.next(10_000), {event: 'reload', data: filename});
      const page = await responseText(`${baseUrl}/play/${shareId}/`);
      assert.equal(page.response.status, 200);
      assert.match(page.body, new RegExp(`dev-rebuild:[^<]*${marker}`));
    }
  } finally {
    controller.abort();
    if (streamReader) await streamReader.cancel().catch(() => {});
  }
});

test('supports the reload client endpoint and sends an empty HEAD body', async () => {
  const reload = await responseText(`${baseUrl}/__dev/reload.js`);
  assert.equal(reload.response.status, 200);
  assertNoStore(reload.response);
  assert.match(reload.response.headers.get('content-type') ?? '', /javascript/i);

  const eventSources = [];
  const reloadCalls = [];
  class EventSourceAdapter {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      eventSources.push(this);
    }

    addEventListener(type, listener) {
      this.listeners.set(type, listener);
    }

    emit(type) {
      this.listeners.get(type)?.();
    }
  }
  vm.runInNewContext(
    reload.body,
    {
      EventSource: EventSourceAdapter,
      window: { location: { reload: () => reloadCalls.push(true) } },
    },
    { filename: 'reload-client.js' },
  );
  assert.equal(eventSources.length, 1);
  assert.equal(eventSources[0].url, '/__dev/events');
  eventSources[0].emit('open');
  assert.equal(reloadCalls.length, 0, 'initial connection must not reload');
  eventSources[0].emit('reload');
  assert.equal(reloadCalls.length, 1, 'reload event must refresh the page');
  eventSources[0].emit('error');
  eventSources[0].emit('open');
  assert.equal(reloadCalls.length, 2, 'reopened connection after an error must refresh the page');

  const head = await responseText(`${baseUrl}/style.css`, { method: 'HEAD' });
  assert.equal(head.response.status, 200);
  assertNoStore(head.response);
  assert.match(head.response.headers.get('content-type') ?? '', /text\/css/i);
  assert.equal(head.body, '');
});

test('returns no-store 404s for unknown, private, and traversal paths', async () => {
  const paths = [
    '/missing',
    '/dev-server.mjs',
    '/.private-helper',
    '/%2e%2e/dev-server.mjs',
    '/%2e%2e%2fdev-server.mjs',
    '/__dev/%2e%2e/dev-server.mjs',
  ];

  for (const pathname of paths) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 404, pathname);
    assertNoStore(response);
  }
});

test('rejects non-GET methods with 405 and advertises GET and HEAD', async () => {
  for (const pathname of ['/style.css', '/']) {
    const response = await fetch(`${baseUrl}${pathname}`, { method: 'POST' });
    assert.equal(response.status, 405, pathname);
    assertNoStore(response);
    assert.match(response.headers.get('allow') ?? '', /GET/i, pathname);
    assert.match(response.headers.get('allow') ?? '', /HEAD/i, pathname);
  }

  for (const method of ['POST', 'HEAD']) {
    const response = await fetch(`${baseUrl}/__dev/events`, { method });
    assert.equal(response.status, 405, `${method} /__dev/events`);
    assertNoStore(response);
    assert.equal(response.headers.get('allow')?.trim(), 'GET');
  }
});

test('rejects an invalid PORT with a bounded nonzero startup failure', { timeout: 8_000 }, async () => {
  const invalid = spawn(process.execPath, ['dev-server.mjs'], {
    cwd: fixtureDirectory,
    env: { ...process.env, PORT: 'not-a-port' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  invalid.stderr.setEncoding('utf8');
  invalid.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  try {
    const outcome = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('invalid PORT child did not exit within 5 seconds')), 5_000);
      invalid.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      invalid.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    assert.equal(outcome.signal, null);
    assert.notEqual(outcome.code, 0);
    assert.match(stderr, /PORT/i);
  } finally {
    await stopProcess(invalid);
  }
});

class GameplayEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    if (!event.target) event.target = this;
    event.currentTarget = this;
    if (typeof event.defaultPrevented !== 'boolean') event.defaultPrevented = false;
    if (!event.preventDefault) event.preventDefault = () => { event.defaultPrevented = true; };
    for (const listener of this.listeners.get(event.type) ?? []) listener.call(this, event);
    return !event.defaultPrevented;
  }
}

class GameplayClassList {
  constructor() {
    this.values = new Set();
  }

  toggle(name, force) {
    const shouldHave = force === undefined ? !this.values.has(name) : Boolean(force);
    if (shouldHave) this.values.add(name);
    else this.values.delete(name);
    return shouldHave;
  }

  contains(name) {
    return this.values.has(name);
  }
}

class GameplayElement extends GameplayEventTarget {
  constructor(document, tagName, id = '') {
    super();
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.href = '';
    this.download = '';
    this._textContent = '';
    this.attributes = new Map();
    this.focused = false;
    this.selected = false;
    this.isContentEditable = false;
    this.classList = new GameplayClassList();
    this.style = {setProperty() {}};
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'href') this.href = '';
    if (name === 'download') this.download = '';
  }

  focus() {
    this.focused = true;
    this.ownerDocument.activeElement = this;
  }

  select() {
    this.selected = true;
  }

  click() {
    if (this.disabled) return false;
    this.dispatchEvent({type: 'click'});
    return true;
  }
}

class GameplayDialog extends GameplayElement {
  constructor(document, id) {
    super(document, 'dialog', id);
    this.open = false;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }
}

class GameplayCanvasContext {
  constructor() {
    this.calls = [];
    this.fillStyle = '#000000';
    this.imageSmoothingEnabled = true;
  }

  reset() {
    this.calls = [];
    this.fillStyle = '#000000';
    this.imageSmoothingEnabled = true;
  }

  fillRect(...args) {
    this.calls.push({method: 'fillRect', args, fillStyle: this.fillStyle});
  }

  createRadialGradient() {
    return {addColorStop() {}};
  }

  measureText(text) {
    return {width: String(text).length * 20};
  }

  fillText(...args) {
    this.calls.push({method: 'fillText', args, fillStyle: this.fillStyle});
  }
}

class GameplayCanvas extends GameplayElement {
  constructor(document, id, blobCallbacks) {
    super(document, 'canvas', id);
    this._width = 300;
    this._height = 150;
    this.context = new GameplayCanvasContext();
    this.blobCallbacks = blobCallbacks;
  }

  get width() {
    return this._width;
  }

  set width(value) {
    this._width = Number(value);
    this.context.reset();
  }

  get height() {
    return this._height;
  }

  set height(value) {
    this._height = Number(value);
  }

  getContext() {
    return this.context;
  }

  toBlob(callback, mime = 'image/png') {
    this.blobCallbacks.push(() => callback(new Blob(['preview'], {type: mime})));
  }
}

class GameplayDocument extends GameplayEventTarget {
  constructor(htmlIds, blobCallbacks) {
    super();
    this.htmlIds = htmlIds;
    this.hidden = false;
    this.activeElement = null;
    this.elements = new Map();
    this.blobCallbacks = blobCallbacks;
    this.body = new GameplayElement(this, 'body');
  }

  register(id, element) {
    assert.ok(this.htmlIds.has(id), `gameplay adapter invented missing DOM id #${id}`);
    this.elements.set(id, element);
  }

  getElementById(id) {
    const element = this.elements.get(id);
    if (!element) throw new Error(`Missing DOM element #${id}`);
    return element;
  }

  createElement(tagName) {
    return tagName.toLowerCase() === 'canvas'
      ? new GameplayCanvas(this, '', this.blobCallbacks)
      : new GameplayElement(this, tagName);
  }
}

class GameplayStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function gameplayClock(day) {
  let currentDay = day;
  return {
    set(nextDay) {
      currentDay = nextDay;
    },
    now() {
      const [year, month, date] = currentDay.split('-').map(Number);
      return new Date(year, month - 1, date, 12);
    },
  };
}

function fixedDateFor(clock) {
  const RealDate = Date;
  return class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [clock.now().getTime()]));
    }

    static now() {
      return clock.now().getTime();
    }
  };
}

function gameplayTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId++;
      pending.set(id, {callback, delay});
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    runNext() {
      const id = pending.keys().next().value;
      assert.notEqual(id, undefined, 'expected a scheduled timer');
      const timer = pending.get(id);
      pending.delete(id);
      timer.callback();
    },
  };
}

let gameplayObjectUrl = 0;
class GameplayURL extends URL {
  static createObjectURL() {
    gameplayObjectUrl += 1;
    return `blob:public-share-${gameplayObjectUrl}`;
  }

  static revokeObjectURL() {}
}

const gameplayElementTags = {
  'dev-reset': 'button',
  'date-label': 'time',
  'help-button': 'button',
  'game-panel': 'section',
  'game-title': 'h1',
  'puzzle-content': 'div',
  'theme-color': 'meta',
  scene: 'canvas',
  'clue-row': 'div',
  'genre-hint': 'span',
  'year-hint': 'span',
  'year-clue': 'span',
  'genre-clue': 'span',
  'title-hint': 'div',
  'letter-count': 'p',
  'masked-title': 'p',
  'guess-form': 'form',
  'guess-input': 'input',
  'guess-button': 'button',
  feedback: 'p',
  'attempt-count': 'strong',
  'attempt-label': 'span',
  'hint-button': 'button',
  'reveal-button': 'button',
  'hint-text': 'p',
  result: 'section',
  'success-heading': 'h2',
  'success-score': 'div',
  'success-count': 'strong',
  'success-unit': 'span',
  'success-hint': 'p',
  'success-date': 'time',
  'answer-title': 'h2',
  'win-barcode': 'canvas',
  'share-prompt': 'p',
  'share-controls': 'div',
  'share-twitter': 'a',
  'share-instagram': 'button',
  'copy-link': 'button',
  'share-status': 'p',
  'share-note': 'p',
  'download-card': 'a',
  'share-link': 'input',
  'completion-message': 'p',
  'play-today': 'a',
  'help-dialog': 'dialog',
  'help-title': 'h2',
  'close-help': 'button',
};

async function loadPinnedGameplay({location, day, storage, shareCalls = []}) {
  const sourceIndex = await readFile(path.join(testDirectory, 'index.html'), 'utf8');
  const htmlIds = new Set([...sourceIndex.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]));
  const blobCallbacks = [];
  const document = new GameplayDocument(htmlIds, blobCallbacks);
  for (const [id, tagName] of Object.entries(gameplayElementTags)) {
    const element = tagName === 'canvas'
      ? new GameplayCanvas(document, id, blobCallbacks)
      : tagName === 'dialog'
        ? new GameplayDialog(document, id)
        : new GameplayElement(document, tagName, id);
    document.register(id, element);
  }
  document.getElementById('result').hidden = true;

  const timers = gameplayTimers();
  const clock = gameplayClock(day);
  const window = new GameplayEventTarget();
  const parsedLocation = new URL(location);
  const locationObject = {
    href: parsedLocation.href,
    search: parsedLocation.search,
    protocol: parsedLocation.protocol,
    hostname: parsedLocation.hostname,
    origin: parsedLocation.origin,
    pathname: parsedLocation.pathname,
  };
  const navigator = {
    canShare: () => true,
    share: async (payload) => { shareCalls.push(payload); },
    clipboard: null,
  };
  window.location = locationObject;
  window.localStorage = storage;
  window.navigator = navigator;
  window.scrollTo = () => {};
  const globals = {
    window,
    document,
    localStorage: storage,
    navigator,
    Date: fixedDateFor(clock),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    Blob,
    File,
    URL: GameplayURL,
    console,
  };
  const context = vm.createContext(globals);
  for (const filename of ['site-config.js', 'daily.js', 'data.js', 'game.js']) {
    const source = await readFile(path.join(testDirectory, filename), 'utf8');
    vm.runInContext(source, context, {filename});
  }
  return {
    window,
    document,
    storage,
    clock,
    timers,
    shareCalls,
    blobCallbacks,
    flushShareCallbacks() {
      while (blobCallbacks.length) blobCallbacks.shift()();
    },
  };
}

function gameplayElement(harness, id) {
  return harness.document.getElementById(id);
}

function submitGameplayGuess(harness, title) {
  const input = gameplayElement(harness, 'guess-input');
  input.value = title;
  gameplayElement(harness, 'guess-form').dispatchEvent({type: 'submit'});
}

function gameplayBarcode(harness) {
  return gameplayElement(harness, 'scene').getContext('2d').calls
    .filter((call) => call.method === 'fillRect')
    .map((call) => call.fillStyle);
}

test('pinned share pages keep the movie/date and preserve attempt and hint details in sharing', {timeout: 15_000}, async () => {
  const published = await loadPublishedModel();
  const today = '2026-10-16';
  const targetMovie = published.MOVIES[0];
  const targetId = published.LUT_DAILY.shareId(targetMovie);
  let pinnedDay;
  for (let offset = 0; offset < published.MOVIES.length; offset += 1) {
    const candidate = new Date(2026, 9, 16 - offset);
    const candidateKey = published.LUT_DAILY.dayKey(candidate);
    if (published.LUT_DAILY.movieForDay(published.MOVIES, candidateKey).id === targetMovie.id) {
      pinnedDay = candidateKey;
      break;
    }
  }
  assert.ok(pinnedDay && pinnedDay !== today);

  const location = `${published.LUT_SITE.baseUrl}play/${targetId}/?day=${pinnedDay}`;
  const storage = new GameplayStorage();
  const shareCalls = [];
  const first = await loadPinnedGameplay({location, day: pinnedDay, storage, shareCalls});
  assert.equal(gameplayElement(first, 'date-label').getAttribute('datetime'), pinnedDay);
  assert.deepEqual(gameplayBarcode(first), Array.from(targetMovie.colors));
  assert.equal(gameplayElement(first, 'play-today').hidden, true);
  assert.equal(gameplayElement(first, 'completion-message').textContent, 'Next movie tomorrow.');
  first.clock.set('2030-01-01');
  first.timers.runNext();
  assert.equal(gameplayElement(first, 'date-label').getAttribute('datetime'), pinnedDay);
  assert.deepEqual(gameplayBarcode(first), Array.from(targetMovie.colors));
  assert.equal(gameplayElement(first, 'play-today').hidden, false);
  assert.equal(gameplayElement(first, 'play-today').href, published.LUT_SITE.baseUrl);
  assert.equal(gameplayElement(first, 'completion-message').textContent, 'A new movie is waiting.');
  first.window.dispatchEvent({type: 'focus'});

  for (let wrongGuess = 1; wrongGuess <= 3; wrongGuess += 1) {
    submitGameplayGuess(first, `not ${targetMovie.title} ${wrongGuess}`);
  }
  assert.equal(gameplayElement(first, 'attempt-count').textContent, '3');
  assert.equal(gameplayElement(first, 'hint-button').disabled, false);
  gameplayElement(first, 'hint-button').click();
  submitGameplayGuess(first, targetMovie.title);
  first.flushShareCallbacks();
  const twitter = new URL(gameplayElement(first, 'share-twitter').href);
  const sharedText = twitter.searchParams.get('text');
  assert.match(sharedText, new RegExp(`lut game · ${pinnedDay}`));
  assert.match(sharedText, /Found the movie in 4 guesses/);
  assert.match(sharedText, /1 hint used/);
  for (const privateAnswer of [targetMovie.title, String(targetMovie.year), targetMovie.hint, ...targetMovie.genres]) {
    assert.equal(sharedText.includes(privateAnswer), false, `share text leaks ${privateAnswer}`);
  }

  gameplayElement(first, 'share-instagram').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shareCalls.length, 1);
  assert.match(shareCalls[0].text, /Found the movie in 4 guesses/);
  assert.match(shareCalls[0].text, /1 hint used/);
  assert.equal(shareCalls[0].url, location);
  assert.equal(shareCalls[0].files.length, 1);

  const restored = await loadPinnedGameplay({location, day: '2030-01-01', storage});
  assert.equal(gameplayElement(restored, 'date-label').getAttribute('datetime'), pinnedDay);
  assert.equal(gameplayElement(restored, 'answer-title').textContent, `${targetMovie.title} (${targetMovie.year})`);
  assert.equal(gameplayElement(restored, 'success-count').textContent, '4');
  assert.equal(gameplayElement(restored, 'success-hint').textContent, '1 hint used');
  assert.equal(gameplayElement(restored, 'genre-hint').hidden, false);
  assert.equal(gameplayElement(restored, 'year-hint').hidden, true);
  assert.deepEqual(gameplayBarcode(restored), Array.from(targetMovie.colors));
});

test('the main daily page loads the next scheduled movie after local midnight', async () => {
  const published = await loadPublishedModel();
  const day = '2026-10-16';
  const nextDay = '2026-10-17';
  const harness = await loadPinnedGameplay({
    location: published.LUT_SITE.baseUrl,
    day,
    storage: new GameplayStorage(),
  });
  const firstMovie = published.LUT_DAILY.movieForDay(published.MOVIES, day);
  const nextMovie = published.LUT_DAILY.movieForDay(published.MOVIES, nextDay);
  assert.equal(gameplayElement(harness, 'date-label').getAttribute('datetime'), day);
  assert.deepEqual(gameplayBarcode(harness), Array.from(firstMovie.colors));

  harness.clock.set(nextDay);
  harness.timers.runNext();
  assert.equal(gameplayElement(harness, 'date-label').getAttribute('datetime'), nextDay);
  assert.deepEqual(gameplayBarcode(harness), Array.from(nextMovie.colors));
  assert.notDeepEqual(gameplayBarcode(harness), Array.from(firstMovie.colors));
  assert.equal(gameplayElement(harness, 'attempt-count').textContent, '0');
  assert.equal(gameplayElement(harness, 'result').hidden, true);
  assert.equal(gameplayElement(harness, 'clue-row').hidden, true);
  assert.equal(gameplayElement(harness, 'title-hint').hidden, true);
  assert.equal(gameplayElement(harness, 'feedback').textContent, 'A new day, a new movie.');
});

test(
  'progressively reveals optional hints at cumulative guess thresholds and persists and resets them',
  {timeout: 15_000},
  async () => {
    const day = '2026-10-16';
    const location = 'http://localhost/?dev=1';
    const storage = new GameplayStorage();
    const shareCalls = [];
    const first = await loadPinnedGameplay({location, day, storage, shareCalls});
    const targetMovie = first.window.LUT_DAILY.movieForDay(first.window.MOVIES, day);
    const sceneBeforeHints = gameplayBarcode(first);

    assert.equal(gameplayElement(first, 'theme-color').getAttribute('content'), '#faf9f6');
    assert.equal(gameplayElement(first, 'clue-row').hidden, true);
    assert.equal(gameplayElement(first, 'genre-hint').hidden, true);
    assert.equal(gameplayElement(first, 'year-hint').hidden, true);
    assert.equal(gameplayElement(first, 'genre-clue').textContent, '');
    assert.equal(gameplayElement(first, 'year-clue').textContent, '');
    assert.equal(gameplayElement(first, 'hint-text').textContent, '');
    assert.equal(gameplayElement(first, 'title-hint').hidden, true);
    assert.equal(gameplayElement(first, 'letter-count').textContent, '');
    assert.equal(gameplayElement(first, 'masked-title').textContent, '');
    assert.equal(gameplayElement(first, 'hint-button').disabled, true);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'Genre hint in 3 guesses');

    // Disabled clicks, blank guesses, and punctuation-only guesses do not reveal or consume anything.
    gameplayElement(first, 'hint-button').click();
    submitGameplayGuess(first, '   ');
    submitGameplayGuess(first, '!!!');
    assert.equal(gameplayElement(first, 'attempt-count').textContent, '0');
    assert.equal(gameplayElement(first, 'clue-row').hidden, true);
    assert.equal(gameplayElement(first, 'hint-button').disabled, true);

    for (let wrongGuess = 1; wrongGuess <= 2; wrongGuess += 1) {
      submitGameplayGuess(first, `not this movie ${wrongGuess}`);
    }
    assert.equal(gameplayElement(first, 'attempt-count').textContent, '2');
    assert.equal(gameplayElement(first, 'hint-button').disabled, true);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'Genre hint in 1 guess');

    submitGameplayGuess(first, 'not this movie 3');
    assert.equal(gameplayElement(first, 'attempt-count').textContent, '3');
    assert.equal(gameplayElement(first, 'clue-row').hidden, true, 'threshold must not reveal a hint before the click');
    assert.equal(gameplayElement(first, 'hint-button').disabled, false);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'Reveal genre');
    gameplayElement(first, 'hint-button').click();
    assert.equal(gameplayElement(first, 'clue-row').hidden, false);
    assert.equal(gameplayElement(first, 'genre-hint').hidden, false);
    assert.equal(gameplayElement(first, 'genre-clue').textContent, targetMovie.genres.join(' / '));
    assert.equal(gameplayElement(first, 'year-hint').hidden, true);
    assert.equal(gameplayElement(first, 'year-clue').textContent, '');
    assert.equal(gameplayElement(first, 'hint-text').textContent, '');
    assert.equal(gameplayElement(first, 'hint-button').disabled, true);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'Year hint in 2 guesses');
    assert.deepEqual(gameplayBarcode(first), sceneBeforeHints, 'revealing genre must not repaint the barcode');

    // A disabled click cannot bypass the next cumulative threshold.
    gameplayElement(first, 'hint-button').click();
    assert.equal(gameplayElement(first, 'genre-hint').hidden, false);
    assert.equal(gameplayElement(first, 'year-hint').hidden, true);

    submitGameplayGuess(first, 'not this movie 4');
    assert.equal(gameplayElement(first, 'hint-button').disabled, true);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'Year hint in 1 guess');
    submitGameplayGuess(first, 'not this movie 5');
    assert.equal(gameplayElement(first, 'attempt-count').textContent, '5');
    assert.equal(gameplayElement(first, 'year-hint').hidden, true);
    assert.equal(gameplayElement(first, 'hint-button').disabled, false);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'Reveal year');
    gameplayElement(first, 'hint-button').click();
    assert.equal(gameplayElement(first, 'genre-clue').textContent, targetMovie.genres.join(' / '));
    assert.equal(gameplayElement(first, 'year-hint').hidden, false);
    assert.equal(gameplayElement(first, 'year-clue').textContent, String(targetMovie.year));
    assert.equal(gameplayElement(first, 'hint-text').textContent, '');
    assert.equal(gameplayElement(first, 'hint-button').disabled, true);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'Story hint in 3 guesses');
    assert.deepEqual(gameplayBarcode(first), sceneBeforeHints, 'revealing year must not repaint the barcode');

    for (let wrongGuess = 6; wrongGuess <= 7; wrongGuess += 1) {
      submitGameplayGuess(first, `not this movie ${wrongGuess}`);
    }
    assert.equal(gameplayElement(first, 'hint-button').disabled, true);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'Story hint in 1 guess');
    submitGameplayGuess(first, 'not this movie 8');
    assert.equal(gameplayElement(first, 'attempt-count').textContent, '8');
    assert.equal(gameplayElement(first, 'hint-text').textContent, '');
    assert.equal(gameplayElement(first, 'hint-button').disabled, false);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'Reveal story hint');
    gameplayElement(first, 'hint-button').click();
    assert.equal(gameplayElement(first, 'hint-text').textContent, targetMovie.hint);
    assert.equal(gameplayElement(first, 'title-hint').hidden, true, 'future title clues stay hidden until their threshold');
    assert.equal(gameplayElement(first, 'letter-count').textContent, '');
    assert.equal(gameplayElement(first, 'masked-title').textContent, '');
    assert.equal(gameplayElement(first, 'hint-button').disabled, true);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'Title shape hint in 5 guesses');
    assert.deepEqual(gameplayBarcode(first), sceneBeforeHints, 'revealing story must not repaint the barcode');

    for (let wrongGuess = 9; wrongGuess <= 12; wrongGuess += 1) {
      submitGameplayGuess(first, `not this movie ${wrongGuess}`);
    }
    assert.equal(gameplayElement(first, 'attempt-count').textContent, '12');
    assert.equal(gameplayElement(first, 'title-hint').hidden, true);
    assert.equal(gameplayElement(first, 'hint-button').disabled, true);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'Title shape hint in 1 guess');
    submitGameplayGuess(first, 'not this movie 13');
    assert.equal(gameplayElement(first, 'attempt-count').textContent, '13');
    assert.equal(gameplayElement(first, 'title-hint').hidden, true, 'the title shape still needs an explicit click');
    assert.equal(gameplayElement(first, 'letter-count').textContent, '');
    assert.equal(gameplayElement(first, 'masked-title').textContent, '');
    assert.equal(gameplayElement(first, 'hint-button').disabled, false);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'Reveal title shape');
    gameplayElement(first, 'hint-button').click();
    assert.equal(gameplayElement(first, 'title-hint').hidden, false);
    const targetLetters = Array.from(targetMovie.title).filter(char => /\p{L}/u.test(char)).length;
    const targetDigits = Array.from(targetMovie.title).filter(char => /\p{N}/u.test(char)).length;
    assert.equal(
      gameplayElement(first, 'letter-count').textContent,
      `${targetLetters} ${targetLetters === 1 ? 'letter' : 'letters'}${targetDigits ? ` · ${targetDigits} ${targetDigits === 1 ? 'digit' : 'digits'}` : ''}`,
    );
    const driveMask = gameplayElement(first, 'masked-title').textContent;
    assert.equal(driveMask, Array.from(targetMovie.title, () => '_').join('\u00a0'));
    assert.equal(driveMask.includes(targetMovie.title), false);
    assert.equal(gameplayElement(first, 'hint-button').disabled, true);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'First letter hint in 8 guesses');

    for (let wrongGuess = 14; wrongGuess <= 20; wrongGuess += 1) {
      submitGameplayGuess(first, `not this movie ${wrongGuess}`);
    }
    assert.equal(gameplayElement(first, 'attempt-count').textContent, '20');
    assert.equal(gameplayElement(first, 'masked-title').textContent, driveMask);
    assert.equal(gameplayElement(first, 'hint-button').disabled, true);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'First letter hint in 1 guess');
    submitGameplayGuess(first, 'not this movie 21');
    assert.equal(gameplayElement(first, 'attempt-count').textContent, '21');
    assert.equal(gameplayElement(first, 'masked-title').textContent, driveMask);
    assert.equal(gameplayElement(first, 'hint-button').disabled, false);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'Reveal first letter');
    gameplayElement(first, 'hint-button').click();
    assert.equal(gameplayElement(first, 'title-hint').hidden, false);
    assert.equal(
      gameplayElement(first, 'letter-count').textContent,
      `${targetLetters} ${targetLetters === 1 ? 'letter' : 'letters'}${targetDigits ? ` · ${targetDigits} ${targetDigits === 1 ? 'digit' : 'digits'}` : ''}`,
    );
    const firstAlphabetic = Array.from(targetMovie.title).find(char => /\p{L}/u.test(char));
    assert.equal(gameplayElement(first, 'masked-title').textContent, `${firstAlphabetic.toUpperCase()}${'\u00a0_'.repeat(targetMovie.title.length - 1)}`);
    assert.equal(gameplayElement(first, 'hint-text').textContent, targetMovie.hint);
    assert.equal(gameplayElement(first, 'hint-button').disabled, true);
    assert.equal(gameplayElement(first, 'hint-button').textContent, 'All hints used');
    assert.deepEqual(gameplayBarcode(first), sceneBeforeHints, 'title hints must not repaint the barcode');

    // The matching path remains generic: the actual scheduled title solves this round.
    submitGameplayGuess(first, targetMovie.title);
    first.flushShareCallbacks();
    assert.equal(gameplayElement(first, 'result').hidden, false);
    assert.equal(gameplayElement(first, 'puzzle-content').hidden, true);
    assert.equal(gameplayElement(first, 'theme-color').getAttribute('content'), '#0d1016');
    assert.equal(gameplayElement(first, 'success-count').textContent, '22');
    assert.equal(gameplayElement(first, 'success-unit').textContent, 'guesses');
    assert.equal(gameplayElement(first, 'success-hint').textContent, '5 hints used');
    const sharedText = new URL(gameplayElement(first, 'share-twitter').href).searchParams.get('text');
    assert.match(sharedText, /Found the movie in 22 guesses/);
    assert.match(sharedText, /5 hints used/);
    for (const privateAnswer of [targetMovie.title, String(targetMovie.year), targetMovie.hint, ...targetMovie.genres]) {
      assert.equal(sharedText.includes(privateAnswer), false, `share text leaks ${privateAnswer}`);
    }
    gameplayElement(first, 'share-instagram').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(shareCalls.length, 1);
    assert.match(shareCalls[0].text, /Found the movie in 22 guesses/);
    assert.match(shareCalls[0].text, /5 hints used/);
    assert.equal(shareCalls[0].files.length, 1);

    // Both the cumulative counters and the terminal result survive a reload.
    const restored = await loadPinnedGameplay({location, day, storage});
    assert.equal(gameplayElement(restored, 'success-count').textContent, '22');
    assert.equal(gameplayElement(restored, 'success-hint').textContent, '5 hints used');
    assert.equal(gameplayElement(restored, 'genre-clue').textContent, targetMovie.genres.join(' / '));
    assert.equal(gameplayElement(restored, 'year-clue').textContent, String(targetMovie.year));
    assert.equal(gameplayElement(restored, 'hint-text').textContent, '');
    assert.equal(gameplayElement(restored, 'title-hint').hidden, true);
    assert.equal(gameplayElement(restored, 'letter-count').textContent, '');
    assert.equal(gameplayElement(restored, 'masked-title').textContent, '');
    assert.deepEqual(gameplayBarcode(restored), sceneBeforeHints);

    gameplayElement(restored, 'dev-reset').click();
    assert.equal(gameplayElement(restored, 'result').hidden, true);
    assert.equal(gameplayElement(restored, 'puzzle-content').hidden, false);
    assert.equal(gameplayElement(restored, 'theme-color').getAttribute('content'), '#faf9f6');
    assert.equal(gameplayElement(restored, 'attempt-count').textContent, '0');
    assert.equal(gameplayElement(restored, 'clue-row').hidden, true);
    assert.equal(gameplayElement(restored, 'genre-clue').textContent, '');
    assert.equal(gameplayElement(restored, 'year-clue').textContent, '');
    assert.equal(gameplayElement(restored, 'hint-text').textContent, '');
    assert.equal(gameplayElement(restored, 'title-hint').hidden, true);
    assert.equal(gameplayElement(restored, 'letter-count').textContent, '');
    assert.equal(gameplayElement(restored, 'masked-title').textContent, '');
    assert.equal(gameplayElement(restored, 'hint-button').disabled, true);
    assert.equal(gameplayElement(restored, 'hint-button').textContent, 'Genre hint in 3 guesses');

    // Older saved results retain their terminal attempt count while migrating the old boolean hint flag.
    const stateKey = `lut-game:${day}`;
    storage.setItem(stateKey, JSON.stringify({
      movieId: targetMovie.id,
      attempts: 4,
      status: 'solved',
      hinted: true,
      lastGuess: 'legacy guess',
    }));
    const legacyHinted = await loadPinnedGameplay({location, day, storage});
    assert.equal(gameplayElement(legacyHinted, 'success-count').textContent, '4');
    assert.equal(gameplayElement(legacyHinted, 'success-hint').textContent, '3 hints used');
    assert.match(new URL(gameplayElement(legacyHinted, 'share-twitter').href).searchParams.get('text'), /3 hints used/);

    storage.setItem(stateKey, JSON.stringify({
      movieId: targetMovie.id,
      attempts: 2,
      status: 'solved',
      hinted: false,
      lastGuess: 'legacy guess',
    }));
    const legacyUnhinted = await loadPinnedGameplay({location, day, storage});
    assert.equal(gameplayElement(legacyUnhinted, 'success-count').textContent, '2');
    assert.equal(gameplayElement(legacyUnhinted, 'success-hint').textContent, 'No hints used');
    assert.match(new URL(gameplayElement(legacyUnhinted, 'share-twitter').href).searchParams.get('text'), /No hints used/);

    storage.setItem(stateKey, JSON.stringify({
      movieId: targetMovie.id,
      attempts: 6,
      status: 'solved',
      hintsUsed: 2,
      lastGuess: 'modern guess',
    }));
    const twoHints = await loadPinnedGameplay({location, day, storage});
    assert.equal(gameplayElement(twoHints, 'success-count').textContent, '6');
    assert.equal(gameplayElement(twoHints, 'success-hint').textContent, '2 hints used');
    assert.match(new URL(gameplayElement(twoHints, 'share-twitter').href).searchParams.get('text'), /2 hints used/);
  },
);

test('title shape and first-letter hints preserve digits punctuation and word boundaries', async () => {
  const published = await loadPublishedModel();
  const targetMovie = published.MOVIES.find(movie => movie.title === '2001: A Space Odyssey');
  assert.ok(targetMovie, 'expected a numeric and punctuated title in the published data');
  const pinnedDay = published.LUT_DAILY.recentDayForMovie(published.MOVIES, targetMovie, '2026-10-16');
  const location = `${published.LUT_SITE.baseUrl}play/${published.LUT_DAILY.shareId(targetMovie)}/?day=${pinnedDay}`;
  const harness = await loadPinnedGameplay({location, day: pinnedDay, storage: new GameplayStorage()});

  for (let wrongGuess = 1; wrongGuess <= 3; wrongGuess += 1) {
    submitGameplayGuess(harness, `not this movie ${wrongGuess}`);
  }
  gameplayElement(harness, 'hint-button').click();
  for (let wrongGuess = 4; wrongGuess <= 5; wrongGuess += 1) {
    submitGameplayGuess(harness, `not this movie ${wrongGuess}`);
  }
  gameplayElement(harness, 'hint-button').click();
  for (let wrongGuess = 6; wrongGuess <= 8; wrongGuess += 1) {
    submitGameplayGuess(harness, `not this movie ${wrongGuess}`);
  }
  gameplayElement(harness, 'hint-button').click();
  for (let wrongGuess = 9; wrongGuess <= 13; wrongGuess += 1) {
    submitGameplayGuess(harness, `not this movie ${wrongGuess}`);
  }
  assert.equal(gameplayElement(harness, 'hint-button').disabled, false);
  assert.equal(gameplayElement(harness, 'hint-button').textContent, 'Reveal title shape');
  gameplayElement(harness, 'hint-button').click();
  const titleShape = gameplayElement(harness, 'masked-title').textContent;
  const alphanumericCount = Array.from(targetMovie.title).filter(char => /[\p{L}\p{N}]/u.test(char)).length;
  const letterCount = Array.from(targetMovie.title).filter(char => /\p{L}/u.test(char)).length;
  const digitCount = Array.from(targetMovie.title).filter(char => /\p{N}/u.test(char)).length;
  assert.equal(gameplayElement(harness, 'title-hint').hidden, false);
  assert.equal(gameplayElement(harness, 'letter-count').textContent, `${letterCount} letters · ${digitCount} digits`);
  assert.equal((titleShape.match(/_/g) ?? []).length, alphanumericCount);
  assert.equal(titleShape.includes(':'), true);
  assert.equal(titleShape.includes('   '), true, 'word boundaries should remain visible');
  assert.equal(titleShape.includes('2001'), false);
  assert.equal(titleShape.includes('A Space Odyssey'), false);

  for (let wrongGuess = 14; wrongGuess <= 21; wrongGuess += 1) {
    submitGameplayGuess(harness, `not this movie ${wrongGuess}`);
  }
  gameplayElement(harness, 'hint-button').click();
  const firstLetter = gameplayElement(harness, 'masked-title').textContent;
  assert.equal(firstLetter.startsWith('_\u00a0_\u00a0_\u00a0_\u00a0:'), true, 'digits remain masked before the first alphabetic character');
  assert.equal(firstLetter.startsWith('_\u00a0_\u00a0_\u00a0_\u00a0:   A'), true);
  assert.equal((firstLetter.match(/_/g) ?? []).length, alphanumericCount - 1);
  assert.equal(firstLetter.includes('2001'), false);
  assert.equal(firstLetter.includes('A Space Odyssey'), false);
});

test('unfinished saved games cannot restore locked hints or migrate the old story flag into new hints', async () => {
  const day = '2026-10-16';
  const location = 'http://localhost/?dev=1';
  const published = await loadPublishedModel();
  const targetMovie = published.LUT_DAILY.movieForDay(published.MOVIES, day);
  for (const item of [
    {name:'old story flag before unlock',attempts:2,hinted:true,expectedHints:0},
    {name:'old story flag after unlock',attempts:12,hinted:true,expectedHints:0},
    {name:'previously migrated early story',attempts:2,hintsUsed:3,expectedHints:0},
    {name:'early story with genre and year eligible',attempts:7,hintsUsed:3,expectedHints:2},
    {name:'legitimately revealed story',attempts:8,hintsUsed:3,expectedHints:3},
  ]) {
    const storage = new GameplayStorage();
    const saved = {movieId:targetMovie.id,status:'playing',attempts:item.attempts,lastGuess:'wrong movie'};
    if ('hinted' in item) saved.hinted = item.hinted;
    else saved.hintsUsed = item.hintsUsed;
    storage.setItem(`lut-game:${day}`,JSON.stringify(saved));
    const harness = await loadPinnedGameplay({location,day,storage});
    assert.equal(gameplayElement(harness,'attempt-count').textContent,String(item.attempts),item.name);
    assert.equal(gameplayElement(harness,'hint-text').textContent,item.expectedHints >= 3 ? targetMovie.hint : '',item.name);
    assert.equal(gameplayElement(harness,'genre-hint').hidden,item.expectedHints < 1,item.name);
    assert.equal(gameplayElement(harness,'year-hint').hidden,item.expectedHints < 2,item.name);
    assert.equal(gameplayElement(harness,'masked-title').textContent,'',item.name);
    submitGameplayGuess(harness,targetMovie.title);
    assert.equal(gameplayElement(harness,'success-hint').textContent,
      item.expectedHints ? `${item.expectedHints} hints used` : 'No hints used',item.name);
  }
});

test('a hint action rechecks a newer solved result before mutating merged progress', async () => {
  const day = '2026-10-17';
  const location = 'http://localhost/?dev=1';
  const storage = new GameplayStorage();
  const firstTab = await loadPinnedGameplay({location, day, storage});
  const secondTab = await loadPinnedGameplay({location, day, storage});
  const targetMovie = firstTab.window.LUT_DAILY.movieForDay(firstTab.window.MOVIES, day);

  for (let wrongGuess = 1; wrongGuess <= 3; wrongGuess += 1) {
    submitGameplayGuess(firstTab, `not this movie ${wrongGuess}`);
  }
  assert.equal(gameplayElement(firstTab, 'hint-button').disabled, false);

  // The second tab reads and merges the first tab's attempts, then solves before the first tab's click.
  submitGameplayGuess(secondTab, targetMovie.title);
  assert.equal(gameplayElement(secondTab, 'success-count').textContent, '4');
  gameplayElement(firstTab, 'hint-button').click();
  assert.equal(gameplayElement(firstTab, 'result').hidden, false);
  assert.equal(gameplayElement(firstTab, 'success-count').textContent, '4');
  assert.equal(gameplayElement(firstTab, 'success-hint').textContent, 'No hints used');
  assert.equal(gameplayElement(firstTab, 'genre-hint').hidden, true);
});

test(
  'opens SSE with a ready event and broadcasts an atomic asset reload event',
  { timeout: 15_000 },
  async () => {
    const controller = new AbortController();
    let streamReader;
    try {
      const response = await fetch(`${baseUrl}/__dev/events`, {
        headers: { accept: 'text/event-stream' },
        signal: controller.signal,
      });
      assert.equal(response.status, 200);
      assertNoStore(response);
      assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/i);
      assert.ok(response.body, 'SSE response should expose a readable body');

      streamReader = response.body.getReader();
      const events = createSseReader(streamReader);
      assert.deepEqual(await events.next(), { event: 'ready', data: 'connected' });

      const replacementPath = fixturePath('style.css.tmp');
      const replacement = 'body { color: rgb(9, 8, 7); }\n';
      await writeFile(replacementPath, replacement);
      await rename(replacementPath, fixturePath('style.css'));

      assert.deepEqual(await events.next(10_000), { event: 'reload', data: 'style.css' });
      const changed = await responseText(`${baseUrl}/style.css`);
      assert.equal(changed.response.status, 200);
      assertNoStore(changed.response);
      assert.equal(changed.body, replacement);

      controller.abort();
      await streamReader.cancel().catch(() => {});
    } finally {
      controller.abort();
      if (streamReader) await streamReader.cancel().catch(() => {});
    }
  },
);
