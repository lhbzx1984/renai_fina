'use strict';
/**
 * AI 视觉提取队列 · 命令行入口
 *
 * 规则引擎解不出关键字段的票据自动入队（ai_status='queued'）。
 * AI 助手（我）在对话里：list 拿清单 -> Read 工具打开 abs_path 看票 -> apply 回填字段。
 * 全程本地、不使用任何付费 OCR；回填后票据仍需人工在网页点「审核通过」才计入金额。
 *
 * 用法：
 *   node server/ai_queue.js list
 *   node server/ai_queue.js view <id>          # 渲染成小预览图，供 AI 助手 Read 看图
 *   node server/ai_queue.js apply <id> --json '{"invoice_no":"...","amount":1390}'
 *   node server/ai_queue.js apply <id> --json '{...}' --force      # 覆盖已有值
 *   node server/ai_queue.js skip <id> [--reason "非发票"]
 */
const PORT = Number(process.env.PORT || 5180);
const BASE = `http://127.0.0.1:${PORT}`;

async function req(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + url, opt);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { json = { raw: text.slice(0, 300) }; }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  if (json && json.ok === false) throw new Error(json.error || '接口返回失败');
  return json;
}

function readArg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

(async () => {
  const cmd = process.argv[2] || 'list';
  try {
    if (cmd === 'list') {
      const r = await req('GET', '/api/ai/queue');
      const q = r.data.queue;
      if (!q.length) { console.log('队列为空，没有待 AI 提取的票据。'); return; }
      console.log(`待处理 ${q.length} 张：\n`);
      for (const it of q) {
        console.log(`#${it.id}  [${it.project_code || '—'}] ${it.project_name || ''}`);
        console.log(`   文件: ${it.file_name}${it.exists ? '' : '  ⚠ 原文件缺失'}`);
        console.log(`   路径: ${it.abs_path}`);
        console.log(`   已有: ${JSON.stringify(it.current)}`);
        console.log('');
      }
      return;
    }

    if (cmd === 'view') {
      const id = process.argv[3];
      if (!id) throw new Error('缺少票据 id');
      const r = await req('GET', '/api/ai/queue');
      const it = r.data.queue.find((x) => String(x.id) === String(id));
      if (!it) throw new Error(`队列中没有票据 #${id}（可能已处理）`);
      if (!it.exists) throw new Error('原文件缺失：' + it.abs_path);
      const { previewImages } = require('./lib/imgocr.js');
      const p = await previewImages(it.abs_path, { width: 1000, quality: 55 });
      if (!p.ok) throw new Error('预览失败：' + (p.reason || '') + ' ' + (p.hint || ''));
      console.log(`票据 #${id}  ${it.file_name}`);
      console.log(`项目: ${it.project_code || ''} ${it.project_name || ''}`);
      console.log(`已有字段: ${JSON.stringify(it.current)}`);
      for (const f of p.files) {
        console.log(`\n预览图: ${f}  (${Math.round(require('node:fs').statSync(f).size / 1024)} KB)`);
      }
      console.log('\n请用 Read 工具打开上面的预览图看票面，再用 apply 回填。');
      return;
    }

    if (cmd === 'apply') {
      const id = process.argv[3];
      if (!id) throw new Error('缺少票据 id');
      const rawJson = readArg('--json');
      if (!rawJson) throw new Error('缺少 --json');
      let fields;
      try { fields = JSON.parse(rawJson); } catch (e) { throw new Error('--json 不是合法 JSON: ' + e.message); }
      const r = await req('POST', `/api/ai/receipts/${id}/fields`, {
        fields,
        force: process.argv.includes('--force'),
      });
      console.log(JSON.stringify(r.data, null, 1));
      return;
    }

    if (cmd === 'skip') {
      const id = process.argv[3];
      if (!id) throw new Error('缺少票据 id');
      const r = await req('POST', `/api/ai/receipts/${id}/skip`, { reason: readArg('--reason') || '' });
      console.log(JSON.stringify(r.data, null, 1));
      return;
    }

    console.log(`未知命令：${cmd}\n用法：list | apply <id> --json '{...}' | skip <id>`);
  } catch (e) {
    console.error('失败：' + e.message);
    process.exit(1);
  }
})();
