'use strict';
/**
 * 零依赖 SMTP 发信（只用 node:net / node:tls）。
 * 支持 465 隐式 SSL（网易 163 / QQ / 腾讯企业邮的默认方式）与 25/587 明文直连。
 * 附件走 MIME multipart/mixed + base64，中文文件名用 RFC2231（filename*=UTF-8''…），
 * 主题与显示名用 =?UTF-8?B?…?= ，避免被对方解析成乱码。
 */
const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const CRLF = '\r\n';
/** 单封邮件的附件总大小上限（字节）——超过就报错，避免把服务拖死 */
const MAX_TOTAL = 25 * 1024 * 1024;

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }
/** 邮件头里的 UTF-8 文本编码：=?UTF-8?B?<base64>?=，长文本按 52 字节折行 */
function mimeWord(s) {
  const b = Buffer.from(String(s), 'utf8').toString('base64');
  const parts = b.match(/.{1,52}/g) || [];
  return parts.map((p) => '=?UTF-8?B?' + p + '?=').join(CRLF + ' ');
}
/** 去掉头注入风险字符 */
function safeHeader(s) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim(); }
/** RFC2231 参数值：filename*=UTF-8''<pct-encoded> */
function rfc2231(name) {
  return "UTF-8''" + encodeURIComponent(String(name)).replace(/'/g, '%27');
}
/** base64 折行（每 76 字符一行，符合 MIME 规范） */
function wrapB64(buf) {
  return buf.toString('base64').replace(/(.{76})/g, '$1' + CRLF);
}
/** 附件文件名的纯 ASCII 兜底（非 ASCII 全部替换成 _，保证老客户端也能存下文件） */
function asciiName(name) {
  const s = String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return s.trim() || 'attachment.pdf';
}

function buildMime({ from, fromName, to, subject, text, attachments }) {
  const boundary = '----=_Part_' + crypto.randomBytes(12).toString('hex');
  const head = [];
  head.push('From: ' + (fromName ? `${mimeWord(fromName)} <${safeHeader(from)}>` : safeHeader(from)));
  head.push('To: ' + safeHeader(to));
  head.push('Subject: ' + mimeWord(subject));
  head.push('Date: ' + new Date().toUTCString().replace(/GMT$/, '+0000'));
  head.push('Message-ID: <' + crypto.randomBytes(12).toString('hex') + '@renai-reimburse>');
  head.push('MIME-Version: 1.0');
  head.push('Content-Type: multipart/mixed; boundary="' + boundary + '"');
  head.push('X-Mailer: renai-reimburse (node)');

  const parts = [];
  parts.push('--' + boundary);
  parts.push('Content-Type: text/plain; charset=UTF-8');
  parts.push('Content-Transfer-Encoding: base64');
  parts.push('');
  parts.push(wrapB64(Buffer.from(String(text || ''), 'utf8')));

  for (const a of attachments || []) {
    parts.push('--' + boundary);
    parts.push(`Content-Type: ${a.contentType || 'application/pdf'}; name="${asciiName(a.filename)}"`);
    parts.push('Content-Transfer-Encoding: base64');
    parts.push(`Content-Disposition: attachment; filename="${asciiName(a.filename)}"; filename*=${rfc2231(a.filename)}`);
    parts.push('');
    parts.push(wrapB64(a.content));
  }
  parts.push('--' + boundary + '--');

  return { message: head.join(CRLF) + CRLF + CRLF + parts.join(CRLF), boundary };
}

/** 读一个完整的 SMTP 响应（支持 250-xxx / 250 xxx 多行） */
function waitResponse(state, timeoutMs) {
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(timer); state.onData = null; fn(v); };
    const timer = setTimeout(() => {
      state.onData = null;
      reject(new Error('SMTP 响应超时（' + Math.round(timeoutMs / 1000) + 's）'));
    }, timeoutMs);

    const tryParse = () => {
      const buf = state.buf;
      const end = buf.lastIndexOf('\r\n', buf.length - 1);
      if (end < 0) return false;
      const text = buf.slice(0, end).toString('utf8');
      const lines = text.split('\r\n').filter((l) => l.length > 0);
      const last = lines[lines.length - 1] || '';
      if (last.length < 4 || (last[3] !== ' ' && last[3] !== '-')) return false;
      if (last[3] !== ' ') return false; // 多行响应未结束
      state.buf = buf.slice(end + 2);
      done(resolve, { code: Number(last.slice(0, 3)), text: lines.join('\n') });
      return true;
    };

    state.onData = () => { try { tryParse(); } catch (e) { done(reject, e); } };
    tryParse();
  });
}

/**
 * 发送一封邮件。
 * cfg: { host, port, secure, user, pass, timeout }
 * msg: { from, fromName, to, subject, text, attachments:[{filename, content(Buffer), contentType}] }
 */
async function sendMail(cfg, msg) {
  const host = String(cfg.host || '').trim();
  const port = Number(cfg.port) || 465;
  const timeout = Number(cfg.timeout) || 30000;
  if (!host) throw new Error('未配置 SMTP 服务器地址');
  if (!msg.from) throw new Error('未配置发件人邮箱');
  if (!msg.to) throw new Error('未配置收件人邮箱');

  const total = (msg.attachments || []).reduce((s, a) => s + (a.content ? a.content.length : 0), 0);
  if (total > MAX_TOTAL) throw new Error(`附件合计 ${(total / 1024 / 1024).toFixed(1)} MB，超过 ${MAX_TOTAL / 1024 / 1024} MB 上限`);

  const socket = cfg.secure === false
    ? net.connect({ host, port })
    : tls.connect({ host, port, servername: host });

  const state = { buf: Buffer.alloc(0), onData: null };
  let finished = false;
  const destroy = () => { if (!finished) { finished = true; try { socket.destroy(); } catch (_) { /* ignore */ } } };

  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`连接 ${host}:${port} 超时`)), timeout);
      const ok = () => { clearTimeout(to); resolve(); };
      socket.once('error', (e) => { clearTimeout(to); reject(e); });
      socket.once(cfg.secure === false ? 'connect' : 'secureConnect', ok);
    });
    socket.on('error', () => { /* 读阶段由超时兜底，忽略迟到的 error 避免未捕获异常 */ });
    socket.setTimeout(0);
    socket.on('data', (chunk) => {
      state.buf = Buffer.concat([state.buf, chunk]);
      if (state.onData) state.onData();
    });

    const read = () => waitResponse(state, timeout);
    const cmd = async (line, expect) => {
      socket.write(line + CRLF);
      const r = await read();
      const okCodes = Array.isArray(expect) ? expect : [expect];
      if (!okCodes.includes(r.code)) throw new Error(`SMTP 指令失败 [${r.code}] ${r.text}`);
      return r;
    };

    await read();                                            // 220 服务就绪
    const ehlo = await cmd('EHLO renai-reimburse', [250]);
    const caps = ehlo.text.toUpperCase();
    if (cfg.user && cfg.pass) {
      if (caps.includes('AUTH') && caps.includes('LOGIN')) {
        await cmd('AUTH LOGIN', [334]);
        await cmd(b64(cfg.user), [334]);
        await cmd(b64(cfg.pass), [235, 503, 535]);
      } else {
        throw new Error('SMTP 服务器不支持 AUTH LOGIN，请检查主机/端口');
      }
    }
    await cmd(`MAIL FROM:<${msg.from}>`, [250, 251]);
    const rcpts = String(msg.to).split(/[;,]/).map((s) => s.trim()).filter(Boolean);
    for (const r of rcpts) await cmd(`RCPT TO:<${r}>`, [250, 251]);
    await cmd('DATA', [354]);
    const { message } = buildMime(msg);
    socket.write(message.replace(/\r?\n/g, CRLF).replace(/\r\n\./g, '\r\n..') + CRLF + '.' + CRLF);
    await read();                                            // 250 已接收
    try { await cmd('QUIT', [221, 250]); } catch (_) { /* 有些服务器不回就直接断 */ }
    destroy();
    return { ok: true, recipients: rcpts, bytes: message.length };
  } catch (e) {
    destroy();
    throw e;
  }
}

module.exports = { sendMail, buildMime };
