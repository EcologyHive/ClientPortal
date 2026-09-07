// Copies dist/offline-template.html into SurveyReview's assets/client-viewer-template.js as a
// pinned window.CLIENT_VIEWER_TEMPLATE_HTML string constant (architecture plan §4) - SurveyReview
// carries its own copy so exporting a handover never depends on portal.ecologyhive.co.uk's uptime.
// Run `npm run build` first. This is a manual sync step, not run automatically on every ClientPortal
// change - re-run it and commit both repos whenever a new viewer build should ship.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEMPLATE_PATH = path.join(ROOT, 'dist', 'offline-template.html');
// SurveyReview is a sibling checkout next to ClientPortal, same layout this build script itself
// lives in (../SurveyReview relative to this repo's root).
const TARGET_PATH = path.join(ROOT, '..', 'SurveyReview', 'assets', 'client-viewer-template.js');

function main() {
  if (!fs.existsSync(TEMPLATE_PATH)) throw new Error('dist/offline-template.html is missing - run `npm run build` first.');
  if (!fs.existsSync(path.dirname(TARGET_PATH))) {
    throw new Error(`Expected sibling checkout at ${path.dirname(TARGET_PATH)} - adjust TARGET_PATH in build/sync-to-surveyreview.js if SurveyReview lives elsewhere.`);
  }
  const html = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  const js = `window.CLIENT_VIEWER_TEMPLATE_HTML = ${JSON.stringify(html)};\n`;
  fs.writeFileSync(TARGET_PATH, js);
  console.log(`Wrote ${path.relative(path.join(ROOT, '..'), TARGET_PATH)} (${(Buffer.byteLength(js) / 1024).toFixed(0)} KB)`);
  console.log('Review and commit both repos to ship this viewer build.');
}

main();
