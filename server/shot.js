'use strict';
/** 界面截图：Chrome headless --screenshot，需先有演示数据 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const OUT = path.join(__dirname, '..', 'docs');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

/** 截图目标：name -> url query */
const SHOTS = {
  dashboard: 'view=dashboard',
  projects: 'view=projects',
  settings: 'view=settings',
  dictionary: 'view=dictionary',
  receipts: 'view=receipts',
  detail: 'project=20&step=members',   // 合肥培训差旅：3 成员 4 票据
  report: 'project=20&step=report',    // 差旅报表预览（11 列模板）
  receiptsStep: 'project=22&step=receipts', // 智能感知科研：2 张待审核票据
};

const requested = process.argv.slice(2);
const targets = requested.length ? requested : ['dashboard', 'projects', 'settings'];

for (const name of targets) {
  const q = SHOTS[name];
  if (!q) { console.log('SKIP 未知截图目标: ' + name); continue; }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-shot-'));
  const out = path.join(OUT, `ui-${name}.png`);
  const url = `http://127.0.0.1:5180/__shot.html?${q}`;
  try {
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      `--user-data-dir=${profile}`,
      '--window-size=1600,1100',
      '--virtual-time-budget=11000',
      `--screenshot=${out}`,
      url,
    ], { encoding: 'utf8', timeout: 90000, stdio: 'ignore' });
    console.log('OK  ' + path.basename(out) + '  ' + (fs.existsSync(out) ? fs.statSync(out).size + ' bytes' : 'MISSING'));
  } catch (e) {
    console.log('ERR ' + name + ': ' + e.message);
  }
  fs.rmSync(profile, { recursive: true, force: true });
}