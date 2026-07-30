#!/usr/bin/env node

/**
 * verify-fresh-setup.mjs
 *
 * Proves a fresh store works end-to-end on the current adapter.
 * Creates a store, writes N episodes, recalls them, asserts no crashes.
 *
 * Usage:
 *   node scripts/verify-fresh-setup.mjs
 *   node scripts/verify-fresh-setup.mjs --db /tmp/verify-fresh.db
 *   node scripts/verify-fresh-setup.mjs --adapter sqlite --episodes 200
 *   node scripts/verify-fresh-setup.mjs --help
 */

// ── CLI parsing ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`Usage: node scripts/verify-fresh-setup.mjs [flags]

Flags:
  --db <path>       Output store path (default: /tmp/verify-fresh.db)
  --episodes <N>    Number of episodes to write (default: 100)
  --queries <N>     Number of recall queries to run (default: 50)
  --adapter <type>  Store adapter type (sqlite|turso, optional — defaults to env STORE_ADAPTER or sqlite)
  --help            Print this help
`);
  process.exit(0);
}

function flag(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return fallback;
}

const DB_PATH = flag('db', '/tmp/verify-fresh.db');
const EPISODE_COUNT = Number(flag('episodes', '100'));
const QUERY_COUNT = Number(flag('queries', '50'));
const ADAPTER_OVERRIDE = flag('adapter', '');

// ── Diverse episode content templates ──────────────────────────────────────────

const TOPICS = [
  {
    category: 'tech',
    templates: [
      'The Rust programming language enforces memory safety at compile time through its ownership system, preventing entire classes of security vulnerabilities.',
      'Neural networks with transformer architectures have revolutionized natural language processing, enabling machines to understand context at unprecedented scale.',
      'The Linux kernel\'s cgroups v2 provides fine-grained resource control for containers, limiting CPU, memory, and I/O per process group.',
      'WebAssembly (Wasm) enables near-native execution speeds in browsers by compiling languages like C, C++, and Rust into a compact binary format.',
      'PostgreSQL\'s MVCC (Multi-Version Concurrency Control) allows multiple transactions to read and write concurrently without blocking each other.',
      'Kubernetes pod autoscaling based on custom metrics allows applications to react to business signals rather than just CPU or memory thresholds.',
      'The actor model of concurrency, used in Erlang and Akka, isolates state within lightweight processes that communicate exclusively through message passing.',
      'SQLite\'s WAL (Write-Ahead Log) mode significantly improves concurrent read performance by allowing readers to proceed while a writer is active.',
      'Protocol Buffers provide a language-neutral, platform-neutral extensible mechanism for serializing structured data, smaller and faster than JSON.',
      'Zero-knowledge proofs allow one party to prove to another that a statement is true without revealing any information beyond the validity of the statement itself.',
    ],
  },
  {
    category: 'cooking',
    templates: [
      'To make a classic French vinaigrette, whisk together one part Dijon mustard with three parts red wine vinegar, then slowly drizzle in nine parts olive oil.',
      'Sourdough starter requires equal parts flour and water by weight, fed daily at room temperature, bubbling actively before it is ready to leaven bread.',
      'The Maillard reaction begins at approximately 140°C (285°F), creating the deep browned flavours that distinguish a properly seared steak from a boiled one.',
      'Kosher salt dissolves faster than table salt because of its larger crystal surface area, making it preferable for finishing dishes and rimming cocktail glasses.',
      'Tempering chocolate involves carefully heating it to 45°C, cooling to 27°C, then reheating to 31°C, producing a glossy snap when set.',
      'A proper risotto uses carnaroli or arborio rice, toasted in butter before adding warm stock one ladle at a time, stirring until each addition is absorbed.',
      'Dry-aging beef in a temperature- and humidity-controlled environment for 30 days concentrates flavour through enzymatic breakdown and moisture evaporation.',
      'The emulsification of hollandaise sauce depends on slowly whisking clarified butter into egg yolks over gentle heat, never exceeding 60°C to avoid scrambling.',
      'Japanese dashi stock, made from kombu seaweed and bonito flakes, forms the umami foundation for miso soup, noodle broths, and simmered dishes.',
      'Baking at high altitude requires reducing sugar and increasing liquid and flour to compensate for lower atmospheric pressure and faster evaporation.',
    ],
  },
  {
    category: 'science',
    templates: [
      'Photosynthesis converts carbon dioxide and water into glucose and oxygen using sunlight, chlorophyll, and a complex chain of electron transport reactions.',
      'Quantum entanglement occurs when two particles become correlated such that measuring one instantly determines the state of the other, regardless of distance.',
      'The CRISPR-Cas9 gene-editing system uses a guide RNA to target specific DNA sequences, where the Cas9 enzyme makes a precise double-strand break.',
      'Plate tectonics explains continental drift through the movement of lithospheric plates driven by mantle convection, slab pull, and ridge push forces.',
      'The Doppler effect causes the observed frequency of a wave to shift when the source and observer are in relative motion, stretching or compressing the wave.',
      'Mitochondria are the powerhouses of eukaryotic cells, converting nutrients into ATP through oxidative phosphorylation across their inner membrane.',
      'The Heisenberg uncertainty principle states that the more precisely one property of a particle is measured, the less precisely another complementary property can be known.',
      'Natural selection operates on heritable variation within populations, favouring traits that improve survival and reproductive success in a given environment.',
      'Superconductivity allows certain materials to conduct electricity with zero resistance when cooled below a critical temperature, enabling powerful electromagnets.',
      'The water cycle involves evaporation, condensation, precipitation, and collection, driven by solar energy and gravity, circulating water through the Earth system.',
    ],
  },
  {
    category: 'geography',
    templates: [
      'The Great Barrier Reef stretches over 2,300 kilometres along the Queensland coast, comprising nearly 3,000 individual reef systems and supporting immense biodiversity.',
      'Lake Baikal in Siberia is the deepest freshwater lake on Earth at 1,642 metres, containing roughly 20% of the world\'s unfrozen surface freshwater.',
      'The Sahara Desert covers approximately 9.2 million square kilometres, making it the largest hot desert on Earth, spanning eleven countries in North Africa.',
      'Iceland sits atop the Mid-Atlantic Ridge, where the Eurasian and North American tectonic plates diverge, creating volcanic activity and geothermal springs.',
      'The Amazon River discharges about 209,000 cubic metres of water per second into the Atlantic Ocean, carrying more water than the next seven largest rivers combined.',
      'Mount Everest\'s height was officially revised in 2020 to 8,848.86 metres following a joint survey by Nepal and China using GPS and ground-penetrating radar.',
      'The Atacama Desert in Chile is the driest non-polar desert on Earth, with some weather stations never having recorded rainfall in centuries of observation.',
      'Venice comprises 118 small islands connected by over 400 bridges, with its historic centre built on wooden piles driven into the marshy lagoon floor.',
      'The Mariana Trench plunges to approximately 11,000 metres below sea level at its deepest point, the Challenger Deep, in the western Pacific Ocean.',
      'Patagonia spans the southern end of South America across Argentina and Chile, featuring the Southern Patagonian Ice Field, the third-largest ice mass after Antarctica.',
    ],
  },
  {
    category: 'history',
    templates: [
      'The Library of Alexandria was one of the largest and most significant libraries of the ancient world, housing hundreds of thousands of scrolls before its destruction.',
      'The Industrial Revolution began in Britain around 1760, introducing mechanised manufacturing, steam power, and factory systems that transformed global economies.',
      'The Rosetta Stone, discovered in 1799, provided the key to deciphering Egyptian hieroglyphs by presenting the same decree in three scripts.',
      'The Silk Road connected China to the Mediterranean through a network of trade routes, facilitating the exchange of goods, ideas, and culture for over 1,500 years.',
      'The signing of the Magna Carta in 1215 established the principle that everyone, including the monarch, was subject to the law — a foundation of constitutional governance.',
      'The Apollo 11 mission landed the first humans on the Moon on July 20, 1969, with Neil Armstrong and Buzz Aldrin spending 21.5 hours on the lunar surface.',
      'The Berlin Wall fell on November 9, 1989, symbolising the end of the Cold War division between East and West Germany and leading to German reunification.',
      'The printing press invented by Johannes Gutenberg around 1440 revolutionised knowledge dissemination, making books affordable and accelerating the Renaissance.',
      'The Panama Canal, completed in 1914, shortened the sea journey between the Atlantic and Pacific Oceans by over 12,000 kilometres, transforming global shipping.',
      'The discovery of penicillin by Alexander Fleming in 1928 marked the beginning of modern antibiotics, saving millions of lives from bacterial infections.',
    ],
  },
  {
    category: 'art',
    templates: [
      'The Mona Lisa, painted by Leonardo da Vinci between 1503 and 1519, is renowned for its enigmatic expression and the sfumato technique of soft, gradual transitions.',
      'Impressionism emerged in 1870s France when artists like Monet and Renoir broke from academic conventions to capture light and movement in visible brushstrokes.',
      'Bauhaus, founded by Walter Gropius in 1919, merged fine arts with functional design, influencing architecture, furniture, and typography worldwide.',
      'Shakespeare\'s Hamlet explores themes of revenge, madness, mortality, and the complexity of human action through its iconic soliloquies and character contrasts.',
      'Frida Kahlo\'s self-portraits confront identity, post-colonialism, gender, class, and race in Mexican society, using vibrant colours and surrealist symbolism.',
      'The invention of photography in 1839 by Louis Daguerre democratised visual representation, challenging painting\'s monopoly on capturing reality.',
      'Beethoven\'s Symphony No. 9, premiered in 1824, broke conventions by introducing vocal soloists and a chorus in the final movement, setting Schiller\'s Ode to Joy.',
      'Japanese woodblock prints from the Edo period, known as ukiyo-e, greatly influenced European Impressionists with their bold lines, flat colours, and asymmetrical composition.',
      'The Harlem Renaissance of the 1920s saw African American literature, music, and visual art flourish, with figures like Langston Hughes and Duke Ellington.',
      'Surrealism seeks to unlock the unconscious mind through dreamlike imagery, automatic drawing, and unexpected juxtapositions, led by André Breton in the 1920s.',
    ],
  },
];

function generateEpisodes(count) {
  const episodes = [];
  for (let i = 0; i < count; i++) {
    const topic = TOPICS[i % TOPICS.length];
    const template = topic.templates[i % topic.templates.length];
    // Add some variation by appending a sequence number
    const content = `[${topic.category}] ${template} (entry ${i + 1})`;
    episodes.push({
      content,
      project_path: '/tmp/verify-fresh-setup',
      tags: [topic.category, 'verify-fresh'],
    });
  }
  return episodes;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  // Set adapter override if supplied (factory reads STORE_ADAPTER env var,
  // defaults to 'turso' when unset — we default to 'sqlite' for local use).
  const resolvedAdapter = ADAPTER_OVERRIDE || process.env.STORE_ADAPTER || 'sqlite';
  process.env.STORE_ADAPTER = resolvedAdapter;

  const adapterType = resolvedAdapter;

  console.log(`verify-fresh-setup: db=${DB_PATH} adapter=${adapterType} episodes=${EPISODE_COUNT} queries=${QUERY_COUNT}`);

  // Dynamic import of memory-core (uses path to dist because pnpm workspace
  // does not hoist @adhd packages to root node_modules — resolving from the
  // pnpm virtual store's symlink via `createRequire` would be fragile; the
  // compiled dist/ is always present for a built workspace package).
  let mc;
  try {
    const mcUrl = new URL('../libs/memory-core/dist/index.js', import.meta.url).href;
    mc = await import(mcUrl);
  } catch (err) {
    console.error(`FAIL: Could not import sox-memory-core — ${err.message}`);
    process.exit(1);
  }

  const { openDb, closeDbWithLease, closeAllAdapters, memoryWrite, memoryRecall } = mc;

  // 1. Create fresh store (delete any existing file first)
  try {
    const { unlinkSync } = await import('node:fs');
    try { unlinkSync(DB_PATH); } catch { /* ok if doesn't exist */ }
    try { unlinkSync(`${DB_PATH}-wal`); } catch { /* ok */ }
    try { unlinkSync(`${DB_PATH}-shm`); } catch { /* ok */ }
    try { unlinkSync(`${DB_PATH}.writer.lock`); } catch { /* ok */ }
  } catch {
    // ignore
  }

  let adapter;
  try {
    adapter = await openDb(DB_PATH);
  } catch (err) {
    console.error(`FAIL: openDb() failed — ${err.message}`);
    process.exit(1);
  }

  // 2. Generate and write episodes
  const episodes = generateEpisodes(EPISODE_COUNT);
  let writeOk = 0;
  let writeFail = 0;
  const writtenUids = [];
  const writtenContents = [];

  console.log(`Writing ${EPISODE_COUNT} episodes...`);
  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    try {
      const result = await memoryWrite(adapter, ep);
      if (result && typeof result === 'object' && 'episode_uid' in result) {
        writeOk++;
        writtenUids.push(result.episode_uid);
        writtenContents.push(ep.content);
      } else if (result && typeof result === 'object' && result.code === 'E_DEDUP') {
        // Dedup shouldn't happen on fresh store, but handle gracefully
        writeOk++;
        writtenUids.push(result.existing_uid);
      } else {
        writeFail++;
        const code = result?.code ?? 'UNKNOWN';
        console.error(`  Write ${i + 1} failed: ${code}`);
      }
    } catch (err) {
      writeFail++;
      console.error(`  Write ${i + 1} threw: ${err.message}`);
    }

    if ((i + 1) % 25 === 0) {
      console.log(`  ... ${i + 1}/${EPISODE_COUNT} written (${writeOk} ok, ${writeFail} fail)`);
    }
  }

  console.log(`Write results: ${writeOk} ok, ${writeFail} fail`);

  if (writeOk === 0) {
    console.error('FAIL: No episodes were written successfully');
    await closeDbWithLease(adapter, DB_PATH);
    process.exit(1);
  }

  // 3. Recall queries using snippets from written episodes
  // Pick queries evenly across the written set
  const queryIndices = [];
  const step = Math.max(1, Math.floor(writtenContents.length / QUERY_COUNT));
  for (let i = 0; i < QUERY_COUNT && i * step < writtenContents.length; i++) {
    queryIndices.push(i * step);
  }
  // If we still have fewer than QUERY_COUNT, fill with remaining
  while (queryIndices.length < QUERY_COUNT && queryIndices.length < writtenContents.length) {
    if (!queryIndices.includes(queryIndices.length)) {
      queryIndices.push(queryIndices.length);
    } else {
      break;
    }
  }
  const actualQueryCount = queryIndices.length;

  let queryOk = 0;
  let queryFail = 0;
  let queryTimeout = 0;

  console.log(`Running ${actualQueryCount} recall queries...`);
  for (let i = 0; i < actualQueryCount; i++) {
    const idx = queryIndices[i];
    const content = writtenContents[idx];
    if (!content) {
      queryFail++;
      continue;
    }

    // Extract a meaningful query snippet (first 40-80 chars of the content, removing [category] prefix)
    const cleanContent = content.replace(/^\[[^\]]+\]\s*/, '');
    const query = cleanContent.slice(0, Math.min(80, cleanContent.length)).replace(/\(.*?\)/g, '').trim();

    try {
      const result = await Promise.race([
        memoryRecall(adapter, 'project', {
          query,
          limit: 5,
          scopes: ['project'],
        }),
        timeout(5000),
      ]);

      if (!result) {
        queryTimeout++;
        queryFail++;
        // Don't flood console with individual timeouts
        if (i < 5 || (i + 1) % 10 === 0) {
          console.error(`  Recall ${i + 1}/${actualQueryCount} TIMEOUT (query: "${query.slice(0, 40)}...")`);
        }
        continue;
      }

      const results = result.results ?? [];
      if (results.length > 0) {
        queryOk++;
      } else {
        queryFail++;
        if (i < 5 || (i + 1) % 10 === 0) {
          console.error(`  Recall ${i + 1}/${actualQueryCount} returned 0 results (query: "${query.slice(0, 40)}...")`);
        }
      }
    } catch (err) {
      queryFail++;
      if (i < 5 || (i + 1) % 10 === 0) {
        console.error(`  Recall ${i + 1}/${actualQueryCount} threw: ${err.message}`);
      }
    }

    if ((i + 1) % 10 === 0) {
      console.log(`  ... ${i + 1}/${actualQueryCount} queries (${queryOk} ok, ${queryFail} fail, ${queryTimeout} timeout)`);
    }
  }

  // 4. Cleanup
  try {
    await closeDbWithLease(adapter, DB_PATH);
  } catch {
    // best effort
  }
  try {
    await closeAllAdapters();
  } catch {
    // best effort
  }

  // 5. Summary
  const allOk = writeFail === 0 && queryFail === 0;
  const line = `ALL PASS: Fresh setup verified (adapter=${adapterType}, episodes=${EPISODE_COUNT}, queries=${actualQueryCount})`;

  if (allOk) {
    console.log(`\n${line}`);
    process.exit(0);
  } else {
    console.error(`\nFAIL: ${writeFail} write failures, ${queryFail} query failures (${queryTimeout} timeout)`);
    process.exit(1);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
  );
}

// ── Run ─────────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`UNCAUGHT: ${err.message}`);
  process.exit(1);
});
