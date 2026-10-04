'use strict';
/**
 * 生成《天津仁爱学院差旅费报销明细表》.docx
 * 严格复刻参考模板的 11 列网格、合并单元格、宋体/方正小标宋样式与大小写合计。
 */
const { makeZip } = require('./zip');
const { rmbUpper, round2 } = require('./money');

const ORG = '天 津 仁 爱 学 院 差 旅 费 报 销 明 细 表';
/* 11 列宽度（dxa），与模板一致 */
const GRID = [1320, 1320, 1320, 1107, 1533, 1320, 1320, 1320, 1320, 1320, 1320];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 段落 XML。opts: {align, bold, size(半磅), font, spacingLine, indent} */
function p(text, opts = {}) {
  const {
    align = 'center', bold = false, size = 24,
    font = '宋体', spacingLine = 360, indent = 0,
  } = opts;
  const rPr =
    `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>` +
    (bold ? '<w:b/><w:bCs/>' : '') +
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;
  const runs = String(text)
    .split('\n')
    .map((t, i) => (i === 0 ? `<w:r>${rPr}<w:t xml:space="preserve">${esc(t)}</w:t></w:r>`
      : `<w:r>${rPr}<w:br/><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`))
    .join('');
  return (
    `<w:p><w:pPr><w:widowControl/>` +
    `<w:spacing w:line="${spacingLine}" w:lineRule="exact"/>` +
    (indent ? `<w:ind w:firstLineChars="${indent}"/>` : '') +
    `<w:jc w:val="${align}"/>${rPr}</w:pPr>${runs}</w:p>`
  );
}

const BD = (val = 'single') =>
  `<w:tcBorders>` +
  `<w:top w:val="${val}" w:sz="4" w:space="0" w:color="auto"/>` +
  `<w:left w:val="${val}" w:sz="4" w:space="0" w:color="auto"/>` +
  `<w:bottom w:val="${val}" w:sz="4" w:space="0" w:color="auto"/>` +
  `<w:right w:val="${val}" w:sz="4" w:space="0" w:color="auto"/>` +
  `</w:tcBorders>`;

/** 单元格。opts: {span, vMerge:'restart'|'continue', align, bold, size, font, noLeft, noTop, noRight} */
function tc(content, opts = {}) {
  const { span = 1, vMerge = null, align = 'center', bold = false, size = 24, font = '宋体', noLeft = false, noTop = false, noRight = false } = opts;
  const borders = `<w:tcBorders>` +
    `<w:top w:val="${noTop ? 'nil' : 'single'}" w:sz="4" w:space="0" w:color="auto"/>` +
    `<w:left w:val="${noLeft ? 'nil' : 'single'}" w:sz="4" w:space="0" w:color="auto"/>` +
    `<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
    `<w:right w:val="${noRight ? 'nil' : 'single'}" w:sz="4" w:space="0" w:color="auto"/>` +
    `</w:tcBorders>`;
  const vm = vMerge === 'restart' ? '<w:vMerge w:val="restart"/>' : vMerge === 'continue' ? '<w:vMerge/>' : '';
  const width = GRID.reduce((a, b) => a + b, 0) / 11;
  const tcW = Math.round(width * span);
  const body = content == null ? p('') : content;
  return `<w:tc><w:tcPr><w:tcW w:w="${tcW}" w:type="dxa"/>` +
    (span > 1 ? `<w:gridSpan w:val="${span}"/>` : '') + vm + borders +
    `<w:vAlign w:val="center"/></w:tcPr>${body}</w:tc>`;
}

function tr(cells, height = 560) {
  // hRule=atLeast：内容折行（长部门名/多行其他费用）时行高自动撑开，避免文字被裁切
  return `<w:tr><w:trPr><w:trHeight w:val="${height}" w:hRule="atLeast"/></w:trPr>${cells}</w:tr>`;
}

function f2(n) {
  const v = round2(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

/**
 * @param {object} data
 * @param {string} data.reason 出差事由
 * @param {string} data.rangeText 出差时间文本，如 "2025年8月13日 至 2025年8月16日 共4天"
 * @param {Array} data.rows 明细行：{dept,name,jobNo,rankLevel,route,transport,hotel,meal,cityTrans,otherItems,subtotal}
 * @param {number} data.total 合计
 * @returns {Buffer}
 */
function buildTravelDocx(data) {
  const rows = data.rows || [];
  const total = round2(data.total || 0);

  const t = [];

  /* 第1行：标题（跨11列，与模板一致：上/左/右无边框，仅下边框，行高767） */
  t.push(tr([
    tc(p(ORG, { bold: true, size: 44, font: '方正小标宋简体', spacingLine: 540 }),
      { span: 11, noLeft: true, noTop: true, noRight: true }),
  ], 767));

  /* 第2行：出差事由 */
  t.push(tr([
    tc(p('出差事由'), { span: 2 }),
    tc(p(data.reason || '', { align: 'left' }), { span: 9, noLeft: true }),
  ]));

  /* 第3行：出差时间 */
  t.push(tr([
    tc(p('出差时间'), { span: 2 }),
    tc(p(data.rangeText || '', { align: 'left' }), { span: 9, noLeft: true }),
  ]));

  /* 第4行：列头（其余列纵向合并） */
  const head = ['部门', '姓名', '工号/学号', '职级', '起讫地点', '城市间交通费', '住宿费', '伙食补助费', '市内交通费'];
  t.push(tr(
    head.map((h, i) => tc(p(h, { size: 24 }), { vMerge: 'restart', noTop: true, noLeft: i > 0 })) +
    [tc(p('其他费用'), { span: 2, vMerge: 'restart', noTop: true, noLeft: true })]
  ));

  /* 第5行：项目 / 金额 */
  t.push(tr(
    head.map(() => tc(p(''), { vMerge: 'continue', noLeft: true })) +
    [tc(p('项目'), { noLeft: true }), tc(p('金额'), { noLeft: true })]
  ));

  /* 明细行 */
  const moneyCells = (r) => {
    const others = Array.isArray(r.otherItems) ? r.otherItems : [];
    // 其他费用拆「项目 | 金额」两列：项目列写名称、金额列写金额（最多 3 行，多余合并为一条）
    let names, amounts;
    if (others.length === 0) { names = '—'; amounts = '0'; }
    else if (others.length <= 3) {
      names = others.map((o) => o.item || '其他').join('\n');
      amounts = others.map((o) => f2(o.amount)).join('\n');
    } else {
      names = others.slice(0, 3).map((o) => o.item || '其他').join('\n') + `\n其他${others.length - 3}项`;
      const restSum = round2(others.slice(3).reduce((a, b) => a + Number(b.amount || 0), 0));
      amounts = others.slice(0, 3).map((o) => f2(o.amount)).join('\n') + `\n${f2(restSum)}`;
    }
    return [
      tc(p(r.dept || '', { size: 22, align: 'left' })),
      tc(p(r.name || '')),
      tc(p(r.jobNo || '')),
      tc(p(r.rankLevel || '')),
      tc(p(r.route || '')),
      tc(p(r.transportExpr || f2(r.transport))),
      tc(p(r.hotelExpr || f2(r.hotel))),
      tc(p(r.mealExpr || f2(r.meal))),
      tc(p(r.cityExpr || f2(r.cityTrans))),
      tc(p(names, { align: 'left', size: 20 })),
      tc(p(amounts, { size: 20 })),
    ];
  };

  for (const r of rows) t.push(tr(moneyCells(r)));

  /* 小计行：最后两列（项目/金额）合并为一格，放小计总额（同模板） */
  const sum = (k) => round2(rows.reduce((a, r) => a + Number(r[k] || 0), 0));
  t.push(tr(
    [tc(p('小计'), { span: 5 })] +
    [f2(sum('transport')), f2(sum('hotel')), f2(sum('meal')), f2(sum('cityTrans'))]
      .map((v) => tc(p(v))) +
    [tc(p(f2(total)), { span: 2 })]
  ));

  /* 合计行：整行合并为一个大格（总计花费） */
  t.push(tr([
    tc(p(`合计　　　　${data.currencyPrefix || '人民币'}：${rmbUpper(total)}　　¥${round2(total).toFixed(2)} 元`, {
      align: 'left', size: 22, indent: 100,
    }), { span: 11 }),
  ]));

  const tbl =
    `<w:tbl><w:tblPr><w:tblStyle w:val="a3"/><w:tblW w:w="0" w:type="auto"/>` +
    `<w:jc w:val="center"/>` +
    `<w:tblBorders>` +
    `<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
    `<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
    `<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
    `<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
    `<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
    `<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
    `</w:tblBorders>` +
    `<w:tblLayout w:type="fixed"/></w:tblPr>` +
    `<w:tblGrid>${GRID.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
    t.join('') +
    `</w:tbl>`;

  /* 模板无表外签字区，表格即文档全部内容 */
  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<w:body>${tbl}` +
    `<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>` +
    `<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="425" w:footer="425" w:gutter="0"/>` +
    `</w:sectPr></w:body></w:document>`;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:docDefaults><w:rPrDefault><w:rPr>` +
    `<w:rFonts w:ascii="宋体" w:hAnsi="宋体" w:eastAsia="宋体" w:cs="宋体"/>` +
    `<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:widowControl w:val="0"/><w:jc w:val="center"/></w:pPr></w:pPrDefault>` +
    `</w:docDefaults>` +
    `<w:style w:type="table" w:styleId="a3"><w:name w:val="Table Grid"/>` +
    `<w:tblPr><w:tblBorders>` +
    `<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
    `<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
    `<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
    `<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
    `<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
    `<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>` +
    `</w:tblBorders></w:tblPr></w:style>` +
    `</w:styles>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `</Relationships>`;

  const docRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const core =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>天津仁爱学院差旅费报销明细表</dc:title>` +
    `<dc:creator>天津仁爱学院报销系统</dc:creator>` +
    `</cp:coreProperties>`;

  return makeZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'docProps/core.xml', data: core },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'word/styles.xml', data: styles },
  ]);
}

module.exports = { buildTravelDocx };