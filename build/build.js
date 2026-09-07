// Produces dist/hosted/ (deployed to portal.ecologyhive.co.uk) and dist/offline-template.html (the
// pinned template SurveyReview embeds a site's data into for an export) from the same viewer/
// source - architecture plan §3. Both outputs use the identical vendored React/ReactDOM/Leaflet/
// font files (plan §2: one execution environment, not two). Run `npm run vendor` first if vendor/
// is missing or stale.
const fs = require('fs');
const path = require('path');
const { minify } = require('terser');

const ROOT = path.join(__dirname, '..');
const VIEWER_DIR = path.join(ROOT, 'viewer');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const DIST_DIR = path.join(ROOT, 'dist');

const VIEWER_SCRIPTS = ['data-model.js', 'files.js', 'map.js', 'wav.js', 'dsp.js', 'portal.js'];

function read(p) { return fs.readFileSync(p, 'utf8'); }
function readBuf(p) { return fs.readFileSync(p); }

function replaceOnce(html, needle, replacement, label) {
  const idx = html.indexOf(needle);
  if (idx === -1) throw new Error(`build.js: could not find expected block "${label}" in viewer/index.html - source template has changed shape, update build.js`);
  if (html.indexOf(needle, idx + 1) !== -1) throw new Error(`build.js: block "${label}" is not unique in viewer/index.html`);
  return html.slice(0, idx) + replacement + html.slice(idx + needle.length);
}

async function stripComments(js, label) {
  const result = await minify(js, { compress: false, mangle: false, format: { comments: false } });
  if (!result || result.error || typeof result.code !== 'string') {
    throw (result && result.error) || new Error(`Terser returned no code for ${label}`);
  }
  return result.code;
}

// Strips comments from every inline <script> in index.html itself (the window.onerror handler, the
// early <head> theme script, the theme-toggle IIFE) - the VIEWER_SCRIPTS loop above only ever
// touched the separate data-model.js/files.js/.../portal.js files, so these inline blocks were
// shipping straight through with every dev comment intact (ChatGPT review via Clara, 2026-09-08:
// found an unminified internal comment - naming Clara, quoting internal discussion, describing
// architecture - sitting in the exported HTML). External <script src="..."> tags (the vendor
// React/ReactDOM/Leaflet references, added later by the CDN-swap steps below) are left alone -
// this runs on the source template BEFORE those get inlined, so it never re-processes ~700KB of
// already-minified vendor code.
async function stripInlineScriptComments(html, label) {
  const re = /<script((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)>([\s\S]*?)<\/script>/g;
  let result = '';
  let lastIndex = 0;
  let match;
  let count = 0;
  while ((match = re.exec(html))) {
    const [full, attrs, content] = match;
    result += html.slice(lastIndex, match.index);
    if (/\bsrc=/.test(attrs) || content.trim() === '') {
      result += full;
    } else {
      const stripped = await stripComments(content, `${label} inline script #${++count}`);
      result += `<script${attrs}>${stripped}</script>`;
    }
    lastIndex = match.index + full.length;
  }
  result += html.slice(lastIndex);
  return result;
}

// Same concern as stripInlineScriptComments but for the plain CSS comments in index.html's own
// <style> blocks (only one exists today - "Same EcologyHive brand tokens..." - but stripped on
// principle so "no internal comments in the export" is actually true, not just true of <script>
// blocks). Safe as a plain regex, unlike JS: CSS has no `//`-inside-a-string-literal gotcha.
function stripStyleComments(html) {
  return html.replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/g, (full, open, content, close) => (
    open + content.replace(/\/\*[\s\S]*?\*\//g, '') + close
  ));
}

// Dormant background-image rules for Leaflet's default marker icon / layers-control toggle - never
// actually requested (the viewer only ever uses custom divIcons, never L.Icon.Default or a layers
// control) but ChatGPT's review flagged them as a residual "could this ever fire a request/produce a
// missing icon" risk for a build meant to be genuinely self-contained. Stripped rather than embedded
// as data URIs, since they're dead weight either way.
function stripDormantLeafletImageRefs(css) {
  return css.replace(/background-image:url\(images\/[^)]*\);?/g, '');
}

function fontFaceCss(manifest, urlFor) {
  return manifest
    .map(
      (f) => `@font-face {
  font-family: '${f.family}';
  font-style: normal;
  font-weight: ${f.weight};
  font-display: swap;
  src: url(${urlFor(f)}) format('woff2');
}`
    )
    .join('\n');
}

async function main() {
  if (!fs.existsSync(VENDOR_DIR)) {
    throw new Error('vendor/ is missing - run `npm run vendor` first (build/fetch-vendor.js).');
  }
  const fontManifest = JSON.parse(read(path.join(VENDOR_DIR, 'fonts', 'manifest.json')));

  const rawSourceHtml = read(path.join(VIEWER_DIR, 'index.html'));
  const viewerJs = {};
  for (const name of VIEWER_SCRIPTS) viewerJs[name] = read(path.join(VIEWER_DIR, name));

  console.log('Stripping comments from viewer scripts...');
  const strippedJs = {};
  for (const name of VIEWER_SCRIPTS) strippedJs[name] = await stripComments(viewerJs[name], name);
  const sourceHtml = stripStyleComments(await stripInlineScriptComments(rawSourceHtml, 'index.html'));

  // ---------------- dist/hosted/ ----------------
  const hostedDir = path.join(DIST_DIR, 'hosted');
  fs.rmSync(hostedDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(hostedDir, 'vendor', 'fonts'), { recursive: true });

  for (const f of ['react.production.min.js', 'react-dom.production.min.js', 'leaflet.min.js']) {
    fs.copyFileSync(path.join(VENDOR_DIR, f), path.join(hostedDir, 'vendor', f));
  }
  fs.writeFileSync(
    path.join(hostedDir, 'vendor', 'leaflet.min.css'),
    stripDormantLeafletImageRefs(read(path.join(VENDOR_DIR, 'leaflet.min.css')))
  );
  const fontFilesUsed = new Set(fontManifest.map((f) => f.fileName));
  for (const fileName of fontFilesUsed) {
    fs.copyFileSync(path.join(VENDOR_DIR, 'fonts', fileName), path.join(hostedDir, 'vendor', 'fonts', fileName));
  }
  for (const name of VIEWER_SCRIPTS) fs.writeFileSync(path.join(hostedDir, name), strippedJs[name]);
  const cnamePath = path.join(ROOT, 'CNAME');
  if (fs.existsSync(cnamePath)) fs.copyFileSync(cnamePath, path.join(hostedDir, 'CNAME'));

  let hostedHtml = sourceHtml;
  hostedHtml = replaceOnce(
    hostedHtml,
    `<!-- VENDOR:leaflet-css - build script replaces this with the pinned local/inlined copy; kept as a
     CDN link here only so \`viewer/\` runs directly during development. -->
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" />`,
    `<link rel="stylesheet" href="vendor/leaflet.min.css" />`,
    'leaflet-css'
  );
  hostedHtml = replaceOnce(
    hostedHtml,
    `<!-- VENDOR:fonts - build script replaces this with the pinned local/inlined WOFF2 copies. -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">`,
    `<style>\n${fontFaceCss(fontManifest, (f) => `vendor/fonts/${f.fileName}`)}\n</style>`,
    'fonts'
  );
  hostedHtml = replaceOnce(
    hostedHtml,
    `<!-- VENDOR:react - build script replaces these three with the pinned local/inlined copies (same
     versions for both the hosted build and the offline export - see the architecture plan §2: one
     execution environment, not two). Kept as CDN links here only so \`viewer/\` runs directly during
     development. -->
<script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin="anonymous"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" crossorigin="anonymous"></script>`,
    `<script src="vendor/react.production.min.js" crossorigin="anonymous"></script>
<script src="vendor/react-dom.production.min.js" crossorigin="anonymous"></script>
<script src="vendor/leaflet.min.js" crossorigin="anonymous"></script>`,
    'react-vendor'
  );
  // The viewer's own <script src="data-model.js">... tags need no change - dist/hosted/ ships the
  // (now comment-stripped) files at those same relative paths.
  fs.writeFileSync(path.join(hostedDir, 'index.html'), hostedHtml);
  console.log(`Wrote dist/hosted/ (${VIEWER_SCRIPTS.length} scripts + vendor assets)`);

  // ---------------- dist/offline-template.html ----------------
  let offlineHtml = sourceHtml;
  const leafletCss = stripDormantLeafletImageRefs(read(path.join(VENDOR_DIR, 'leaflet.min.css')));
  offlineHtml = replaceOnce(
    offlineHtml,
    `<!-- VENDOR:leaflet-css - build script replaces this with the pinned local/inlined copy; kept as a
     CDN link here only so \`viewer/\` runs directly during development. -->
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" />`,
    `<style>\n${leafletCss}\n</style>`,
    'leaflet-css'
  );
  const fontDataUri = (f) => {
    const buf = readBuf(path.join(VENDOR_DIR, 'fonts', f.fileName));
    return `data:font/woff2;base64,${buf.toString('base64')}`;
  };
  offlineHtml = replaceOnce(
    offlineHtml,
    `<!-- VENDOR:fonts - build script replaces this with the pinned local/inlined WOFF2 copies. -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">`,
    `<style>\n${fontFaceCss(fontManifest, fontDataUri)}\n</style>`,
    'fonts'
  );
  const reactJs = read(path.join(VENDOR_DIR, 'react.production.min.js'));
  const reactDomJs = read(path.join(VENDOR_DIR, 'react-dom.production.min.js'));
  const leafletJs = read(path.join(VENDOR_DIR, 'leaflet.min.js'));
  offlineHtml = replaceOnce(
    offlineHtml,
    `<!-- VENDOR:react - build script replaces these three with the pinned local/inlined copies (same
     versions for both the hosted build and the offline export - see the architecture plan §2: one
     execution environment, not two). Kept as CDN links here only so \`viewer/\` runs directly during
     development. -->
<script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin="anonymous"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin="anonymous"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" crossorigin="anonymous"></script>`,
    `<script>\n${reactJs}\n</script>\n<script>\n${reactDomJs}\n</script>\n<script>\n${leafletJs}\n</script>`,
    'react-vendor'
  );
  offlineHtml = replaceOnce(
    offlineHtml,
    `<!-- Deliberately trimmed, viewer-safe copies authored directly in this repo (see each file's own
     header comment and the architecture plan §1/§2) - NOT loaded live from review.ecologyhive.co.uk
     any more. Neither the hosted portal nor an offline export has any runtime dependency on
     SurveyReview's domain, repo, or uptime. -->
<script src="data-model.js"></script>
<script src="files.js"></script>
<script src="map.js"></script>
<!-- wav.js/dsp.js for sonogram viewing - portal.js calls the synchronous Dsp.computeSpectrogram
     directly (see SonogramPopup's own comment); the off-main-thread worker path is analyst-only
     tooling, deliberately excluded (see dsp.js's own header comment). -->
<script src="wav.js"></script>
<script src="dsp.js"></script>
<script src="portal.js"></script>`,
    `<script>\n${strippedJs['data-model.js']}\n</script>
<script>\n${strippedJs['files.js']}\n</script>
<script>\n${strippedJs['map.js']}\n</script>
<script>\n${strippedJs['wav.js']}\n</script>
<script>\n${strippedJs['dsp.js']}\n</script>
<!--EH_CLIENT_PRELOAD-->
<script>\n${strippedJs['portal.js']}\n</script>`,
    'viewer-scripts'
  );
  fs.mkdirSync(DIST_DIR, { recursive: true });
  fs.writeFileSync(path.join(DIST_DIR, 'offline-template.html'), offlineHtml);
  console.log(`Wrote dist/offline-template.html (${(Buffer.byteLength(offlineHtml) / 1024).toFixed(0)} KB, fully self-contained)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
