export { BUNDLED_EMBEDDING_ID, BUNDLED_EMBEDDING_MODEL, bundledModelDir, bundledModelFilePath, bundledModelStatus, fetchBundledModel, resolveModelCacheDir, verifyBundledModel, type BundledModelFile, type BundledModelStatus } from './model-assets.js';
export { createBundledEmbedder, LocalEmbeddingModelUnavailableError, type BundledEmbedderOptions, type EmbeddingRole, type SyncMemoryEmbedder } from './onnx-embedder.js';
export { basicTokenize, encodeWordPiece, encodeWordPiecePair, loadWordPieceVocabulary, type WordPieceVocabulary } from './wordpiece.js';
export { acquireSharedEmbedder, releaseSharedEmbedder, resetSharedEmbedders } from './shared.js';
