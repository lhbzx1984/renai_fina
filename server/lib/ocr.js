'use strict';
/**
 * OCR 适配层。
 * 设计要点：识别引擎可插拔，默认 offline 引擎（零依赖、离线可跑、返回待审核草稿）。
 * 接入真实 OCR（如百度/腾讯/TextIn）只需实现 runOcr(buffer, mime) 返回同结构结果。
 * 无论哪种引擎，结果一律 ocr_status='pending'，必须人工审核后才计入报销。
 */
const path = require('node:path');
const crypto = require('node:crypto');
const { extractPdfText, extractPdfInvoiceMeta } = require('./pdftext');
const { runImageOcr } = require('./imgocr');

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.tif': 'image/tiff', '.tiff': 'image/tiff',
};

function mimeOf(fileName) {
  return MIME_BY_EXT[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
}

/* ---------------- 规则抽取：从 OCR 文本里抓字段 ---------------- */
function extractFields(text) {
  const out = {};
  if (!text) return out;
  const t = String(text);

  const patterns = {
    invoice_no: [
      /发票\s*号码[:：\s]*([0-9]{8,20})/,
      /No[.\s]*([0-9]{8,20})/i,
      /(?:票号|票据号)[:：\s]*([0-9A-Z\-]{8,30})/i,
      // 数电发票号：表头常残缺（发X号码X），号码本身独立成块 -> 20 位纯数字兜底
      /(?<!\d)(\d{20})(?!\d)/,
    ],
    amount: [
      // 大写金额后跟 ¥ 小写（数电发票：…圆整\n¥1541.00）
      /[壹贰叁肆伍陆柒捌玖拾佰仟万][壹贰叁肆伍陆柒捌玖拾佰仟万圆角分整零]{2,}[\s\S]{0,12}?[¥￥]\s*(\d{1,7}(?:\.\d{1,2})?)/,
      /（小写）[\s\S]{0,16}?[¥￥]\s*(\d{1,7}(?:\.\d{1,2})?)/,
      /(?:价税合计|合计金额|价税合计\(大写\)|小写|票价)[:：\s]{0,8}[（(]?[¥￥]?\s*(\d{1,7}(?:[.,]\d{1,2})?)/,
      /[¥￥]\s*(\d{1,7}(?:\.\d{1,2})?)/,
    ],
    invoice_date: [
      /(?:开票日期|日期)[:：\s]*(\d{4}[-年/.]\s?\d{1,2}[-月/.]\s?\d{1,2})/,
      /(\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日)/,
    ],
    tax_no: [
      /(?:纳税人识别号|统一社会信用代码|税号)[:：\s]*([0-9A-Z]{15,20})/i,
      // 数电发票：识别号在名称行下一行
      /识别号[:：][\s\S]{0,60}?([0-9A-Z]{15,20})/,
      // 表头残缺时：18 位统一社会信用代码独立成块，最后一个是销售方
      /(?<![0-9A-Z])([0-9A-Z]{18})(?![0-9A-Z])/g,
    ],
    vendor: [
      // 数电发票：标签与值分离渲染，「名称：」后常跟着别的字段，按单位后缀名直接扫（取最后一个 = 销售方；排除地址行）
      // \s 排除：Tm 定位已按块加空格，跨块粘连会把购买方/日期一起吞进去
      /(?<![\u4e00-\u9fa5]{0,4}地址[:：])[^\n\r：:,，\s]{3,28}(?:有限公司|有限责任公司|公司|酒店|宾馆|饭店|商行|商店|超市|药店|诊所|医院|学院|大学|中心|事务所|旅行社|厂|馆|部)(?![\u4e00-\u9fa5])/g,
      /(?:销售方名称|销方名称|商户名称|收款方)[:：\s]*([^\n\r，,]{2,30})/,
      /名称[:：\s]*([^\n\r，,]{2,30})/,
    ],
    itinerary: [
      /(?:行程|路线|出发地-?到达地|出发地|到达地)[:：\s]*([^\n\r]{2,60})/,
      /([\u4e00-\u9fa5]{2,10})\s*[→\-—~至到]\s*([\u4e00-\u9fa5]{2,10})/,
    ],
  };

  for (const [key, list] of Object.entries(patterns)) {
    for (const re of list) {
      // /g 模式（如按单位后缀扫销售方）取最后一个匹配，其余取第一个
      const m = re.global
        ? (([...t.matchAll(re)].pop()) || null)
        : t.match(re);
      if (m) {
        let v = m[1] != null ? m[1] : m[0];
        // 行程双捕获组（出发/到达）拼成「A-B」
        if (key === 'itinerary' && m[2] != null) v = `${m[1]}-${m[2]}`;
        v = String(v).trim();
        if (key === 'amount') {
          v = parseFloat(v.replace(/,/g, ''));
          if (!Number.isFinite(v) || v <= 0 || v >= 1e7) v = null; // 金额 sanity
        }
        if (key === 'invoice_date') {
          const d = v.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
          if (d) v = `${d[1]}-${String(d[2]).padStart(2, '0')}-${String(d[3]).padStart(2, '0')}`;
        }
        if (key === 'amount' && v == null) continue; // 本锚点无效，试下一个
        if (key === 'tax_no' && /^[0-9]{20}$/.test(v)) continue; // 20 位纯数字是发票号不是税号
        out[key] = v;
        break;
      }
    }
  }

  // 铁路电子客票：站名布局无箭头，按「xx站」成对取（先出现的为出发站）
  if (out.itinerary == null && /铁路|客票|车票/.test(t)) {
    const stations = [];
    for (const m of t.matchAll(/([\u4e00-\u9fa5]{2,8})\s*站(?![\u4e00-\u9fa5])/g)) {
      if (!stations.includes(m[1])) stations.push(m[1]);
      if (stations.length === 2) break;
    }
    if (stations.length === 2) out.itinerary = `${stations[0]}-${stations[1]}`;
  }

  // 兜底：¥ 前缀金额；再兜底取文中最后一个独立两位小数（客票价常分离渲染）
  if (out.amount == null) {
    let m = t.match(/[¥￥]\s*(\d{1,7}(?:\.\d{1,2})?)/);
    if (!m) {
      const all = [...t.matchAll(/(?<![\d.]).{0,2}?(\d{1,7}\.\d{2})(?![\d.])/g)]
        .map((x) => parseFloat(x[1])).filter((x) => x > 0 && x < 1e7);
      if (all.length) m = [null, String(all[all.length - 1])];
    }
    if (m) out.amount = parseFloat(m[1]);
  }
  return out;
}

/** 依据字段特征猜测费用科目（只作预填，人工审核时可改） */
const CATEGORY_RULES = [
  [/酒店|宾馆|住宿|客房|HOTEL|INN/i, 'hotel'],
  [/出租|网约|滴滴|地铁|公交|客运|火车|高铁|铁路|客票|列车|航空|机票|车票|行程单|旅行社|代订/i, 'transport'],
  [/餐|饭|food|餐费/i, 'city_trans'],
  [/版面费|审稿费|论文|期刊|编辑部|出版/i, 'paper_fee'],
  [/专利|知识产权|专利年费|代理费/i, 'patent_fee'],
  [/技术服务|技术开发|技术咨询|软件服务|检测服务|测试服务/i, 'tech_fee'],
  [/外协|协作费|委托加工|委托开发/i, 'outsource_fee'],
  [/维修|维保|保养|修理|维护/i, 'maintain_fee'],
  [/打印|印刷|复印|装订|图文|快印/i, 'print_fee'],
  [/耗材|硒鼓|墨盒|碳粉|打印纸|文具|办公用品/i, 'office_fee'],
  [/器材|材料费|配件|元器件|电子元件|实验耗材/i, 'consumable_fee'],
];
function guessCategory(fields, hint = '') {
  const s = `${hint} ${fields.itinerary || ''} ${fields.vendor || ''}`;
  for (const [re, key] of CATEGORY_RULES) if (re.test(s)) return key;
  return 'other';
}

/** 关键字段命中数：判断是否值得动用（较慢的）图像 OCR */
const KEY_FIELDS = ['amount', 'invoice_no', 'invoice_date'];
function hitKeyFields(f) {
  return KEY_FIELDS.filter((k) => f[k] != null && f[k] !== '').length;
}

/**
 * 默认引擎：PDF 文本层直读（零依赖）+ 文件名启发式兜底。
 * PDF 有文本层（如 12306 铁路电子客票、增值税电子发票）时直接解析出真实字段；
 * 图片或无文本层 PDF 回退到文件名启发式，返回待审核草稿。
 */
async function runOcr(buffer, mime, fileName, hint = '') {
  const id = crypto.createHash('md5').update(buffer).digest('hex').slice(0, 12);
  const baseName = String(fileName || '').replace(/\.[^.]+$/, '');
  const isPdf = mime === 'application/pdf' || /\.pdf$/i.test(fileName || '');

  // 1) PDF 文本层提取（优先级最高）
  let fields = {};
  let engine = 'offline-draft';
  let confidence = 0.2;
  let categoryHint = '';
  let pdfNote = null;
  if (isPdf) {
    try {
      const text = extractPdfText(buffer);
      if (text && /[\u4e00-\u9fa5]|[\d]{4}/.test(text)) {
        fields = extractFields(text);
        if (Object.keys(fields).length) {
          engine = 'pdf-text';
          confidence = 0.75;
        }
        if (/铁路电子客票/.test(text)) {
          fields.vendor = '中国铁路';
          categoryHint = 'transport';
        }
        pdfNote = { chars: text.length, sample: text.slice(0, 400) };
      }
      // 2) 数电发票 ObjStm 元数据兜底（开票软件写入的结构化字段，最可靠）
      const meta = extractPdfInvoiceMeta(buffer);
      for (const [k, mk] of [['invoice_no', 'invoice_no'], ['amount', 'amount'],
        ['invoice_date', 'invoice_date'], ['tax_no', 'buyer_no']]) {
        if (fields[k] == null && meta[mk] != null) {
          fields[k] = meta[mk];
          if (engine === 'offline-draft') { engine = 'pdf-meta'; confidence = 0.85; }
        }
      }
    } catch (e) {
      pdfNote = { error: String(e.message) };
    }
  }

  // 3) 图像 OCR 兜底：扫描件 PDF / 拍照图片没有文本层，转成图再识别，仍走同一套字段规则
  let imageNote = null;
  const needImage = hitKeyFields(fields) < 2;
  if (needImage) {
    if (!process.env.OCR_CMD) {
      imageNote = { reason: 'no-engine', hint: '未配置 OCR_CMD（如 tesseract），扫描件/图片无法自动识别，请人工录入' };
    } else {
      const im = await runImageOcr(buffer, fileName, {});
      if (im.ok) {
        const f2 = extractFields(im.text);
        for (const k of Object.keys(f2)) if (fields[k] == null) fields[k] = f2[k];
        if (Object.keys(f2).length) {
          engine = isPdf ? 'pdf-image-ocr' : 'image-ocr';
          confidence = 0.7;
        }
        imageNote = { via: im.via, pages: im.pages, chars: im.text.length };
      } else {
        imageNote = { reason: im.reason, hint: im.hint };
      }
    }
  }

  // 2) 文件名启发式兜底（仅补 PDF 未解出的字段）
  if (fields.amount == null) {
    // 必须带明确货币标识：1743.00元 / ¥88 / 50块，纯数字串不再当金额（修复天文数字 bug）
    const amt = baseName.match(/[¥￥]\s*(\d{1,7}(?:\.\d{1,2})?)/) ||
      baseName.match(/(\d{1,7}(?:\.\d{1,2})?)\s*(?:元|块|rmb|cny)/i);
    if (amt && parseFloat(amt[1]) > 0 && parseFloat(amt[1]) < 1e7) {
      fields.amount = parseFloat(amt[1]);
      if (engine === 'offline-draft') confidence = 0.55;
    }
  }
  if (fields.invoice_date == null) {
    const dt = baseName.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})/);
    if (dt) {
      const [, y, mo, d] = dt;
      if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31) {
        fields.invoice_date = `${y}-${mo}-${d}`;
      }
    }
  }
  if (fields.invoice_no == null && isPdf) {
    // 铁路客票等常以发票号命名：26119110010009334802-电子发票.pdf
    const no = baseName.match(/^(\d{8,20})(?=[\s_\-.])/);
    if (no) fields.invoice_no = no[1];
  }

  const guessed = guessCategory(
    { ...fields, vendor: fields.vendor || '' },
    `${hint} ${baseName}`
  );
  return {
    engine,
    confidence,
    fields,
    category: categoryHint || guessed,
    raw: {
      note: engine === 'pdf-text'
        ? '已从 PDF 文本层解析字段，请人工核对。'
        : engine === 'pdf-meta'
          ? '已从 PDF 元数据解析字段，请人工核对。'
          : /image-ocr/.test(engine)
            ? '扫描件/图片已通过图像 OCR 识别，请人工核对。'
            : '文本层与图像 OCR 均未取到字段，已按文件名生成待审核草稿，请人工补录。',
      pdf: pdfNote,
      imageOcr: imageNote,
      fileName,
      mime,
      bytes: buffer.length,
      hash: id,
      hint,
    },
  };
}

/** 批量导入 CSV 文本解析：表头 -> 对象数组 */
function parseCsv(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const split = (line) => {
    const out = [];
    let cur = '';
    let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const head = split(lines[0]).map((h) => h.replace(/^"|"$/g, ''));
  return lines.slice(1).map((line) => {
    const vals = split(line);
    const o = {};
    head.forEach((h, i) => { o[h] = vals[i] == null ? '' : vals[i]; });
    return o;
  });
}

module.exports = { runOcr, mimeOf, extractFields, guessCategory, parseCsv, MIME_BY_EXT };