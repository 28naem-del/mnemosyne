# Dependency inference suite (synthetic)

`v1/corpus.json` is the corpus for dependency inference suite v1. Every record, task and
ground-truth edge in it is synthetic. A seeded generator writes it
(`src/evaluation/dependencies/generator.ts`, seed `20261028`, generator
`dependencies-v1-generator@1`). Do not edit it by hand: any change to its bytes makes a new
suite version.

| Version | Records | Premises | Procedures | Skills | Tasks | True undeclared edges | sha256 |
|---|---:|---:|---:|---:|---:|---:|---|
| v1 | 228 | 120 | 84 | 24 | 717 | 160 | `e56da493f548a94907b6f95b9f8c2c8d3a984b9ad7f079706921e3801aca0d6f` |

`tests/dependencies-gate.test.ts` checks four things:

- the regenerated corpus is byte-identical to this file;
- the sha256 above is the sha256 of this file;
- the suite passes its gate (invalidation recall >= 90 %, precision >= 95 %, zero stale
  executions);
- the committed report under `reports/dependencies/v1/` holds the same metrics as the run.

To regenerate and run the suite:

```sh
npm run build
node dist/evaluation/dependencies/cli.js --write-corpus benchmarks/dependencies/v1/corpus.json   # must leave git diff empty
node dist/evaluation/dependencies/cli.js --corpus benchmarks/dependencies/v1/corpus.json --out reports/dependencies/v1 --seeds 1,2,3,4,5,11,12,13,14,15
```

[`docs/DEPENDENCIES.md`](../../docs/DEPENDENCIES.md) covers what is inferred, the eval
protocol, the numbers and the limits.
