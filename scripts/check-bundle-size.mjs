// Fail the build if the dashboard's entry chunk grows past its budget: the
// first paint parses all of it, so views and heavy libraries (recharts,
// markdown) belong in lazy chunks. Run after `npm run build`.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BUDGET_KB = Number(process.env.COT_ENTRY_BUDGET_KB ?? 360);
const dir = process.argv[2] ?? 'dist/assets';
const entries = readdirSync(dir).filter((f) => /^index-[\w-]+\.js$/.test(f));
if (entries.length === 0) {
  console.error(`no entry chunk (index-*.js) in ${dir}; build first`);
  process.exit(1);
}
let over = false;
for (const f of entries) {
  const kb = statSync(join(dir, f)).size / 1024;
  const ok = kb <= BUDGET_KB;
  over ||= !ok;
  console.log(`${ok ? 'ok  ' : 'OVER'} ${f} ${kb.toFixed(1)} KB (budget ${BUDGET_KB} KB)`);
}
process.exit(over ? 1 : 0);
