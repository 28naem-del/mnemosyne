# Governance

Mnemosyne (the `mnemosy-ai` package in this repository) is maintained by one person. There is no steering committee, vote, or second maintainer.

## Maintainer

Ali Naem Deveci ([@28naem-del](https://github.com/28naem-del)) is the sole maintainer. The project is built by Aristotle Intelligence Inc. (Delaware). Names, scope and contact are in [MAINTAINERS.md](MAINTAINERS.md).

## What the maintainer decides

The maintainer decides what merges, what ships, and how trust, scope, erasure, provenance and promotion rules change. Changes in those areas need the maintainer's review. Pull requests are welcome. A review request does not transfer that decision.

Participation follows [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). How to send a change is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Releases

Stable releases are published to npm `latest` from an existing tag by a manual run of `.github/workflows/publish.yml`. Pre-releases use the npm `next` dist-tag. The workflow checks that the tag equals `v` plus `package.json` version, packs one tarball, and publishes that tarball with npm provenance. A GitHub Release is created separately. Only after the whole publish job succeeds (including MCP Registry publication), and when that release already exists, the same workflow attaches a CycloneDX SBOM named `mnemosy-ai-<version>.cdx.json`.

npm `latest` is 2.0.0. The newest pre-release on `next` is 3.0.0-rc.4. There is no published long-term-support branch.

## Security reports

Private vulnerability reports go to [28naem@gmail.com](mailto:28naem@gmail.com), as described in [SECURITY.md](SECURITY.md). The maintainer acknowledges a report and keeps it private until a fix ships or a disclosure date is agreed. There is no published response-time guarantee.

## Changes to governance

The maintainer updates this file and [MAINTAINERS.md](MAINTAINERS.md) in a pull request. Adding a maintainer is an invitation from the current maintainer after reviewed contributions. There is no open maintainer seat and no automatic path to one.
