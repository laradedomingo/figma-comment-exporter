// Sincroniza los comentarios de uno o varios archivos de Figma con una Google Sheet.
// Cada ejecución reescribe la pestaña completa: así los hilos resueltos o borrados
// en Figma quedan reflejados sin lógica de diferencias.
import { google } from 'googleapis';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const env = process.env;
const FIGMA_TOKEN = env.FIGMA_TOKEN;
const FILE_KEYS = (env.FIGMA_FILE_KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
const FOLDER_ID = (env.FIGMA_FOLDER_ID || '').trim();
const SHEET_ID = env.SHEET_ID;
const SHEET_TAB = env.SHEET_TAB || 'Comentarios';
const SYNC_TAB = 'Sync';
const FETCH_NODE_NAMES = env.FETCH_NODE_NAMES !== 'false';
const CACHE_PATH = '.cache/node-names.json';
// LOCAL_ONLY=true: no toca Google Sheets, solo escribe el CSV que lee docs/index.html.
const LOCAL_ONLY = env.LOCAL_ONLY === 'true';
const LOCAL_CSV_PATH = 'docs/figma-comments - Comentarios.csv';
const API = 'https://api.figma.com';

const HEADER = [
  'Archivo', 'Hilo', 'Tipo', 'Estado', 'Autor', 'Mensaje',
  'Creado', 'Resuelto', 'Página', 'Capa / pantalla', 'Enlace', 'ID comentario', 'ID hilo',
];
const LAST_COLUMN = 'M'; // Columna de la última cabecera de HEADER.
const WHOLE_PAGE = '(toda la página)';

const warnings = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assertEnv() {
  const missing = [];
  if (!FIGMA_TOKEN) missing.push('FIGMA_TOKEN');
  if (!LOCAL_ONLY && !SHEET_ID) missing.push('SHEET_ID');
  if (!LOCAL_ONLY && !env.GOOGLE_SERVICE_ACCOUNT_JSON && !env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    missing.push('GOOGLE_SERVICE_ACCOUNT_JSON (o GOOGLE_SERVICE_ACCOUNT_FILE en local)');
  }
  if (!FILE_KEYS.length && !FOLDER_ID) missing.push('FIGMA_FILE_KEYS o FIGMA_FOLDER_ID');
  if (missing.length) throw new Error('Faltan variables de entorno: ' + missing.join(', '));
}

// Llamada a la REST API de Figma. Con optional=true, un fallo se registra como aviso
// y devuelve null en lugar de abortar la sincronización.
async function figma(path, { optional = false } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(API + path, { headers: { 'X-Figma-Token': FIGMA_TOKEN } });
    if (res.ok) return res.json();

    let msg;
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') || 60);
      if (wait <= 60 && attempt < 3) {
        await sleep(wait * 1000);
        continue;
      }
      const type = res.headers.get('x-figma-rate-limit-type') || '?';
      msg = `Límite de la API de Figma en ${path} (espera ${wait}s, tipo ${type})`;
    } else {
      msg = `Figma respondió ${res.status} en ${path}: ${(await res.text()).slice(0, 300)}`;
    }
    if (optional) {
      warnings.push(msg);
      console.warn(msg);
      return null;
    }
    throw new Error(msg);
  }
}

async function getFiles() {
  const files = new Map();
  if (FOLDER_ID) {
    // Carpetas (antes "proyectos"): endpoint v2, requiere el scope folders:read.
    const data = await figma(`/v2/folders/${FOLDER_ID}/files`);
    for (const f of data.files ?? []) files.set(f.key, f.name);
  }
  for (const key of FILE_KEYS) {
    if (files.has(key)) continue;
    const meta = await figma(`/v1/files/${key}/meta`, { optional: true });
    files.set(key, meta?.file?.name || key);
  }
  return [...files].map(([key, name]) => ({ key, name }));
}

// La página y el frame de cada comentario salen de endpoints con límites estrictos
// (Tier 1), así que se guardan en caché y solo se piden los node_id nuevos.
async function loadCache() {
  try {
    return JSON.parse(await readFile(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function saveCache(cache) {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache));
}

// Devuelve { node_id: { page, layer } }. Una sola petición con depth=2 trae las páginas y
// sus frames de primer nivel. Los nodos que no aparecen ahí (anidados o eliminados) se
// buscan por nombre y quedan sin página. Las entradas antiguas de la caché eran solo un
// texto (el nombre de la capa): se vuelven a resolver.
async function resolveNodeInfo(fileKey, nodeIds, cache) {
  const known = (cache[fileKey] ||= {});
  const missing = nodeIds.filter((id) => typeof known[id] !== 'object');
  if (!FETCH_NODE_NAMES || !missing.length) return known;

  const file = await figma(`/v1/files/${fileKey}?depth=2`, { optional: true });
  if (!file) return known; // Sin datos esta vez; se reintenta en la siguiente ejecución.

  const index = {};
  for (const page of file.document?.children ?? []) {
    index[page.id] = { page: page.name, layer: WHOLE_PAGE };
    for (const frame of page.children ?? []) index[frame.id] = { page: page.name, layer: frame.name };
  }

  const unindexed = [];
  for (const id of missing) {
    if (index[id]) known[id] = index[id];
    else unindexed.push(id);
  }

  for (let i = 0; i < unindexed.length; i += 50) {
    const batch = unindexed.slice(i, i + 50);
    const ids = batch.map(encodeURIComponent).join(',');
    const data = await figma(`/v1/files/${fileKey}/nodes?ids=${ids}&depth=1`, { optional: true });
    if (!data) break;
    for (const id of batch) {
      known[id] = { page: '', layer: data.nodes?.[id]?.document?.name ?? '(capa eliminada)' };
    }
  }
  return known;
}

const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 16) : '';

// Evita que un comentario que empiece por =, +, - o @ se interprete como fórmula.
const safeText = (s) => (/^[=+\-@]/.test(s) ? `'${s}` : s);

const fileLink = (fileKey) => `https://www.figma.com/design/${fileKey}`;
const nodeLink = (fileKey, nodeId) =>
  `${fileLink(fileKey)}?node-id=${encodeURIComponent(nodeId.replace(/:/g, '-'))}`;

function buildRows(file, comments, nodeInfo) {
  const threads = comments
    .filter((c) => !c.parent_id)
    .sort((a, b) => Number(a.order_id || 0) - Number(b.order_id || 0));
  const replies = comments.filter((c) => c.parent_id);

  const rows = [];
  for (const t of threads) {
    const nodeId = t.client_meta?.node_id;
    const status = t.resolved_at ? 'Resuelto' : 'Abierto';
    const info = nodeId ? nodeInfo[nodeId] : null;
    const page = nodeId ? info?.page ?? '' : '(sin página)';
    const layer = nodeId ? info?.layer ?? '' : '(sin capa)';
    const link = nodeId ? nodeLink(file.key, nodeId) : fileLink(file.key);
    const threadReplies = replies
      .filter((r) => r.parent_id === t.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));

    for (const c of [t, ...threadReplies]) {
      const isThread = c === t;
      rows.push([
        file.name,
        Number(t.order_id) || '',
        isThread ? 'Comentario' : 'Respuesta',
        status,
        c.user?.handle || '',
        safeText(c.message || ''),
        fmtDate(c.created_at),
        isThread ? fmtDate(t.resolved_at) : '',
        page,
        layer,
        link,
        c.id,
        t.id,
      ]);
    }
  }
  return rows;
}

// Mismo contenido que la pestaña, sin el apóstrofo que safeText añade para Sheets.
async function writeLocalCsv(rows) {
  const cell = (v) => {
    const t = String(v).replace(/^'(?=[=+\-@])/, '');
    return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const csv = [HEADER, ...rows].map((r) => r.map(cell).join(',')).join('\n') + '\n';
  await mkdir(dirname(LOCAL_CSV_PATH), { recursive: true });
  await writeFile(LOCAL_CSV_PATH, csv);
}

async function getSheetsClient() {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON || (await readFile(env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(raw),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function writeSheet(rows, fileCount) {
  const sheets = await getSheetsClient();

  // Crea las pestañas si no existen.
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID, fields: 'sheets.properties.title' });
  const titles = meta.data.sheets.map((s) => s.properties.title);
  const missing = [SHEET_TAB, SYNC_TAB].filter((t) => !titles.includes(t));
  if (missing.length) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) },
    });
  }

  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `'${SHEET_TAB}'!A:${LAST_COLUMN}` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${SHEET_TAB}'!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [HEADER, ...rows] },
  });

  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `'${SYNC_TAB}'!A:B` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `'${SYNC_TAB}'!A1`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [
        ['Última sincronización', fmtDate(new Date().toISOString())],
        ['Archivos', fileCount],
        ['Filas', rows.length],
        ['Avisos', warnings.join(' | ') || '—'],
      ],
    },
  });
}

async function main() {
  assertEnv();
  const files = await getFiles();
  const cache = await loadCache();

  // Primero se descarga todo; si algo falla, la hoja conserva los datos anteriores.
  const rows = [];
  for (const file of files) {
    const { comments } = await figma(`/v1/files/${file.key}/comments`);
    const nodeIds = [...new Set(comments.map((c) => c.client_meta?.node_id).filter(Boolean))];
    const nodeInfo = await resolveNodeInfo(file.key, nodeIds, cache);
    rows.push(...buildRows(file, comments, nodeInfo));
    console.log(`${file.name}: ${comments.length} comentarios`);
  }

  await saveCache(cache);
  if (LOCAL_ONLY) {
    await writeLocalCsv(rows);
    console.log(`${LOCAL_CSV_PATH}: ${rows.length} filas de ${files.length} archivo(s). La hoja no se ha modificado.`);
    return;
  }
  await writeSheet(rows, files.length);
  console.log(`Hoja actualizada: ${rows.length} filas de ${files.length} archivo(s).`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
