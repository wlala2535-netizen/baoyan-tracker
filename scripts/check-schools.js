#!/usr/bin/env node
// Daily school check script
// Checks each school's graduate school / foreign language college pages for new 2026 announcements
// Runs via GitHub Actions daily at 8am Beijing time

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHECK_LIST = path.join(__dirname, '..', 'data', 'schools-check-list.json');
const FINDINGS = path.join(__dirname, '..', 'data', 'daily-findings.json');
const CHECK_LOG = path.join(__dirname, '..', 'data', 'check-log.json');

const CONCURRENCY = 10;
const TIMEOUT_MS = 8000;
const KEYWORDS = ['2026', '夏令营', '推免', '优秀大学生', '暑期学校', '预推免'];

function fetchUrl(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: TIMEOUT_MS, headers: { 'User-Agent': 'Mozilla/5.0 BaoyanChecker/1.0' } }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; if (body.length > 50000) { req.destroy(); resolve({ ok: true, body: body.substring(0, 50000) }); } });
      res.on('end', () => { resolve({ ok: true, body }); });
    });
    req.on('error', (err) => { resolve({ ok: false, error: err.code || err.message }); });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

function checkPage(html) {
  const found = [];
  const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
  for (const kw of KEYWORDS) {
    if (title.includes(kw)) found.push(kw);
  }
  // Also check meta and visible text for keywords
  const text = html.replace(/<[^>]+>/g, ' ').substring(0, 20000);
  for (const kw of KEYWORDS) {
    if (!found.includes(kw) && text.includes(kw)) found.push(kw);
  }
  return { title: title.substring(0, 100), keywords: found, hasMatch: found.length >= 2 };
}

async function run() {
  console.log('=== 保研信息每日自动检查 ===');
  console.log(`开始时间: ${new Date().toISOString()}`);
  console.log(`加载检查清单: ${CHECK_LIST}`);

  const schools = JSON.parse(fs.readFileSync(CHECK_LIST, 'utf-8'));
  console.log(`共 ${schools.length} 所学校待检查\n`);

  const results = [];
  const discoveries = [];

  // Process in batches
  for (let i = 0; i < schools.length; i += CONCURRENCY) {
    const batch = schools.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(async (school) => {
      const urlResults = [];
      for (const url of school.urls) {
        const result = await fetchUrl(url);
        if (result.ok) {
          const check = checkPage(result.body);
          urlResults.push({ url, title: check.title, keywords: check.keywords, reachable: true });
          if (check.hasMatch) {
            console.log(`🆕 ${school.name} (${school.tier}) - 发现关键词: ${check.keywords.join(', ')} | ${url}`);
          }
        } else {
          urlResults.push({ url, error: result.error, reachable: false });
        }
      }
      return {
        id: school.id,
        name: school.name,
        tier: school.tier,
        urls: urlResults,
        hasDiscovery: urlResults.some(u => u.reachable && u.keywords && u.keywords.length >= 2),
        allUnreachable: urlResults.every(u => !u.reachable)
      };
    }));
    results.push(...batchResults);

    // Progress
    const done = Math.min(i + CONCURRENCY, schools.length);
    const discovered = results.filter(r => r.hasDiscovery).length;
    const unreachable = results.filter(r => r.allUnreachable).length;
    process.stdout.write(`\r进度: ${done}/${schools.length}  |  发现: ${discovered}  |  不可达: ${unreachable}`);
  }

  console.log('\n');

  // Compile discoveries
  results.filter(r => r.hasDiscovery).forEach(r => {
    const matchedUrls = r.urls.filter(u => u.reachable && u.keywords && u.keywords.length >= 2);
    discoveries.push({
      school: r.name,
      tier: r.tier,
      id: r.id,
      foundAt: new Date().toISOString(),
      urls: matchedUrls.map(u => ({ url: u.url, title: u.title, keywords: u.keywords }))
    });
  });

  // Summary
  const reachableCount = results.filter(r => !r.allUnreachable).length;
  const discoveryCount = discoveries.length;
  const unreachableCount = results.filter(r => r.allUnreachable).length;

  console.log('=== 检查完成 ===');
  console.log(`总计: ${results.length} 所学校`);
  console.log(`可连接: ${reachableCount} 所`);
  console.log(`不可达: ${unreachableCount} 所`);
  console.log(`🔍 发现新通知: ${discoveryCount} 所`);
  discoveries.forEach(d => console.log(`  🆕 ${d.school} (${d.tier})`));

  // Write daily findings
  const findings = {
    checkedAt: new Date().toISOString(),
    totalSchools: results.length,
    reachableCount,
    unreachableCount,
    discoveryCount,
    discoveries,
    allResults: results
  };

  fs.writeFileSync(FINDINGS, JSON.stringify(findings, null, 2));
  console.log(`\n已写入: ${FINDINGS}`);

  // Update check log
  let log = [];
  if (fs.existsSync(CHECK_LOG)) {
    try { log = JSON.parse(fs.readFileSync(CHECK_LOG, 'utf-8')); } catch(e) {}
  }
  log.push({
    checkedAt: findings.checkedAt,
    discoveryCount,
    reachableCount,
    unreachableCount,
    discoveries: discoveries.map(d => ({ school: d.school, id: d.id }))
  });
  // Keep last 30 days
  if (log.length > 30) log = log.slice(-30);
  fs.writeFileSync(CHECK_LOG, JSON.stringify(log, null, 2));
  console.log(`已更新检查日志: ${CHECK_LOG}`);

  process.exit(0);
}

run().catch(err => { console.error('检查失败:', err); process.exit(1); });
