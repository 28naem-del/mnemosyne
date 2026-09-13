/** Pinned optional CPU presets. Model licenses remain those of their authors. */
export const LOCAL_MODEL_RUNTIME = '3.8.1';
export const LOCAL_EMBEDDING_SPEC = Object.freeze({
  id: 'Xenova/all-MiniLM-L6-v2', revision: '751bff37182d3f1213fa05d7196b954e230abad9', dimensions: 384,
  dtype: 'q8', maxTokens: 256, pooling: 'mean', normalization: 'l2', chunkPolicy: 'lossless-bisect-token-weighted-mean-v1',
  license: 'Apache-2.0',
});
export const LOCAL_RERANKER_SPEC = Object.freeze({
  id: 'Xenova/ms-marco-MiniLM-L-6-v2', revision: 'a09144355adeed5f58c8ed011d209bf8ee5a1fec',
  dtype: 'q8', maxTokens: 512, chunkPolicy: 'lossless-bisect-max-logit-v1', scoreTransform: 'sigmoid-ranking-not-probability', license: 'Apache-2.0',
});
export const LOCAL_EMBEDDING_ID = `transformers.js@${LOCAL_MODEL_RUNTIME}|${JSON.stringify(LOCAL_EMBEDDING_SPEC)}`;
export const LOCAL_RERANKER_ID = `transformers.js@${LOCAL_MODEL_RUNTIME}|${JSON.stringify(LOCAL_RERANKER_SPEC)}`;
