'use strict';
/** 金额工具：四舍五入到分 + 人民币大写 */

function round2(n) {
  const v = Number(n) || 0;
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

const DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'];
const UNITS = ['', '拾', '佰', '仟'];
const BIG_UNITS = ['', '万', '亿', '万亿'];

/**
 * 人民币金额转大写。参考财务部规范：0 -> 零元整；整数部分不出现零连跳；封顶"元"后补"整"。
 * @param {number|string} num
 * @returns {string} 例：2572 -> 贰仟伍佰柒拾贰元整
 */
function rmbUpper(num) {
  let n = round2(num);
  const neg = n < 0;
  if (neg) n = -n;

  const intPart = Math.floor(n);
  const frac = Math.round((n - intPart) * 100);

  let intStr = '';
  if (intPart === 0) {
    intStr = '零';
  } else {
    const groups = [];
    let rest = intPart;
    while (rest > 0) {
      groups.push(rest % 10000);
      rest = Math.floor(rest / 10000);
    }
    const parts = [];
    for (let g = groups.length - 1; g >= 0; g--) {
      const val = groups[g];
      let seg = '';
      let zero = false;
      const four = String(val).padStart(4, '0');
      for (let i = 0; i < 4; i++) {
        const d = Number(four[i]);
        const unit = UNITS[3 - i];
        if (d === 0) {
          zero = true;
        } else {
          if (zero && seg !== '') seg += '零';
          zero = false;
          seg += DIGITS[d] + unit;
        }
      }
      if (seg !== '') {
      // 已有更高位分组，且当前组不足千位（高位补零）时须显式补"零"，如 10001 -> 壹万零壹
        const prev = parts[parts.length - 1];
        if (val < 1000 && parts.length > 0 && prev !== undefined && !prev.endsWith('零')) {
          parts.push('零');
        }
        parts.push(seg + BIG_UNITS[g]);
      } else if (parts.length > 0 && !parts[parts.length - 1].endsWith('零')) {
        parts.push('零');
      }
    }
    intStr = parts.join('').replace(/零+$/, '');
    if (intStr === '') intStr = '零';
  }

  let out = intStr + '元';
  if (frac === 0) {
    out += '整';
  } else {
    const jiao = Math.floor(frac / 10);
    const fen = frac % 10;
    out += jiao > 0 ? DIGITS[jiao] + '角' : '零';
    if (fen > 0) out += DIGITS[fen] + '分';
    else out += '整';
  }
  return (neg ? '负' : '') + out;
}

/** 人民币大写（带符号位，用于表单占位） */
function rmbUpperLabel(num) {
  return '人民币：' + rmbUpper(num);
}

/** 格式化为两位小数的数字字符串 */
function fmt2(n) {
  return round2(n).toFixed(2);
}

module.exports = { round2, rmbUpper, rmbUpperLabel, fmt2 };