// Quick checks (CI and local): syntax of the page scripts, invisible control characters
// (a \b turned into a backspace breaks a regex without any visible error).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
let failed = 0;
const files = [
  ...fs.readdirSync(path.join(root, 'ui')).filter((f) => f.endsWith('.js')).map((f) => path.join(root, 'ui', f)),
  ...fs.readdirSync(__dirname).filter((f) => f.endsWith('.js')).map((f) => path.join(__dirname, f)),
];
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error(`✗ ${path.relative(root, file)}\n${e.stderr}`);
  }
}
const scanned = [...files, ...fs.readdirSync(path.join(root, 'src-tauri', 'src')).map((f) => path.join(root, 'src-tauri', 'src', f))];
for (const file of scanned) {
  if (/[\x00-\x08\x0e-\x1f]/.test(fs.readFileSync(file, 'utf8'))) {
    failed++;
    console.error(`✗ ${path.relative(root, file)}: invisible control character`);
  }
}
if (failed) process.exit(1);
console.log(`✓ ${scanned.length} files checked`);
