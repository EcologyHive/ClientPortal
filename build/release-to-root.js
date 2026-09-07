// Copies dist/hosted/ (the built, decoupled, IP-bounded viewer - see build.js) over the repo root,
// which is what GitHub Pages actually serves at portal.ecologyhive.co.uk. Run `npm run build` first.
// The root's index.html/portal.js/etc afterwards ARE the deployed output, not source to hand-edit -
// source lives in viewer/.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HOSTED_DIR = path.join(ROOT, 'dist', 'hosted');

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copyRecursive(path.join(src, entry), path.join(dest, entry));
  } else {
    fs.copyFileSync(src, dest);
  }
}

function main() {
  if (!fs.existsSync(HOSTED_DIR)) throw new Error('dist/hosted/ is missing - run `npm run build` first.');
  for (const entry of fs.readdirSync(HOSTED_DIR)) {
    copyRecursive(path.join(HOSTED_DIR, entry), path.join(ROOT, entry));
  }
  console.log('Copied dist/hosted/ over the repo root. Review with `git status` / `git diff`, then commit and push to deploy.');
}

main();
