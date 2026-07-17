const axios = require('axios');

const API_BASE = process.env.API_BASE;
const API_KEY = process.env.API_KEY;

async function fetchProductJS(sourceUrl) {
  const handleMatch = sourceUrl.match(/\/products\/([^\/?]+)/);
  if (!handleMatch) return { data: null, status: null };
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
    return { data: response.data, status: response.status };
  } catch(e) {
    const status = e.response?.status || null;
    console.error(`Failed ${jsUrl}: status=${status || 'unknown'}`);
    return { data: null, status };
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
  const rawPrice = newData.price;
  const rawCompare = newData.compare_at_price;
  const newPrice = rawPrice ? (rawPrice / (rawPrice > 100000 ? 100 : 1)) : null;
  const newCompare = rawCompare ? (rawCompare / (rawCompare > 100000 ? 100 : 1)) : null;

  return { newPrice, newCompare };
}

async function getEnrichmentBatch(limit = 30) {
  const res = await axios.get(`${API_BASE}/enrichment-products?limit=${limit}`, {
    headers: { 'x-api-key': API_KEY }
  });
  return res.data;
}

async function updateProducts(updates) {
  await axios.post(`${API_BASE}/enrichment-update`,
    { updates },
    { headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY } }
  );
}

async function run() {
  const batch = await getEnrichmentBatch(30);
  console.log(`Received ${batch.products.length} products to enrich`);

  if (batch.done || batch.products.length === 0) {
    console.log('No more products to enrich. Done.');
    process.exit(0);
  }

  const updates = [];

  for (const product of batch.products) {
    console.log(`  Enriching #${product.id}: ${product.source_url}`);
    const jsData = await fetchProductJS(product.source_url);
    const { data: jsData, status } = await fetchProductJS(product.source_url);

if (!jsData) {
  if (status === 404) {
    updates.push({
      id: product.id,
      fields: { stock_status: 'out_of_stock' },
      notes: [{ flag: 'not_found_404', at: new Date().toISOString() }]
    });
  }
  continue;
}

    // Build fields to update only if currently missing
    const fields = {};
    if (!product.tags || product.tags === '[]') {
      fields.tags = JSON.stringify(jsData.tags || []);
    }
    if (!product.sizes || product.sizes === '[]') {
      fields.sizes = JSON.stringify(extractSizes(jsData.variants || [], jsData.options || []));
    }
    if (!product.description || product.description === '') {
      fields.description = jsData.description || '';
    }
    if (!product.options_data || product.options_data === '[]' || product.options_data === '') {
      fields.options_data = JSON.stringify(jsData.options || []);
    }
    if (!product.vendor) {
      fields.vendor = jsData.vendor || '';
    }
    if (!product.type) {
      fields.type = jsData.type || '';
    }

    // Always update stock status
    fields.stock_status = jsData.available ? 'in_stock' : 'out_of_stock';

    // Detect price/compare changes and create notes
    const notes = detectPriceChanges(product, jsData);

    updates.push({
      id: product.id,
      fields,
      notes
    });

    // Delay between products: 8-12 seconds
    await new Promise(r => setTimeout(r, 5000 + Math.random() * 4000));
  }

  if (updates.length > 0) {
    await updateProducts(updates);
    console.log(`Updated ${updates.length} products.`);
  }

  console.log('Batch complete.');
  process.exit(0);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
