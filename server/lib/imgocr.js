'use strict';
/**
 * 图像 OCR 兜底层：把「没有文本层」的票据（扫描件 PDF、拍照图片）变成文本，
 * 再交回 ocr.js 的同一套字段规则抽取 —— 这就是泛化能力的来源：
 * 规则只写一次，文本从哪来（PDF 文本层 / 渲染图 OCR / 云 OCR）不影响下游。
 *
 * 三级取字：
 *   1) PDF 内嵌原始图像（扫描件通常直接嵌 JPEG，原图质量最好、最快）
 *   2) 矢量/混合 PDF -> pymupdf 渲染成 PNG（需本机有 pymupdf）
 *   3) 已经是图片的文件 -> 直接送引擎
 *
 * 引擎可插拔，由环境变量 OCR_CMD 指定，形如：
 *   OCR_CMD="tesseract {in} stdout -l chi_sim+eng"         # 本地 tesseract
 *   OCR_CMD="python C:/tools/myocr.py {in}"                # 自定义脚本，stdout 输出文本
 * 未配置时本模块返回 { ok:false, reason:'no-engine' }，调用方降级为人工录入，不报错。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PY_CANDIDATES = [
  process.env.OCR_PYTHON,
  'python',
  'python3',
  'C:/Users/Dell/.workbuddy/binaries/python/versions/3.13.12/python.exe',
  'C:/Users/Dell/.workbuddy/binaries/python/versions/3.14.3/python.exe',
].filter(Boolean);

let pyBinCache;
/** 找一个能 import pymupdf 的 python（结果缓存，避免每次上传都探测） */
function findPython() {
  if (pyBinCache !== undefined) return pyBinCache;
  const probe = 'import pymupdf,sys;print("ok")';
  for (const bin of PY_CANDIDATES) {
    try {
      const out = execFileSync(bin, ['-c', probe], { encoding: 'utf8', timeout: 20000, windowsHide: true });
      if (/ok/.test(out)) { pyBinCache = bin; return bin; }
    } catch (e) { /* 换下一个 */ }
  }
  pyBinCache = null;
  return null;
}

/** 命令串 -> argv（支持双引号包裹的含空格路径） */
function toArgv(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function tmpDir() {
  const d = path.join(os.tmpdir(), 'renai-ocr');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cleanup(files) {
  for (const f of files || []) { try { fs.unlinkSync(f); } catch (e) { /* 忽略 */ } }
}

const PY_PREVIEW = `
import sys, pymupdf
doc = pymupdf.open(sys.argv[1])
w = int(sys.argv[2]); q = int(sys.argv[3]); maxp = int(sys.argv[4])
for i, page in enumerate(doc):
    if i >= maxp: break
    zoom = w / max(page.rect.width, 1)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
    with open("%s.%d.jpg" % (sys.argv[5], i), "wb") as f:
        f.write(pix.tobytes("jpeg", jpg_quality=q))
print(min(len(doc), maxp))
`;

/**
 * 渲染预览图：给 AI 助手「看图」用（原 PDF 动辄几 MB，直接读超限）。
 * @returns {Promise<{ok:boolean, files:string[], reason?:string}>}
 */
async function previewImages(file, opts = {}) {
  const py = findPython();
  if (!py) return { ok: false, reason: 'no-pymupdf' };
  if (!file || !fs.existsSync(file)) return { ok: false, reason: 'file-missing' };
  const width = Number(opts.width || 1100);
  const quality = Number(opts.quality || 60);
  const maxPages = Number(opts.maxPages || 2);
  const tag = `preview-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const out = path.join(tmpDir(), tag);
  try {
    const r = execFileSync(py, ['-c', PY_PREVIEW, file, String(width), String(quality), String(maxPages), out],
      { encoding: 'utf8', timeout: 60000, windowsHide: true });
    const n = parseInt(String(r).trim(), 10) || 0;
    const files = [];
    for (let i = 0; i < n; i++) {
      const f = `${out}.${i}.jpg`;
      if (fs.existsSync(f)) files.push(f);
    }
    return files.length ? { ok: true, files } : { ok: false, reason: 'no-image' };
  } catch (e) {
    return { ok: false, reason: 'render-failed', hint: String(e.message || e).slice(0, 200) };
  }
}

const PY_EXTRACT = `
import sys, base64, pymupdf
doc = pymupdf.open(sys.argv[1])
dpi = int(sys.argv[2])
maxpages = int(sys.argv[3])
out = []
for i, page in enumerate(doc):
    if i >= maxpages: break
    best = None
    for info in page.get_images(full=True):
        try:
            img = doc.extract_image(info[0])
        except Exception:
            continue
        if not img or not img.get("image"): continue
        w, h = img.get("width", 0), img.get("height", 0)
        # 只取覆盖页面的大图（小图多为图标/印章），原图比渲染图更清晰
        if w < 600 or h < 400: continue
        if best is None or w * h > best[0]:
            best = (w * h, img)
    if best is not None:
        img = best[1]
        ext = img.get("ext") or "png"
        out.append((ext, img["image"]))
    else:
        pix = page.get_pixmap(dpi=dpi)
        out.append(("png", pix.tobytes("png")))
for i, (ext, data) in enumerate(out):
    with open("%s.%d.%s" % (sys.argv[4], i, ext), "wb") as f:
        f.write(data)
print(len(out))
`;

/**
 * 取票据的可识别图像：PDF 优先抠内嵌原图，其次渲染；图片文件原样返回。
 * @returns {Promise<{ok:boolean, files:string[], reason?:string}>}
 */
async function ticketImages(buffer, fileName, opts = {}) {
  const dpi = Number(opts.dpi || process.env.OCR_DPI || 200);
  const maxPages = Number(opts.maxPages || process.env.OCR_MAX_PAGES || 3);
  const dir = tmpDir();
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const isPdf = /\.pdf$/i.test(fileName || '') ||
    (buffer.length > 4 && buffer.slice(0, 4).toString('latin1') === '%PDF');

  if (!isPdf) {
    // 已是图片：落盘交给引擎
    const ext = (path.extname(fileName || '').toLowerCase() || '.png').replace(/[^a-z0-9.]/g, '');
    const fp = path.join(dir, `${tag}.0${ext || '.png'}`);
    fs.writeFileSync(fp, buffer);
    return { ok: true, files: [fp], via: 'raw-image' };
  }

  const py = findPython();
  if (!py) return { ok: false, reason: 'no-pymupdf', hint: '未找到带 pymupdf 的 Python，无法把 PDF 转成图像' };
  const src = path.join(dir, `${tag}.pdf`);
  const outPrefix = path.join(dir, `${tag}.out`);
  fs.writeFileSync(src, buffer);
  try {
    const r = execFileSync(py, ['-c', PY_EXTRACT, src, String(dpi), String(maxPages), outPrefix],
      { encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const n = parseInt(String(r).trim(), 10) || 0;
    const files = [];
    for (let i = 0; i < n; i++) {
      const hit = fs.readdirSync(dir).find((f) => f.startsWith(`${tag}.out.${i}.`));
      if (hit) files.push(path.join(dir, hit));
    }
    cleanup([src]);
    return files.length ? { ok: true, files, via: 'pdf-render' } : { ok: false, reason: 'no-image' };
  } catch (e) {
    cleanup([src]);
    return { ok: false, reason: 'render-failed', hint: String(e.message || e).slice(0, 200) };
  }
}

/** 用外部引擎识别一张图，返回 stdout 文本 */
function ocrOne(file) {
  const cmd = process.env.OCR_CMD;
  if (!cmd) return { ok: false, reason: 'no-engine' };
  const argv = toArgv(cmd);
  const bin = argv[0];
  const dir = tmpDir();
  const outFile = path.join(dir, `${path.basename(file)}.txt`);
  const args = argv.slice(1).map((a) => a
    .replace(/\{in\}/g, file)
    .replace(/\{out\}/g, outFile));
  try {
    const stdout = execFileSync(bin, args, {
      encoding: 'utf8', timeout: Number(process.env.OCR_TIMEOUT || 90000),
      windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    });
    let text = String(stdout || '');
    if (cmd.includes('{out}')) {
      try { text += fs.readFileSync(outFile, 'utf8'); } catch (e) { /* 无输出文件 */ }
    }
    text = text.replace(/\r/g, '').trim();
    return text ? { ok: true, text } : { ok: false, reason: 'empty-output' };
  } catch (e) {
    return { ok: false, reason: 'engine-failed', hint: String(e.message || e).slice(0, 200) };
  }
}

/**
 * 图像 OCR 主入口：票据文件 -> 文本。
 * @returns {Promise<{ok:boolean, text?:string, reason?:string, hint?:string, via?:string, pages?:number}>}
 */
async function runImageOcr(buffer, fileName, opts = {}) {
  const imgs = await ticketImages(buffer, fileName, opts);
  if (!imgs.ok) return imgs;
  const texts = [];
  for (const f of imgs.files) {
    const r = ocrOne(f);
    if (r.ok && r.text) texts.push(r.text);
    else if (r.reason !== 'empty-output' && !imgs.__err) imgs.__err = r;
  }
  const text = texts.join('\n').trim();
  try { cleanup(imgs.files); } catch (e) { /* 忽略 */ }
  if (text) return { ok: true, text, via: imgs.via, pages: imgs.files.length };
  return { ok: false, reason: (imgs.__err && imgs.__err.reason) || 'empty-output', hint: imgs.__err && imgs.__err.hint };
}

/** 引擎可用性自检（给设置页/诊断用） */
function engineStatus() {
  const py = findPython();
  return {
    cmd: process.env.OCR_CMD || '',
    configured: !!process.env.OCR_CMD,
    python: py || null,
    pymupdf: !!py,
    ready: !!process.env.OCR_CMD && !!py,
  };
}

module.exports = { runImageOcr, ticketImages, previewImages, engineStatus, findPython };
