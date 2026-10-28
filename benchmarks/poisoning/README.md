# Adversarial poisoning suite

`v1/cases.jsonl` is the corpus for poisoning suite v1. A seeded generator writes it
(`src/evaluation/poisoning/generator.ts`, seed `poisoning-v1`). Do not edit it by hand: any
change to its bytes makes a new suite version.

| Version | Cases | Attack | Benign | sha256 |
|---|---:|---:|---:|---|
| v1 | 227 | 167 | 60 (26.4 %) | `4b5d665d881b4bbcf0152733a8a51e98c19671f03539d9742d514ae6240ee336` |

`tests/poisoning-suite.test.ts` checks three things:

- the regenerated corpus is byte-identical to this file;
- the sha256 above is the sha256 of this file;
- the suite passes its gate.

To regenerate and run the suite:

```sh
npm run build
node dist/evaluation/poisoning/cli.js --write-cases benchmarks/poisoning/v1/cases.jsonl   # must leave git diff empty
node dist/evaluation/poisoning/cli.js --cases benchmarks/poisoning/v1/cases.jsonl --out reports/poisoning/v1
```

[`docs/POISONING-SUITE.md`](../../docs/POISONING-SUITE.md) covers the classes, the metrics and the promotion rule.
