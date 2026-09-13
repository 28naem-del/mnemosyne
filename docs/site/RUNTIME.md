# Mnemosyne Memory Runtime

Capture original evidence, connect it to reusable observations and carry it across agent sessions. `MemoryRuntime` preserves supplied visible text and stable message identities in the host's scoped database. Replaying the same input is idempotent; reusing an identity with changed content is rejected. Capture reads only the messages or files explicitly supplied by the host. It does not discover account histories or install application hooks.

## Capture and inspect original evidence

Source-backed observations retain their dependencies, and `expandSource` exposes bounded original evidence for inspection. A correction makes advice based on the previous source unusable; forgetting removes the live source lineage and its dependents. Captured text is untrusted by default. A host may mark material it witnessed as observed, which does not certify the truth of its contents.

## Project models, skill trials and traces

Durable jobs support explicitly selected proposal callbacks and finite work budgets. Queuing a job does not call a model or start a scheduler. Skills begin as private candidates. Existing compatibility behavior allows promotion after one successful trial; the recommended policy requires two distinct tasks and two distinct verifier identities. Those identities are controller assertions: the host must provide real tests and independent evidence.

```ts
import { createLocalMemory } from 'mnemosy-ai/local';
import {
  MemoryRuntime,
  RECOMMENDED_SKILL_PROMOTION_POLICY,
} from 'mnemosy-ai/runtime';

const memory = createLocalMemory({
  path: './memory.sqlite', workspaceId: 'my-project', agentId: 'assistant',
});
const runtime = new MemoryRuntime(memory, {
  skillPromotionPolicy: RECOMMENDED_SKILL_PROMOTION_POLICY,
});
```

## Hybrid retrieval

The runtime works with [Mnemosyne Recall](/docs/reference/RECALL.html), source-aware context and an explicitly selected semantic provider. Local inference is available through [Local Intelligence](/docs/reference/LOCAL-INTELLIGENCE.html). Model generation remains optional and host-controlled; neither provenance links nor a successful trial establish general answer quality.

<a id="http-inspector-and-python"></a>
## Local service and inspector

The local HTTP service, client library and inspector expose the same scoped memory lifecycle. The service defaults to loopback with bearer authentication; the host manages credentials and any remote transport. A scope selector is not user authentication. [Deployment](/docs/reference/deployment.html) and [recovery](/docs/reference/OPERATIONS.html) describe persistent storage and operator boundaries.
