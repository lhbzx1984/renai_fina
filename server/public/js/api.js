'use strict';
/** API 客户端 + 通用 UI 工具 */

const Api = {
  async call(method, url, body) {
    const opt = { method, headers: {} };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, opt);
    } catch (e) {
      throw new Error('无法连接服务器，请确认服务已启动');
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    }
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 (${res.status})`);
    return data.data;
  },
  get(u) { return this.call('GET', u); },
  post(u, b) { return this.call('POST', u, b); },
  put(u, b) { return this.call('PUT', u, b); },
  del(u) { return this.call('DELETE', u); },

  async upload(projectId, files, hints) {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    if (hints && hints.length) fd.append('hints', hints.join('||'));
    const res = await fetch(`/api/projects/${projectId}/receipts/upload`, { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || '上传失败');
    return data.data;
  },
};

/* ---------------- DOM 与格式化工具 ---------------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/** HTML 转义，所有用户输入渲染前必须经过 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function money(n) {
  const v = Number(n) || 0;
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function money0(n) {
  return (Number(n) || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function toast(msg, type) {
  const wrap = $('#toastWrap');
  const icons = { ok: '✓', err: '✕', warn: '!', info: 'i' };
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'info');
  el.innerHTML = `<span class="ico">${icons[type] || 'i'}</span><span>${esc(msg)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(28px)';
    setTimeout(() => el.remove(), 320);
  }, type === 'err' ? 5200 : 3000);
}

/** 通用弹窗。footer 为按钮数组 [{label,cls,onClick(close)}] */
function modal(title, bodyHtml, opts = {}) {
  const mask = $('#modalMask');
  const box = $('#modalBox');
  box.className = 'modal' + (opts.size ? ' ' + opts.size : '');
  const foot = opts.buttons || [{ label: '关闭', cls: 'btn' }];
  box.innerHTML = `
    <div class="modal-head"><h3>${esc(title)}</h3><button class="modal-close" data-close>&times;</button></div>
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-foot">${foot.map((b, i) =>
    `<button class="btn ${b.cls || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>`;
  mask.classList.add('show');

  const close = () => { mask.classList.remove('show'); box.innerHTML = ''; };
  box.querySelector('[data-close]').onclick = close;
  mask.onclick = (e) => { if (e.target === mask && opts.dismissible !== false) close(); };
  $$('[data-i]', box).forEach((btn) => {
    btn.onclick = async () => {
      const b = foot[Number(btn.dataset.i)];
      if (!b.onClick) return close();
      btn.disabled = true;
      const orig = btn.textContent;
      btn.textContent = '处理中…';
      try {
        const r = await b.onClick(close);
        if (r !== false) close();
      } catch (err) {
        toast(err.message, 'err');
      } finally {
        btn.disabled = false;
        btn.textContent = orig;
      }
    };
  });
  return { close, box };
}

function confirmDialog(title, message, onYes) {
  return modal(title, `<p style="line-height:1.7">${esc(message)}</p>`, {
    buttons: [
      { label: '取消', cls: 'btn' },
      { label: '确认', cls: 'btn btn-danger', onClick: async (close) => { await onYes(); close(); } },
    ],
  });
}

/** 可输入 + 可下拉的候选框（替代 datalist：datalist 只显示与已填文本匹配的建议，
 *  编辑已有值时点不出其他选项）。聚焦/点箭头列出全部候选，输入时包含匹配过滤，仍可自由手输。 */
function attachCombo(input, options) {
  const wrap = document.createElement('div');
  wrap.className = 'combo';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'combo-btn'; btn.title = '展开选项'; btn.textContent = '▾';
  wrap.appendChild(btn);
  const panel = document.createElement('div');
  panel.className = 'combo-panel';
  wrap.appendChild(panel);

  let hideTimer = null;
  const cancelHide = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
  const isOpen = () => panel.classList.contains('show');
  const onDocDown = (e) => { if (!wrap.contains(e.target)) hide(); }; // 点击组件外收起
  const hide = () => { cancelHide(); panel.classList.remove('show'); document.removeEventListener('mousedown', onDocDown, true); };
  const show = (all) => {
    const q = all ? '' : input.value.trim(); // 点箭头=列全部候选；输入时=按已填文本过滤
    const list = q ? options.filter((x) => x.includes(q)) : options;
    panel.innerHTML = list.length
      ? list.map((x) => `<div class="combo-item" data-v="${esc(x)}">${esc(x)}</div>`).join('')
      : '<div class="combo-empty">无匹配项，可直接输入</div>';
    panel.classList.add('show');
    document.removeEventListener('mousedown', onDocDown, true);
    document.addEventListener('mousedown', onDocDown, true);
  };

  input.addEventListener('focus', () => show());
  input.addEventListener('input', () => show());
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  // 用 mousedown 做 toggle：preventDefault 防失焦，且此时 focus 尚未转移，不会与 focus 监听打架
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (isOpen()) hide();
    else { input.focus(); show(true); }
  });
  panel.addEventListener('mousedown', (e) => {
    const it = e.target.closest('.combo-item');
    if (!it) return;
    e.preventDefault(); // 保持焦点在 input，避免先触发收起
    input.value = it.dataset.v;
    hide();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // 焦点离开组件（点击外部）后延迟收起，给「点箭头」留出时间窗
  wrap.addEventListener('focusout', (e) => {
    if (!wrap.contains(e.relatedTarget)) { cancelHide(); hideTimer = setTimeout(hide, 160); }
  });
  wrap.addEventListener('focusin', cancelHide);
}

function lightbox(src) {
  $('#lightboxImg').src = src;
  $('#lightbox').classList.add('show');
}
$('#lightbox').onclick = () => $('#lightbox').classList.remove('show');

const CAT_LABEL = { research: '科研', teaching: '教学', reform: '教改', training: '师资培训', competition: '竞赛' };
const CAT_CLASS = { research: '', teaching: 'green', reform: 'purple', training: 'gold', competition: 'red' };
const BUCKET_LABEL = { transport: '城市间交通费', hotel: '住宿费', city_trans: '市内交通费', other: '其他费用' };

/** 优先取服务端下发的字典（含设置页新增的自定义项），字典未加载时回落到内置表 */
const dictLabel = (listName, k, fallback) => {
  const list = (window.App && App.state && App.state[listName]) || [];
  const hit = list.find((x) => x.key === k);
  return hit ? hit.label : (fallback[k] || k);
};
function catLabel(k) { return dictLabel('categories', k, CAT_LABEL); }
function bucketLabel(k) { return dictLabel('buckets', k, BUCKET_LABEL); }

function catTag(k) {
  return `<span class="tag ${CAT_CLASS[k] || ''}">${esc(catLabel(k))}</span>`;
}

function emptyState(icon, text, sub) {
  return `<div class="empty"><div class="ico">${icon}</div><p>${esc(text)}</p>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
}