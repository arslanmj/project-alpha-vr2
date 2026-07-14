const cheerio = require('cheerio');
const axios = require('axios');

const API_BASE = process.env.API_BASE;
const API_KEY = process.env.API_KEY;

async function fetchCollectionPage(colUrl, baseUrl) {
  const res = await axios.get(colUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' }
  });
  const $ = cheerio.load(res.data);
  const productUrls = [];
  $('a[href*="/products/"]').each((i, el) => {
    const href = $(el).attr('href');
    if (href && !href.includes('#') && !href.includes('?')) {
      productUrls.push(href.startsWith('http') ? href : baseUrl + href);
    }
  });
  return [...new Set(productUrls)];
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

async function fetchProductFromJS(productUrl, storeUrl) {
  const handleMatch = productUrl.match(/\/products\/([^\/?]+)/);
  if (!handleMatch) return null;
  const handle = handleMatch[1].replace(/\.html$/, '');

  const jsUrl = `${storeUrl}/products/${handle}.js`;

  let data;
  try {
    const response = await axios.get(jsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Referer': productUrl,
      },
      timeout: 15000
    });
    data = response.data;
  } catch(e) {
    return null;
  }

  if (!data) return null;

  const rawPrice = data.price;
  const rawCompare = data.compare_at_price;

  return {
    title: data.title || null,
    price: rawPrice ? (rawPrice / (rawPrice > 100000 ? 100 : 1)) : null,
    comparePrice: rawCompare ? (rawCompare / (rawCompare > 100000 ? 100 : 1)) : null,
    stockStatus: data.available ? 'in_stock' : 'out_of_stock',
    sizes: extractSizes(data.variants || [], data.options || []),
    images: (data.images || []).map(img => img.startsWith('//') ? 'https:' + img : img),
    tags: data.tags || [],
    vendor: data.vendor || null,
    type: data.type || null,
    description: data.description || null
  };
}

// CHANGE: unified to axios (was native fetch)
async function getNextCollection() {
  const res = await axios.get(`${API_BASE}/fetch-next-collection`, {
    headers: { 'x-api-key': API_KEY }
  });
  return res.data;
}

// CHANGE: unified to axios (was native fetch)
async function saveProducts(collectionId, products, brandId) {
  const formatted = products.map(p => ({
    ...p,
    brand_id: brandId,
    slug: p.source_url ? p.source_url.split('/products/')[1]?.split('?')[0]?.replace(/\.html$/, '') : '',
    promo_type: p.promo_type || ''
  }));
  await axios.post(`${API_BASE}/save-products`, 
    { collection_id: collectionId, products: formatted },
    { headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY } }
  );
}

async function run() {
  const collection = await getNextCollection();
  console.log('Collection:', JSON.stringify(collection));

  if (collection.done) {
    console.log('No more collections to fetch.');
    process.exit(0);
  }

  // CHANGE: defensive check — fail gracefully instead of crashing on undefined fields
  if (!collection.collection_url || !collection.base_url || !collection.id) {
    console.error('Invalid collection payload received, likely a race condition on fetch-next-collection. Exiting cleanly.');
    console.error('Payload was:', JSON.stringify(collection));
    process.exit(0); // exit 0, not 1 — this run just had nothing valid to do, not a real failure
  }

  console.log(`Fetching: ${collection.brand_name} > ${collection.collection_url}`);

  const productUrls = await fetchCollectionPage(collection.collection_url, collection.base_url);
  const toFetch = productUrls.slice(0, collection.fetch_limit);

  const products = [];
  for (const url of toFetch) {
    try {
      const storeUrl = new URL(url).origin;
      const data = await fetchProductFromJS(url, storeUrl);
      if (data && data.price) {
        products.push({
          ...data,
          source_url: url,
          image: data.images[0] || '',
          compare_price: data.comparePrice,
          stock_status: data.stockStatus,
          promo_type: collection.type === 'sale' ? 'sale' : collection.type === 'new-arrival' ? 'new-arrival' : '',
          brand_id: collection.brand_id
        });
      }
    } catch(e) {
      console.error(`Error fetching ${url}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 5000));
  }

  if (products.length > 0) {
    await saveProducts(collection.id, products, collection.brand_id);
    console.log(`Saved ${products.length} products.`);
  }

  console.log('Collection done. Exiting to get fresh IP.');
  process.exit(0);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
