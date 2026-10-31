// ==UserScript==
// @name         易班 · 网络易指数 一键提交全部
// @namespace    https://github.com/foweh/yiban-yizhishu-oneshot
// @version      1.0.0
// @description  ①一键把草稿逐条「编辑→提交」自动跑完 ②每行提交按钮按状态染绿/染红 ③给超宽表格补横向滚动条（三块容器同步）
// @author       foweh
// @match        *://*.yiban.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /* ============================ 配置 ============================ */
  const CFG = {
    stepTimeout: 25000,   // 等编辑页/提交结果的最长时间
    gapMs: 900,           // 每条之间的间隔（可在面板里改）
    submitLabels: ['提交'],
    backLabels: ['返回', '返回列表'],
    confirmLabels: ['确定', '确认', '提交', '是', '继续'],
    draftPattern: /草稿|待提交|未提交|被退回|退回|不通过/,
  };

  const LOG_MAX = 200;
  const logs = [];
  let stopFlag = false;
  let running = false;
  let dryRun = false;

  /* ============================ 小工具 ============================ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function labelOf(btn) {
    if (!btn) return '';
    const el = btn.querySelector('.mdc-button__label');
    return (el ? el.textContent : btn.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function realClick(el) {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  }

  async function waitFor(fn, timeout = CFG.stepTimeout, interval = 150) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  function log(msg) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    logs.push(`[${t}] ${msg}`);
    if (logs.length > LOG_MAX) logs.shift();
    renderLog();
    // 方便在 console 里回看
    console.log('[易班提效]', msg);
  }

  /* ============================ 表格结构 ============================ */
  // 易指数申报列表：tr.mdc-data-table__row，末列 sticky，含「编辑」「提交」两个按钮；
  // 状态列 <td class="mdc-data-table__cell status-NN">草稿</td>
  function listRows() {
    return Array.from(document.querySelectorAll('tr.mdc-data-table__row')).map((tr) => {
      const tds = tr.querySelectorAll('td');
      const statusTd = tr.querySelector('td[class*="status-"]');
      const status = statusTd ? statusTd.textContent.replace(/\s+/g, ' ').trim() : '';
      const buttons = Array.from(tr.querySelectorAll('button'));
      const btnSubmit = buttons.find((b) => labelOf(b) === '提交');
      const btnEdit = buttons.find((b) => labelOf(b) === '编辑');
      const id = tds.length ? tds[0].textContent.replace(/\s+/g, ' ').trim() : '';
      return { tr, id, status, statusTd, btnSubmit, btnEdit };
    }).filter((r) => r.btnEdit || r.statusTd);
  }

  const isSubmitted = (status) => status !== '' && !CFG.draftPattern.test(status);

  // 判断当前是不是「列表页」：编辑页也有 footer.application-footer，且编辑页里
  // 有一张只有 1 行的操作记录表（tr.mdc-data-table__row 也会命中），所以不能只看行数
  function onEditPage() {
    return !!document.querySelector('footer.application-footer');
  }

  function listReady() {
    if (onEditPage()) return false;
    return listRows().filter((r) => r.btnEdit).length >= 2;
  }

  /* ============================ ① 状态着色 ============================ */
  const STYLE_ID = 'yb-enhance-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
      .yb-btn-sub { color:#fff !important; font-weight:600 !important; border-radius:4px !important; }
      .yb-btn-sub.yb-on  { background:#16a34a !important; border-color:#16a34a !important; }
      .yb-btn-sub.yb-off { background:#dc2626 !important; border-color:#dc2626 !important; }
      .yb-btn-sub.yb-busy{ background:#d97706 !important; border-color:#d97706 !important; }
      tr.yb-row-busy { outline:2px solid #d97706; outline-offset:-2px; }
      /* 横向滚动：MDC 固定表头/表体/表尾三块容器同步 */
      .mdc-data-table__table-container { overflow-x: auto !important; }
      .mdc-data-table { overflow: visible !important; }
      .table-responsive { overflow-x: auto !important; }
      ${'' /* 面板样式在 JS 里内联，避免和站点 CSS 打架 */}
    `;
    document.head.appendChild(st);
  }

  function paint() {
    const rows = listRows();
    let on = 0, off = 0;
    rows.forEach((r) => {
      const done = isSubmitted(r.status);
      done ? on++ : off++;
      if (r.btnSubmit && !r.btnSubmit.classList.contains('yb-busy')) {
        r.btnSubmit.classList.add('yb-btn-sub');
        r.btnSubmit.classList.toggle('yb-on', done);
        r.btnSubmit.classList.toggle('yb-off', !done);
        r.btnSubmit.title = `当前状态：${r.status || '未知'}（${done ? '已提交' : '未提交'}）`;
      }
      // 有些状态下「提交」按钮不存在，那就把状态单元格染上
      if (!r.btnSubmit && r.statusTd) {
        r.statusTd.style.color = done ? '#16a34a' : '#dc2626';
        r.statusTd.style.fontWeight = '600';
      }
    });
    updateStat(on, off);
  }

  /* ============================ ② 横向滚轮 ============================ */
  let scrollHooked = false;
  function fixHScroll() {
    const conts = Array.from(document.querySelectorAll('.mdc-data-table__table-container'));
    conts.forEach((c) => { c.style.overflowX = 'auto'; });
    if (!scrollHooked && conts.length) {
      scrollHooked = true;
      let lock = false;
      conts.forEach((c) => c.addEventListener('scroll', () => {
        if (lock) return;
        lock = true;
        const x = c.scrollLeft;
        conts.forEach((o) => { if (o !== c) o.scrollLeft = x; });
        lock = false;
      }, { passive: true }));
    }
    // 申报管理系统（AdminLTE）：bootstrap 的 .table-responsive 常被父级 overflow 裁掉
    document.querySelectorAll('.table-responsive').forEach((el) => {
      el.style.overflowX = 'auto';
      el.style.webkitOverflowScrolling = 'touch';
    });
    // 兜底：表格比容器宽却没有滚动条时，强制给容器加
    document.querySelectorAll('table').forEach((tb) => {
      const p = tb.parentElement;
      if (!p) return;
      if (tb.scrollWidth > p.clientWidth + 4 && getComputedStyle(p).overflowX === 'visible') {
        p.style.overflowX = 'auto';
      }
    });
  }

  function scrollWatch() {
    fixHScroll();
    let t = null;
    const mo = new MutationObserver(() => {
      if (t) return;
      t = setTimeout(() => { t = null; fixHScroll(); paint(); }, 250);
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  /* ============================ ③ 面板 UI ============================ */
  let panel, statEl, logEl, runBtn, stopBtn;

  function buildPanel() {
    if (document.getElementById('yb-enhance-panel')) return;
    panel = document.createElement('div');
    panel.id = 'yb-enhance-panel';
    panel.style.cssText = `
      position:fixed; right:16px; bottom:16px; z-index:2147483000;
      width:280px; background:#111827; color:#e5e7eb; border:1px solid #374151;
      border-radius:10px; font:12px/1.5 system-ui,-apple-system,"Microsoft YaHei",sans-serif;
      box-shadow:0 10px 30px rgba(0,0,0,.45); overflow:hidden;
    `;
    panel.innerHTML = `
      <div id="yb-head" style="display:flex;align-items:center;gap:6px;padding:8px 10px;background:#1f2937;cursor:move;user-select:none;">
        <b style="flex:1;font-size:12.5px;">易班提效</b>
        <span id="yb-fold" style="cursor:pointer;opacity:.7;">—</span>
      </div>
      <div id="yb-body" style="padding:10px;">
        <div id="yb-stat" style="margin-bottom:8px;color:#9ca3af;">扫描中…</div>
        <div style="display:flex;gap:6px;margin-bottom:8px;">
          <button id="yb-run" style="flex:1;padding:8px 0;border:0;border-radius:6px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;">一键提交全部</button>
          <button id="yb-stop" style="padding:8px 10px;border:1px solid #4b5563;border-radius:6px;background:#374151;color:#e5e7eb;cursor:pointer;">停止</button>
        </div>
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;color:#9ca3af;">
          <label>间隔</label>
          <input id="yb-gap" type="number" min="0" step="100" value="${CFG.gapMs}" style="width:64px;background:#0b1220;border:1px solid #4b5563;border-radius:4px;color:#e5e7eb;padding:2px 4px;">
          <label style="display:flex;align-items:center;gap:4px;cursor:pointer;">
            <input id="yb-dry" type="checkbox"> 干跑
          </label>
          <button id="yb-refresh" style="margin-left:auto;border:1px solid #4b5563;border-radius:5px;background:#374151;color:#e5e7eb;padding:2px 8px;cursor:pointer;">刷新</button>
        </div>
        <div id="yb-log" style="max-height:132px;overflow:auto;background:#0b1220;border:1px solid #374151;border-radius:6px;padding:6px;color:#9ca3af;font-family:ui-monospace,Consolas,monospace;font-size:11px;white-space:pre-wrap;"></div>
      </div>
    `;
    document.body.appendChild(panel);

    statEl = panel.querySelector('#yb-stat');
    logEl = panel.querySelector('#yb-log');
    runBtn = panel.querySelector('#yb-run');
    stopBtn = panel.querySelector('#yb-stop');

    runBtn.addEventListener('click', runAll);
    stopBtn.addEventListener('click', () => { stopFlag = true; log('已请求停止（当前这条处理完就停）'); });
    panel.querySelector('#yb-refresh').addEventListener('click', () => { paint(); fixHScroll(); log('已刷新状态'); });
    panel.querySelector('#yb-gap').addEventListener('change', (e) => {
      const v = parseInt(e.target.value, 10);
      CFG.gapMs = Number.isFinite(v) && v >= 0 ? v : 900;
      e.target.value = CFG.gapMs;
    });
    panel.querySelector('#yb-dry').addEventListener('change', (e) => { dryRun = e.target.checked; });

    // 折叠 / 拖动
    const body = panel.querySelector('#yb-body');
    panel.querySelector('#yb-fold').addEventListener('click', () => {
      const hide = body.style.display !== 'none';
      body.style.display = hide ? 'none' : 'block';
      panel.querySelector('#yb-fold').textContent = hide ? '+' : '—';
    });
    const head = panel.querySelector('#yb-head');
    let drag = null;
    head.addEventListener('mousedown', (e) => {
      drag = { x: e.clientX, y: e.clientY, rect: panel.getBoundingClientRect() };
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.left = drag.rect.left + 'px';
      panel.style.top = drag.rect.top + 'px';
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      panel.style.left = drag.rect.left + (e.clientX - drag.x) + 'px';
      panel.style.top = drag.rect.top + (e.clientY - drag.y) + 'px';
    });
    window.addEventListener('mouseup', () => { drag = null; });
  }

  function updateStat(on, off) {
    if (!statEl) return;
    statEl.innerHTML = `未提交 <b style="color:#f87171">${off}</b> · 已提交 <b style="color:#4ade80">${on}</b>`;
  }

  function renderLog() {
    if (!logEl) return;
    logEl.textContent = logs.slice(-40).join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  }

  /* ============================ ④ 单条提交流程 ============================ */
  // 站点自身的坑：列表里的「提交」按钮点了不生效（时间字段未初始化），
  // 必须走「编辑 → 编辑页底部提交」，这里就照这条唯一有效的路走。
  async function submitOne(row, idx, total) {
    const tag = `#${idx}/${total} id=${row.id || '?'} [${row.status}]`;
    log(`${tag} 点「编辑」`);

    realClick(row.btnEdit);

    // 等编辑页出现（底部 footer 里的「提交」）
    const footer = await waitFor(() => {
      const f = document.querySelector('footer.application-footer');
      if (!f) return null;
      const b = Array.from(f.querySelectorAll('button')).find((x) => labelOf(x) === '提交');
      return b ? f : null;
    }, CFG.stepTimeout);
    if (!footer) {
      log(`${tag} ✗ 编辑页没出现，跳过`);
      return false;
    }

    // 等表单渲染完（编辑页可能异步拉数据）
    await sleep(600);

    if (dryRun) {
      log(`${tag} 干跑：已到编辑页，不提交`);
      await goBack(footer);
      return true;
    }

    const btnSubmit = Array.from(footer.querySelectorAll('button')).find((x) => labelOf(x) === '提交');
    row.tr.classList.add('yb-row-busy');
    if (row.btnSubmit) {
      row.btnSubmit.classList.remove('yb-on', 'yb-off');
      row.btnSubmit.classList.add('yb-busy');
    }
    log(`${tag} 点编辑页「提交」`);
    realClick(btnSubmit);

    // 可能弹确认框
    const confirmBtn = await waitFor(() => {
      const box = document.querySelector('.mdc-dialog--open, .swal2-popup, .modal.show, .modal[style*="block"]');
      if (!box) return null;
      const cands = Array.from(box.querySelectorAll('button'))
        .filter((b) => CFG.confirmLabels.includes(labelOf(b)));
      return cands.length ? cands[cands.length - 1] : null;
    }, 3000);
    if (confirmBtn) {
      log(`${tag} 确认弹窗 → 点「${labelOf(confirmBtn)}」`);
      realClick(confirmBtn);
    }

    // 等结果：出现成功提示 / 回到列表 / 报错
    const result = await waitFor(() => {
      const txt = document.body.innerText || '';
      if (/提交成功|保存成功|操作成功/.test(txt)) return 'ok';
      const rows = document.querySelectorAll('tr.mdc-data-table__row').length;
      if (!document.querySelector('footer.application-footer') && rows > 0) return 'back';
      if (/请填写|请选择|不能为空|校验/.test(txt)) return 'invalid';
      return null;
    }, CFG.stepTimeout);

    row.tr.classList.remove('yb-row-busy');
    if (row.btnSubmit) row.btnSubmit.classList.remove('yb-busy');

    if (result === 'invalid') {
      log(`${tag} ✗ 校验没通过（页面上有必填项未填），跳过`);
      return false;
    }
    if (!result) {
      log(`${tag} ? 没等到明确结果，按已提交继续`);
    } else {
      log(`${tag} ✓ 提交完成（${result === 'ok' ? '成功提示' : '已返回列表'}）`);
    }

    // 回列表
    await goBack(footer);
    await sleep(CFG.gapMs);
    return true;
  }

  async function goBack(footer) {
    const back = Array.from((footer || document).querySelectorAll('button'))
      .find((b) => CFG.backLabels.includes(labelOf(b)));
    if (back) {
      realClick(back);
    } else if (history.length > 1) {
      history.back();
    }
    await waitFor(() => listReady(), 15000);
  }

  /* ============================ ⑤ 批量跑 ============================ */
  async function runAll() {
    if (running) { log('已经在跑了'); return; }
    if (onEditPage()) { log('现在在编辑页，先点「返回」回到列表再一键提交'); return; }
    if (!listReady()) { log('没找到申报列表（可能需要先登录 / 还没渲染完）'); return; }
    running = true;
    stopFlag = false;
    runBtn.disabled = true;
    runBtn.style.opacity = '.6';

    let ok = 0, fail = 0;
    try {
      // 每轮重新扫描：提交完以后 DOM 会重排，别拿着旧引用
      let round = 0;
      while (!stopFlag) {
        round++;
        // 每次都得确认回到了列表，否则可能在编辑页里误点
        if (!(await waitFor(() => listReady(), 12000))) {
          log('回不到列表页，停止');
          break;
        }
        const todo = listRows().filter((r) => !isSubmitted(r.status));
        if (!todo.length) { log('没有未提交的了 ✅'); break; }
        log(`—— 第 ${round} 轮：还有 ${todo.length} 条未提交`);
        const row = todo[0];
        const done = await submitOne(row, ok + fail + 1, ok + fail + todo.length);
        if (done) ok++; else fail++;
        if (round > 500) { log('轮次过多，保险起见停下'); break; }
      }
    } catch (err) {
      log(`✗ 异常：${err && err.message ? err.message : err}`);
    } finally {
      running = false;
      runBtn.disabled = false;
      runBtn.style.opacity = '1';
      log(`结束：成功 ${ok} 条，失败/跳过 ${fail} 条${dryRun ? '（干跑模式）' : ''}`);
      paint();
    }
  }

  /* ============================ 启动 ============================ */
  function boot() {
    injectStyle();
    buildPanel();
    paint();
    scrollWatch();
    // 列表是异步渲染 + 分页切换，定时补刷
    setInterval(() => { if (!running) paint(); }, 2000);
    log('已就绪：按钮已按状态上色，超宽表格已补横向滚动');
  }

  // SPA 路由切换后要重新挂
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => { fixHScroll(); paint(); }, 400);
    }
  }, 800);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
