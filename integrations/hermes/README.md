# Mnemosyne for Hermes Agent (`mnemosy-ai`)

A [Portable Agent Plugin](https://agent-plugins.org/specification) that connects
[Hermes Agent](https://github.com/NousResearch/hermes-agent) to Mnemosyne, the
npm package [`mnemosy-ai`](https://www.npmjs.com/package/mnemosy-ai): an
evidence-tracked local memory MCP server. Website: https://mnemosy.ai.

**Which Mnemosyne is this?** This package is published from
`28naem-del/mnemosyne` as npm `mnemosy-ai`. It is not the `mnemosyne` Hermes
memory provider from `mnemosyne-oss/mnemosyne` (PyPI `mnemosyne-memory`); the two
projects share a name and nothing else.

## What it adds
- One MCP server, `mnemosy`, started over stdio with
  `npx -y -p mnemosy-ai@3.0.0-rc.4 mnemosy mcp`. Its 16 tools appear as
  `mcp__mnemosy__memory_*` (recall, context, store, correct, checkpoint, resume,
  inspect and others). `memory_forget` is not exposed.
- One skill, `mnemosy-ai:mnemosy-memory`, telling the model when to recall,
  store, correct and checkpoint.
- No Python, no hooks, no automatic per-turn recall or capture.

## Install
```sh
hermes plugins install mnemosy-ai --no-enable   # once listed in the catalog
hermes plugins enable mnemosy-ai
```
Needs Node.js >= 22.16 and npm (`npx`) on `PATH`.

The first start downloads the package with `npx`, which can take longer than
Hermes's default 60 s MCP connect timeout, and a portable plugin cannot raise
it. If the server fails to connect on first start, run
`npx -y -p mnemosy-ai@3.0.0-rc.4 mnemosy --help` once to fill the npm cache, or
use the `~/.hermes/config.yaml` route with `connect_timeout: 120` (see the
project README).

## Disclosures
- **Package download.** The first start runs `npx`, which downloads the pinned
  `mnemosy-ai@3.0.0-rc.4` and its dependencies from the npm registry. These
  include native addons (`onnxruntime-node`; optional `sqlite-vec` and
  `hnswlib-node`) that npm installs as prebuilt binaries for your platform. No
  binary is committed in this plugin directory.
- **Pre-release.** 3.0.0-rc.4 is a release candidate on the npm `next` channel.
- **Local data.** Memories are written to `memory.sqlite` in the plugin's
  profile-scoped data directory (`${PLUGIN_DATA}`), file mode `0600`. Each
  Hermes profile gets its own database. Apart from the optional model cache below, the server reads no other host files.
- **Network.** On this default configuration the server makes no network calls
  and sends no telemetry. Semantic recall uses a local embedding model only if
  you have fetched it beforehand in a separate, explicit setup step (see the
  project README); otherwise recall is lexical. Hermes itself may check the npm
  package against the OSV malware database before launching it.
- **Writes without a prompt.** Store, correct, checkpoint, capture and observe
  calls write to the local database without asking. To require approval for
  every write, add a same-name `mcp_servers.mnemosy` entry with
  `trust: untrusted` to `~/.hermes/config.yaml`.
- **No credentials.** The plugin needs no API key and stores none.

## Untested status
This package follows the Hermes Portable Agent Plugin format as documented for
Hermes v0.22.5. The maintainers have not yet run this plugin under Hermes. In
particular, it is unverified which Node.js runtime Hermes uses to start stdio
MCP servers, and whether the package's native addons load under it.

## License
MIT, see [LICENSE](LICENSE).

## Maintainers
At each release, bump `version` in `plugin.json` and the `mnemosy-ai@<version>`
pin in `mcp.json` together; the Hermes catalog entry then needs a new commit sha.
