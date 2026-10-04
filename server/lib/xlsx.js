'use strict';
/**
 * 生成《天津仁爱学院资金申请单》.xlsx
 * 逐格复刻官方模板「天津仁爱学院资金申请单-合肥培训.xlsx」：
 * 标题/日期行、6 行信息区、金额数字网格（⊗ 注销）、两行 6 格签字栏；
 * 合并区 11 处、默认列宽 23.78、默认行高 39、标题行高 60。
 * 使用 inlineStr 避免 sharedStrings。
 */
const { makeZip } = require('./zip');
const { round2 } = require('./money');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const COLS = [
  { w: 23.8 }, { w: 23.8 }, { w: 23.8 }, { w: 23.8 }, { w: 23.8 }, { w: 23.8 },
];

/** 列字母 */
function colName(i) {
  return String.fromCharCode(65 + i);
}

/**
 * @param {object} d
 * @param {string} d.dept
 * @param {string} d.category      借款 / 报销（默认报销）
 * @param {string} d.reason        支付事由
 * @param {string} d.payMethod     支付方式描述
 * @param {string} d.contractName  合同(项目)编号及名称
 * @param {string} d.payeeName     收款单位名称
 * @param {string} d.payeeBank     收款单位开户银行
 * @param {string} d.payeeAccount  收款单位银行账号
 * @param {number} d.amount
 */
/**
 * 金额数字网格（复刻官方模板 B8 格式）：
 * 「人民币：_仟_佰⊗拾⊗万陆仟陆佰零拾零元零角零分」
 * 位序：仟佰拾万仟佰拾元角分（千万..分），前导零用 ⊗ 注销，千万/百万留空。
 */
function rmbGridText(amount) {
  const DIG = '零壹贰叁肆伍陆柒捌玖';
  const UNITS = ['仟', '佰', '拾', '万', '仟', '佰', '拾', '元', '角', '分'];
  const SCALE = [1e9, 1e8, 1e7, 1e6, 1e5, 1e4, 1e3, 1e2, 10, 1]; // 单位：分
  const amt = Math.round(round2(amount) * 100);
  let highest = -1;
  for (let i = 0; i < 10; i++) {
    if (Math.floor(amt / SCALE[i]) % 10) { highest = i; break; }
  }
  const parts = ['人民币：'];
  for (let i = 0; i < 10; i++) {
    const d = Math.floor(amt / SCALE[i]) % 10;
    const ds = d === 0 && (highest < 0 || i < highest)
      ? (i < 2 ? '' : '⊗')
      : DIG[d];
    parts.push(`${ds} ${UNITS[i]}`);
  }
  return parts.join(' ');
}

function buildFundXlsx(d) {
  const amount = round2(d.amount || 0);
  const amtText = ` ¥ ${amount.toFixed(2)}元`;
  const gridText = rmbGridText(amount);
  const categoryText =
    (d.category === '借款' ? '■' : '□') + ' 借款        ' +
    (d.category === '报销' ? '■' : '□') + ' 报销  ';

  // 官方模板布局：11 处合并区
  const merges = [
    'A1:F1', 'A2:F2', 'B3:C3', 'E3:F3', 'B4:F4', 'B5:F5',
    'B6:C6', 'E6:F6', 'B7:C7', 'E7:F7', 'B8:E8',
  ];

  const rows = [];
  const add = (r, cells) => rows.push({ r, cells });

  add(1, [{ c: 0, v: '天 津 仁 爱 学 院 资 金 申 请 单', s: 1 }]);
  add(2, [{ c: 0, v: '  年    月    日         ', s: 2 }]);
  add(3, [
    { c: 0, v: '部门', s: 3 },
    { c: 1, v: d.dept || '', s: 4 },
    { c: 3, v: '类别', s: 3 },
    { c: 4, v: categoryText, s: 4 },
  ]);
  add(4, [
    { c: 0, v: '支付事由', s: 3 },
    { c: 1, v: d.reason || '', s: 4 },
  ]);
  add(5, [
    { c: 0, v: '支付方式', s: 3 },
    { c: 1, v: d.payMethod || '   □  现金        □  支票        □  电汇       □  其他', s: 4 },
  ]);
  add(6, [
    { c: 0, v: '合同(项目)编号及名称', s: 3 },
    { c: 1, v: d.contractName || '', s: 4 },
    { c: 3, v: '收款单位名称', s: 3 },
    { c: 4, v: d.payeeName || '', s: 4 },
  ]);
  add(7, [
    { c: 0, v: '收款单位开户银行', s: 3 },
    { c: 1, v: d.payeeBank || '', s: 4 },
    { c: 3, v: '收款单位银行账号', s: 3 },
    { c: 4, v: d.payeeAccount || '', s: 4 },
  ]);
  add(8, [
    { c: 0, v: '金额', s: 3 },
    { c: 1, v: gridText, s: 4 },
    { c: 5, v: amtText, s: 5 },
  ]);
  // 签字栏两行 6 格（与模板一致）
  add(9, [
    { c: 0, v: '申请人', s: 3 }, { c: 1, v: '', s: 3 },
    { c: 2, v: '部门(项目)负责人', s: 3 }, { c: 3, v: '', s: 3 },
    { c: 4, v: '财务处长', s: 3 }, { c: 5, v: '', s: 3 },
  ]);
  add(10, [
    { c: 0, v: '主管校领导', s: 3 }, { c: 1, v: '', s: 3 },
    { c: 2, v: '财务副校长', s: 3 }, { c: 3, v: '', s: 3 },
    { c: 4, v: '校长/书记', s: 3 }, { c: 5, v: '', s: 3 },
  ]);

  // 合并区内的非锚点单元格也必须带边框样式，否则缺边框
  const cellMap = new Map();
  for (const row of rows) for (const cell of row.cells) cellMap.set(`${colName(cell.c)}${row.r}`, cell);
  for (const m of merges) {
    const [a, b] = m.split(':');
    const c1 = a.charCodeAt(0) - 65;
    const c2 = b.charCodeAt(0) - 65;
    const r = parseInt(a.slice(1), 10);
    for (let c = c1; c <= c2; c++) {
      const ref = `${colName(c)}${r}`;
      if (!cellMap.has(ref)) cellMap.set(ref, { c, v: '', s: 4 });
    }
  }
  const byRow = new Map();
  for (const [ref, cell] of cellMap.entries()) {
    const r = parseInt(ref.slice(1), 10);
    if (!byRow.has(r)) byRow.set(r, []);
    byRow.get(r).push(cell);
  }

  const sheetRows = [...byRow.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([r, cells]) => {
      const cs = cells
        .sort((x, y) => x.c - y.c)
        .map((cell) => {
          const ref = `${colName(cell.c)}${r}`;
          const styleAttr = cell.s ? ` s="${cell.s}"` : '';
          const isNum = typeof cell.v === 'number';
          return isNum
            ? `<c r="${ref}"${styleAttr}><v>${cell.v}</v></c>`
            : `<c r="${ref}"${styleAttr} t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`;
        })
        .join('');
      const ht = r === 1 ? 60 : '';
      return `<row r="${r}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${cs}</row>`;
    })
    .join('');

  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="A1:F10"/>` +
    `<sheetViews><sheetView tabSelected="1" workbookViewId="0"><selection sqref="A1"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultColWidth="23.78" defaultRowHeight="39"/>` +
    `<cols>${COLS.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.w}" customWidth="1"/>`).join('')}</cols>` +
    `<sheetData>${sheetRows}</sheetData>` +
    `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` +
    `</worksheet>`;

  /* 样式：0默认 1标题(宋体18粗) 2日期(宋体14粗右对齐) 3标签/空格(宋体12居中带框) 4填写区(宋体12居中带框换行) 5金额(宋体12左对齐带框) */
  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="4">` +
    `<font><sz val="12"/><name val="宋体"/></font>` +
    `<font><b/><sz val="18"/><name val="宋体"/></font>` +
    `<font><b/><sz val="14"/><name val="宋体"/></font>` +
    `<font><sz val="12"/><name val="宋体"/></font>` +
    `</fonts>` +
    `<fills count="2">` +
    `<fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `</fills>` +
    `<borders count="2">` +
    `<border><left/><right/><top/><bottom/><diagonal/></border>` +
    `<border><left style="thin"><color indexed="64"/></left><right style="thin"><color indexed="64"/></right>` +
    `<top style="thin"><color indexed="64"/></top><bottom style="thin"><color indexed="64"/></bottom><diagonal/></border>` +
    `</borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="6">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>` +
    `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `</Types>`;

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
    `</Relationships>`;

  const wbRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="资金申请单" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const core =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>天津仁爱学院资金申请单</dc:title><dc:creator>天津仁爱学院报销系统</dc:creator>` +
    `</cp:coreProperties>`;

  return makeZip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'docProps/core.xml', data: core },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

module.exports = { buildFundXlsx };