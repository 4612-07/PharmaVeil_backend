/**
 * PharmaVeil — RegIntel RSS Scraper
 * Tourne chaque matin via GitHub Actions
 * Scrape les sources réglementaires et pousse vers Railway
 */

'use strict';

const https = require('https');
const http  = require('http');

// ── Configuration ────────────────────────────────────────────────────────────

const RAILWAY_URL = process.env.RAILWAY_URL || 'https://pharmaveilbackend-production.up.railway.app';
const API_KEY     = process.env.INTERNAL_API_KEY;
const HOURS_BACK  = parseInt(process.env.HOURS_BACK || '25'); // items < 25h pour éviter les ratés

if (!API_KEY) {
  console.error('❌ INTERNAL_API_KEY manquant');
  process.exit(1);
}

// ── Sources RSS ───────────────────────────────────────────────────────────────

const SOURCES = [
  {
    code: 'EMA',
    name: 'European Medicines Agency',
    rss: 'https://www.ema.europa.eu/en/news/rss',
    vigilance_type: 'pv',
  },
  {
    code: 'FDA',
    name: 'Food and Drug Administration',
    rss: 'https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/drugs/rss.xml',
    vigilance_type: 'pv',
  },
  {
    code: 'ICH',
    name: 'International Council for Harmonisation',
    rss: 'https://www.ich.org/rss/news.xml',
    vigilance_type: 'pv',
  },
  {
    code: 'MHRA',
    name: 'Medicines and Healthcare products Regulatory Agency',
    rss: 'https://www.gov.uk/drug-safety-update.atom',
    vigilance_type: 'pv',
  },
  {
    code: 'ANSM',
    name: 'Agence Nationale de Sécurité du Médicament',
    rss: 'https://ansm.sante.fr/rss/informations_securite',
    vigilance_type: 'pv',
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'PharmaVeil-RegIntel-Bot/1.0 (contact@pharmaveil.eu)',
        'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml',
      },
      timeout: 15000,
    }, (res) => {
      // Gérer les redirections
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function parseRSS(xml, source) {
  const items = [];
  const cutoff = new Date(Date.now() - HOURS_BACK * 3600 * 1000);

  // Extraire les items RSS ou entries Atom
  const itemRegex = /<(?:item|entry)[\s>]([\s\S]*?)<\/(?:item|entry)>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];

    const getTag = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/${tag}>`, 'i'));
      return m ? m[1].trim().replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"') : null;
    };

    const title   = getTag('title');
    const link    = getTag('link') || getTag('id');
    const pubDate = getTag('pubDate') || getTag('published') || getTag('updated') || getTag('dc:date');
    const desc    = getTag('description') || getTag('summary') || getTag('content') || getTag('content:encoded') || '';

    if (!title) continue;

    // Vérifier la date
    if (pubDate) {
      const itemDate = new Date(pubDate);
      if (!isNaN(itemDate) && itemDate < cutoff) continue; // trop vieux
    }

    // Nettoyer le contenu HTML
    const content = desc
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 2000);

    items.push({
      title: title.substring(0, 200),
      url: link,
      content: content || title,
      published_date: pubDate
        ? new Date(pubDate).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10),
      source_code: source.code,
      vigilance_type: source.vigilance_type,
    });
  }

  return items;
}

function postToRailway(item) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      title:          item.title,
      url:            item.url,
      content:        item.content,
      source_code:    item.source_code,
      published_date: item.published_date,
    });

    const options = {
      hostname: RAILWAY_URL.replace('https://', '').replace('http://', '').split('/')[0],
      path:     '/api/regintel/submit',
      method:   'POST',
      headers: {
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-api-key':     API_KEY,
      },
      timeout: 30000,
    };

    const lib = RAILWAY_URL.startsWith('https') ? https : http;
    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 201 || res.statusCode === 200) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error(`Railway returned ${res.statusCode}: ${data.substring(0, 100)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Railway timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔭 PharmaVeil RegIntel Scraper — ${new Date().toISOString()}`);
  console.log(`📡 Railway: ${RAILWAY_URL}`);
  console.log(`⏰ Fenêtre: ${HOURS_BACK}h\n`);

  let totalFetched = 0;
  let totalPosted  = 0;
  let totalErrors  = 0;

  for (const source of SOURCES) {
    console.log(`\n📥 [${source.code}] ${source.name}`);

    let xml;
    try {
      xml = await fetchUrl(source.rss);
      console.log(`   ✅ RSS récupéré (${xml.length} chars)`);
    } catch (err) {
      console.error(`   ❌ Fetch error: ${err.message}`);
      totalErrors++;
      continue;
    }

    const items = parseRSS(xml, source);
    console.log(`   📄 ${items.length} item(s) dans les dernières ${HOURS_BACK}h`);
    totalFetched += items.length;

    if (items.length === 0) continue;

    // Poster chaque item vers Railway (séquentiel pour éviter le rate limit)
    for (const item of items) {
      try {
        const result = await postToRailway(item);
        console.log(`   ✓ Posté: "${item.title.substring(0, 60)}..." [${result.impact_score || '?'}]`);
        totalPosted++;
        // Pause 2s entre chaque appel Claude pour éviter le rate limit
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`   ✗ Post error: ${err.message}`);
        totalErrors++;
      }
    }
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`✅ Terminé — ${totalFetched} items récupérés, ${totalPosted} postés, ${totalErrors} erreurs`);
  console.log(`${'═'.repeat(50)}\n`);

  if (totalErrors > 0 && totalPosted === 0) {
    process.exit(1); // Faire échouer le run GitHub Actions si tout a planté
  }
}

main().catch(err => {
  console.error('💥 Fatal:', err.message);
  process.exit(1);
});
