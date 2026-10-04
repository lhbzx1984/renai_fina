'use strict';
/**
 * 零依赖 PDF 合并：把多个 PDF 的所有页面拼成一个新 PDF。
 *
 * 思路：逐个源文档解析出「间接对象表」→ 收集页面树 → 从每个 Page 出发
 * 递归收集其依赖对象（字体/资源/内容流…）→ 重新分配对象号写入新文档。
 * 流数据原样搬运（不解压、不改 Filter），只重写 /Length 与对象引用。
 *
 * 注意：ObjStm（对象流）里的对象会被展开成普通对象写出；不支持加密 PDF。
 */
const zlib = require('node:zlib');

const RE_OBJ_HEAD = /(\d+)\s+(\d+)\s+obj\b/g;
const RE_REF = /(\d+)\s+(\d+)\s+R/g;

/** 扫描全部顶层间接对象（顺序扫描，跳过流内容，天然免疫流内的伪 obj） */
function scanObjects(text) {
  const list = [];
  let i = 0;
  while (i < text.length) {
    RE_OBJ_HEAD.lastIndex = i;
    const m = RE_OBJ_HEAD.exec(text);
    if (!m) break;
    const bodyStart = m.index + m[0].length;
    const endObjIdx = text.indexOf('endobj', bodyStart);
    if (endObjIdx === -1) break;

    let streamIdx = -1;
    // 定位真正的 stream 关键字（后跟 EOL，避免匹配 /StreamType 之类的名字）
    let probe = bodyStart;
    while (probe < endObjIdx) {
      const k = text.indexOf('stream', probe);
      if (k === -1 || k > endObjIdx) break;
      // stream 前允许空白或字典闭合 `>>`（很多生成器写成 `>>stream` 不带换行）
      if (/[\s\r\n>]/.test(text[k - 1] || '') && /[\s\r\n]/.test(text[k + 6] || '')) { streamIdx = k; break; }
      probe = k + 6;
    }

    if (streamIdx !== -1) {
      // 数据起点：stream 关键字后跳过 1 个 EOL（\r\n 或 \n，PDF 规范：可跟 \r 或 \n）
      let dataStart = streamIdx + 6;
      if (text[dataStart] === '\r') dataStart++;
      if (text[dataStart] === '\n') dataStart++;
      const endStreamIdx = text.indexOf('endstream', dataStart);
      const dataEnd = endStreamIdx === -1 ? endObjIdx : endStreamIdx;
      list.push({
        num: +m[1],
        dict: text.slice(bodyStart, streamIdx),
        stream: Buffer.from(text.slice(dataStart, dataEnd), 'latin1'),
      });
      i = (endObjIdx + 6);
    } else {
      list.push({ num: +m[1], dict: text.slice(bodyStart, endObjIdx), stream: null });
      i = endObjIdx + 6;
    }
  }
  return list;
}

function inflateIfNeeded(buf, dict) {
  if (!buf) return buf;
  if (/FlateDecode/.test(dict)) {
    try { return zlib.inflateSync(buf); } catch (e) { /* 部分文件流尾部脏字节，忽略 */ }
    try { return zlib.inflateRawSync(buf); } catch (e2) { return buf; }
  }
  return buf;
}

/** 解析一个 PDF 文档：返回 { objs: Map<num,{dict,stream}>, root } */
function parsePdf(buf) {
  const text = buf.toString('latin1');
  if (/\/Encrypt\b/.test(text.slice(-3000))) {
    throw new Error('该 PDF 已加密，无法合并');
  }
  const list = scanObjects(text);
  const objs = new Map();
  for (const o of list) objs.set(o.num, { dict: o.dict, stream: o.stream });

  // 展开对象流（ObjStm）
  for (const o of list) {
    if (!/\/ObjStm\b/.test(o.dict)) continue;
    const n = /\/N\s+(\d+)/.exec(o.dict);
    const first = /\/First\s+(\d+)/.exec(o.dict);
    if (!n || !first) continue;
    let data = inflateIfNeeded(o.stream, o.dict);
    if (!data) continue;
    const cnt = +n[1];
    const base = +first[1];
    const head = data.slice(0, base).toString('latin1').trim().split(/\s+/);
    const pairs = [];
    for (let i = 0; i + 1 < head.length && pairs.length < cnt; i += 2) {
      pairs.push([+head[i], +head[i + 1]]);
    }
    for (let i = 0; i < pairs.length; i++) {
      const [num, off] = pairs[i];
      const end = i + 1 < pairs.length ? base + pairs[i + 1][1] : data.length;
      const body = data.slice(base + off, end).toString('latin1');
      if (!objs.has(num)) objs.set(num, { dict: body, stream: null });
    }
  }

  const rootM = /\/Root\s+(\d+)\s+\d+\s+R/.exec(text);
  const root = rootM ? +rootM[1] : null;
  return { objs, root };
}

/** 取字典里某个键的间接引用号 */
function refOf(dict, key) {
  const m = new RegExp(`${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return m ? +m[1] : null;
}

/** 收集页面对象（含从父节点继承的 MediaBox / Rotate / Resources） */
function collectPages(doc) {
  const { objs, root } = doc;
  const pages = [];
  const rootObj = root ? objs.get(root) : null;
  let pagesNum = rootObj ? refOf(rootObj.dict, '/Pages') : null;
  if (pagesNum == null) {
    // 兜底：找 /Type /Pages 的对象
    for (const [num, o] of objs) {
      if (/\/Type\s*\/Pages\b/.test(o.dict)) { pagesNum = num; break; }
    }
  }

  const walk = (num, inherit) => {
    const o = objs.get(num);
    if (!o) return;
    const d = o.dict;
    const mb = /\/MediaBox\s*\[[^\]]*\]/.exec(d);
    const rot = /\/Rotate\s*(-?\d+)/.exec(d);
    const res = /\/Resources\s*(\d+\s+\d+\s+R|<<[\s\S]*?>>)/.exec(d);
    const next = {
      mediaBox: mb ? mb[0] : inherit.mediaBox,
      rotate: rot ? rot[0] : inherit.rotate,
      resources: res ? res[1] : inherit.resources,
    };
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(d);
    if (kids) {
      for (const km of kids[1].matchAll(RE_REF)) walk(+km[1], next);
      return;
    }
    if (/\/Type\s*\/Page\b/.test(d) || /\/Contents\b/.test(d)) pages.push({ num, inherit: next });
  };

  if (pagesNum != null) walk(pagesNum, { mediaBox: null, rotate: null, resources: null });
  return pages;
}

/** 从若干根对象出发递归收集依赖对象号（拓扑无关，PDF 不要求顺序） */
function collectDeps(objs, roots) {
  const seen = new Set();
  const order = [];
  const stack = [...roots];
  while (stack.length) {
    const num = stack.pop();
    if (seen.has(num)) continue;
    const o = objs.get(num);
    if (!o) continue;
    seen.add(num);
    order.push(num);
    // /Parent 必须排除，否则会顺着父节点把整棵页面树（所有页）都搬过来
    const scan = o.dict.replace(/\/Parent\s+\d+\s+\d+\s+R/g, '');
    for (const m of scan.matchAll(RE_REF)) stack.push(+m[1]);
  }
  return order;
}

function rewriteRefs(dict, map) {
  return dict.replace(RE_REF, (mm, a) => {
    const nn = map.get(+a);
    return nn ? `${nn} 0 R` : mm;
  });
}

/**
 * @param {Buffer[]} buffers 源 PDF 字节
 * @returns {{buf: Buffer, pages: number, sources: number}}
 */
function mergePdfs(buffers) {
  const docs = [];
  for (const b of buffers) {
    const doc = parsePdf(b);
    const pages = collectPages(doc);
    if (!pages.length) continue;
    docs.push({ ...doc, pages });
  }
  if (!docs.length) throw new Error('没有可合并的 PDF 页面');

  const chunks = [];
  let offset = 0;
  const push = (s, buf) => {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1');
    chunks.push(b); offset += b.length;
    if (buf !== undefined) { chunks.push(buf); offset += buf.length; }
  };

  push('%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n');

  const offsets = [];   // 对象号 -> 起始偏移（下标 0 对应对象 1）
  const objBuffer = []; // 对象体（延后写入，先算号）
  let nextNum = 3;      // 1=Catalog, 2=Pages
  const kids = [];

  const writeObj = (num, dict, stream) => {
    const d = dict.trim();
    const head = Buffer.from(`${num} 0 obj\n${d}\n`, 'latin1');
    offsets[num] = offset;
    push(head);
    if (stream && stream.length) {
      push('stream\n');
      push(stream);
      if (stream[stream.length - 1] !== 0x0a) push('\n');
      push('endstream\n');
    }
    push('endobj\n');
  };

  for (const doc of docs) {
    for (const pg of doc.pages) {
      const deps = collectDeps(doc.objs, [pg.num]);
      const map = new Map();
      for (const d of deps) map.set(d, nextNum++);

      for (const d of deps) {
        const o = doc.objs.get(d);
        let dict = o.dict;
        if (d === pg.num) {
          // 补齐继承属性，重写父指针
          dict = dict.replace(/\/Parent\s+\d+\s+\d+\s+R/g, '');
          if (!/\/MediaBox\b/.test(dict) && pg.inherit.mediaBox) dict += ` ${pg.inherit.mediaBox}`;
          if (!/\/Rotate\b/.test(dict) && pg.inherit.rotate) dict += ` ${pg.inherit.rotate}`;
          if (!/\/Resources\b/.test(dict) && pg.inherit.resources) dict += ` /Resources ${pg.inherit.resources}`;
          dict = dict.replace(/^\s*<<\s*/, '<< /Parent 2 0 R ');
        }
        dict = rewriteRefs(dict, map);
        if (o.stream && o.stream.length) {
          dict = dict.replace(/\/Length\s+(\d+\s+\d+\s+R|\d+)/, `/Length ${o.stream.length}`);
          if (!/\/Length\b/.test(dict)) dict = dict.replace(/^\s*<<\s*/, `<< /Length ${o.stream.length} `);
        }
        writeObj(map.get(d), dict, o.stream);
      }
      kids.push(map.get(pg.num));
    }
  }

  // 对象 1 Catalog / 对象 2 Pages 最后写（写进 offsets 后需在 xref 里占位）
  const catalogNum = 1;
  const pagesNum = 2;
  const kidsText = kids.map((k) => `${k} 0 R`).join(' ');
  // 先记录位置：这两个对象要出现在 xref 里，但字节必须写进文件——
  // 直接追加到末尾即可（PDF 允许对象出现顺序任意，只要 xref 偏移正确）
  offsets[catalogNum] = offset;
  push(`${catalogNum} 0 obj\n<< /Type /Catalog /Pages ${pagesNum} 0 R >>\nendobj\n`);
  offsets[pagesNum] = offset;
  push(`${pagesNum} 0 obj\n<< /Type /Pages /Kids [${kidsText}] /Count ${kids.length} >>\nendobj\n`);

  const total = nextNum; // 最大对象号 + 1 = Size
  const xrefOff = offset;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let n = 1; n < total; n++) {
    const off = offsets[n];
    xref += off == null ? '0000000000 65535 f \n' : `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n<< /Size ${total} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`);

  return { buf: Buffer.concat(chunks), pages: kids.length, sources: docs.length };
}

module.exports = { mergePdfs, parsePdf, collectPages };
