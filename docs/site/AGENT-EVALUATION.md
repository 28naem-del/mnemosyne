# Evaluate Mnemosyne in Your Agent

Measure the outcome your agent must deliver, with the same model, tasks and budgets across memory conditions. Mnemosyne includes separate tools for retrieval measurements, scripted lifecycle checks and matched agent experiments. Their results answer different questions; a retrieved source is not proof that an agent answered correctly.

## What is controlled

The matched agent harness compares isolated no-memory, recent-history, lexical and adaptive conditions through a supplied reader. Keep the reader revision, prompts, context allowance and output budget fixed. Retain failed and withheld attempts, and define task correctness separately from evidence grounding, stale actions and negative transfer.

## Run with an explicitly chosen model

The host supplies the reader and any model configuration. Scripted fixtures validate integration and accounting without external model calls. They do not establish real-model performance. A real experiment needs a frozen task split, an appropriate evaluator and an explicit accounting of provider calls and failures.

## Reading the result

Public retrieval measurements and their limits are collected in [Evaluation](/docs/#evaluation). Read the positive-label denominator, source revision, context budget, chronology policy and overflow counts before comparing numbers. No generated-answer accuracy or matched competitor score is implied by those retrieval results.
