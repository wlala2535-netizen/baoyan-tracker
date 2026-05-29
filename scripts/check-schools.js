#!/usr/bin/env node
// 保研信息每日自动检查 v2.1
// 解析公告页，提取标题+日期+链接，对比昨天找新增
// GitHub Actions 每天 UTC 00:00 (北京时间8:00) 运行

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHECK_LIST = path.join(__dirname, '..', 'data', 'schools-check-list.json');
const FINDINGS = path.join(__dirname, '..', 'data', 'daily-findings.json');
const CHECK_LOG = path.join(__dirname, '..', 'data', 'check-log.json');
const CONCURRENCY = 8;
const TIMEOUT_MS = 10000;
const KW = ['夏令营', '推免', '优秀大学生', '暑期学校'];

function fetchUrl(url) {
  return new Promise((resolve) => {
    try {
      const client = url.startsWith('https') ? https : http;
      const req = client.get(url, { timeout: TIMEOUT_MS, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BaoyanChecker/2.1)' } }, (res) => {
        if (res.statusCode >= 400) { req.destroy(); return resolve({ ok: false, error: 'HTTP' + res.statusCode }); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; if (body.length > 200000) { req.destroy(); resolve({ ok: true, body }); } });
        res.on('end', () => resolve({ ok: true, body }));
      });
      req.on('error', e => resolve({ ok: false, error: e.code || e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    } catch(e) { resolve({ ok: false, error: e.message }); }
  });
}

const NAV_FILTER = /^(首页|登录|注册|返回|更多|通知公告|招生信息|夏令营报名|夏令营公示|预推免报名|预推免公示|夏令营考生|预推免考生|推免生信息|夏令营网上|推免生网报|大学生夏令营)$/;

function extractAnnouncements(html, baseUrl) {
  const items = [];
  const seen = new Set();
  const text = html.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#x?[0-9a-f]+;/gi, '');

  // Find dates in text
  const dates = [];
  let dm;
  const dp = /(20\d{2}[-./年]\d{1,2}[-./月]\d{1,2}[日]?)/g;
  while ((dm = dp.exec(text)) !== null) dates.push({ date: dm[1], pos: dm.index });

  // Find links
  const lp = /<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = lp.exec(text)) !== null) {
    const href = m[1].trim();
    const title = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!title || title.length < 6 || title.length > 200) continue;
    if (NAV_FILTER.test(title)) continue;
    if (/login|logon/i.test(href)) continue;
    if (/\.(png|jpg|gif|docx?|xlsx?|pdf|zip)$/i.test(href)) continue;
    if (!KW.some(kw => title.includes(kw))) continue;

    // Resolve URL
    let fullUrl = href;
    if (href.startsWith('/')) { try { fullUrl = new URL(baseUrl).origin + href; } catch(e) {} }
    else if (!href.startsWith('http')) { try { fullUrl = new URL(baseUrl).origin + '/' + href; } catch(e) {} }

    // Find nearest date
    const mp = m.index;
    let nd = '', cd = Infinity;
    for (const d of dates) { const dist = Math.abs(d.pos - mp); if (dist < cd && dist < 2000) { cd = dist; nd = d.date; } }
    if (nd && !nd.match(/20(25|26)/)) continue;

    // Dedup
    const key = title.substring(0, 60) + '|' + nd;
    if (seen.has(key)) continue;
    seen.add(key);

    items.push({ title: title.substring(0, 140), date: nd, url: fullUrl });
  }

  const pageTitle = (text.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
  return { items, pageTitle };
}

function loadPrevUrls() {
  if (!fs.existsSync(CHECK_LOG)) return new Set();
  try {
    const log = JSON.parse(fs.readFileSync(CHECK_LOG, 'utf-8'));
    const urls = new Set();
    (log.slice(-5) || []).forEach(entry => {
      (entry.discoveries || []).forEach(d => { (d.items || []).forEach(i => urls.add(i.url)); });
    });
    return urls;
  } catch(e) { return new Set(); }
}

async function run() {
  console.log('=== 保研信息每日自动检查 v2.1 ===');
  console.log(`开始: ${new Date().toLocaleString('zh-CN')}\n`);

  const schools = JSON.parse(fs.readFileSync(CHECK_LIST, 'utf-8'));
  const prevUrls = loadPrevUrls();
  console.log(`加载 ${schools.length} 校, ${prevUrls.size} 条历史公告\n`);

  const results = [];
  let newTotal = 0;

  for (let i = 0; i < schools.length; i += CONCURRENCY) {
    const batch = schools.slice(i, i + CONCURRENCY);
    const br = await Promise.all(batch.map(async (s) => {
      const urlResults = [];
      for (const url of (s.urls || [])) {
        const r = await fetchUrl(url);
        if (!r.ok) { urlResults.push({ url, error: r.error, reachable: false, items: [] }); continue; }
        const ex = extractAnnouncements(r.body, url);
        urlResults.push({ url, pageTitle: ex.pageTitle, reachable: true, items: ex.items });
      }
      const allItems = urlResults.flatMap(u => u.items);
      const newItems = allItems.filter(it => !prevUrls.has(it.url));
      if (newItems.length > 0) { console.log(`🆕 ${s.name} +${newItems.length}`); newTotal += newItems.length; }
      return { id: s.id, name: s.name, tier: s.tier, urls: urlResults, totalItems: allItems.length, newItems: newItems.length, allUnreachable: urlResults.every(u => !u.reachable) };
    }));
    results.push(...br);
    const done = Math.min(i + CONCURRENCY, schools.length);
    process.stdout.write(`\r${done}/${schools.length} | 新增:${newTotal} | 不可达:${results.filter(r=>r.allUnreachable).length}`);
  }
  console.log('\n');

  const discoveries = results.filter(r => r.totalItems > 0).map(r => {
    const allItems = r.urls.flatMap(u => u.items);
    return { school: r.name, tier: r.tier, id: r.id, totalAnnouncements: allItems.length, newAnnouncements: allItems.filter(it => !prevUrls.has(it.url)).length, items: allItems.map(i => ({ ...i, isNew: !prevUrls.has(i.url) })) };
  });

  const reachable = results.filter(r => !r.allUnreachable).length;
  const unreachable = results.filter(r => r.allUnreachable).length;
  const withItems = results.filter(r => r.totalItems > 0).length;
  const totalItems = discoveries.reduce((s, d) => s + d.totalAnnouncements, 0);

  console.log(`✅ 完成: ${results.length}校 | 📡可连${reachable} | ⚠️不可达${unreachable}`);
  console.log(`📋 公告: ${withItems}校共${totalItems}条 | 🆕新增${newTotal}条`);

  // Write findings (compact, for website)
  const findings = {
    checkedAt: new Date().toISOString(),
    totalSchools: results.length, reachableCount: reachable, unreachableCount: unreachable,
    schoolsWithItems: withItems, totalAnnouncements: totalItems, newAnnouncements: newTotal,
    discoveries: discoveries.sort((a, b) => b.newAnnouncements - a.newAnnouncements)
  };
  fs.writeFileSync(FINDINGS, JSON.stringify(findings));

  // Update log (keep last 60 days)
  let log = [];
  if (fs.existsSync(CHECK_LOG)) { try { log = JSON.parse(fs.readFileSync(CHECK_LOG, 'utf-8')); } catch(e) {} }
  log.push({ checkedAt: findings.checkedAt, newAnnouncements: newTotal, totalAnnouncements: totalItems, discoveries: discoveries.filter(d => d.newAnnouncements > 0).map(d => ({ school: d.school, tier: d.tier, newCount: d.newAnnouncements, items: d.items.filter(i => i.isNew) })) });
  if (log.length > 60) log = log.slice(-60);
  fs.writeFileSync(CHECK_LOG, JSON.stringify(log));

  console.log(`📁 已写入 daily-findings.json & check-log.json\n`);
  process.exit(0);
}

run().catch(err => { console.error('失败:', err); process.exit(1); });
