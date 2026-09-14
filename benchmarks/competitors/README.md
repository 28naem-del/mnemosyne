# Matched-run competitor SDKs

These packages are installed **here**, not in the root `package.json`, on purpose:

- `mnemosy-ai` must never make a competitor's SDK a dependency of itself. `npm i mnemosy-ai`
  would otherwise pull in Mem0 and its whole transitive tree.
- The root `package-lock.json` stays untouched, so a benchmark dependency can never drift
  into the published package.

Install them with the repository-root script:

```sh
npm run benchmark:matched:install   # npm ci --prefix benchmarks/competitors
npm run benchmark:matched
```

Without this step `npm run benchmark:matched` still runs. It reports every competitor row as
**not run**, with the reason, and never as a number.

Versions here are exact, not ranges, because the matched run's published numbers are attached to
a specific competitor build.
