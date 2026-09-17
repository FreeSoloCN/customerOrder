/* 校验脚本：直接从生成好的 index.html 里抠出线上代码来跑，确保验的就是主管会打开的那一份。
   用法：node build/verify.js   （在仓库根目录执行）
   做三件事：1) 核对各项统计与异常判定 2) 用 DOM 桩跑通渲染 3) 检查生成的 HTML 结构闭合 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ticket-verify-'));

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const js = html.match(/<script>\n([\s\S]*?)\n<\/script>/)[1];
const sample = html.match(/<script type="application\/json" id="sample-data">([\s\S]*?)<\/script>/)[1];

let failures = 0;
function ok(cond, label, extra) {
  console.log((cond ? '  ✓ ' : '  ✗ ') + label + (extra !== undefined ? '  → ' + extra : ''));
  if (!cond) failures++;
}

/* ---------- 1. DOM 桩 ---------- */
const store = {};
function el(id) {
  return store[id] || (store[id] = {
    id, innerHTML: '', textContent: '', value: '', checked: false, style: {}, dataset: {},
    children: [], handlers: {},
    classList: { _s: new Set(), add(c) { this._s.add(c) }, remove(c) { this._s.delete(c) },
      toggle(c) { if (this._s.has(c)) { this._s.delete(c); return false } this._s.add(c); return true } },
    addEventListener(t, f) { (this.handlers[t] = this.handlers[t] || []).push(f) },
    appendChild(c) { this.children.push(c) },
    click() { (this.handlers.click || []).forEach(f => f({ preventDefault() {}, target: { closest() { return null } } })) },
    scrollIntoView() {}, getAttribute() { return null }
  });
}
el('sample-data').textContent = sample;
global.document = {
  getElementById: el,
  createElement: () => ({ value: '', textContent: '' }),
  addEventListener: (t, f) => { if (t === 'DOMContentLoaded') global.__ready = f; },
  querySelectorAll: () => [], body: {}
};
global.getComputedStyle = () => ({ fontFamily: 'stub' });
global.window = { scrollTo() {} };
const chartConfigs = [];
global.Chart = class { constructor(c, cfg) { chartConfigs.push({ canvas: c.id, cfg }); } destroy() {} };
global.Chart.defaults = { font: {} };

const modPath = path.join(TMP, 'page.js');
fs.writeFileSync(modPath, js);
const mod = require(modPath);

/* ---------- 2. 统计与异常判定 ---------- */
console.log('\n[1/3] 分析结果');
const v = mod.validate(sample);
ok(v.ok && v.tickets.length === 50, '50 条工单全部通过校验', v.tickets && v.tickets.length);
const a = mod.analyze(v.tickets);

const round = (n, d) => Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
const T = v.tickets;
const meanOf = (arr, f) => arr.reduce((s, x) => s + f(x), 0) / arr.length;
ok(a.kpi.total === T.length, 'KPI 工单总量', a.kpi.total);
ok(a.kpi.sat === round(meanOf(T, t => t.sat), 2), 'KPI 平均满意度与独立计算一致', a.kpi.sat);
ok(a.kpi.rt === round(meanOf(T, t => t.rt), 1), 'KPI 平均时长与独立计算一致', a.kpi.rt);
ok(a.kpi.unres === T.filter(t => !t.done).length, 'KPI 未解决数', a.kpi.unres);
ok(a.daily.reduce((s, d) => s + d.n, 0) === T.length, '每日工单量之和等于总量');
ok(a.byCat.reduce((s, c) => s + c.n, 0) === T.length, '各分类工单量之和等于总量');
ok(a.byCat.every(c => c.a + c.b === c.n), '每个分类的前后两段之和等于该分类总量');
ok(a.pris.reduce((s, p) => s + p.n, 0) === T.length, '各优先级之和等于总量');
ok(a.chs.reduce((s, c) => s + c.n, 0) === T.length, '各渠道之和等于总量');

const surge = a.byCat.find(c => c.cat === '支付问题');
ok(surge && surge.a === 5 && surge.b === 11, '支付问题前后段计数 5 → 11', surge && surge.a + '→' + surge.b);
const backlog = a.anomalies.find(x => x.rule === 'R3');
ok(backlog && backlog.tickets.length === T.filter(t => !t.done && t.pri === '高').length,
  'R3 列出的工单数等于「高优先级且未解决」的实际数量', backlog && backlog.tickets.length);
ok(a.anomalies.every(x => x.tickets.every(t => T.indexOf(t) >= 0)),
  '所有异常引用的都是真实存在的工单');
ok(a.anomalies.every(x => x.why && x.why.length > 10), '每条异常都写了判断依据');
ok(a.anomalies.every(x => x.act), '每条异常都给了建议动作');
ok(a.anomalies.every((x, i, arr) => i === 0 || arr[i - 1].lv <= x.lv), '异常按严重度排序');
console.log('     异常清单：' + a.anomalies.map(x => '[' + x.lv + ']' + x.rule).join(' '));

/* ---------- 3. 渲染 ---------- */
console.log('\n[2/3] 页面渲染');
global.__ready();
el('demo').click();
ok(el('report').style.display === 'block' && el('intro').style.display === 'none', '点示例数据后切到报表视图');
ok(chartConfigs.length === 4, '四张图表都创建了', chartConfigs.map(c => c.canvas).join(','));
ok(chartConfigs[0].cfg.data.datasets[0].data.length === a.daily.length, '趋势图数据点数等于天数');
const alerts = el('alerts').innerHTML;
ok((alerts.match(/<article/g) || []).length === a.anomalies.length, '异常卡数量与分析结果一致');
ok((alerts.match(/class="act"/g) || []).length === a.anomalies.length, '每张卡都渲染了建议动作');
const rows = () => (el('tableWrap').innerHTML.match(/<tr id=/g) || []).length;
ok(rows() === T.length, '明细表渲染全部工单', rows());
el('fUnres').checked = true; el('fUnres').handlers.input.forEach(f => f());
ok(rows() === a.kpi.unres, '「只看未解决」筛选正确', rows());
el('fUnres').checked = false; el('fFlag').checked = true; el('fFlag').handlers.input.forEach(f => f());
ok(rows() === Object.keys(a.flagged).length, '「只看被标记」筛选正确', rows());
el('fFlag').checked = false; el('fQ').value = 'zzz不存在'; el('fQ').handlers.input.forEach(f => f());
ok(el('tableWrap').innerHTML.includes('empty'), '搜索无结果时显示空状态提示');

/* ---------- 4. 异常输入 ---------- */
console.log('\n[3/3] 异常输入处理');
const bad = [
  ['不是 JSON', '{坏掉的'],
  ['不是数组', '{"a":1}'],
  ['空数组', '[]'],
  ['缺字段', '[{"ticket_id":"X1"}]'],
  ['时间格式错', '[{"ticket_id":"X1","created_at":"6/1/2024","category":"a","description":"b","priority":"高","resolution_time_hours":1,"satisfaction":3,"channel":"在线","is_resolved":true}]'],
  ['满意度越界', '[{"ticket_id":"X1","created_at":"2024-06-01 09:00","category":"a","description":"b","priority":"高","resolution_time_hours":1,"satisfaction":9,"channel":"在线","is_resolved":true}]']
];
bad.forEach(([label, text]) => {
  const r = mod.validate(text);
  ok(!r.ok && r.errs.length > 0, label + ' → 给出可读的错误提示', r.errs && r.errs[0].slice(0, 42));
});
const mixed = JSON.parse(sample).slice(0, 3).concat([{ ticket_id: 'BAD', created_at: 'x' }]);
const rm = mod.validate(JSON.stringify(mixed));
ok(rm.ok && rm.tickets.length === 3 && rm.warn.length === 1, '部分脏数据时跳过坏记录、保留好记录');

/* ---------- 5. HTML 结构 ---------- */
const tags = s => {
  const VOID = new Set(['br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'col']);
  const stack = []; let m; const re = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*?(\/?)>/g;
  while ((m = re.exec(s))) {
    const [full, tag, selfClose] = m;
    if (VOID.has(tag.toLowerCase()) || selfClose) continue;
    if (full[1] === '/') { if (stack.pop() !== tag) return '闭合不匹配：' + tag; }
    else stack.push(tag);
  }
  return stack.length ? '未闭合：' + stack.join(',') : null;
};
const structErr = tags(alerts) || tags(el('kpis').innerHTML) || tags(el('cmpChannel').innerHTML);
ok(!structErr, '动态生成的 HTML 标签闭合完整', structErr || '');

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? '\n✗ ' + failures + ' 项未通过' : '\n全部通过。');
process.exit(failures ? 1 : 0);
