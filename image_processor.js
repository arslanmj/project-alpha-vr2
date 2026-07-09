import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import pLimit from "p-limit";
import fetch from "node-fetch";
import sharp from "sharp";

const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY
  }
});

const BUCKET = process.env.BUCKET;
const CDN_URL = process.env.CDN;
const API_BASE = process.env.API_BASE;
const API_KEY = process.env.API_KEY;

async function getBatch(limit = 50) {
  const res = await fetch(`${API_BASE}/image-queue?limit=${limit}`, {
    headers: { 'x-api-key': API_KEY }
  });
  const data = await res.json();
  return data.products || [];
}

async function updateProduct(id, cdnImages, count) {
  await fetch(`${API_BASE}/image-update`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY
    },
    body: JSON.stringify({ id, cdnImages, count })
  });
}

async function downloadAndStream(url, brand, collection, productId, index) {
  const cleanUrl = url.split('?')[0];
  const response = await fetch(cleanUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = await response.arrayBuffer();
  const optimized = await sharp(buffer)
    .resize(1080, 1440, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();

  const key = `products/${brand}/${collection}/${productId}-${index}.webp`;
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: optimized,
    ContentType: 'image/webp'
  }));
  return `${CDN_URL}/${key}`;
}

async function processBatch(offset = 0, batchSize = 300) {
  const products = await getBatch(50);
  let imageQueue = [];

  for (const product of products) {
    const images = JSON.parse(product.images || '[]');
    const cdnImages = JSON.parse(product.cdn_images || '[]');
    images.forEach((url, idx) => {
      if (!cdnImages[idx]) {
        imageQueue.push({
          url,
          brand: product.brand_name,
          collection: product.collection_name,
          productId: product.id,
          index: idx
        });
      }
    });
  }

  const activeBatch = imageQueue.slice(offset, offset + batchSize);
  if (activeBatch.length === 0) {
    console.log('✅ All images processed.');
    process.exit(0);
  }

  const throttle = pLimit(8);
  const tasks = activeBatch.map(item => {
    return throttle(async () => {
      const cdnUrl = await downloadAndStream(item.url, item.brand, item.collection, item.productId, item.index);
      return { productId: item.productId, index: item.index, cdnUrl };
    });
  });

  const results = await Promise.all(tasks);

  const productUpdates = {};
  for (const { productId, index, cdnUrl } of results) {
    if (!productUpdates[productId]) {
      productUpdates[productId] = { cdnImages: {}, count: 0, originalProduct: products.find(p => p.id === productId) };
    }
    productUpdates[productId].cdnImages[index] = cdnUrl;
    productUpdates[productId].count++;
  }

  for (const [id, update] of Object.entries(productUpdates)) {
    const orig = update.originalProduct;
    const existingCdn = JSON.parse(orig.cdn_images || '[]');
    for (const idx in update.cdnImages) {
      existingCdn[idx] = update.cdnImages[idx];
    }
    const totalCount = existingCdn.filter(Boolean).length;
    await updateProduct(id, existingCdn, totalCount);
    console.log(`✅ Product ${id}: ${update.count} images uploaded`);
  }

  console.log(`Processed ${activeBatch.length} images.`);
  process.exit(10);
}

const offset = parseInt(process.env.BATCH_OFFSET) || 0;
const batchSize = parseInt(process.env.BATCH_SIZE) || 300;
processBatch(offset, batchSize);
