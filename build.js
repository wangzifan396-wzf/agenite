// Build a single self-contained dist/agenite.html (CSS + JS inlined) so the
// whole app can be served from one file. ESM import/export are stripped and
// the used core modules are concatenated in dependency order.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;

async function collect(entry) {
  const seen = new Set();
  const ordered = [];
  async function visit(file) {
    const abs = resolve(root, file);
    if (seen.has(abs)) return;
    seen.add(abs);
    const src = await readFile(abs, 'utf8');
    const imports = [...src.matchAll(/import\s+[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const imp of imports) {
      if (imp.startsWith('node:') || !imp.endsWith('.js')) continue;
      const rel = resolve(dirname(abs), imp).split(sep).join('/').replace(root.split(sep).join('/'), '').replace(/^\//, '');
      await visit(rel);
    }
    ordered.push({ abs, src });
  }
  await visit(entry);
  return ordered;
}

function stripModule(code) {
  code = code.replace(/^\s*import\s+[^;]*?from\s+['"][^'"]+['"];?\s*$/gm, '');
  code = code.replace(/^\s*import\s+['"][^'"]+['"];?\s*$/gm, '');
  code = code.replace(/export\s+(async\s+)?(function|const|let|class|default)/g, (_, a, b) => (a ? a + ' ' : '') + b);
  code = code.replace(/export\s*\{[^}]*\};?/g, '');
  code = code.replace(/export\s+default\s+/g, '');
  return code;
}

async function main() {
  const ordered = await collect('src/app.js');
  const js = ordered.map((o) => `/* ${o.abs.split(sep).pop()} */\n${stripModule(o.src)}`).join('\n');
  const css = await readFile(join(root, 'src/styles.css'), 'utf8');
  let html = await readFile(join(root, 'index.html'), 'utf8');

  html = html.replace(
    '<link rel="stylesheet" href="./src/styles.css" />',
    `<style>\n${css}\n</style>`
  );

  // Inline the icon and drop the manifest — a single file has no siblings.
  const icon = await readFile(join(root, 'icon.svg'), 'utf8');
  html = html
    .replace(/\s*<link rel="manifest"[^>]*>/g, '')
    .replace(
      /<link rel="icon"[^>]*>/,
      `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(icon)}" />`
    );

  // Ship a classic script, not a module: module scripts are blocked by CORS
  // when the file is opened via file://, which would break every button.
  html = html.replace(
    '<script type="module" src="./src/app.js"></script>',
    `<script>\n${js}\n</script>`
  );

  await mkdir(join(root, 'dist'), { recursive: true });
  const out = join(root, 'dist', 'agenite.html');
  await writeFile(out, html, 'utf8');
  console.log(`Built dist/agenite.html (${(html.length / 1024).toFixed(1)} KB) from ${ordered.length} modules`);
}

main().catch((e) => { console.error(e); process.exit(1); });
