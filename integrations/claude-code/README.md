# Mnemosyne plugin for Claude Code

A Claude Code plugin that registers one MCP server, `mnemosyne`, from the npm
package [`mnemosy-ai`](https://www.npmjs.com/package/mnemosy-ai). The
marketplace that lists it is `.claude-plugin/marketplace.json` at the root of
this repository (marketplace name `mnemosy-ai`).

## Install

```sh
claude plugin marketplace add 28naem-del/mnemosyne      # in a session: /plugin marketplace add 28naem-del/mnemosyne
claude plugin install mnemosyne@mnemosy-ai             # add --scope project to share it through .claude/settings.json
```

Needs Node.js >= 22.16 and `npx` on `PATH`.

## What it runs

```sh
npx -y -p mnemosy-ai@next mnemosy mcp --db ${CLAUDE_PROJECT_DIR}/.mnemosyne/memory.sqlite --workspace default --agent claude-code
```

- One SQLite file per project, at `.mnemosyne/memory.sqlite` in the project
  directory (file mode `0600`). Add `.mnemosyne/` to the project's `.gitignore`.
  The data is not kept in the plugin's data directory, so uninstalling the
  plugin does not delete it.
- 16 tools, named `mcp__plugin_mnemosyne_mnemosyne__memory_*` inside Claude
  Code; permission rules must use that form. `memory_forget` is not exposed.
- The first start downloads the package with `npx`. If that start fails,
  Claude Code may skip the server for a while; run `claude mcp list` to see its
  status.

## Maintainers

At each release, bump `version` in `.claude-plugin/plugin.json` (it decides
when installed copies update) and check the `mnemosy-ai@next` launcher in
`.mcp.json` (switch it to the stable tag or version at 3.0.0 GA).
