// Copia docs/figma-comments - Comentarios.csv a docs/data.js para que docs/index.html
// lo cargue al abrirlo con doble clic (los navegadores no dejan leer un CSV por file://).
import { readFile, writeFile } from 'node:fs/promises';

const CSV = 'docs/figma-comments - Comentarios.csv';
const OUT = 'docs/data.js';

const csv = await readFile(CSV, 'utf8');
await writeFile(OUT, `window.FIGMA_CSV = ${JSON.stringify({ name: 'figma-comments - Comentarios.csv', csv })};\n`);
console.log(`${OUT} generado desde ${CSV}`);
