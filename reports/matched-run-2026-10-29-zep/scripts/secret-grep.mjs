// Searches every file under the build dir (skipping wt/node_modules) for the Zep key values loaded
// by withkey.sh, including inside .gz files. Prints only counts, never a key or a fragment of one.
// Usage: scripts/withkey.sh node scripts/secret-grep.mjs <dir>
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = process.argv[2];
const keys = Object.entries(process.env).filter(([n, v]) => /^ZEP_API_KEY/.test(n) && v && v.length >= 16);
let files = 0, hits = 0; const hitFiles = [];
const walk = d => { for (const n of readdirSync(d)) {
  const p = join(d, n); const rel = relative(root, p);
  if (rel === join('wt', 'node_modules') || rel.startsWith(join('wt', 'node_modules') + '/')) continue;
  const st = lstatSync(p);
  if (st.isSymbolicLink()) continue;
  if (st.isDirectory()) { walk(p); continue; }
  files++;
  let buf = readFileSync(p);
  if (n.endsWith('.gz')) { try { buf = Buffer.concat([buf, gunzipSync(buf)]); } catch {} }
  let c = 0; for (const [, v] of keys) { let i = -1; while ((i = buf.indexOf(v, i + 1)) !== -1) c++; }
  if (c) { hits += c; hitFiles.push(rel); }
} };
walk(root);
console.log(`keys checked=${keys.length} files scanned=${files} matches=${hits} files with matches=${hitFiles.length}`);
if (hitFiles.length) console.log('files:', hitFiles.join(' '));
process.exit(hits ? 1 : 0);
