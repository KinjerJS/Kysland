// Vérifications rapides (CI et local) : syntaxe des scripts de l'interface, caractères de
// contrôle invisibles (un \b devenu "retour arrière" casse une regex sans erreur visible).
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
    console.error(`✗ ${path.relative(root, file)} : caractère de contrôle invisible`);
  }
}
if (failed) process.exit(1);
console.log(`✓ ${scanned.length} fichiers vérifiés`);
