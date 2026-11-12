#!/usr/bin/env node
// Verify NetPractice exported configs (*.json at repo root) against the
// bundled offline simulator in test/ without a browser.
//
// Usage:
//   node .github/scripts/verify-configs.js --seed <N>          # check all levels with seed N
//   node .github/scripts/verify-configs.js --login <login>     # same, seed derived from login
//   node .github/scripts/verify-configs.js --search <max>      # find seeds 0..max that pass all levels
//
// The simulator randomises some addresses from hash_login(login), so an
// exported config is only valid for the login it was produced with.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SIM_DIR = path.join(ROOT, 'test', 'js');

function levelOfFile(name) {
  const m = /^level\s*(\d+)(?:\s+data)?\.json$/i.exec(name);
  return m ? parseInt(m[1], 10) : null;
}

function findConfigs() {
  const out = {};
  for (const f of fs.readdirSync(ROOT)) {
    const lvl = levelOfFile(f);
    if (lvl !== null) {
      if (out[lvl]) throw new Error(`duplicate config for level ${lvl}: ${out[lvl]} and ${f}`);
      out[lvl] = f;
    }
  }
  return out;
}

// Minimal DOM: only what show.js/sim.js need to build the board headlessly.
function makeDocument() {
  const inputs = {};
  const goalsDiv = { innerHTML: '' };
  const logsDiv = { innerHTML: '' };
  const root = {
    appendChild(el) {
      const re = /<input[^>]*\bid=(\S+)\s+value="([^"]*)"/g;
      let m;
      while ((m = re.exec(el.innerHTML || '')) !== null) inputs[m[1]] = { value: m[2] };
    },
  };
  const body = { appendChild() {}, removeChild() {} };
  return {
    inputs,
    document: {
      body,
      createElement: () => ({ style: {}, innerHTML: '', setAttribute() {}, appendChild() {} }),
      createElementNS: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      getElementById(id) {
        if (id === 'root_id') return root;
        if (id === 'goals_id') return goalsDiv;
        if (id === 'logs_id') return logsDiv;
        if (id === 'sl') return { appendChild() {}, innerHTML: '' };
        return inputs[id] || null;
      },
    },
  };
}

const SOURCES = {};
function src(file) {
  if (!SOURCES[file]) SOURCES[file] = fs.readFileSync(path.join(SIM_DIR, file), 'utf8');
  return SOURCES[file];
}

// Returns {ok, problems[], results[]} for one level with a given seed.
function runLevel(level, config, seed) {
  const { document, inputs } = makeDocument();
  const ctx = { document, console, Math, JSON, parseInt, isNaN };
  vm.createContext(ctx);
  vm.runInContext(src(`level${level}.js`), ctx);
  vm.runInContext(src('show.js'), ctx);
  vm.runInContext(src('sim.js'), ctx);
  ctx.__seed = seed;
  vm.runInContext(`
    g_my_login = 'ci';
    g_rand_prev = __seed;
    var __root = document.getElementById('root_id');
    hosts.forEach(h => show_host(__root, h));
    ifs.forEach(i => show_ifs(__root, i));
    links.forEach(l => draw_links(__root, l));
    goals.forEach(g => prep_goals(g));
  `, ctx);

  const problems = [];
  const apply = (section, key, field, prefix) => {
    const editable = vm.runInContext(
      `(${section}.find(e => e[${JSON.stringify(section === 'ifs' ? 'if' : 'rid')}] === ${JSON.stringify(key)}) || {})[${JSON.stringify(field + '_edit')}]`, ctx);
    const value = config[section]?.[key]?.[field];
    if (editable === 'true') {
      if (value === undefined) problems.push(`${section}.${key}.${field}: missing (editable field)`);
      else inputs[`${prefix}_${key}`].value = String(value);
    } else if (value !== undefined) {
      problems.push(`${section}.${key}.${field}: not editable in level ${level}`);
    }
  };
  const ifIds = vm.runInContext('ifs.map(i => i["if"])', ctx);
  const routeIds = vm.runInContext('routes.map(r => r.rid)', ctx);
  for (const k of Object.keys(config.ifs || {})) if (!ifIds.includes(k)) problems.push(`ifs.${k}: unknown interface`);
  for (const k of Object.keys(config.routes || {})) if (!routeIds.includes(k)) problems.push(`routes.${k}: unknown route`);
  for (const k of ifIds) { apply('ifs', k, 'ip', 'ip'); apply('ifs', k, 'mask', 'mask'); }
  for (const k of routeIds) { apply('routes', k, 'route', 'route'); apply('routes', k, 'gate', 'gate'); }

  const results = vm.runInContext(
    `goals.map(g => { g_sim_logs = ''; var r = sim_goal(g); return {id: g.id, status: r.status, text: r.text}; })`, ctx);
  const ok = problems.length === 0 && results.every(r => r.status === 1);
  return { ok, problems, results };
}

function hashLogin(login) {
  let seed = 0;
  for (let i = 0; i < login.length; i++) {
    if (i % 2 === 0) seed += 973 * (login.charCodeAt(i) + i);
    else seed += 5 * login.charCodeAt(i) * i;
  }
  return seed;
}

function loadConfigs() {
  const files = findConfigs();
  const configs = {};
  for (const [lvl, f] of Object.entries(files)) {
    try {
      configs[lvl] = { file: f, data: JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')) };
    } catch (e) {
      throw new Error(`${f}: invalid JSON (${e.message})`);
    }
  }
  return configs;
}

function main(argv) {
  const configs = loadConfigs();
  const levels = Object.keys(configs).map(Number).sort((a, b) => a - b);
  let failed = false;
  for (let l = 1; l <= 10; l++) if (!configs[l]) { console.error(`level ${l}: config file missing`); failed = true; }

  const opt = argv[0];
  if (opt === '--search') {
    const max = parseInt(argv[1] || '1000000', 10);
    for (let h = 0; h <= max; h++) {
      if (levels.every(l => runLevel(l, configs[l].data, l + h).ok)) console.log(`seed ${h} passes all levels`);
    }
    return failed ? 1 : 0;
  }
  let hash;
  if (opt === '--seed') hash = parseInt(argv[1], 10);
  else if (opt === '--login') hash = hashLogin(argv[1] || '');
  else if (process.env.NETPRACTICE_SEED) hash = parseInt(process.env.NETPRACTICE_SEED, 10);
  if (hash === undefined || isNaN(hash)) {
    console.error('usage: verify-configs.js --seed <N> | --login <login> | --search <max>');
    return 2;
  }
  for (const l of levels) {
    const { ok, problems, results } = runLevel(l, configs[l].data, l + hash);
    console.log(`${ok ? 'PASS' : 'FAIL'} level ${l} (${configs[l].file})`);
    for (const p of problems) console.log(`  - ${p}`);
    for (const r of results) if (r.status !== 1) console.log(`  - goal ${r.id}: ${r.text}`);
    if (!ok) failed = true;
  }
  return failed ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { runLevel, hashLogin, levelOfFile };
