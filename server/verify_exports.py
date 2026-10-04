#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
独立校验生成的 docx / xlsx：
不仅验证 ZIP 结构，还用 python-docx / openpyxl 真实解析，
并校验「各列金额之和 == 小计 == 合计 == 大写金额」这条财务等式。
"""
import sys, os, re, json, glob
from docx import Document
from openpyxl import load_workbook

ROOT = os.path.dirname(os.path.abspath(__file__))
EXP = os.path.abspath(os.path.join(ROOT, '..', 'exports'))
ok, bad = 0, 0

def chk(name, cond, extra=''):
    global ok, bad
    if cond:
        ok += 1; print(f'  ok   {name}')
    else:
        bad += 1; print(f'  FAIL {name}   -> {extra}')

D2I = {'零':0,'壹':1,'贰':2,'叁':3,'肆':4,'伍':5,'陆':6,'柒':7,'捌':8,'玖':9}

def parse_cn_upper(s):
    """把 '叁仟捌佰零伍元整' 解析成数值，用于与合计交叉校验"""
    s = s.replace('人民币：', '').split('¥')[0]
    s = re.sub(r'[^\u4e00-\u9fa5]', '', s)
    s = s.replace('元整', '元').replace('整', '')
    m = re.match(r'^(.*?)元', s)
    if not m: return None
    intpart = m.group(1)
    total, unit = 0, 1
    for ch in reversed(intpart):
        if ch in D2I:
            total += D2I[ch] * unit
        elif ch == '拾': unit = 10
        elif ch == '佰': unit = 100
        elif ch == '仟': unit = 1000
        elif ch == '万':
            total *= 10000; unit = 1
    return total

GRID_UNITS = [('仟',1e7),('佰',1e6),('拾',1e5),('万',1e4),('仟',1e3),('佰',1e2),('拾',10),('元',1),('角',0.1),('分',0.01)]

def parse_rmb_grid(s):
    """解析官方模板的金额数字网格，如
    '人民币：  仟  佰 ⊗ 拾 ⊗ 万 陆 仟 陆 佰 零 拾 零 元 零 角 零 分' -> 6600.0
    位序 仟佰拾万仟佰拾元角分（千万..分），前导零 ⊗ 注销，最高两位置可留空。"""
    s = s.replace('人民币：', '').replace(' ', '').replace('\u3000', '')
    total, i = 0.0, 0
    for unit, w in GRID_UNITS:
        idx = s.find(unit, i)
        if idx < 0: return None
        seg = s[i:idx]
        if seg in ('', '⊗'):
            d = 0
        elif len(seg) == 1 and seg in D2I:
            d = D2I[seg]
        else:
            return None
        total += d * w
        i = idx + 1
    return round(total, 2)

print('\n=== 导出文件独立校验 ===\n')

# ---------- DOCX ----------
print('[1] 差旅费报销明细表.docx（python-docx 解析）')
docs = sorted(glob.glob(os.path.join(EXP, '*_travel.docx')))
if not docs:
    print('  SKIP 缺少 *_travel.docx'); bad += 1
else:
    dpath = docs[-1]
    print(f'  文件: {os.path.basename(dpath)}')
    doc = Document(dpath)
    chk('可被 Word 库解析', True)
    t = doc.tables[0]
    grid = t._tbl.find('.//{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tblGrid')
    cols = len(grid) if grid is not None else 0
    chk('表格为 11 列（与模板一致）', cols == 11, f'实际 {cols}')

    rows = []
    for row in t.rows:
        # python-docx 对合并单元格会重复展开，按 gridSpan 去重
        seen, cells = [], []
        for tc in row._tr.tc_lst:
            txt = ''.join(n.text or '' for n in tc.iter() if n.tag.endswith('}t')).strip()
            cells.append(txt)
        rows.append(cells)
    alltxt = '\n'.join('\t'.join(r) for r in rows)

    chk('含标题', '差旅费报销明细表' in alltxt.replace(' ', ''))
    chk('含出差事由行', '出差事由' in alltxt)
    chk('含出差时间行', '出差时间' in alltxt)
    chk('含列头：部门/姓名/工号学号/职级/起讫地点',
        all(x in alltxt for x in ['部门','姓名','工号/学号','职级','起讫地点']))
    chk('含列头：城市间交通费/住宿费/伙食补助费/市内交通费/其他费用',
        all(x in alltxt for x in ['城市间交通费','住宿费','伙食补助费','市内交通费','其他费用']))
    chk('含小计行', '小计' in alltxt)
    chk('含合计行', '合计' in alltxt)

    # 定位小计行与合计行
    sub_i = next((i for i,r in enumerate(rows) if r and r[0]=='小计'), -1)
    tot_i = next((i for i,r in enumerate(rows) if r and r[0] and r[0].startswith('合计')), -1)
    chk('小计行存在', sub_i >= 0)
    chk('合计行存在', tot_i >= 0)

    if sub_i >= 0 and tot_i >= 0:
        sub_row = rows[sub_i]
        # 合计行已整行合并为一个大格（总计花费），金额文本与「合计」同格
        tot_cells = rows[tot_i]
        tot_line = next((c for c in tot_cells if '人民币' in c or '¥' in c), tot_cells[-1] if tot_cells else '')
        # 小计行：4 个分项 + 末尾合并格放总额（其他费用项目/金额两列已合并，无独立小计列）
        sub_nums = [float(x) for x in sub_row[-5:] if re.match(r'^-?[\d.]+$', x.replace(',',''))]
        chk('小计行有 4 个分项 + 1 个总额', len(sub_nums) == 5, sub_row[-5:])
        chk('小计合计 = 各列之和', abs(sum(sub_nums[:4]) - sub_nums[4]) < 0.01,
            f'各列和={sum(sub_nums[:4]):.2f} vs 合计={sub_nums[4]:.2f}')

        # 合计行金额
        m = re.search(r'¥([\d,]+\.?\d*)\s*元', tot_line)
        chk('合计行含 ¥金额', bool(m), tot_line)
        chk('合计金额为两位小数', bool(m) and '.' in m.group(1) and len(m.group(1).split('.')[1]) == 2, m.group(1) if m else '')
        if m:
            total = float(m.group(1).replace(',', ''))
            chk('合计 == 小计合计', abs(total - sub_nums[4]) < 0.01, f'{total} vs {sub_nums[4]}')
            upper_m = re.search(r'人民币：([^\s¥]+)', tot_line)
            chk('合计行含人民币大写', bool(upper_m), tot_line)
            if upper_m:
                parsed = parse_cn_upper(upper_m.group(1))
                chk(f'大写「{upper_m.group(1)}」== {total}', parsed is not None and abs(parsed - total) < 0.01,
                    f'解析得 {parsed}')
        print('  --- 小计行 ---')
        print('   ', sub_row[-6:])
        print('  --- 合计行 ---')
        print('   ', tot_line)

    # 明细行校验（模板 11 列 = 部门..其他项目,其他金额，末尾无独立小计列，小计只在汇总行）
    def cell_num(s):
        """表格里的金额可能是 '1743'、定额表达式 '100*4'，或票价比值式 '54.5*2' / '54.5*2+273*1'"""
        s = str(s).strip()
        if re.match(r'^-?[\d.]+$', s.replace(',', '')):
            return float(s.replace(',', ''))
        if re.match(r'^[\d.]+(\s*[*x×]\s*\d+)?(\s*\+\s*[\d.]+\s*[*x×]\s*\d+)*$', s):
            total = 0.0
            for part in s.split('+'):
                part = part.strip()
                m = re.match(r'^([\d.]+)\s*[*x×]\s*(\d+)$', part)
                total += float(m.group(1)) * int(m.group(2)) if m else float(part.replace(',', ''))
            return round(total, 2)
        return None

    detail_rows = []
    for r in rows:
        if len(r) >= 11 and cell_num(r[5]) is not None and '合计' not in r[0] and '小计' not in r[0]:
            detail_rows.append(r)
    chk('存在明细行', len(detail_rows) >= 1, f'{len(detail_rows)} 行')

    row_subtotals = []
    for r in detail_rows:
        # 第 9 列是「其他费用-项目」文本（非金额），第 10 列才是其金额
        nums = [cell_num(r[i]) for i in [5, 6, 7, 8, 10]]
        if None in nums:
            chk(f'明细行「{r[1]}」金额列可解析', False, nums)
            continue
        st = round(sum(nums[:5]), 2)
        row_subtotals.append(st)
        chk(f'明细行「{r[1]}」含姓名/工号/起讫地点', bool(r[1].strip()) and bool(r[2].strip()) and bool(r[4].strip()),
            f'姓名={r[1]} 工号={r[2]} 地点={r[4]}')
        print(f'  --- 明细行「{r[1]}」---')
        print(f'     交通={nums[0]} 住宿={nums[1]} 伙食={nums[2]}({r[7]}) 市交={nums[3]}({r[8]}) 其他={nums[4]} 合计={st}')

    if row_subtotals and sub_i >= 0:
        # 明细行小计之和 应等于汇总行最后一列
        sum_of_rows = round(sum(row_subtotals), 2)
        chk('各明细行小计之和 == 汇总小计', abs(sum_of_rows - sub_nums[4]) < 0.01,
            f'{sum_of_rows} vs {sub_nums[4]}')

# ---------- XLSX ----------
print('\n[2] 资金申请单.xlsx（openpyxl 解析）')
xls = sorted(glob.glob(os.path.join(EXP, '*_fund.xlsx')))
if not xls:
    print('  SKIP 缺少 *_fund.xlsx'); bad += 1
else:
    xpath = xls[-1]
    print(f'  文件: {os.path.basename(xpath)}')
    wb = load_workbook(xpath)
    chk('可被 Excel 库解析', True)
    ws = wb[wb.sheetnames[0]]

    cells = {}
    for row in ws.iter_rows():
        for c in row:
            if c.value is not None and str(c.value).strip():
                cells[str(c.value).strip()] = True
    allv = [str(c.value) for row in ws.iter_rows() for c in row
            if c.value is not None and str(c.value).strip()]
    joined = '\n'.join(allv)

    chk('含标题', '资 金 申 请 单' in joined)
    chk('含空白日期行（年 月 日）', re.search(r'年\s*月\s*日', joined) is not None)
    for label in ['部门','类别','支付事由','支付方式','合同(项目)编号及名称','收款单位名称','收款单位开户银行','金额']:
        chk(f'含字段「{label}」', label in joined)
    chk('含签字栏（两行6格）', all(x in joined for x in
        ['申请人','部门(项目)负责人','财务处长','主管校领导','财务副校长','校长/书记']))

    # 合同(项目)编号及名称：仅科研类（编号 KY 前缀）填写，其余类别留空
    contract = ''
    for row in ws.iter_rows():
        vals = [('' if c.value is None else str(c.value).strip()) for c in row]
        if vals and vals[0] == '合同(项目)编号及名称':
            contract = vals[1] if len(vals) > 1 else ''
            break
    code_prefix = os.path.basename(xpath).split('_')[0][:2].upper()
    is_research = code_prefix == 'KY'
    chk('合同(项目)编号仅科研类填写',
        (not is_research and contract == '') or (is_research and bool(contract)),
        f'前缀={code_prefix} 值={contract!r}')

    # 金额一致性：¥ 小写 vs 数字网格大写
    small = re.search(r'¥\s*([\d,]+\.\d{2})元', joined)
    chk('含 ¥ 金额且两位小数', bool(small), [v for v in allv if '¥' in v])
    grid_cell = next((v for v in allv if '人民币：' in v), '')
    chk('含人民币数字网格', bool(grid_cell), [v for v in allv if '人民币' in v])
    if small and grid_cell:
        s_val = float(small.group(1).replace(',', ''))
        g_val = parse_rmb_grid(grid_cell)
        chk(f'网格金额 == 小写 {s_val}', g_val is not None and abs(g_val - s_val) < 0.01,
            f'解析得 {g_val}，原文「{grid_cell.strip()[:60]}」')

    merged = [str(m) for m in ws.merged_cells.ranges]
    chk('合并单元格 >= 10', len(merged) >= 10, f'实际 {len(merged)}')
    chk('合并区无重复', len(merged) == len(set(merged)))
    # 检查交叠
    import itertools
    def box(r):
        a, b = r.split(':')
        ma, rb = re.match(r'([A-Z]+)(\d+)', a).groups()
        mb, re_ = re.match(r'([A-Z]+)(\d+)', b).groups()
        return ord(ma), int(rb), ord(mb), int(re_)
    ov = []
    for x, y in itertools.combinations(merged, 2):
        ax1, ay1, ax2, ay2 = box(x); bx1, by1, bx2, by2 = box(y)
        if ax1 <= bx2 and bx1 <= ax2 and ay1 <= by2 and by1 <= ay2:
            ov.append((x, y))
    chk('合并区无交叠', not ov, ov[:4])
    print('  --- 金额相关单元格 ---')
    for v in allv:
        if '¥' in v or '人民币' in v:
            print('   ', v)

print(f'\n=== 独立校验结果：PASS {ok} / FAIL {bad} ===\n')
sys.exit(0 if bad == 0 else 1)