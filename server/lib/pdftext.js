'use strict';
/**
 * 零依赖 PDF 文本提取器。
 * 支持：FlateDecode（raw 与 zlib 头）、GBK-EUC-H 等双字节编码的字面串、
 * UTF-16BE hex 字符串、ToUnicode CMap（bfchar/bfrange）。
 * 不支持：加密 PDF、图片型 PDF（无文本层时返回空串，由上层回退）。
 */
const zlib = require('node:zlib');

const GBK_DECODER = (() => {
  try { return new TextDecoder('gbk'); } catch (e) { return null; }
})();

const UTF16BE_DECODER = (() => {
  try { return new TextDecoder('utf-16be'); } catch (e) { return null; }
})();

/** Buffer(latin1 字节) -> UTF-16BE 字符串 */
function decodeUtf16be(buf) {
  if (UTF16BE_DECODER) return UTF16BE_DECODER.decode(buf);
  return Buffer.from(buf).swap16().toString('utf16le');
}

function inflateAny(raw) {
  for (const fn of [zlib.inflateRawSync, zlib.inflateSync]) {
    try { return fn(raw); } catch (e) { /* try next */ }
  }
  return null;
}

/** 解压后是否像文本流：控制字符（除 \t\n\r）占比过高的（发票私有二进制数据）丢弃 */
function looksTextual(buf) {
  const n = Math.min(buf.length, 8192);
  if (!n) return false;
  let ok = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i];
    if (b === 9 || b === 10 || b === 13 || b >= 32) ok++;
  }
  return ok / n >= 0.9;
}

/** hex 转目标串：先按 UTF-16BE，出现控制字符再按单字节码回退 */
function hexToStr(hex) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  if (clean.length % 2 !== 0) return null;
  const buf = Buffer.from(clean, 'hex');
  if (clean.length % 4 === 0) {
    const u = decodeUtf16be(buf);
    if (!/[\u0001-\u001f]/.test(u)) return u;
  }
  return buf.toString('latin1');
}

/**
 * 解析嵌入 TrueType 字体（FontFile2）的 cmap 表 -> Map(gid -> unicode)。
 * 用途：开票软件生成的 subset 字体 ToUnicode 常漏映射个别字形（如 <0004>→'5'），
 * 导致发票号/日期/金额数字丢失。CIDFontType2 + CIDToGIDMap/Identity 时 CID 即 GID，
 * 可用字体自身 cmap 反查兜底。支持 format 4 与 format 12；gid 冲突取最小码位。
 */
function parseTTFcmap(buf) {
  try {
    if (!buf || buf.length < 12) return null;
    const numTables = buf.readUInt16BE(4);
    let cmapOff = -1;
    for (let i = 0; i < numTables && 12 + i * 16 + 16 <= buf.length; i++) {
      const rec = 12 + i * 16;
      if (buf.toString('latin1', rec, rec + 4) === 'cmap') { cmapOff = buf.readUInt32BE(rec + 8); break; }
    }
    if (cmapOff < 0 || cmapOff + 4 > buf.length) return null;
    const nSub = buf.readUInt16BE(cmapOff + 2);
    const subs = [];
    for (let i = 0; i < nSub && cmapOff + 4 + i * 8 + 8 <= buf.length; i++) {
      const r = cmapOff + 4 + i * 8;
      subs.push({ pid: buf.readUInt16BE(r), eid: buf.readUInt16BE(r + 2), off: cmapOff + buf.readUInt32BE(r + 4) });
    }
    const pick = (pid, eid) => subs.find(c => c.pid === pid && c.eid === eid);
    const sub = pick(3, 10) || pick(0, 6) || pick(0, 4) || pick(3, 1) || pick(0, 3) || pick(0, 1) || subs[0];
    if (!sub || sub.off + 2 > buf.length) return null;
    const rev = new Map();
    const put = (gid, cp) => {
      if (!gid || !cp) return;
      if (cp === 0xFFFD || (cp >= 0xD800 && cp <= 0xDFFF)) return;
      if ((cp >= 0xF000 && cp <= 0xF8FF) || (cp >= 0xFE00 && cp <= 0xFE0F)) return; // 私用区/变体选择符
      const cur = rev.get(gid);
      if (cur === undefined || cp < cur) rev.set(gid, cp);
    };
    const fmt = buf.readUInt16BE(sub.off);
    if (fmt === 4) {
      const segX2 = buf.readUInt16BE(sub.off + 6);
      const seg = segX2 / 2;
      if (!seg || seg > 65535) return null;
      const endOff = sub.off + 14;
      const startOff = endOff + segX2 + 2;
      const deltaOff = startOff + segX2;
      const rangeOff = deltaOff + segX2;
      for (let i = 0; i < seg; i++) {
        if (rangeOff + i * 2 + 2 > buf.length) break;
        const end = buf.readUInt16BE(endOff + i * 2);
        const start = buf.readUInt16BE(startOff + i * 2);
        const delta = buf.readInt16BE(deltaOff + i * 2);
        const ro = buf.readUInt16BE(rangeOff + i * 2);
        if (start === 0xFFFF) continue;
        for (let c = start; c <= end && c !== 0xFFFF; c++) {
          let gid;
          if (ro === 0) gid = (c + delta) & 0xFFFF;
          else {
            const gi = rangeOff + i * 2 + ro + (c - start) * 2;
            if (gi + 2 > buf.length) break;
            gid = buf.readUInt16BE(gi); // 间接寻址：读到的就是 glyph id，不加 delta
            if (!gid) continue;
          }
          put(gid, c);
        }
      }
    } else if (fmt === 12) {
      const nGroups = buf.readUInt32BE(sub.off + 12);
      for (let g = 0; g < nGroups; g++) {
        const go = sub.off + 16 + g * 12;
        if (go + 12 > buf.length) break;
        const sC = buf.readUInt32BE(go), eC = buf.readUInt32BE(go + 4), g0 = buf.readUInt32BE(go + 8);
        if (eC - sC > 65535) continue;
        for (let c = sC, gid = g0; c <= eC; c++, gid++) put(gid, c);
      }
    } else return null;
    return rev.size ? rev : null;
  } catch (e) { return null; }
}

/** 解析 ToUnicode CMap 文本 -> Map(code -> 字符串)；map.codeBytes 记录源码宽（字节）。
 *  bfchar / bfrange 必须分段解析：全局扫会把 bfchar 相邻两行误配成 bfrange（三连 hex），
 *  污染映射表 —— 数电发票 subset 字体大量使用 bfrange，此 bug 会丢数字。 */
function parseCMap(text) {
  const map = new Map();
  if (!text) return map;
  // 码宽由 codespacerange 决定（Identity-H 等为 2 字节）
  const cr = text.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>/);
  if (cr) map.codeBytes = cr[1].length / 2;
  const section = (tag) => {
    const m = text.match(new RegExp(`begin${tag}(?:[\\s\\S]*?)end${tag}`));
    return m ? m[0] : '';
  };
  // bfchar：每行 <src> <dst>
  for (const m of section('bfchar').matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
    const src = parseInt(m[1], 16);
    const val = hexToStr(m[2]);
    if (val && !map.has(src)) map.set(src, val);
  }
  // bfrange：<start> <end> <dstStart> 或 <start> <end> [<d1> <d2> ...]
  for (const m of section('bfrange').matchAll(
    /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
    const start = parseInt(m[1], 16), end = parseInt(m[2], 16);
    if (end - start > 65535) continue; // 异常范围防炸
    if (m[3] != null) {
      const base = hexToStr(m[3]);
      if (base != null) {
        let cur = base;
        for (let c = start; c <= end; c++) {
          if (!map.has(c)) map.set(c, cur);
          cur = String.fromCharCode(cur.charCodeAt(0) + 1);
        }
      }
    }
  }
  return map;
}

function decodeLiteral(bytes) {
  let hasHigh = false;
  for (const b of bytes) if (b >= 0x80) { hasHigh = true; break; }
  if (!hasHigh) return bytes.toString('latin1');
  if (GBK_DECODER) {
    try { return GBK_DECODER.decode(bytes); } catch (e) { /* fallthrough */ }
  }
  return bytes.toString('latin1');
}

/** hex 字符串解码：
 * 1) 有 CMap 时按码宽（默认 2 字节，Identity-H/Type0）分组查 ToUnicode —— 数电发票主路径；
 *    未命中的 CID 再查嵌入字体 TTF cmap 反查（subset CMap 漏映射兜底）；
 * 2) 退化为直接 UTF-16BE（简单字体直接写 Unicode）；
 * 3) 再退化为单字节逐个查 CMap（旧式 GBK-EUC-H hex 写法）。 */
function decodeHex(hex, font) {
  const cmap = font && font.cmap;
  const ttf = font && font.ttf;
  const clean = hex.replace(/[^0-9A-Fa-f]/g, '');
  if (!clean) return '';
  if ((cmap && cmap.size) || ttf) {
    const step = ((cmap && cmap.codeBytes) || 2) * 2;
    if (clean.length % step === 0) {
      let out = '';
      let miss = 0;
      for (let i = 0; i < clean.length; i += step) {
        const cid = parseInt(clean.slice(i, i + step), 16);
        const ch = (cmap && cmap.get(cid)) || (ttf && ttf.get(cid)) || '';
        if (!ch) miss++;
        out += ch;
      }
      if (out.replace(/\s/g, '') && miss < out.length) return out;
    }
  }
  if (clean.length % 4 === 0) {
    const u = decodeUtf16be(Buffer.from(clean, 'hex'));
    if (!/[\u0000-\u0008\u000e-\u001f]/.test(u)) return u;
  }
  let out = '';
  if (clean.length % 2 === 0) {
    for (let i = 0; i + 1 < clean.length; i += 2) {
      const code = parseInt(clean.slice(i, i + 2), 16);
      out += (cmap && cmap.get(code)) || (ttf && ttf.get(code)) || '';
    }
  }
  return out || decodeUtf16be(Buffer.from(clean, 'hex'));
}

/** 展开对象流（/Type/ObjStm）：把内部对象 {num, body(Buffer)} 收集到 out */
function expandObjStm(dict, inf, out) {
  const nM = /\/N\s+(\d+)/.exec(dict);
  const fM = /\/First\s+(\d+)/.exec(dict);
  if (!nM || !fM) return;
  const first = +fM[1];
  const head = inf.slice(0, first).toString('latin1').trim().split(/\s+/);
  const entries = [];
  for (let i = 0; i + 1 < head.length && entries.length < +nM[1]; i += 2) {
    entries.push([+head[i], +head[i + 1]]);
  }
  const sorted = entries.map((e) => e[1]).sort((a, b) => a - b);
  for (const [num, off] of entries) {
    const idx = sorted.indexOf(off);
    const end = idx + 1 < sorted.length ? first + sorted[idx + 1] : inf.length;
    if (end > first + off) out.push({ num, body: inf.slice(first + off, end) });
  }
}

/**
 * 建立字体名 -> 字体信息 { cmap, ucs2 } 映射。
 * - cmap 来自 /ToUnicode（CID 字体 2 字节码，简单字体 1 字节码）
 * - ucs2：Encoding 名为 *-UCS2-*（如 UniGB-UCS2-H）且无 ToUnicode 时，
 *   文本串本身就是 UTF-16BE 的 Unicode，直接解码即可（数电发票常用 STSong-Light）
 * 扫全部字典（顶层 + ObjStm 内），按 /Font<<名字 引用>> 关联资源名。
 */
function buildFontCmaps(numDicts, streamTexts, fontFiles) {
  const byRef = new Map(); // 字体对象号 -> { cmap, ucs2, ttf }
  const merged = new Map(); // 全局兜底 cmap
  // 字体描述符对象号 -> 嵌入 TTF 的 gid->unicode 反查表（subset ToUnicode 漏映射时兜底）
  const descTtf = new Map();
  for (const [num, d] of numDicts) {
    const ff = /\/FontFile2?\s+(\d+)\s+0\s+R/.exec(d);
    if (ff && fontFiles) {
      const ttf = parseTTFcmap(fontFiles.get(+ff[1]));
      if (ttf) descTtf.set(num, ttf);
    }
  }
  const ttfOf = (d) => {
    const dm = /\/FontDescriptor\s+(\d+)\s+0\s+R/.exec(d);
    if (dm && descTtf.has(+dm[1])) return descTtf.get(+dm[1]);
    for (const df of d.matchAll(/\/DescendantFonts\s*\[\s*(\d+)\s+0\s+R/g)) {
      const sub = numDicts.get(+df[1]);
      if (!sub) continue;
      const dm2 = /\/FontDescriptor\s+(\d+)\s+0\s+R/.exec(sub);
      if (dm2 && descTtf.has(+dm2[1])) return descTtf.get(+dm2[1]);
      const ff2 = /\/FontFile2\s+(\d+)\s+0\s+R/.exec(sub);
      if (ff2 && descTtf.has(+ff2[1])) return descTtf.get(+ff2[1]);
    }
    return null;
  };
  for (const [num, d] of numDicts) {
    if (!/\/Type\s*\/Font\b/.test(d)) continue;
    const encM = /\/Encoding\s*\/([A-Za-z0-9\-]+)/.exec(d);
    const ucs2 = !!encM && /UCS2/i.test(encM[1]);
    let cmap = null;
    const to = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(d);
    if (to) {
      const cmapText = streamTexts.get(+to[1]);
      if (cmapText && /beginbfchar|beginbfrange/.test(cmapText)) cmap = parseCMap(cmapText);
    }
    const ttf = ttfOf(d);
    if (!cmap && !ucs2 && !ttf) continue; // 三者皆无：按编码原样输出
    const info = { cmap: cmap || new Map(), ucs2, ttf };
    if (cmap) {
      for (const [k, v] of cmap) if (!merged.has(k)) merged.set(k, v);
      if (cmap.codeBytes && !merged.codeBytes) merged.codeBytes = cmap.codeBytes;
    }
    byRef.set(num, info);
  }
  const byName = new Map();
  for (const [, d] of numDicts) {
    for (const fm of d.matchAll(/\/Font\s*<<[\s\S]{0,600}?>>/g)) {
      for (const nm of fm[0].matchAll(/\/(\w+)\s+(\d+)\s+0\s+R/g)) {
        const info = byRef.get(+nm[2]);
        if (info && !byName.has(nm[1])) byName.set(nm[1], info);
      }
    }
  }
  return { byName, merged };
}

/** 字面串按当前字体解码：UCS2 走 UTF-16BE；单字节码简单字体逐字节查 ToUnicode */
function decodeLiteralByFont(bytes, font) {
  if (font && font.ucs2 && bytes.length >= 2 && bytes.length % 2 === 0) {
    return decodeUtf16be(bytes);
  }
  const cmap = font && font.cmap;
  const ttf = font && font.ttf;
  if ((cmap && cmap.size && (cmap.codeBytes || 2) === 1) || (ttf && bytes.length === 1)) {
    let out = '';
    for (const b of bytes) out += (cmap && cmap.get(b)) || (ttf && ttf.get(b)) || '';
    if (out.replace(/\s/g, '')) return out;
  }
  return decodeLiteral(bytes);
}

/** 提取 PDF 全部可读文本（按内容流顺序拼接，Td/TD/T* 视为换行） */
function extractPdfText(buf) {
  if (!buf || buf.length < 8 || buf.toString('latin1', 0, 5) !== '%PDF-') return '';
  const s = buf.toString('latin1');

  // 1) 顺序扫描对象，解压收集流内容（跳过伪 obj / 图片 / XML / 附件流；展开 ObjStm）
  const streamTexts = new Map(); // 对象号 -> 解压文本（含 CMap 流）
  const fontFiles = new Map();   // 对象号 -> 嵌入字体二进制（FontFile/FontFile2）
  const objStmObjs = []; // 对象流内部对象 [{num, body}]
  const numDicts = new Map(); // 对象号 -> 字典文本（顶层 + ObjStm 内）
  let lastEnd = 0;
  for (const m of s.matchAll(/(\d+)\s+\d+\s+obj\b/g)) {
    if (m.index < lastEnd) continue; // 跳过落在二进制流数据里的伪 obj
    const cs = s.indexOf('obj', m.index) + 3;
    lastEnd = s.indexOf('endobj', cs);
    if (lastEnd < 0) lastEnd = s.length;
    const si = s.indexOf('stream', cs);
    if (si < 0 || si > lastEnd) {
      numDicts.set(+m[1], s.slice(cs, lastEnd)); // 无流对象：字典本身就是全部
      continue;
    }
    const dict = s.slice(cs, si);
    numDicts.set(+m[1], dict);
    if (/\/Subtype\s*\/(?:XML|Image|EmbeddedFile)/.test(dict)) continue;
    let d0 = si + 6; if (s[d0] === '\r') d0++; if (s[d0] === '\n') d0++;
    const d1 = s.indexOf('endstream', d0);
    if (d1 < 0 || d1 > lastEnd) continue;
    let content = null;
    if (/FlateDecode/.test(dict)) {
      content = inflateAny(Buffer.from(s.slice(d0, d1), 'latin1'));
      if (!content) continue;
    } else if (/\/Filter/.test(dict)) {
      continue; // 其他滤镜（DCTDecode 等图片流）跳过
    } else {
      content = Buffer.from(s.slice(d0, d1), 'latin1'); // 未压缩流
    }
    if (/\/Type\s*\/ObjStm\b/.test(dict)) {
      expandObjStm(dict, content, objStmObjs);
      continue;
    }
    if (/\/Length1\b/.test(dict) && !/\/Subtype\s*\/(?:XML|Image)/.test(dict)) {
      fontFiles.set(+m[1], content); // 嵌入字体（FontFile/FontFile2 特征 /Length1）
      continue;
    }
    // 二进制流（发票私有数据等）过滤：解压后控制字符占比过高则非文本流。
    // 但仍收集起来 —— 有的开票软件 FontFile2 连 /Length1 都不写，只能从「非文本」里捞
    if (!looksTextual(content)) {
      fontFiles.set(+m[1], content);
      continue;
    }
    streamTexts.set(+m[1], content.toString('latin1'));
  }
  for (const { num, body } of objStmObjs) numDicts.set(num, body.toString('latin1'));

  // 2) 建立字体名 -> ToUnicode CMap 映射（多字体不合并，避免 CID 冲突错字）
  const { byName, merged } = buildFontCmaps(numDicts, streamTexts, fontFiles);

  // 3) 内容流文本提取（跟踪 Tf 切换当前字体；Td/TD/T* 视为换行）
  let full = '';
  for (const [, t] of streamTexts) {
    if (!/TJ|Tj/.test(t) || /beginbfchar|beginbfrange|begincmap/.test(t)) continue;

    // Tm 绝对定位：y 变化 -> 换行；y 相同 -> 空格分隔（数电发票逐块定位，字段间必须有间隔）
    const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]{2,}>|\bTJ\b|\bTj\b|\bT\*\b|\bTd\b|\bTD\b|\/(\w+)\s+[\d.]+\s+Tf|(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+Tm/g;
    let mm;
    let curFont = { cmap: merged, ucs2: false };
    let prevY = null;
    while ((mm = re.exec(t))) {
      const tok = mm[0];
      if (mm[1]) { curFont = byName.get(mm[1]) || { cmap: merged, ucs2: false }; continue; }
      if (mm[2] !== undefined) {
        // 1 0 0 1 0 0 Tm 是复位矩阵，不参与排版判断
        if (!(mm[2] === '1' && mm[3] === '0' && mm[4] === '0' && mm[5] === '1' && mm[6] === '0' && mm[7] === '0')) {
          const y = parseFloat(mm[7]);
          if (prevY !== null) full += (Math.abs(y - prevY) > 0.6 ? '\n' : ' ');
          prevY = y;
        }
        continue;
      }
      if (tok[0] === '(') {
        const inner = tok.slice(1, -1);
        const bytes = [];
        for (let i = 0; i < inner.length; i++) {
          const ch = inner[i];
          if (ch === '\\' && i + 1 < inner.length) {
            const n = inner[++i];
            if (n >= '0' && n <= '7') {
              const oct = inner.slice(i).match(/^[0-7]{1,3}/)[0];
              bytes.push(parseInt(oct, 8));
              i += oct.length - 1;
            } else bytes.push({ n: 10, r: 13, t: 9, b: 8, f: 12 }[n] ?? n.charCodeAt(0));
          } else bytes.push(ch.charCodeAt(0) & 0xFF);
        }
        full += decodeLiteralByFont(Buffer.from(bytes), curFont);
      } else if (tok[0] === '<') {
        full += decodeHex(tok.slice(1, -1), curFont);
      } else if (tok === 'T*' || tok === 'TD' || tok === 'Td') {
        full += '\n';
      }
    }
    full += '\n';
  }
  return full.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 数电发票元数据兜底：开票软件（GP/KT）把结构化字段写在 ObjStm 内的私有对象里。
 * 返回 { invoice_no, amount, invoice_date, buyer_no, seller_no }（缺失项为 null）。
 */
function extractPdfInvoiceMeta(buf) {
  const out = { invoice_no: null, amount: null, invoice_date: null, buyer_no: null, seller_no: null };
  if (!buf || buf.length < 8 || buf.toString('latin1', 0, 5) !== '%PDF-') return out;
  const s = buf.toString('latin1');
  let lastEnd = 0;
  for (const m of s.matchAll(/(\d+)\s+\d+\s+obj\b/g)) {
    if (m.index < lastEnd) continue;
    const cs = s.indexOf('obj', m.index) + 3;
    lastEnd = s.indexOf('endobj', cs);
    if (lastEnd < 0) lastEnd = s.length;
    if (!/\/Type\s*\/ObjStm\b/.test(s.slice(cs, lastEnd))) continue;
    const si = s.indexOf('stream', cs);
    if (si < 0 || si > lastEnd) continue;
    let d0 = si + 6; if (s[d0] === '\r') d0++; if (s[d0] === '\n') d0++;
    const d1 = s.indexOf('endstream', d0);
    if (d1 < 0 || d1 > lastEnd) continue;
    const dict = s.slice(cs, si);
    const inf = inflateAny(Buffer.from(s.slice(d0, d1), 'latin1'));
    if (!inf) continue;
    const bodies = [];
    expandObjStm(dict, inf, bodies);
    for (const { body } of bodies) {
      const t = body.toString('latin1');
      if (!/InvoiceNumber|TotalTax-includedAmount|IssueTime/.test(t)) continue;
      let mm = t.match(/InvoiceNumber\((\d{8,20})\)/);
      if (mm && !out.invoice_no) out.invoice_no = mm[1];
      mm = t.match(/TotalTax-includedAmount\((\d{1,7}(?:\.\d{1,2})?)\)/);
      if (mm && out.amount == null) out.amount = parseFloat(mm[1]);
      mm = t.match(/BuyerIdNum\(([0-9A-Z]{15,20})\)/);
      if (mm && !out.buyer_no) out.buyer_no = mm[1];
      mm = t.match(/SellerIdNum\(([0-9A-Z]{15,20})\)/);
      if (mm && !out.seller_no) out.seller_no = mm[1];
      mm = issueTimeOf(body);
      if (mm && !out.invoice_date) out.invoice_date = mm;
    }
  }
  return out;
}

/** IssueTime 值是 UTF-16BE 字符串（如 2026年08月03日），需按字节定位解码 */
function issueTimeOf(bodyBuf) {
  const key = Buffer.from('IssueTime(', 'latin1');
  const i = bodyBuf.indexOf(key);
  if (i < 0) return null;
  let j = i + key.length;
  while (j < bodyBuf.length && bodyBuf[j] !== 0x29 && j - (i + key.length) < 128) j++; // 0x29 = ')'
  const val = bodyBuf.slice(i + key.length, j);
  if (val.length % 2) return null;
  try {
    const str = decodeUtf16be(val);
    const d = str.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
    return d ? `${d[1]}-${String(d[2]).padStart(2, '0')}-${String(d[3]).padStart(2, '0')}` : null;
  } catch (e) { return null; }
}

module.exports = { extractPdfText, extractPdfInvoiceMeta, parseCMap, parseTTFcmap, decodeLiteral, decodeHex };
