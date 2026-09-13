# Mnemosyne Local Intelligence

Add semantic retrieval and reranking without sending memory text to a remote inference endpoint. Mnemosyne provides `createLocalEmbedder` and `createLocalReranker` through `mnemosy-ai/providers/local`. These APIs integrate explicitly prepared, pinned model artifacts with the memory engine and its scope checks.

## Explicit setup, local execution

The host chooses an absolute model-cache location and prepares the supported runtime and pinned artifacts. Downloads are disabled by default. Once the required files are present, inference runs locally in dedicated processes. Missing artifacts fail explicitly rather than selecting a remote provider. Model licensing remains separate from the memory-engine license.

## Bounded work

Embedding and reranking have input-size, batch, startup and operation limits. A provider handles one operation at a time; await it before submitting the next, and dispose it when finished. Cancellation or timeout terminates its process so a later request cannot consume a late response. Local execution still consumes host CPU and memory, and model initialization has a cost.

## What it establishes

Local inference can supply the semantic channel and reranker used by [Mnemosyne Recall](/docs/reference/RECALL.html). It does not replace the host's answer model, automatically generate memories or certify an answer. [Evaluation](/docs/#evaluation) distinguishes live local-model integration checks from retrieval measurements and unmeasured answer quality.
