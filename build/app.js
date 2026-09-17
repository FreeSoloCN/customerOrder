/* ============================================================
   工单值班台 — 分析引擎 + 渲染
   全部计算在浏览器本地完成，数据不外传。
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 固定阈值（页面上会向主管说明每一条） ---------- */
  var RULES = {
    SURGE_WARN: 1.5,      // 后段日均 ≥ 前段 1.5 倍 → 关注
    SURGE_CRIT: 2.0,      // ≥ 2 倍 → 严重
    SURGE_MIN_COUNT: 3,   // 后段至少 3 张，避免小数字放大
    RECUR_WARN: 3,        // 同一问题指纹命中 ≥3 张 → 关注
    RECUR_CRIT: 5,        // ≥5 张 → 严重
    BACKLOG_CRIT: 3,      // 高优先级未解决 ≥3 张 → 严重
    LOW_SAT: 2.0,         // 分类平均满意度 ≤2.0 且样本 ≥3 → 关注
    LOW_SAT_MIN_N: 3,
    SAT_DROP: 0.4,        // 后段比前段平均满意度低 ≥0.4 分 → 关注
    SLOW_FACTOR: 3,       // 处理时长 ≥ 中位数的 3 倍
    SLOW_SAT: 2,          // 且满意度 ≤2 → 留意
    CHANNEL_GAP: 0.5      // 渠道间满意度差 ≥0.5 分 → 留意
  };

  /* ---------- 问题指纹：靠关键词识别反复出现的同一件事 ---------- */
  var FINGERPRINTS = [
    { name: '重复扣款 / 金额不对', kw: ['重复扣款', '扣了两次', '都扣钱', '多扣了', '扣款金额不对', '扣了我'] },
    { name: '扣款成功但订单状态没跟上', kw: ['订单显示未支付', '订单没生成', '订单还是待支付', '订单没成功', '没收到订单', '订单取消了'] },
    { name: '退款迟迟不到账', kw: ['还在审核', '钱还没退', '退款还在处理', '到现在没退', '什么时候给', '钱什么时候退'] },
    { name: '退货运费谁承担', kw: ['退货运费', '退货快递费', '运费太贵', '运费垫付'] },
    { name: '物流信息停滞', kw: ['物流更新', '没更新', '还没发货', '快递显示异常'] },
    { name: '机器人与客服响应体验', kw: ['机器人', '客服态度', '才有客服接', '人手不够'] }
  ];

  var C = {
    ink: '#141E28', ink2: '#56697A', ink3: '#8496A5',
    line: '#D2DAE2', line2: '#E4E9EE',
    alert: '#A82A2E', warn: '#9C6512', notice: '#3F6482',
    calm: '#2E5E8E', calm2: '#9FBBD2', good: '#2B7357'
  };
  var LEVEL = { 1: '严重', 2: '关注', 3: '留意' };

  /* ============================================================
     1. 校验
     ============================================================ */
  var REQUIRED = ['ticket_id', 'created_at', 'category', 'description',
    'priority', 'resolution_time_hours', 'satisfaction', 'channel', 'is_resolved'];
  var PRIORITY_MAP = { '高': '高', '中': '中', '低': '低', high: '高', medium: '中', low: '低' };

  function parseDate(s) {
    if (typeof s !== 'string') return null;
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2}))?/);
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
    return isNaN(d.getTime()) ? null : d;
  }

  function validate(text) {
    var errs = [], raw;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return { ok: false, errs: ['文件不是有效的 JSON：' + e.message, '如果是从工单系统导出的，请确认导出格式选的是 JSON，而不是 Excel 改后缀名。'] };
    }
    if (!Array.isArray(raw)) {
      if (raw && Array.isArray(raw.data)) raw = raw.data;
      else return { ok: false, errs: ['文件最外层需要是一个工单数组 [ … ]，当前是 ' + (raw === null ? 'null' : typeof raw) + '。'] };
    }
    if (!raw.length) return { ok: false, errs: ['文件里没有工单记录。'] };

    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var t = raw[i], where = '第 ' + (i + 1) + ' 条';
      if (!t || typeof t !== 'object') { errs.push(where + '不是一条工单记录。'); continue; }
      if (t.ticket_id) where = '工单 ' + t.ticket_id;
      var miss = REQUIRED.filter(function (f) { return !(f in t); });
      if (miss.length) { errs.push(where + ' 缺少字段：' + miss.join('、')); continue; }
      var d = parseDate(t.created_at);
      if (!d) { errs.push(where + ' 的 created_at「' + t.created_at + '」无法识别，需要 YYYY-MM-DD HH:MM 格式。'); continue; }
      var pri = PRIORITY_MAP[t.priority];
      if (!pri) { errs.push(where + ' 的 priority「' + t.priority + '」不认识，应为 高 / 中 / 低。'); continue; }
      var rt = Number(t.resolution_time_hours);
      if (!isFinite(rt) || rt < 0) { errs.push(where + ' 的处理时长「' + t.resolution_time_hours + '」不是有效数字。'); continue; }
      var sat = Number(t.satisfaction);
      if (!isFinite(sat) || sat < 1 || sat > 5) { errs.push(where + ' 的满意度「' + t.satisfaction + '」超出 1–5 分范围。'); continue; }
      out.push({
        id: String(t.ticket_id), at: d, day: dayKey(d),
        cat: String(t.category), desc: String(t.description),
        pri: pri, rt: rt, sat: sat, ch: String(t.channel),
        done: t.is_resolved === true || t.is_resolved === 1 || t.is_resolved === '是'
      });
    }
    if (!out.length) return { ok: false, errs: ['没有一条工单通过校验。'].concat(errs.slice(0, 6)) };
    return { ok: true, tickets: out, warn: errs };
  }

  /* ============================================================
     2. 分析
     ============================================================ */
  function dayKey(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : 0; }
  function median(a) {
    if (!a.length) return 0;
    var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function r1(n) { return Math.round(n * 10) / 10; }
  function r2(n) { return Math.round(n * 100) / 100; }
  function groupBy(arr, fn) {
    var m = {};
    arr.forEach(function (x) { var k = fn(x); (m[k] = m[k] || []).push(x); });
    return m;
  }
  function cnMD(key) { var p = key.split('-'); return +p[1] + '月' + (+p[2]) + '日'; }

  function stats(list) {
    return {
      n: list.length,
      sat: r2(mean(list.map(function (t) { return t.sat; }))),
      rt: r1(mean(list.map(function (t) { return t.rt; }))),
      unres: list.filter(function (t) { return !t.done; }).length,
      doneRate: list.length ? Math.round(list.filter(function (t) { return t.done; }).length / list.length * 100) : 0
    };
  }

  function analyze(tickets) {
    tickets = tickets.slice().sort(function (a, b) { return a.at - b.at; });
    var start = tickets[0].at, end = tickets[tickets.length - 1].at;

    // 按日填满（含没有工单的日子）
    var days = [], cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    var last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    while (cur <= last) { days.push(dayKey(cur)); cur.setDate(cur.getDate() + 1); }
    var byDay = groupBy(tickets, function (t) { return t.day; });
    var daily = days.map(function (k) {
      var g = byDay[k] || [], s = stats(g);
      return { day: k, label: cnMD(k), n: g.length, sat: g.length ? s.sat : null, rt: s.rt, unres: s.unres, done: g.length - s.unres };
    });

    // 对半切
    var firstLen = Math.ceil(days.length / 2), secondLen = days.length - firstLen;
    var cutDay = days[firstLen - 1];
    var segA = tickets.filter(function (t) { return t.day <= cutDay; });
    var segB = tickets.filter(function (t) { return t.day > cutDay; });

    var cats = Object.keys(groupBy(tickets, function (t) { return t.cat; }));
    var byCat = cats.map(function (c) {
      var g = tickets.filter(function (t) { return t.cat === c; });
      var a = segA.filter(function (t) { return t.cat === c; }).length;
      var b = segB.filter(function (t) { return t.cat === c; }).length;
      var rateA = a / firstLen, rateB = secondLen ? b / secondLen : 0;
      var s = stats(g);
      return {
        cat: c, n: g.length, share: Math.round(g.length / tickets.length * 100),
        sat: s.sat, rt: s.rt, unres: s.unres, doneRate: s.doneRate,
        a: a, b: b, rateA: r2(rateA), rateB: r2(rateB),
        ratio: rateA > 0 ? rateB / rateA : (rateB > 0 ? Infinity : 1),
        tickets: g
      };
    }).sort(function (x, y) { return y.n - x.n; });

    var pris = ['高', '中', '低'].filter(function (p) {
      return tickets.some(function (t) { return t.pri === p; });
    }).map(function (p) {
      var g = tickets.filter(function (t) { return t.pri === p; }), s = stats(g);
      return { pri: p, n: g.length, sat: s.sat, rt: s.rt, unres: s.unres, doneRate: s.doneRate };
    });

    var chs = Object.keys(groupBy(tickets, function (t) { return t.ch; })).map(function (c) {
      var g = tickets.filter(function (t) { return t.ch === c; }), s = stats(g);
      return { ch: c, n: g.length, sat: s.sat, rt: s.rt, unres: s.unres, doneRate: s.doneRate };
    }).sort(function (x, y) { return y.n - x.n; });

    // 问题指纹
    var prints = FINGERPRINTS.map(function (f) {
      var hit = tickets.filter(function (t) {
        return f.kw.some(function (k) { return t.desc.indexOf(k) >= 0; });
      });
      return { name: f.name, kw: f.kw, tickets: hit, n: hit.length };
    }).filter(function (f) { return f.n > 0; }).sort(function (x, y) { return y.n - x.n; });

    var all = stats(tickets);
    var medRT = median(tickets.map(function (t) { return t.rt; }));

    var model = {
      tickets: tickets, daily: daily, byCat: byCat, pris: pris, chs: chs, prints: prints,
      start: start, end: end, days: days, firstLen: firstLen, secondLen: secondLen, cutDay: cutDay,
      segA: segA, segB: segB, medRT: medRT,
      kpi: {
        total: tickets.length, doneRate: all.doneRate, unres: all.unres,
        rt: all.rt, medRT: r1(medRT), sat: all.sat,
        lowSat: tickets.filter(function (t) { return t.sat <= 2; }).length
      }
    };
    model.anomalies = detect(model);
    model.flagged = {};
    model.anomalies.forEach(function (a) {
      a.tickets.forEach(function (t) { model.flagged[t.id] = true; });
    });
    return model;
  }

  /* ---------- 异常识别 ---------- */
  function detect(m) {
    var out = [];
    var segALabel = cnMD(m.days[0]) + '–' + cnMD(m.cutDay) + '（' + m.firstLen + ' 天）';
    var segBLabel = cnMD(m.days[m.firstLen]) + '–' + cnMD(m.days[m.days.length - 1]) + '（' + m.secondLen + ' 天）';

    // R1 某类工单激增
    m.byCat.forEach(function (c) {
      if (c.b < RULES.SURGE_MIN_COUNT || c.ratio < RULES.SURGE_WARN) return;
      var lv = c.ratio >= RULES.SURGE_CRIT ? 1 : 2;
      var pct = isFinite(c.ratio) ? Math.round((c.ratio - 1) * 100) + '%' : '从无到有';
      out.push({
        lv: lv, rule: 'R1',
        title: '「' + c.cat + '」明显变多了',
        why: '后半段 ' + segBLabel + ' 共 ' + c.b + ' 张，日均 ' + c.rateB + ' 张；前半段 ' + segALabel +
          ' 共 ' + c.a + ' 张，日均 ' + c.rateA + ' 张，涨幅 ' + pct +
          '。超过「日均涨幅 ' + Math.round((RULES.SURGE_WARN - 1) * 100) + '% 且后段不少于 ' + RULES.SURGE_MIN_COUNT + ' 张」的预警线。',
        act: '先看这类工单里有没有共同的触发条件（同一个功能、同一批订单、同一天上线的改动），再决定是加人手还是推给对应团队。',
        tickets: c.tickets.filter(function (t) { return t.day > m.cutDay; })
      });
    });

    // R2 同一问题反复出现
    m.prints.forEach(function (f) {
      if (f.n < RULES.RECUR_WARN) return;
      var span = {}; f.tickets.forEach(function (t) { span[t.day] = 1; });
      out.push({
        lv: f.n >= RULES.RECUR_CRIT ? 1 : 2, rule: 'R2',
        title: '反复出现：' + f.name,
        why: f.n + ' 张工单的描述里出现了同一组说法（' + f.kw.slice(0, 3).join('、') + '…），分布在 ' +
          Object.keys(span).length + ' 天里。命中 ' + RULES.RECUR_WARN + ' 张即提示、' + RULES.RECUR_CRIT +
          ' 张记为严重。同一件事被不同客户反复提起，通常不是客服能单独解决的。',
        act: '把这几张工单的原话打包给能改系统或改流程的人，比逐张回复省力，也能真正止住来单。',
        tickets: f.tickets
      });
    });

    // R3 高优先级未解决积压
    var backlog = m.tickets.filter(function (t) { return !t.done && t.pri === '高'; })
      .sort(function (a, b) { return b.rt - a.rt; });
    if (backlog.length) {
      out.push({
        lv: backlog.length >= RULES.BACKLOG_CRIT ? 1 : 2, rule: 'R3',
        title: '高优先级工单还挂着 ' + backlog.length + ' 张',
        why: '这些工单标记为高优先级但至今未解决，平均已经挂了 ' +
          r1(mean(backlog.map(function (t) { return t.rt; }))) + ' 小时，最久的一张 ' +
          Math.max.apply(null, backlog.map(function (t) { return t.rt; })) + ' 小时。下面按已耗时从多到少排列。',
        act: '逐张确认卡在哪一环：等客户回复、等其他部门，还是没人认领。挂得最久的几张先给客户一个明确答复时间。',
        tickets: backlog
      });
    }

    // R4 满意度垫底的分类
    m.byCat.forEach(function (c) {
      if (c.n < RULES.LOW_SAT_MIN_N || c.sat > RULES.LOW_SAT) return;
      out.push({
        lv: 2, rule: 'R4',
        title: '「' + c.cat + '」的满意度只有 ' + c.sat + ' 分',
        why: '共 ' + c.n + ' 张工单，平均满意度 ' + c.sat + ' 分（满分 5），已经跌到 ' + RULES.LOW_SAT +
          ' 分预警线；平均处理 ' + c.rt + ' 小时，解决率 ' + c.doneRate + '%。下面列出其中打 1–2 分的工单。',
        act: '看看低分集中在处理慢还是结果不如客户预期。前者靠排班和流程，后者要动政策，别用同一招。',
        tickets: c.tickets.filter(function (t) { return t.sat <= 2; })
      });
    });

    // R5 满意度整体下滑
    var satA = r2(mean(m.segA.map(function (t) { return t.sat; })));
    var satB = r2(mean(m.segB.map(function (t) { return t.sat; })));
    if (satA - satB >= RULES.SAT_DROP) {
      out.push({
        lv: 2, rule: 'R5',
        title: '满意度在往下掉',
        why: '前半段 ' + segALabel + ' 平均 ' + satA + ' 分，后半段 ' + segBLabel + ' 平均 ' + satB +
          ' 分，掉了 ' + r2(satA - satB) + ' 分，超过 ' + RULES.SAT_DROP + ' 分预警线。下面列出的是后半段打 1–2 分的工单。',
        act: '对照上面的分类趋势看是不是被某一类问题拖下去的，单独盯那一类比全员强调服务态度更有效。',
        tickets: m.segB.filter(function (t) { return t.sat <= 2; })
      });
    }

    // R6 又慢又差的单子
    var slow = m.tickets.filter(function (t) {
      return t.rt >= m.medRT * RULES.SLOW_FACTOR && t.sat <= RULES.SLOW_SAT;
    }).sort(function (a, b) { return b.rt - a.rt; });
    if (slow.length) {
      out.push({
        lv: 3, rule: 'R6',
        title: '又慢又差的工单有 ' + slow.length + ' 张',
        why: '处理时长达到全部工单中位数（' + r1(m.medRT) + ' 小时）的 ' + RULES.SLOW_FACTOR + ' 倍以上，' +
          '也就是超过 ' + r1(m.medRT * RULES.SLOW_FACTOR) + ' 小时，同时满意度只有 ' + RULES.SLOW_SAT + ' 分或更低。',
        act: '这批单子适合拿到周会上复盘：慢在哪一步、是谁在等谁，往往能找出一条卡所有人的流程。',
        tickets: slow
      });
    }

    // R7 渠道差距
    if (m.chs.length >= 2) {
      var sorted = m.chs.slice().sort(function (a, b) { return a.sat - b.sat; });
      var lo = sorted[0], hi = sorted[sorted.length - 1];
      if (hi.sat - lo.sat >= RULES.CHANNEL_GAP && lo.n >= 5) {
        out.push({
          lv: 3, rule: 'R7',
          title: lo.ch + '渠道的体验明显差一截',
          why: lo.ch + '渠道 ' + lo.n + ' 张工单，平均满意度 ' + lo.sat + ' 分、平均处理 ' + lo.rt + ' 小时；' +
            hi.ch + '渠道 ' + hi.n + ' 张，' + hi.sat + ' 分、' + hi.rt + ' 小时。两者相差 ' + r2(hi.sat - lo.sat) +
            ' 分，超过 ' + RULES.CHANNEL_GAP + ' 分预警线。',
          act: '先判断是这个渠道本身体验差，还是难题都被转到了这个渠道。看该渠道的分类构成就能区分。',
          tickets: m.tickets.filter(function (t) { return t.ch === lo.ch && t.sat <= 2; })
        });
      }
    }

    return out.sort(function (a, b) { return a.lv - b.lv || b.tickets.length - a.tickets.length; });
  }

  /* ============================================================
     3. 渲染
     ============================================================ */
  var charts = [];
  var MODEL = null;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function $(id) { return document.getElementById(id); }

  function render(m) {
    MODEL = m;
    $('intro').style.display = 'none';
    var rep = $('report');
    rep.style.display = 'block';
    rep.classList.add('enter');

    $('range').textContent = cnMD(m.days[0]) + ' – ' + cnMD(m.days[m.days.length - 1]) +
      ' · ' + m.days.length + ' 天 · ' + m.kpi.total + ' 张工单';
    $('footN').textContent = m.kpi.total;

    renderHero(m);
    renderKpis(m);
    renderRulebook();
    renderChannel(m);
    renderTable(m);
    drawCharts(m);
    window.scrollTo(0, 0);
  }

  function alertCard(a, i) {
    var ids = a.tickets.slice(0, 40);
    return '<article class="alert lv' + a.lv + '">' +
      '<div class="alert-head"><span class="tag">' + LEVEL[a.lv] + '</span><h3>' + esc(a.title) + '</h3></div>' +
      '<p class="why">' + esc(a.why) + '</p>' +
      (a.act ? '<p class="act"><b>建议</b>' + esc(a.act) + '</p>' : '') +
      (ids.length ? '<div class="tix">' + ids.map(function (t) {
        return '<button data-goto="' + esc(t.id) + '" title="在明细里查看">' + esc(t.id) + '</button>';
      }).join('') + (a.tickets.length > 40 ? '<span class="pill">等 ' + a.tickets.length + ' 张</span>' : '') + '</div>' : '') +
      (ids.length ? '<button class="toggle" data-ev="' + i + '">展开这些工单的原话</button>' +
        '<div class="evidence" id="ev' + i + '"><table>' + a.tickets.map(function (t) {
          return '<tr><td>' + esc(t.id) + '</td><td class="d">' + esc(t.desc) + '</td>' +
            '<td>' + esc(t.cat) + ' · ' + t.rt + 'h · ' + t.sat + '分 · ' + (t.done ? '已解决' : '未解决') + '</td></tr>';
        }).join('') + '</table></div>' : '') +
      '</article>';
  }

  function renderHero(m) {
    var crit = m.anomalies.filter(function (a) { return a.lv === 1; });
    var main = m.anomalies.filter(function (a) { return a.lv <= 2; });
    var minor = m.anomalies.filter(function (a) { return a.lv === 3; });

    $('heroTitle').textContent = m.anomalies.length
      ? '需要你过问的 ' + main.length + ' 件事'
      : '这段时间没有触发任何异常';
    $('heroLede').textContent = m.anomalies.length
      ? (crit.length ? '其中 ' + crit.length + ' 件建议今天就处理，最要紧的是：' + crit[0].title + '。' : '没有严重级别的信号。') +
        '每条结论都写清了判断依据，点工单号可以跳到明细核对原话。'
      : '所有指标都在阈值内。下面的图表可以用来看常规走势。';

    var html = main.map(function (a, i) { return alertCard(a, i); }).join('');
    if (minor.length) {
      html += '<details class="minor"><summary>另外还有 ' + minor.length + ' 条次要信号，展开看看</summary>' +
        minor.map(function (a, i) { return alertCard(a, main.length + i); }).join('') + '</details>';
    }
    $('alerts').innerHTML = html;

    if (!$('alerts').dataset.bound) {
      $('alerts').dataset.bound = '1';
      $('alerts').addEventListener('click', function (e) {
        var g = e.target.closest('[data-goto]');
        if (g) { gotoTicket(g.getAttribute('data-goto')); return; }
        var tg = e.target.closest('[data-ev]');
        if (tg) {
          var box = $('ev' + tg.getAttribute('data-ev'));
          var open = box.classList.toggle('open');
          tg.textContent = open ? '收起原话' : '展开这些工单的原话';
        }
      });
    }
  }

  function renderKpis(m) {
    var k = m.kpi;
    var items = [
      { v: k.total, k: '工单总量', n: m.days.length + ' 天，日均 ' + r1(k.total / m.days.length) + ' 张' },
      { v: k.doneRate, u: '%', k: '解决率', n: '还有 ' + k.unres + ' 张未解决', bad: k.unres > 0 },
      { v: k.rt, u: 'h', k: '平均处理时长', n: '中位数 ' + k.medRT + ' 小时' },
      { v: k.sat, k: '平均满意度', n: '满分 5 分', bad: k.sat < 3 },
      { v: k.lowSat, k: '打 1–2 分的工单', n: '占 ' + Math.round(k.lowSat / k.total * 100) + '%', bad: k.lowSat > k.total * 0.3 }
    ];
    $('kpis').innerHTML = items.map(function (i) {
      return '<div class="kpi' + (i.bad ? ' bad' : '') + '"><div class="v">' + i.v +
        (i.u ? '<small>' + i.u + '</small>' : '') + '</div><div class="k">' + i.k + '</div><div class="n">' + i.n + '</div></div>';
    }).join('');
  }

  function renderRulebook() {
    $('rulebook').innerHTML = [
      'R1 某类工单激增：把周期对半切，后半段日均 ≥ 前半段 ' + RULES.SURGE_WARN + ' 倍（且后半段不少于 ' + RULES.SURGE_MIN_COUNT + ' 张）记为关注，≥ ' + RULES.SURGE_CRIT + ' 倍记为严重。',
      'R2 同一问题反复出现：按关键词把描述归到同一个「问题指纹」，命中 ≥ ' + RULES.RECUR_WARN + ' 张记为关注，≥ ' + RULES.RECUR_CRIT + ' 张记为严重。',
      'R3 高优先级积压：优先级为高且未解决的工单全部列出，≥ ' + RULES.BACKLOG_CRIT + ' 张记为严重。',
      'R4 分类满意度垫底：某分类样本 ≥ ' + RULES.LOW_SAT_MIN_N + ' 张且平均满意度 ≤ ' + RULES.LOW_SAT + ' 分。',
      'R5 满意度下滑：后半段平均满意度比前半段低 ≥ ' + RULES.SAT_DROP + ' 分。',
      'R6 又慢又差：处理时长 ≥ 中位数的 ' + RULES.SLOW_FACTOR + ' 倍，且满意度 ≤ ' + RULES.SLOW_SAT + ' 分。',
      'R7 渠道差距：满意度最高与最低的渠道相差 ≥ ' + RULES.CHANNEL_GAP + ' 分。',
      '阈值是固定的，不需要设置；用中位数和日均而不是总量，是为了不被单日高峰和不等长的时间段带偏。'
    ].map(function (s) { return '<li>' + s + '</li>'; }).join('');
  }

  function renderChannel(m) {
    var maxRT = Math.max.apply(null, m.chs.map(function (c) { return c.rt; })) || 1;
    var rows = [];
    rows.push('<p class="cmp-h">平均满意度（满分 5）</p>');
    m.chs.forEach(function (c) {
      rows.push('<div class="cmp-row"><span>' + esc(c.ch) + '</span><span class="bar"><i style="width:' +
        (c.sat / 5 * 100) + '%' + (c.sat < 2.5 ? ';background:var(--alert)' : '') + '"></i></span><span class="val">' + c.sat + '</span></div>');
    });
    rows.push('<p class="cmp-h" style="margin-top:8px">平均处理时长（小时）</p>');
    m.chs.forEach(function (c) {
      rows.push('<div class="cmp-row"><span>' + esc(c.ch) + '</span><span class="bar"><i class="warnc" style="width:' +
        (c.rt / maxRT * 100) + '%"></i></span><span class="val">' + c.rt + '</span></div>');
    });
    rows.push('<p class="cmp-h" style="margin-top:8px">工单量与未解决数</p>');
    var maxN = Math.max.apply(null, m.chs.map(function (c) { return c.n; })) || 1;
    m.chs.forEach(function (c) {
      rows.push('<div class="cmp-row"><span>' + esc(c.ch) + '</span><span class="bar"><i style="width:' +
        (c.n / maxN * 100) + '%"></i></span><span class="val">' + c.n + ' / ' + c.unres + '</span></div>');
    });
    $('cmpChannel').innerHTML = rows.join('');
  }

  /* ---------- 明细表 ---------- */
  function fillSelect(el, values) {
    values.forEach(function (v) {
      var o = document.createElement('option'); o.value = v; o.textContent = v; el.appendChild(o);
    });
  }

  function renderTable(m) {
    if (!$('fCat').dataset.ready) {
      fillSelect($('fCat'), m.byCat.map(function (c) { return c.cat; }));
      fillSelect($('fPri'), m.pris.map(function (p) { return p.pri; }));
      fillSelect($('fCh'), m.chs.map(function (c) { return c.ch; }));
      $('fCat').dataset.ready = '1';
      ['fCat', 'fPri', 'fCh', 'fUnres', 'fFlag', 'fQ'].forEach(function (id) {
        $(id).addEventListener('input', paintTable);
      });
    }
    paintTable();
  }

  function paintTable() {
    var m = MODEL;
    var cat = $('fCat').value, pri = $('fPri').value, ch = $('fCh').value;
    var unres = $('fUnres').checked, flag = $('fFlag').checked, q = $('fQ').value.trim();
    var rows = m.tickets.filter(function (t) {
      return (!cat || t.cat === cat) && (!pri || t.pri === pri) && (!ch || t.ch === ch) &&
        (!unres || !t.done) && (!flag || m.flagged[t.id]) &&
        (!q || t.desc.indexOf(q) >= 0 || t.id.indexOf(q) >= 0);
    });
    if (!rows.length) {
      $('tableWrap').innerHTML = '<div class="panel empty">没有符合条件的工单。把筛选条件放宽一点试试。</div>';
      return;
    }
    var html = '<table class="data"><thead><tr><th>工单</th><th>时间</th><th>分类</th><th>优先级</th>' +
      '<th>问题描述</th><th style="text-align:right">时长</th><th style="text-align:right">满意度</th><th>渠道</th><th>状态</th></tr></thead><tbody>';
    rows.forEach(function (t) {
      html += '<tr id="row-' + esc(t.id) + '"' + (m.flagged[t.id] ? ' class="flagged"' : '') + '>' +
        '<td class="id">' + esc(t.id) + '</td>' +
        '<td class="n">' + cnMD(t.day) + ' ' + pad(t.at.getHours()) + ':' + pad(t.at.getMinutes()) + '</td>' +
        '<td>' + esc(t.cat) + '</td>' +
        '<td><span class="pill p' + t.pri + '">' + t.pri + '</span></td>' +
        '<td>' + esc(t.desc) + '</td>' +
        '<td class="n">' + t.rt + 'h</td>' +
        '<td class="n sat' + t.sat + '">' + t.sat + '</td>' +
        '<td>' + esc(t.ch) + '</td>' +
        '<td class="' + (t.done ? 'yes' : 'no') + '">' + (t.done ? '已解决' : '未解决') + '</td></tr>';
    });
    $('tableWrap').innerHTML = html + '</tbody></table>';
  }

  function gotoTicket(id) {
    ['fCat', 'fPri', 'fCh'].forEach(function (i) { $(i).value = ''; });
    $('fUnres').checked = false; $('fFlag').checked = false; $('fQ').value = '';
    paintTable();
    var row = $('row-' + id);
    if (!row) return;
    document.querySelectorAll('tr.hl').forEach(function (r) { r.classList.remove('hl'); });
    row.classList.add('hl');
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* ---------- 图表 ---------- */
  function drawCharts(m) {
    charts.forEach(function (c) { c.destroy(); });
    charts = [];
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.font.size = 12;
    Chart.defaults.color = C.ink2;

    charts.push(new Chart($('cDaily'), {
      data: {
        labels: m.daily.map(function (d) { return d.label; }),
        datasets: [
          { type: 'bar', label: '已解决', data: m.daily.map(function (d) { return d.done; }), backgroundColor: C.calm2, stack: 's', order: 3 },
          { type: 'bar', label: '未解决', data: m.daily.map(function (d) { return d.unres; }), backgroundColor: C.alert, stack: 's', order: 3 },
          {
            type: 'line', label: '平均满意度', data: m.daily.map(function (d) { return d.sat; }),
            yAxisID: 'y1', borderColor: C.ink, backgroundColor: C.ink, tension: .25,
            pointRadius: 3, borderWidth: 2, spanGaps: true, order: 1
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } },
          y: { stacked: true, beginAtZero: true, title: { display: true, text: '工单量' }, grid: { color: C.line2 }, ticks: { precision: 0 } },
          y1: { position: 'right', min: 1, max: 5, title: { display: true, text: '满意度' }, grid: { display: false } }
        },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } } }
      }
    }));

    charts.push(new Chart($('cCat'), {
      type: 'bar',
      data: {
        labels: m.byCat.map(function (c) { return c.cat; }),
        datasets: [
          { label: '前半段日均', data: m.byCat.map(function (c) { return c.rateA; }), backgroundColor: C.calm2 },
          {
            label: '后半段日均', data: m.byCat.map(function (c) { return c.rateB; }),
            backgroundColor: m.byCat.map(function (c) { return c.ratio >= RULES.SURGE_WARN && c.b >= RULES.SURGE_MIN_COUNT ? C.alert : C.calm; })
          }
        ]
      },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        scales: {
          x: { beginAtZero: true, title: { display: true, text: '每天平均工单数' }, grid: { color: C.line2 } },
          y: { grid: { display: false } }
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } },
          tooltip: {
            callbacks: {
              afterBody: function (items) {
                var c = m.byCat[items[0].dataIndex];
                return '合计 ' + c.n + ' 张（占 ' + c.share + '%）\n平均 ' + c.rt + ' 小时 · 满意度 ' + c.sat + ' 分 · 未解决 ' + c.unres + ' 张';
              }
            }
          }
        }
      }
    }));

    charts.push(new Chart($('cPri'), {
      data: {
        labels: m.pris.map(function (p) { return p.pri + '优先级' }),
        datasets: [
          { type: 'bar', label: '平均处理时长（小时）', data: m.pris.map(function (p) { return p.rt; }), backgroundColor: C.calm, order: 2 },
          {
            type: 'line', label: '平均满意度', data: m.pris.map(function (p) { return p.sat; }),
            yAxisID: 'y1', borderColor: C.alert, backgroundColor: C.alert, borderWidth: 2, pointRadius: 4, tension: .2, order: 1
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false } },
          y: { beginAtZero: true, title: { display: true, text: '小时' }, grid: { color: C.line2 } },
          y1: { position: 'right', min: 1, max: 5, title: { display: true, text: '满意度' }, grid: { display: false } }
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10 } },
          tooltip: {
            callbacks: {
              afterBody: function (items) {
                var p = m.pris[items[0].dataIndex];
                return p.n + ' 张 · 解决率 ' + p.doneRate + '% · 未解决 ' + p.unres + ' 张';
              }
            }
          }
        }
      }
    }));

    charts.push(new Chart($('cScatter'), {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: '已解决',
            data: m.tickets.filter(function (t) { return t.done; }).map(pt),
            backgroundColor: 'rgba(46,94,142,.55)', pointRadius: 5
          },
          {
            label: '未解决',
            data: m.tickets.filter(function (t) { return !t.done; }).map(pt),
            backgroundColor: 'rgba(168,42,46,.75)', pointRadius: 6, pointStyle: 'triangle'
          }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: {
            type: 'logarithmic', title: { display: true, text: '处理时长（小时，对数刻度）' },
            grid: { color: C.line2 },
            ticks: { callback: function (v) { return [0.5, 1, 2, 4, 8, 24, 48, 120].indexOf(v) >= 0 ? v : ''; } }
          },
          y: { min: 0.5, max: 5.5, ticks: { stepSize: 1 }, title: { display: true, text: '满意度' }, grid: { color: C.line2 } }
        },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, usePointStyle: true } },
          tooltip: {
            callbacks: {
              label: function (i) {
                var t = i.raw.t;
                return t.id + ' · ' + t.cat + ' · ' + t.rt + ' 小时 · ' + t.sat + ' 分';
              },
              afterLabel: function (i) { return i.raw.t.desc; }
            }
          }
        }
      }
    }));

    function pt(t) { return { x: Math.max(t.rt, 0.5), y: t.sat, t: t }; }
  }

  /* ============================================================
     4. 交互
     ============================================================ */
  function showErrors(list) {
    var box = $('errbox');
    box.style.display = 'block';
    box.innerHTML = '<h3>这份文件读不了</h3><p style="margin:0;font-size:14px;color:var(--ink2)">修好下面的问题再传一次，或者先看示例数据确认格式。</p>' +
      '<ul>' + list.slice(0, 8).map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') +
      (list.length > 8 ? '<li>…还有 ' + (list.length - 8) + ' 条同类问题</li>' : '') + '</ul>';
  }

  function load(text) {
    var res = validate(text);
    if (!res.ok) { showErrors(res.errs); return; }
    $('errbox').style.display = 'none';
    render(analyze(res.tickets));
    if (res.warn && res.warn.length) {
      console.warn('已跳过 ' + res.warn.length + ' 条不合规工单：', res.warn);
    }
  }

  function readFile(file) {
    if (!file) return;
    if (!/\.json$/i.test(file.name)) {
      showErrors(['「' + file.name + '」不是 JSON 文件。目前只支持 .json 格式的工单导出。']);
      return;
    }
    var fr = new FileReader();
    fr.onload = function () { load(String(fr.result)); };
    fr.onerror = function () { showErrors(['文件读取失败，换一份文件试试。']); };
    fr.readAsText(file, 'utf-8');
  }

  // 供校验脚本调用（Node 环境下只导出分析逻辑，不绑定界面）
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { validate: validate, analyze: analyze, RULES: RULES, FINGERPRINTS: FINGERPRINTS };
  }
  if (typeof document === 'undefined') return;

  document.addEventListener('DOMContentLoaded', function () {
    $('pick').addEventListener('click', function () { $('file').click(); });
    $('file').addEventListener('change', function (e) { readFile(e.target.files[0]); });
    $('demo').addEventListener('click', function () { load($('sample-data').textContent); });
    $('again').addEventListener('click', function () {
      $('report').style.display = 'none';
      $('intro').style.display = 'flex';
      $('file').value = '';
      window.scrollTo(0, 0);
    });

    var drop = $('drop');
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files.length) readFile(e.dataTransfer.files[0]);
    });
  });
})();
