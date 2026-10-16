import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync as readFileSyncLocal } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as vm from 'node:vm';
import { deflateSync } from 'node:zlib';

const scriptPath = fileURLToPath(import.meta.url);
const publicRoot = path.resolve(path.dirname(scriptPath), '..');
const distRoot = path.join(publicRoot, 'dist');

const PUBLIC_FILES = [
  'index.html',
  'style.css',
  'game.js',
  'data.js',
  'LICENSE.txt',
  'daily.js',
  'site-config.js',
];
const PREVIEW_WIDTH = 1200;
const PREVIEW_HEIGHT = 630;
const BARCODE_X = 40;
const BARCODE_Y = 110;
const BARCODE_WIDTH = 1120;
const BARCODE_HEIGHT = 410;
const BACKGROUND = [0x0d, 0x10, 0x16];
const FRAME = [0x2b, 0x31, 0x3d];
const FRAME_DARK = [0x08, 0x0b, 0x11];
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const ROOT_TITLE = 'Name the movie — lut game';
const SHARE_TITLE = 'Can you name this movie? — lut game';
const DESCRIPTION = 'A daily film guessing game: identify one movie from its chronological color barcode.';
const IMAGE_ALT = 'Color barcode for a movie guessing puzzle. The title is not shown.';
const RUNTIME_ASSETS = [
  { source: 'style.css', attribute: 'href', extension: 'css' },
  { source: 'site-config.js', attribute: 'src', extension: 'js' },
  { source: 'daily.js', attribute: 'src', extension: 'js' },
  { source: 'data.js', attribute: 'src', extension: 'js' },
  { source: 'game.js', attribute: 'src', extension: 'js' },
];
const RETAINABLE_ASSET_EXTENSIONS = new Map([
  ['style', 'css'],
  ['game', 'js'],
  ['daily', 'js'],
  ['data', 'js'],
  ['site-config', 'js'],
]);
const RETAINABLE_ASSET_PATTERN = /^([a-z-]+)\.([0-9a-f]{16})\.(css|js)$/;

function loadBrowserSources() {
  const sandbox = { window: {} };
  const context = vm.createContext(sandbox);
  for (const filename of ['site-config.js', 'daily.js', 'data.js']) {
    const source = readFileSync(path.join(publicRoot, filename));
    vm.runInContext(source, context, { filename, timeout: 1000 });
  }

  const { window } = sandbox;
  if (!window.LUT_SITE || !window.LUT_DAILY || !Array.isArray(window.MOVIES)) {
    throw new Error('Could not load site config, daily helpers, and movie data.');
  }
  return window;
}

function readFileSync(filename) {
  // The source files are local and small enough to read synchronously while
  // the VM is being prepared.
  return readFileSyncLocal(filename, 'utf8');
}

function assertSiteConfig(site) {
  if (typeof site?.baseUrl !== 'string' || !site.baseUrl.endsWith('/')) {
    throw new Error('site-config.js must provide a baseUrl ending in /.');
  }
  const url = new URL(site.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('site-config.js baseUrl must be a clean HTTPS URL.');
  }
}

function assertMovieData(movies, daily) {
  if (!movies.length) throw new Error('At least one movie is required.');

  const ids = new Set();
  const shareIds = new Map();
  for (const movie of movies) {
    if (!movie || typeof movie.id !== 'string' || ids.has(movie.id)) {
      throw new Error('Movie ids must be present and unique.');
    }
    ids.add(movie.id);
    if (!Array.isArray(movie.colors) || movie.colors.length === 0) {
      throw new Error(`Movie ${movie.id} has no color timeline.`);
    }
    for (const color of movie.colors) {
      if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
        throw new Error(`Movie ${movie.id} contains an invalid source color.`);
      }
    }
    const id = daily.shareId(movie);
    if (!/^[0-9a-f]{16}$/.test(id)) {
      throw new Error(`Movie ${movie.id} produced an invalid share id.`);
    }
    if (shareIds.has(id)) {
      throw new Error(`Share id collision between ${shareIds.get(id)} and ${movie.id}.`);
    }
    shareIds.set(id, movie.id);
  }
  return shareIds;
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function metaTag(attribute, value) {
  return `<meta ${attribute}="${escapeHtmlAttribute(value)}" />`;
}

function socialMetadata({ baseUrl, isRoot, shareId }) {
  const imageId = shareId;
  const pageUrl = isRoot ? baseUrl : `${baseUrl}play/${shareId}/`;
  const imageUrl = `${baseUrl}previews/${imageId}.png`;
  const title = isRoot ? ROOT_TITLE : SHARE_TITLE;
  return [
    metaTag('property="og:title" content', title),
    metaTag('property="og:type" content', 'website'),
    metaTag('property="og:url" content', pageUrl),
    metaTag('property="og:image" content', imageUrl),
    metaTag('property="og:image:width" content', '1200'),
    metaTag('property="og:image:height" content', '630'),
    metaTag('property="og:image:type" content', 'image/png'),
    metaTag('property="og:image:alt" content', IMAGE_ALT),
    metaTag('property="og:description" content', DESCRIPTION),
    metaTag('name="twitter:card" content', 'summary_large_image'),
    metaTag('name="twitter:title" content', title),
    metaTag('name="twitter:description" content', DESCRIPTION),
    metaTag('name="twitter:image" content', imageUrl),
    metaTag('name="twitter:image:alt" content', IMAGE_ALT),
    `<link rel="canonical" href="${escapeHtmlAttribute(pageUrl)}" />`,
  ].join('\n    ');
}

function replaceDescriptionTag(html) {
  const description = metaTag('name="description" content', DESCRIPTION);
  const pattern = /<meta\b(?=[^>]*\bname\s*=\s*["']description["'])[^>]*>/i;
  return pattern.test(html) ? html.replace(pattern, description) : html;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runtimeAssetManifest(bytesBySource) {
  return new Map(RUNTIME_ASSETS.map(({ source, extension }) => {
    const bytes = bytesBySource.get(source);
    if (!bytes) throw new Error(`Missing runtime source ${source}.`);
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    return [source, {
      bytes,
      path: `assets/${source.replace(/\.[^.]+$/, '')}.${hash}.${extension}`,
      hash,
    }];
  }));
}

async function readRetainedRuntimeAssets() {
  const retained = new Map();
  let entries;
  try {
    entries = await readdir(path.join(distRoot, 'assets'), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return retained;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = entry.name.match(RETAINABLE_ASSET_PATTERN);
    if (!match || RETAINABLE_ASSET_EXTENSIONS.get(match[1]) !== match[3]) continue;
    let bytes;
    try {
      bytes = await readFile(path.join(distRoot, 'assets', entry.name));
    } catch {
      continue;
    }
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    if (hash === match[2]) retained.set(`assets/${entry.name}`, bytes);
  }
  return retained;
}

function rewriteRuntimeAssetReferences(html, manifest) {
  let rewritten = html;
  for (const { source, attribute } of RUNTIME_ASSETS) {
    const asset = manifest.get(source);
    if (!asset) throw new Error(`Missing hashed runtime asset for ${source}.`);
    const pattern = new RegExp(
      `(\\b${attribute}\\s*=\\s*["'])(?:\\./)?${escapeRegExp(source)}(["'])`,
      'g',
    );
    rewritten = rewritten.replace(pattern, `$1${asset.path}$2`);
  }
  return rewritten;
}

function assertRuntimeAssetReferences(html, manifest) {
  for (const { source } of RUNTIME_ASSETS) {
    const asset = manifest.get(source);
    if (!asset || !html.includes(asset.path)) {
      throw new Error(`Generated HTML does not reference ${source} at its hashed path.`);
    }
    const plainReference = new RegExp(`(?:href|src)=["'](?:\\./)?${escapeRegExp(source)}["']`);
    if (plainReference.test(html)) {
      throw new Error(`Generated HTML retains an unversioned ${source} reference.`);
    }
  }
}

function buildHtml(source, { baseUrl, isRoot, shareId }) {
  const title = isRoot ? ROOT_TITLE : SHARE_TITLE;
  let html = source
    .replace(/<base\b[^>]*>\s*/gi, '')
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, `<title>${escapeHtmlAttribute(title)}</title>`);
  html = replaceDescriptionTag(html);
  html = html.replace(/<head(\s[^>]*)?>/i, (head) => {
    if (isRoot) return head;
    return `${head}\n    <base href="../../">`;
  });
  const metadata = socialMetadata({ baseUrl, isRoot, shareId });
  if (!/<\/head>/i.test(html)) throw new Error('Source index.html has no closing head tag.');
  return html.replace(/<\/head>/i, `    ${metadata}\n  </head>`);
}

function colorToRgb(color) {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

function fillRect(pixels, x, y, width, height, color) {
  const xStart = Math.max(0, x);
  const yStart = Math.max(0, y);
  const xEnd = Math.min(PREVIEW_WIDTH, x + width);
  const yEnd = Math.min(PREVIEW_HEIGHT, y + height);
  for (let row = yStart; row < yEnd; row += 1) {
    let offset = (row * PREVIEW_WIDTH + xStart) * 3;
    for (let column = xStart; column < xEnd; column += 1) {
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      offset += 3;
    }
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuffer, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), 8 + data.length);
  return chunk;
}

function encodePng(pixels) {
  const scanlines = Buffer.alloc((PREVIEW_WIDTH * 3 + 1) * PREVIEW_HEIGHT);
  const rowSize = PREVIEW_WIDTH * 3;
  for (let row = 0; row < PREVIEW_HEIGHT; row += 1) {
    const scanlineOffset = row * (rowSize + 1);
    scanlines[scanlineOffset] = 0;
    pixels.copy(scanlines, scanlineOffset + 1, row * rowSize, (row + 1) * rowSize);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(PREVIEW_WIDTH, 0);
  ihdr.writeUInt32BE(PREVIEW_HEIGHT, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const compressed = deflateSync(scanlines, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function buildPreview(movie) {
  const pixels = Buffer.alloc(PREVIEW_WIDTH * PREVIEW_HEIGHT * 3);
  fillRect(pixels, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT, BACKGROUND);

  // A quiet frame keeps the barcode legible in social-card previews without
  // putting text or other claims into the generated image.
  fillRect(pixels, 34, 102, 1132, 526 - 102, FRAME_DARK);
  fillRect(pixels, 37, 105, 1126, 420, FRAME);
  fillRect(pixels, BARCODE_X, BARCODE_Y, BARCODE_WIDTH, BARCODE_HEIGHT, FRAME_DARK);

  const colors = movie.colors.map(colorToRgb);
  for (let outputColumn = 0; outputColumn < BARCODE_WIDTH; outputColumn += 1) {
    const sourceIndex = Math.min(
      colors.length - 1,
      Math.floor((outputColumn * colors.length) / BARCODE_WIDTH),
    );
    fillRect(
      pixels,
      BARCODE_X + outputColumn,
      BARCODE_Y,
      1,
      BARCODE_HEIGHT,
      colors[sourceIndex],
    );
  }

  fillRect(pixels, BARCODE_X, BARCODE_Y - 3, BARCODE_WIDTH, 3, FRAME_DARK);
  fillRect(pixels, BARCODE_X, BARCODE_Y + BARCODE_HEIGHT, BARCODE_WIDTH, 3, FRAME_DARK);
  return encodePng(pixels);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
  return value >>> 0;
});

async function main() {
  const window = loadBrowserSources();
  const { baseUrl } = window.LUT_SITE;
  assertSiteConfig(window.LUT_SITE);
  const movies = window.MOVIES;
  const shareIds = assertMovieData(movies, window.LUT_DAILY);
  const runtimeBytes = new Map(await Promise.all(RUNTIME_ASSETS.map(async ({ source }) => [
    source,
    await readFile(path.join(publicRoot, source)),
  ])));
  const runtimeManifest = runtimeAssetManifest(runtimeBytes);
  const retainedRuntimeAssets = await readRetainedRuntimeAssets();
  const sourceIndex = await readFile(path.join(publicRoot, 'index.html'), 'utf8');
  const rootMovie = window.LUT_DAILY.movieForDay(movies, window.LUT_DAILY.dayKey(new Date())) || movies[0];
  const rootShareId = window.LUT_DAILY.shareId(rootMovie);

  await rm(distRoot, { recursive: true, force: true });
  await mkdir(path.join(distRoot, 'assets'), { recursive: true });
  await mkdir(path.join(distRoot, 'previews'), { recursive: true });
  await mkdir(path.join(distRoot, 'play'), { recursive: true });

  await Promise.all(PUBLIC_FILES.map((filename) => copyFile(
    path.join(publicRoot, filename),
    path.join(distRoot, filename),
  )));
  await writeFile(path.join(distRoot, '.nojekyll'), '');
  const assetsToWrite = new Map(retainedRuntimeAssets);
  for (const asset of runtimeManifest.values()) assetsToWrite.set(asset.path, asset.bytes);
  await Promise.all([...assetsToWrite].map(([assetPath, bytes]) => writeFile(
    path.join(distRoot, assetPath),
    bytes,
  )));

  const rootHtml = rewriteRuntimeAssetReferences(buildHtml(sourceIndex, {
    baseUrl,
    isRoot: true,
    shareId: rootShareId,
  }), runtimeManifest);
  assertRuntimeAssetReferences(rootHtml, runtimeManifest);
  await writeFile(path.join(distRoot, 'index.html'), rootHtml);

  let previewCount = 0;
  let pageCount = 0;
  for (const movie of movies) {
    const id = [...shareIds.entries()].find(([, movieId]) => movieId === movie.id)?.[0];
    if (!id) throw new Error(`Could not resolve share id for ${movie.id}.`);
    const preview = buildPreview(movie);
    await writeFile(path.join(distRoot, 'previews', `${id}.png`), preview);
    previewCount += 1;

    const pageDirectory = path.join(distRoot, 'play', id);
    await mkdir(pageDirectory, { recursive: true });
    const pageHtml = rewriteRuntimeAssetReferences(
      buildHtml(sourceIndex, { baseUrl, isRoot: false, shareId: id }),
      runtimeManifest,
    );
    assertRuntimeAssetReferences(pageHtml, runtimeManifest);
    if (!pageHtml.includes('<base href="../../">')) throw new Error(`Missing base tag for ${id}.`);
    await writeFile(path.join(pageDirectory, 'index.html'), pageHtml);
    pageCount += 1;
  }

  const rootIndex = await readFile(path.join(distRoot, 'index.html'), 'utf8');
  if (!rootIndex.includes(`property="og:url" content="${escapeHtmlAttribute(baseUrl)}"`)) {
    throw new Error('Root landing page has an invalid canonical URL.');
  }
  if (previewCount !== movies.length || pageCount !== movies.length) {
    throw new Error('Preview or landing-page count does not match movie count.');
  }
  console.log(`Built dist/ (${previewCount} previews, ${pageCount} play pages, ${runtimeManifest.size} hashed runtime assets).`);
}

await main();
