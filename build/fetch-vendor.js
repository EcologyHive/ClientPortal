// One-time developer script: downloads pinned copies of the third-party libraries the viewer uses
// (React, ReactDOM, Leaflet, Montserrat/Inter) into vendor/, so build.js can produce a hosted build
// and an offline export that reference/inline local files instead of unpkg.com/cdnjs.cloudflare.com/
// fonts.googleapis.com at runtime (architecture plan §3/§4). Re-run only when a pinned version
// changes - the fetched files are committed, not fetched at build time or runtime.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VENDOR_DIR = path.join(__dirname, '..', 'vendor');
const FONTS_DIR = path.join(VENDOR_DIR, 'fonts');

const REACT_VERSION = '18.3.1';
const LEAFLET_VERSION = '1.9.4';

const FILES = [
  {
    url: `https://unpkg.com/react@${REACT_VERSION}/umd/react.production.min.js`,
    out: 'react.production.min.js',
  },
  {
    url: `https://unpkg.com/react-dom@${REACT_VERSION}/umd/react-dom.production.min.js`,
    out: 'react-dom.production.min.js',
  },
  {
    url: `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET_VERSION}/leaflet.min.js`,
    out: 'leaflet.min.js',
  },
  {
    url: `https://cdnjs.cloudflare.com/ajax/libs/leaflet/${LEAFLET_VERSION}/leaflet.min.css`,
    out: 'leaflet.min.css',
  },
];

// Google Fonts serves different formats depending on User-Agent; a modern Chrome UA gets woff2.
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchText(url, extraHeaders) {
  const res = await fetch(url, { headers: extraHeaders });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function fetchBuffer(url, extraHeaders) {
  const res = await fetch(url, { headers: extraHeaders });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  fs.mkdirSync(FONTS_DIR, { recursive: true });

  for (const f of FILES) {
    console.log(`Fetching ${f.url}`);
    const buf = await fetchBuffer(f.url);
    fs.writeFileSync(path.join(VENDOR_DIR, f.out), buf);
    console.log(`  -> vendor/${f.out} (${buf.length} bytes)`);
  }

  // Same family/weight set as ClientPortal's own index.html <link> today.
  const cssUrl =
    'https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Inter:wght@400;500;600&display=swap';
  console.log(`Fetching ${cssUrl}`);
  const css = await fetchText(cssUrl, { 'User-Agent': CHROME_UA });

  // Google Fonts returns one @font-face block per unicode-range subset (cyrillic, greek, vietnamese,
  // latin-ext, latin, ...) for each family/weight - this app is English-only UI text, so only the
  // "latin" subset block (unicode-range starting U+0000-00FF, the basic Latin + Latin-1 Supplement
  // range) is needed. Explicitly matched rather than relying on it being the last block in the
  // response, which happens to be true today but isn't a documented guarantee.
  const blockRe = /@font-face\s*{([^}]+)}/g;
  const manifest = [];
  const savedByHash = new Map(); // content hash -> fileName already written, so a variable font
  // serving multiple discrete weights from one physical file (Montserrat/Inter both do this - see
  // below) is only saved to disk once, not once per weight.
  let m;
  while ((m = blockRe.exec(css))) {
    const block = m[1];
    const family = (/font-family:\s*'([^']+)'/.exec(block) || [])[1];
    const weight = (/font-weight:\s*(\d+)/.exec(block) || [])[1];
    const unicodeRange = (/unicode-range:\s*([^;]+);/.exec(block) || [])[1];
    const srcUrl = (/src:\s*url\(([^)]+)\)\s*format\('woff2'\)/.exec(block) || [])[1];
    if (!family || !weight || !srcUrl || !unicodeRange) continue;
    if (!unicodeRange.trim().startsWith('U+0000-00FF')) continue; // skip non-latin subsets
    console.log(`Fetching ${srcUrl}`);
    const buf = await fetchBuffer(srcUrl);
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 8);
    let fileName = savedByHash.get(hash);
    if (!fileName) {
      // Montserrat/Inter are variable fonts - Google serves the same physical woff2 for every
      // requested weight in-range, so name the file by content rather than by weight.
      fileName = `${family.toLowerCase()}-${hash}.woff2`;
      fs.writeFileSync(path.join(FONTS_DIR, fileName), buf);
      savedByHash.set(hash, fileName);
      console.log(`  -> vendor/fonts/${fileName} (${buf.length} bytes)`);
    } else {
      console.log(`  -> same file as vendor/fonts/${fileName} (already saved), reusing`);
    }
    manifest.push({ family, weight: Number(weight), fileName });
  }
  const expected = 6; // Montserrat 600/700/800 + Inter 400/500/600
  if (manifest.length !== expected) {
    throw new Error(`Expected ${expected} latin-subset font files, got ${manifest.length} - Google Fonts response shape may have changed, check build/fetch-vendor.js`);
  }

  fs.writeFileSync(path.join(FONTS_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nDone. Vendored ${FILES.length} library files and ${manifest.length} font files.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
