# Connect Your Agent to Mnemosyne

`MemoryAgent` connects a host-owned agent loop to scoped memory, context and source capture. Construction starts no background work, discovers no conversation history and calls no provider. The host remains responsible for its responder, caller authentication and action permissions.

## One host turn

Use `beforeTurn()` and `afterTurn()` when your application already controls turn boundaries. Use `runTurn()` for a bounded responder call with context revalidation and durable replay protection. Successful visible input and output are captured together. A stable session and turn identity prevents the same retained operation from invoking the responder again; ambiguous failures require host reconciliation rather than a blind retry.

## Gradual migration beside an existing memory system

A [MemoryBridge](/docs/reference/BRIDGE.html) can provide context while the old store remains connected. Its adapter reads the old backend, while the bridge stages local copies, so the agent must allow capture. Read-only agents reject that path before calling the adapter. Ordinary recall-only hosts can use `beforeTurn()` and their own responder.

## Bounded learning while the host runs

Capture defaults to untrusted. Mark material observed only when the host witnessed it. Observation work needs an explicitly supplied proposer and an explicit drain or finite background run. Calls, input bytes, deadlines and cancellation remain bounded; queued jobs survive reopening. Skills require the separate trial and promotion policy described in [Memory Runtime](/docs/reference/RUNTIME.html).

## Check evidence immediately before an action

`prepareAction()` binds the operation, arguments and declared memory dependencies; `executeAction()` rechecks them immediately before dispatch. Correction, forgetting, failed outcomes, expired checks or replay can reject the plan. The host must supply complete dependencies and actual action authorization. This gate does not lock an external service or undo work the responder already performed.
