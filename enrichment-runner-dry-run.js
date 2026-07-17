const axios = require('axios');
const fs = require('fs');

const API_BASE = process.env.API_BASE;
const API_KEY = process.env.API_KEY;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '30', 10);
const OUTPUT_FILE = process.env.OUTPUT_FILE || `enrichment-dryrun-${Date.now()}.json`;

async function fetchProductJS(sourceUrl) {
  const handleMatch = sourceUrl.match(/\/products\/([^\/?]+)/);
  if (!handleMatch) return null;
  const handle = handleMatch[1].replace(/\.html$/, '');
  const storeUrl = new URL(sourceUrl).origin;
  const jsUrl = `${storeUrl}/products/${handle}.js`;

  try {
    const response = await axios.get(jsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*',
        'Referer': sourceUrl,
      },
      timeout: 15000
    });
    return response.data;
  } catch(e) {
    console.error(`Failed ${jsUrl}: status=${e.response?.status || 'unknown'}`);
    return null;
  }
}

function extractSizes(variants, options) {
  if (!variants?.length) return [];
  const sizeIndex = (options || []).findIndex(opt => /size/i.test(opt.name));
  if (sizeIndex >= 0) {
    return [...new Set(variants.map(v => v[`option${sizeIndex + 1}`]).filter(Boolean))];
  }
  const counts = [0, 0, 0];
  variants.forEach(v => {
    if (v.option1) counts[0]++;
    if (v.option2) counts[1]++;
    if (v.option3) counts[2]++;
  });
  const bestIndex = counts.indexOf(Math.max(...counts));
  return [...new Set(variants.map(v => v[`option${bestIndex + 1}`]).filter(Boolean))];
}

function detectPriceChanges(oldProduct, newData) {
  const notes = [];
  const rawPrice = newData.price;
  const rawCompare = newData.compare_at_price;
  const newPrice = rawPrice ? (rawPrice / (rawPrice > 100000 ? 100 : 1)) : null;
  const newCompare = rawCompare ? (rawCompare / (rawCompare > 100000 ? 100 : 1)) : null;

  if (oldProduct.price !== null && newPrice !== null && oldProduct.price !== newPrice) {
    notes.push({
      flag: 'price_changed',
      old: oldProduct.price,
      new: newPrice,
      at: new Date().toISOString()
    });
  }

  if (oldProduct.compare_price !== null && newCompare === null) {
    notes.push({
      flag: 'compare_price_removed',
      old: oldProduct.compare_price,
      at: new Date().toISOString()
    });
  } else if (oldProduct.compare_price !== null && newCompare !== null && oldProduct.compare_price !== newCompare) {
    notes.push({
      flag: 'compare_price_changed',
      old: oldProduct.compare_price,
      new: newCompare,
      at: new Date().toISOString()
    });
  }

  return notes;
}

async function getEnrichmentBatch(limit) {
  const res = await axios.get(`${API_BASE}/enrichment-products?limit=${limit}`, {
    headers: { 'x-api-key': API_KEY }
  });
  return res.data;
}

// CHANGE: replaced DB write with local file write for dry-run review
function writeReport(report) {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(report, null, 2));
  console.log(`\nDry-run report written to: ${OUTPUT_FILE}`);
}

async function run() {
  const batch = await getEnrichmentBatch(BATCH_SIZE);
  console.log(`Received ${batch.products.length} products to enrich (DRY RUN - no DB writes)`);

  if (batch.done || batch.products.length === 0) {
    console.log('No more products to enrich. Done.');
    process.exit(0);
  }

  const report = [];

  for (const product of batch.products) {
    console.log(`  Checking #${product.id}: ${product.source_url}`);
    const jsData = await fetchProductJS(product.source_url);
    if (!jsData) {
      console.log('    Failed to fetch .js, skipping.');
      report.push({
        id: product.id,
        source_url: product.source_url,
        status: 'fetch_failed'
      });
      continue;
    }

    // Build fields to update only if currently missing (same logic as live script)
    const fields = {};
    const before = {};

    if (!product.tags || product.tags === '[]') {
      before.tags = product.tags;
      fields.tags = JSON.stringify(jsData.tags || []);
    }
    if (!product.sizes || product.sizes === '[]') {
      before.sizes = product.sizes;
      fields.sizes = JSON.stringify(extractSizes(jsData.variants || [], jsData.options || []));
    }
    if (!product.description || product.description === '') {
      before.description = product.description;
      fields.description = jsData.description || '';
    }
    if (!product.options_data || product.options_data === '[]' || product.options_data === '') {
      before.options_data = product.options_data;
      fields.options_data = JSON.stringify(jsData.options || []);
    }
    if (!product.vendor) {
      before.vendor = product.vendor;
      fields.vendor = jsData.vendor || '';
    }
    if (!product.type) {
      before.type = product.type;
      fields.type = jsData.type || '';
    }

    // Always update stock status (same as live script)
    before.stock_status = product.stock_status;
    fields.stock_status = jsData.available ? 'in_stock' : 'out_of_stock';

    // Detect price/compare changes and create notes (same as live script)
    const notes = detectPriceChanges(product, jsData);

    report.push({
      id: product.id,
      source_url: product.source_url,
      title: product.title,
      before,
      would_write: fields,
      notes,
      raw_jsData_snapshot: {
        title: jsData.title,
        price: jsData.price,
        compare_at_price: jsData.compare_at_price,
        available: jsData.available,
        tags: jsData.tags,
        vendor: jsData.vendor,
        type: jsData.type,
        options: jsData.options,
        variants_count: (jsData.variants || []).length
      }
    });

    // Delay between products: 8-12 seconds (same as live script)
    await new Promise(r => setTimeout(r, 8000 + Math.random() * 4000));
  }

  writeReport(report);
  console.log(`\nBatch complete. Reviewed ${report.length} products, wrote 0 DB updates (dry run).`);
  process.exit(0);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
