'use strict';
/**
 * 启停助手：restart | stop | start
 * 解决 Windows 上 node 进程与 db 文件锁、端口占用的问题。
 */
const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const PORT = Number(process.env.PORT) || 5180;
const SERVER = path.join(__dirname, 'index.js');
const LOG = path.join(__dirname, '..', 'data', 'server.log');
const NODE = process.execPath;

function listeningPids() {
  try {
    const out = execSync(`netstat -ano -p tcp | findstr ":${PORT}" | findstr LISTENING`, { encoding: 'utf8' });
    return [...new Set(out.trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/).pop()))]
      .filter(Boolean);
  } catch (_) { return []; }
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function stop() {
  const pids = listeningPids();
  for (const pid of pids) {
    try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); console.log(`  已停止进程 ${pid}`); }
    catch (e) { console.log(`  停止 ${pid} 失败：${e.message}`); }
  }
  await new Promise((r) => setTimeout(r, 900));
  const left = listeningPids();
  console.log(left.length ? `  ⚠ 端口仍被占用：${left.join(',')}` : '  ✓ 端口已释放');
  return left.length === 0;
}

function start() {
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, ['--experimental-sqlite', SERVER], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, PORT: String(PORT) },
  });
  child.unref();
  console.log(`  已拉起服务（pid ${child.pid}），日志：${path.relative(path.join(__dirname, '..'), LOG)}`);
}

(async () => {
  const cmd = process.argv[2] || 'restart';
  console.log(`\n[报销系统] ${cmd} @ 127.0.0.1:${PORT}`);

  if (cmd === 'stop') { await stop(); process.exit(0); }

  await stop();
  start();

  let ok = false;
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await ping()) { ok = true; break; }
  }
  console.log(ok
    ? `  ✓ 服务就绪：http://127.0.0.1:${PORT}\n`
    : `  ✗ 启动失败，请查看 ${LOG}\n`);
  process.exit(ok ? 0 : 1);
})();