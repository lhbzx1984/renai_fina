'use strict';
/**
 * 发票邮件发送 —— 端到端自测（不真发信、不留痕）
 *
 * 思路：在本机起一个假 SMTP 服务器（明文端口），把邮件配置临时指向它，
 * 让系统把某个项目的 PDF 发票发出去，然后校验 SMTP 会话与 MIME 结构，
 * 最后把配置恢复原样。
 *
 * 用法： node mail_e2e.js          （服务需已在 5180 运行）
 */
const net = require('node:net');
const BASE = process.env.BASE || 'http://127.0.0.1:5180';
const PORT = 2525;

let raw = '';           // 收到的完整会话（含 DATA 正文）
let inData = false;
let authStep = 0;       // AUTH LOGIN 的两段 base64（用户名 / 密码）
let pass = 0, fail = 0;
const need = (c, m) => { if (c) pass++; else fail++; console.log((c ? '  ok   ' : '  FAIL ') + m); };

const server = net.createServer((sock) => {
  let buf = '';
  sock.write('220 fake.smtp.local ESMTP ready\r\n');
  sock.on('data', (chunk) => {
    buf += chunk.toString('binary');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') { inData = false; sock.write('250 2.0.0 Ok queued\r\n'); }
        else raw += (line.startsWith('..') ? line.slice(1) : line) + '\r\n';
        continue;
      }
      const up = line.toUpperCase();
      raw += '[C] ' + line + '\r\n';
      if (up.startsWith('EHLO')) {
        sock.write('250-fake.smtp.local\r\n250-AUTH LOGIN PLAIN\r\n250-8BITMIME\r\n250 SIZE 35882577\r\n');
      } else if (up === 'AUTH LOGIN') { authStep = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
      else if (up.startsWith('MAIL FROM')) sock.write('250 2.1.0 Ok\r\n');
      else if (up.startsWith('RCPT TO')) sock.write('250 2.1.5 Ok\r\n');
      else if (up === 'DATA') { inData = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
      else if (up === 'QUIT') { sock.write('221 2.0.0 Bye\r\n'); sock.end(); }
      else if (authStep === 1 && /^[A-Za-z0-9+/=]+$/.test(line)) { authStep = 2; sock.write('334 UGFzc3dvcmQ6\r\n'); }
      else if (authStep === 2 && /^[A-Za-z0-9+/=]+$/.test(line)) { authStep = 0; sock.write('235 2.7.0 Authentication successful\r\n'); }
      else sock.write('250 2.0.0 Ok\r\n');
    }
  });
  sock.on('error', () => { /* 忽略连接重置 */ });
});

async function put(body) {
  return (await fetch(`${BASE}/api/settings`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })).json();
}
const getJson = async (u) => (await fetch(BASE + u)).json();

/** 找一个有「已审核 PDF 票据」的真实项目来发 */
async function pickProject() {
  const ps = (await getJson('/api/projects')).data.projects || [];
  for (const p of ps) {
    if (/^(UI烟测|冒烟测试|测试)/.test(p.name || '')) continue;
    const rs = (await getJson(`/api/projects/${p.id}/receipts`)).data.receipts || [];
    const n = rs.filter((r) => r.ocr_status === 'approved'
      && (/pdf/i.test(r.mime || '') || /\.pdf$/i.test(r.file_name || ''))).length;
    if (n > 0) return { p, n };
  }
  return null;
}

async function main() {
  const target = await pickProject();
  if (!target) { console.log('没有可用于测试的项目（需含已审核的 PDF 票据）'); process.exit(2); }
  console.log(`\n=== 发票邮件发送 · 端到端自测 ===`);
  console.log(`测试项目：#${target.p.id} ${target.p.code} ${target.p.name}（已审核 PDF ${target.n} 张）`);

  const before = (await getJson('/api/mail/status')).data;
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

  try {
    await put({
      mail_to: '13752070316@fapiao56.com', mail_from: 'sender@163.com',
      mail_from_name: '天津仁爱学院报销系统', mail_smtp_host: '127.0.0.1',
      mail_smtp_port: String(PORT), mail_smtp_secure: '0',
      mail_smtp_user: 'sender@163.com', mail_smtp_pass: 'test-auth-code',
    });
    const st = (await getJson('/api/mail/status')).data;
    need(st.configured === true, '配置齐全时 configured=true');

    const res = await (await fetch(`${BASE}/api/projects/${target.p.id}/send-invoices`, { method: 'POST' })).json();
    console.log('  发送结果：' + JSON.stringify(res.data || res.error));
    need(res.ok === true, '发送成功');
    need(res.data && res.data.count === target.n, `附件数 ${res.data ? res.data.count : 0} = 已审核 PDF ${target.n}`);

    console.log('\n-- SMTP 会话 --');
    need(/\[C\] EHLO /.test(raw), 'EHLO');
    need(/\[C\] AUTH LOGIN/.test(raw), 'AUTH LOGIN 认证');
    need(/\[C\] MAIL FROM:<sender@163\.com>/.test(raw), 'MAIL FROM 正确');
    need(/\[C\] RCPT TO:<13752070316@fapiao56\.com>/.test(raw), 'RCPT TO 指向配置的收件人');
    need(/\[C\] DATA/.test(raw), '进入 DATA');

    console.log('\n-- MIME 结构 --');
    need(/Content-Type: multipart\/mixed; boundary=/.test(raw), 'multipart/mixed');
    const attaches = [...raw.matchAll(/Content-Disposition: attachment; filename="([^"]*)"; filename\*=([^\r\n]*)/g)];
    need(attaches.length === target.n, `附件 ${attaches.length} 个`);
    need([...raw.matchAll(/Content-Type: application\/pdf; name="([^"]*)"/g)].length === target.n, '附件类型 application/pdf');
    need(/filename\*=UTF-8''/.test(raw), '中文文件名用 RFC2231');

    const subjB64 = (raw.match(/Subject: ([\s\S]*?)\r\nMIME-Version/) || [])[1] || '';
    const subject = Buffer.from(subjB64.replace(/=\?UTF-8\?B\?|\?=|\r\n|\s/g, ''), 'base64').toString('utf8');
    need(/发票/.test(subject), '主题 UTF-8 base64 可解码：' + subject);
    for (const a of attaches) console.log('   · ' + decodeURIComponent(a[2].replace("UTF-8''", '')));

    const bnd = (raw.match(/boundary="([^"]+)"/) || [])[1];
    const blocks = bnd ? raw.split('--' + bnd).filter((b) => /Content-Disposition: attachment/.test(b)) : [];
    let okPdf = 0;
    for (const b of blocks) {
      const body = (b.split('\r\n\r\n')[1] || '').replace(/\r\n/g, '').replace(/^-+/, '');
      if (Buffer.from(body, 'base64').slice(0, 4).toString('latin1') === '%PDF') okPdf++;
    }
    need(okPdf === target.n, `附件 base64 解出合法 PDF 头 ${okPdf}/${target.n}`);

    const t = await (await fetch(`${BASE}/api/mail/test`, { method: 'POST' })).json();
    need(t.ok === true, '测试邮件（无附件）发送成功');
  } finally {
    // 恢复原配置：授权码清空、主机/端口/账号还原
    await put({
      mail_to: before.to, mail_from: before.from, mail_from_name: before.fromName,
      mail_smtp_host: before.host, mail_smtp_port: String(before.port),
      mail_smtp_secure: before.secure ? '1' : '0',
      mail_smtp_user: before.user, mail_smtp_pass: '__CLEAR__',
    });
    server.close();
  }

  const after = (await getJson('/api/mail/status')).data;
  need(after.passSet === before.passSet, '授权码状态已复原（不泄漏测试凭据）');
  console.log(`\n=== 结果：PASS ${pass} / FAIL ${fail} ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('异常：', e); process.exit(1); });
