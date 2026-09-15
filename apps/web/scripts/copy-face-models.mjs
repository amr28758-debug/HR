// Copies the browser-side face models shipped with @vladmandic/human (MIT) into public/models so the terminal pages can
// load them from our own origin (no CDN dependency, works on isolated site networks). Runs before `next dev/build`.
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const src = path.join(path.dirname(require.resolve('@vladmandic/human')), '..', 'models');
const dest = path.resolve(process.cwd(), 'public', 'models');
// Client needs detection + mesh/iris (gestures for the active liveness challenge) + antispoof/liveness for local gating.
// Embeddings (faceres) are computed server-side only — the browser never holds recognition templates.
const models = ['blazeface', 'facemesh', 'iris', 'antispoof', 'liveness'];
mkdirSync(dest, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) if (models.some((m) => f === `${m}.json` || f === `${m}.bin`)) { cpSync(path.join(src, f), path.join(dest, f)); n++; }
if (!existsSync(path.join(dest, 'blazeface.json'))) throw new Error('face models missing after copy');
console.log(`[face-models] copied ${n} files → public/models`);
