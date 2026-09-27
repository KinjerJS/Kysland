// Copies the page's web dependencies (dayjs, Lucide icon font) into ui/vendor.
// Runs before every build: ui/vendor isn't committed.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'ui', 'vendor');
fs.mkdirSync(out, { recursive: true });
const files = {
  'dayjs.min.js': 'node_modules/dayjs/dayjs.min.js',
  'dayjs-fr.js': 'node_modules/dayjs/locale/fr.js',
  'lucide.css': 'node_modules/lucide-static/font/lucide.css',
  'lucide.woff2': 'node_modules/lucide-static/font/lucide.woff2',
};
for (const [name, src] of Object.entries(files)) fs.copyFileSync(path.join(root, src), path.join(out, name));
console.log(`ui/vendor: ${Object.keys(files).length} files`);
