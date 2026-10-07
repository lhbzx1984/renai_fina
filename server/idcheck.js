'use strict';
/**
 * 一次性校验：JS 里引用的元素 id，是否都真的存在于 HTML 中。
 * 教训：这个检查千万别用 `bash -c "python -c \"...\""` 内联写 —— 双引号里
 * 的 `$` 会被 shell 吃掉，正则里的 `$` 变成行尾锚点，匹配永远为 0，
 * 于是得出「全部通过」的假结论。写成脚本文件跑才可信。
 */
const fs = require('node:fs');
const path = require('node:path');
const PUB = path.join(__dirname, 'public');

function idsOf(html) {
  const s = new Set();
  const re = /id="([A-Za-z0-9_-]+)"/g;
  let m;
  while ((m = re.exec(html))) s.add(m[1]);
  return s;
}

/** JS 里通过模板字符串动态生成的 id（弹窗内容），也算「已定义」 */
function idsInJs(js) {
  const s = new Set();
  const re = /id="([A-Za-z0-9_-]+)"/g;
  let m;
  while ((m = re.exec(js))) s.add(m[1]);
  return s;
}

function selsOf(js) {
  const s = new Set();
  // 覆盖 $('#x') / $$('#x') / on('#x') / onEvt('#x') / querySelector('#x')
  const re = /(?:querySelector(?:All)?|\$\$?|on|onEvt)\(\s*'#([A-Za-z0-9_-]+)'/g;
  let m;
  while ((m = re.exec(js))) s.add(m[1]);
  return s;
}

let bad = 0;
for (const [htmlName, jsNames] of [
  ['admin.html', ['js/admin.js']],
]) {
  const html = fs.readFileSync(path.join(PUB, htmlName), 'utf8');
  const ids = idsOf(html);
  for (const jn of jsNames) {
    const js = fs.readFileSync(path.join(PUB, jn), 'utf8');
    const dynamic = idsInJs(js); // 弹窗里动态生成的不算缺失
    const missing = [...selsOf(js)].filter((x) => !ids.has(x) && !dynamic.has(x));
    console.log(`[${jn}] 引用 ${selsOf(js).size} 个 id，HTML 中缺失 ${missing.length} 个`);
    if (missing.length) { console.log('   缺失：', missing.join(', ')); bad++; }
  }
}
console.log(bad ? '\n结果：存在缺失' : '\n结果：全部对应，无缺失');
