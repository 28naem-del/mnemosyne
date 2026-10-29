#!/bin/bash
set -uo pipefail
cd "$(dirname "$0")/../wt"
echo "== npm ci"; npm ci 2>&1 | tail -5 || exit 1
echo "== approve-scripts"; npm approve-scripts onnxruntime-node 2>&1 | tail -3
echo "== build"; npm run build 2>&1 | tail -3 || exit 1
echo "== competitors"; npm run benchmark:matched:install 2>&1 | tail -3
echo "== fetch locomo"; npm run benchmark:fetch -- --corpus locomo 2>&1 | tail -3
echo "== fetch longmemeval"; npm run benchmark:fetch -- --corpus longmemeval 2>&1 | tail -3
echo BOOTSTRAP_DONE
