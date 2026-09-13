# Local semantic retrieval

Mnemosyne can embed memories and rerank results on the host CPU. Model inference sends no memory text to a remote service. The optional runtime and model weights are separate dependencies; normal installation and `createLocalMemory` do not download them or start a model.

The tested optional runtime requires a patched transitive dependency. Merge this exact dependency and override into **your application's root `package.json`**, preserving other dependencies and overrides. Replace an existing `^3.8.1` range with the exact `3.8.1` value shown; npm rejects a version-scoped override when the direct dependency specification differs.

```json
{
  "dependencies": {
    "@huggingface/transformers": "3.8.1"
  },
  "overrides": {
    "@huggingface/transformers@3.8.1": {
      "sharp": "0.35.4"
    }
  }
}
```

Then install the updated application dependencies:

```sh
npm install
npm audit --omit=dev
```

The runtime's original dependency range selects an older `sharp` release affected by [GHSA-rgj7-g3m4-5g8c](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c). These providers accept text and never decode images, but the optional install still needs the patched dependency. A library's own npm overrides do not propagate to consumers; the override must live in the application. The provider checks the `sharp` copy actually resolved by the inference runtime before loading it and rejects vulnerable or unrecognized versions. This checks a known advisory threshold, not all possible vulnerabilities. Manage globally supplied native libraries separately if you replace the package's prebuilt binaries.

```ts
import { createLocalMemory } from 'mnemosy-ai/local';
import { createLocalEmbedder, createLocalReranker, type LocalEmbedder, type LocalReranker } from 'mnemosy-ai/providers/local';

const memory = createLocalMemory({ path: './memory.sqlite', workspaceId: 'app', agentId: 'assistant' });
const models = { cacheDir: '/absolute/path/to/model-cache', allowDownload: true };
// Use allowDownload only when provisioning pinned public model artifacts.
// Omit it on subsequent offline runs; missing cache entries fail clearly.
let embedder: LocalEmbedder | undefined;
let reranker: LocalReranker | undefined;
try {
  embedder = await createLocalEmbedder(models);
  reranker = await createLocalReranker(models);
  let indexed;
  do {
    indexed = await memory.indexEmbeddings({ embedder, limit: 1000, batchSize: 16, timeoutMs: 60000 });
  } while (indexed.remaining > 0);
  const packet = await memory.compileHybrid({ query: 'How do I recover the account?', maxTokens: 8192 }, { embedder, reranker, timeoutMs: 60000 });
  console.log(packet.text);
} finally {
  try { await Promise.all([embedder?.dispose(), reranker?.dispose()]); }
  finally { memory.close(); }
}
```

The CPU presets use 384-dimensional MiniLM embeddings and a MiniLM cross-encoder reranker. Their model revisions, quantization, normalization, token windows and chunk policies are included in the embedding/index identity. Embeddings from different identities do not share an index. BM25 and dense candidates are generated independently and combined with reciprocal-rank fusion before optional reranking.

Long texts are split into complete contiguous text windows. Each window must fit the actual tokenizer: no tail is silently discarded. Embeddings combine normalized window vectors with token-length weights and normalize the result. Reranking uses the maximum window logit, transformed through a monotonic sigmoid into the kernel's 0–1 range; this ranking score is not a calibrated probability. These aggregation rules are explicit engineering choices, not claims of equivalence to a long-context encoder. A text requiring over 256 windows fails and must be split into smaller records. Reranking queries over 128 tokens fail rather than truncate.

Each provider has one isolated subprocess and accepts one operation at a time. A native inference crash is contained in that subprocess. Calls are limited to 100 records and 1 MiB of text; individual records are limited to 65,536 bytes. Initialization defaults to a two-minute deadline, inference to 30 seconds. Cancellation or timeout terminates the subprocess; recreate the provider before retrying. Always dispose providers, including after a failed larger operation. The cache is local controller-owned storage, not a security boundary against another process with filesystem access.

The runnable example uses synthetic memories and requires an explicit model cache:

```sh
npm run build
node --experimental-strip-types examples/local-semantic.ts --cache /absolute/path/to/model-cache --download
# Subsequent cached offline run:
node --experimental-strip-types examples/local-semantic.ts --cache /absolute/path/to/model-cache
```

## Reproducibility and attribution

| Component | Pinned artifact | License |
|---|---|---|
| Runtime | `@huggingface/transformers@3.8.1` | Apache-2.0 |
| Patched runtime dependency | `sharp@0.35.4` via the application's scoped override | Apache-2.0 |
| Embedding model | `Xenova/all-MiniLM-L6-v2@751bff37182d3f1213fa05d7196b954e230abad9` | Apache-2.0 |
| Reranker | `Xenova/ms-marco-MiniLM-L-6-v2@a09144355adeed5f58c8ed011d209bf8ee5a1fec` | Apache-2.0 |

Mnemosyne supplies the integration, scoping, index lifecycle and context checks. The underlying models and inference library are the work of their respective authors. See the [embedding model card](https://huggingface.co/Xenova/all-MiniLM-L6-v2), [reranker model card](https://huggingface.co/Xenova/ms-marco-MiniLM-L-6-v2), and [runtime documentation](https://huggingface.co/docs/transformers.js/v3.8.1/index).

CPU smoke tests establish functioning embedding, reranking, long-input handling and cached offline reopening. They do not establish public-benchmark answer accuracy. The checked-in [retrieval results](evaluation/BENCHMARKS.md) identify which conditions used models; the full LongMemEval paired BM25 report used none.
