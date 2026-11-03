#!/usr/bin/env bash
# Same first-time setup as CONTRIBUTING.md. Model setup needs the network once.
set -euo pipefail
npm ci --ignore-scripts
npm run build
npm rebuild hnswlib-node
npm run setup:embedder
npm run setup:reranker
