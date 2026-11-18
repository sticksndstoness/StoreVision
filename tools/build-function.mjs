// Builds supabase/functions/team-admin/index.ts as ONE self-contained file (rules inlined from logic.mjs), so it can be pasted
// into the Supabase dashboard editor as well as deployed from the repo. Run: npm run build:fn   (CI fails if the output is stale)
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('..', import.meta.url);
const logic = readFileSync(new URL('supabase/functions/team-admin/logic.mjs', root), 'utf8');
const handler = readFileSync(new URL('tools/team-admin.handler.ts', root), 'utf8');
const names = [...logic.matchAll(/^export (?:const|function) (\w+)/gm)].map((m) => m[1]);
const inlined = logic.replace(/^export /gm, '') + `\nconst L = { ${names.join(', ')} };\n`;
const banner = '// @ts-nocheck\n// GENERATED FILE - do not edit. Source: tools/team-admin.handler.ts + supabase/functions/team-admin/logic.mjs (run `npm run build:fn`).\n';
if (!handler.includes('// @@LOGIC@@')) throw new Error('marker missing in handler');
writeFileSync(new URL('supabase/functions/team-admin/index.ts', root), banner + handler.replace('// @@LOGIC@@', inlined));
console.log('built supabase/functions/team-admin/index.ts (' + names.length + ' rules inlined)');
