/**
 * Vector parity: re-embed stored chunks through EMBED_URL and compare them
 * with the vectors in the database. Run it before trusting search on a new
 * embedding server (e.g. the hub's embed_server.py on the CPU of another
 * machine): every cosine should be above 0.9999, and then nothing needs
 * re-indexing.
 *
 *   npm run embed-parity [-- COUNT]     (default 200, spread over all chunks)
 */
const config = require('./config');
const store = require('./store');
const { embed } = require('./embed');

const MIN_COS = 0.9999;

async function main() {
  const want = Math.max(1, Number(process.argv[2]) || 200);
  const all = store.allChunks();
  if (!all.length) throw new Error('no chunks in the database yet');
  const step = Math.max(1, Math.floor(all.length / want));
  const sample = all.filter((_, i) => i % step === 0).slice(0, want);

  const items = new Map();
  const prefix = (id) => {
    if (!items.has(id)) {
      const it = store.getItem(id);
      items.set(id, it ? `[${it.course_code} ${it.course_title}] ` : ''); // as indexer.js embeds passages
    }
    return items.get(id);
  };
  console.log(`→ Re-embedding ${sample.length} of ${all.length} chunks with ${config.embedUrl} …`);
  const { model, vectors } = await embed(sample.map((c) => prefix(c.item_id) + c.text), 'passage');

  const cos = sample.map((c, i) => {
    let dot = 0, a = 0, b = 0;
    for (let k = 0; k < c.embedding.length; k++) {
      dot += c.embedding[k] * vectors[i][k];
      a += c.embedding[k] ** 2;
      b += vectors[i][k] ** 2;
    }
    return dot / Math.sqrt(a * b);
  });
  const low = cos.map((v, i) => [v, sample[i]]).filter(([v]) => !(v > MIN_COS));
  const mean = cos.reduce((s, v) => s + v, 0) / cos.length;
  console.log(`  model ${model} (stored: ${[...new Set(sample.map((c) => c.embed_model))].join(', ')})`);
  console.log(`  cosine min ${Math.min(...cos).toFixed(6)}, mean ${mean.toFixed(6)}; ${low.length} below ${MIN_COS}`);
  for (const [v, c] of low.slice(0, 10)) console.log(`  ${v.toFixed(6)}  ${c.item_id} #${c.idx}`);
  if (low.length) {
    console.log('✗ The vectors differ: re-index (change EMBED_MODEL or redo index) before relying on search.');
    process.exit(1);
  }
  console.log('✓ Same vectors: no re-index needed.');
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
