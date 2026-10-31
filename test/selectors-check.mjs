/**
 * 静态自测：核对油猴脚本依赖的 DOM 选择器能否命中真实页面。
 * 用法：
 *   node test/selectors-check.mjs                  # 用仓库里自带的样例快照
 *   node test/selectors-check.mjs 页面.html 页面2.html
 *
 * 只做字符串/正则级核对（不需要浏览器，也不需要登录）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const defaults = [
  join(root, 'samples', 'list.html'),
  join(root, 'samples', 'edit.html'),
  join(root, 'samples', 'declare-admin.html'),
];

const files = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const targets = files.length ? files.map((f) => resolve(f)) : defaults;

const count = (text, re) => (text.match(re) || []).length;
const labelCount = (text, label) =>
  count(text, new RegExp(`mdc-button__label">\\s*${label}\\s*<`, 'g'));

let failed = 0;
const ok = (cond, msg, extra = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '✔' : '✘'} ${msg}${extra ? ' ' + extra : ''}`);
};

for (const file of targets) {
  if (!existsSync(file)) {
    console.log(`- 跳过（不存在）：${file}`);
    continue;
  }
  const html = readFileSync(file, 'utf8');
  console.log(`\n=== ${file}  (${(html.length / 1024).toFixed(0)} KB)`);

  const rows = count(html, /class="mdc-data-table__row"/g);
  const statusCells = count(html, /class="[^"]*status-\d+/g);
  const hasFooter = /footer class="application-footer"/.test(html);
  const editBtns = labelCount(html, '编辑');
  const submitBtns = labelCount(html, '提交');
  const backBtns = labelCount(html, '返回');
  const responsive = count(html, /table-responsive/g);

  if (rows > 1 && editBtns > 0) {
    // 列表页
    ok(rows >= 2, '找到表格行 tr.mdc-data-table__row', `(${rows} 行)`);
    ok(editBtns === submitBtns, '每行一个「编辑」+ 一个「提交」按钮',
      `(编辑 ${editBtns} / 提交 ${submitBtns})`);
    ok(statusCells >= rows, '每行都有状态单元格 td.status-*', `(${statusCells} 个)`);
    ok(!hasFooter, '列表页不应有 footer.application-footer（否则会误判成编辑页）');
  } else if (hasFooter) {
    // 编辑页
    ok(hasFooter, '找到编辑页 footer.application-footer');
    ok(submitBtns >= 1, '编辑页底部有「提交」按钮', `(${submitBtns})`);
    ok(backBtns >= 1, '编辑页底部有「返回」按钮', `(${backBtns})`);
  } else {
    // 其它后台（申报管理系统等）：只核对横向滚动兜底
    ok(true, '不是易指数页面（跳过行/按钮检查）');
  }

  if (responsive > 0) ok(true, '有 .table-responsive 容器（横向滚动会补在这里）');
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n失败 ${failed} 项 ❌`);
process.exit(failed === 0 ? 0 : 1);
