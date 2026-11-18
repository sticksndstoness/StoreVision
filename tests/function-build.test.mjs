// The deployable single-file function must contain exactly the tested rules (guards against forgetting `npm run build:fn`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import * as L from '../supabase/functions/team-admin/logic.mjs';
const root = new URL('..', import.meta.url);
const before = readFileSync(new URL('supabase/functions/team-admin/index.ts', root), 'utf8');
execFileSync('node', ['tools/build-function.mjs'], { cwd: root.pathname, stdio: 'pipe' });
const after = readFileSync(new URL('supabase/functions/team-admin/index.ts', root), 'utf8');
assert.equal(after, before, 'index.ts is stale: run `npm run build:fn` and commit');
// run the inlined rules for real
const start = after.indexOf('const ROLES'); const exportless = after.slice(after.indexOf('export'.length ? 'const ROLES' : ''), after.indexOf('const cors = {'));
const inlined = new Function(`${exportless}\nreturn L;`)();
const B = '11111111-1111-1111-1111-111111111111';
const input = { full_name: 'A B', email: 'a@b.co', role: 'counter', branch_id: B, password: '123456' };
assert.deepEqual(inlined.validateCreate(input), L.validateCreate(input));
assert.deepEqual(inlined.validateCreate({ ...input, role: 'manager' }), L.validateCreate({ ...input, role: 'manager' }));
const admin = { isOwner: false, memberships: [{ branch_id: B, role: 'admin', active: true }] };
assert.deepEqual(inlined.authorizeCreate(admin, { branch_id: B, role: 'admin' }), L.authorizeCreate(admin, { branch_id: B, role: 'admin' }));
assert.equal(inlined.authorizeCreate(admin, { branch_id: B, role: 'admin' }).ok, false);
console.log('ok - generated function matches the tested rules and is up to date');
