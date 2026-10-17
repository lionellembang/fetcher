// The code is split by the machine it runs on:
//   shared/   both machines (no hub or compute code, no npm packages but dotenv)
//   hub/      the always-on hub (Mac): may use shared/
//   compute/  the compute node (PC): may use shared/, and no npm packages, so
//             the PC needs none of the hub's (Playwright, Express, MCP SDK, …)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { builtinModules } = require('module');

const SERVER = path.join(__dirname, '..');
const RULES = {
  shared: { folders: ['shared'], packages: ['dotenv'] },
  hub: { folders: ['shared', 'hub'], packages: Object.keys(require('../package.json').dependencies) },
  compute: { folders: ['shared', 'compute'], packages: [] },
};
const builtin = (name) => name.startsWith('node:') || builtinModules.includes(name.split('/')[0]);
const packageName = (name) => (name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]);

function* sources(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* sources(p);
    else if (e.name.endsWith('.js')) yield p;
  }
}

test('shared/, hub/ and compute/ only import what their machine has', () => {
  const problems = [];
  for (const [area, rule] of Object.entries(RULES)) {
    for (const file of sources(path.join(SERVER, area))) {
      const where = path.relative(SERVER, file);
      for (const [, name] of fs.readFileSync(file, 'utf8').matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (name.startsWith('.')) {
          const target = path.relative(SERVER, path.resolve(path.dirname(file), name));
          if (target === 'package.json') continue;
          const top = target.split(path.sep)[0];
          if (!rule.folders.includes(top)) problems.push(`${where} imports ${name} (${top}/ is off limits for ${area}/)`);
        } else if (!builtin(name) && !rule.packages.includes(packageName(name))) {
          problems.push(`${where} imports the npm package ${name}`);
        }
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('every source file is in shared/, hub/ or compute/', () => {
  const loose = fs.readdirSync(SERVER).filter((f) => f.endsWith('.js'));
  assert.deepEqual(loose, [], 'entry points live in hub/ or compute/');
  assert.ok(!fs.existsSync(path.join(SERVER, 'src')), 'src/ is gone');
});
