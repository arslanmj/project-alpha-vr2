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
    images: (data.images || []).map(img => img.startsWith('//') ? 'https:' + img : img),
    tags: data.tags || [],
    vendor: data.vendor || null,
    type: data.type || null
  };
}

async function getNextCollection() {
  const res = await fetch(`${API_BASE}/fetch-next-collection`, {
    headers: { 'x-api-key': API_KEY }
  });
  return res.json();
}

async function saveProducts(collectionId, products, brandId) {
  const formatted = products.map(p => ({
    ...p,
    brand_id: brandId,
    slug: p.source_url ? p.source_url.split('/products/')[1]?.split('?')[0]?.replace(/\.html$/, '') : '',
    promo_type: '' // will be set by collection type if needed
  }));
  await fetch(`${API_BASE}/save-products`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY
    },
    body: JSON.stringify({ collection_id: collectionId, products: formatted })
  });
}

async function run() {
  const collection = await getNextCollection();
  if (collection.done) {
    console.log('No more collections to fetch.');
    process.exit(0);
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
          images: data.images,
          image: data.images[0] || '',
          price: data.price,
          compare_price: data.comparePrice,
          stock_status: data.stockStatus,
          type: data.type,
          promo_type: collection.type === 'sale' ? 'sale' : collection.type === 'new-arrival' ? 'new-arrival' : '',
          brand_id: collection.brand_id // will be looked up server-side
        });
      }
    } catch(e) {
      console.error(`Error fetching ${url}: ${e.message}`);
    }
    // Small delay between products within the same IP run (we're on GitHub's IP, no need for huge delays)
    await new Promise(r => setTimeout(r, 500 + Math.random() * 1000));
  }

  if (products.length > 0) {
    await saveProducts(collection.id, products, 0); // brand_id server-side
    console.log(`Saved ${products.length} products.`);
  }

  console.log('Collection done. Exiting to get fresh IP.');
  process.exit(0);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
