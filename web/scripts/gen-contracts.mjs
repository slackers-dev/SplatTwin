// Erzeugt src/contracts/generated.ts aus ../contracts/*.schema.json.
// Mit --check: nur pruefen, ob die Datei aktuell ist (fuer CI).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compile } from 'json-schema-to-typescript';

const root = resolve(import.meta.dirname, '../../contracts');
const out = resolve(import.meta.dirname, '../src/contracts/generated.ts');

const parts = [];
for (const file of readdirSync(root).filter((f) => f.endsWith('.schema.json')).sort()) {
  const schema = JSON.parse(readFileSync(resolve(root, file), 'utf8'));
  parts.push(await compile(schema, schema.title, { bannerComment: '', cwd: root, additionalProperties: false }));
}
const text = `// Erzeugt aus contracts/*.schema.json mit \`npm run gen:contracts\`. Nicht von Hand aendern.\n\n${parts.join('\n')}`;

if (process.argv.includes('--check')) {
  if (readFileSync(out, 'utf8') !== text) {
    console.error('src/contracts/generated.ts ist veraltet: npm run gen:contracts');
    process.exit(1);
  }
} else {
  writeFileSync(out, text);
  console.log(`geschrieben: ${out}`);
}
