// ── Clan Stats — build pipeline ─────────────────────────────────────────
// Concatenates all js/ modules, transpiles JSX → JS with esbuild, writes
// dist/bundle.js. Run: node build.js  (or npm run build for CSS too)
const esbuild = require('esbuild');
const fs      = require('fs');
const path    = require('path');

const JS_MODULES = [
  'helpers.js', 'components.js', 'overview.js', 'leaderboard.js',
  'players.js', 'settings.js', 'trends.js', 'heatmap.js', 'secret-keys.js', 'app.js',
];

const BASE   = __dirname;
const jsDir  = path.join(BASE, 'js');
const distDir = path.join(BASE, 'dist');

fs.mkdirSync(distDir, { recursive: true });

const source = JS_MODULES
  .map(f => fs.readFileSync(path.join(jsDir, f), 'utf8'))
  .join('\n\n');

esbuild.transform(source, {
  loader:      'jsx',
  jsx:         'transform',         // React.createElement — matches UMD React global
  jsxFactory:  'React.createElement',
  jsxFragment: 'React.Fragment',
  minify:      true,
  target:      'es2018',
  sourcemap:   false,
}).then(({ code, warnings }) => {
  fs.writeFileSync(path.join(distDir, 'bundle.js'), code);
  const kb = (code.length / 1024).toFixed(1);
  console.log(`✓ dist/bundle.js  ${kb} KB`);
  if (warnings.length) warnings.forEach(w => console.warn('  warn:', w.text));
}).catch(err => {
  console.error('Build failed:', err.message);
  process.exit(1);
});
