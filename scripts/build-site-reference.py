"""Render explicitly curated public guides for the product website.

Build-time dependency: Python-Markdown. Does not publish source code or deploy.
"""
from __future__ import annotations

from html import escape
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import quote, unquote, urlsplit

import markdown

ROOT = Path(__file__).resolve().parents[1]
IDENTITY = json.loads((ROOT / 'scripts/public-identity.json').read_text())
SITE = ROOT / 'site'
PUBLIC = ROOT / 'docs/site'
GUIDES = (
    'BRIDGE', 'RUNTIME', 'MAINTENANCE', 'deployment', 'MIGRATION-v2',
    'MIGRATION', 'AGENT-EVALUATION', 'PROFILES', 'AGENT', 'CONTEXT',
    'OPERATIONS', 'PROVIDER-TOOLS', 'ANTHROPIC-MEMORY', 'RECALL',
    'TIMELINE', 'LOCAL-INTELLIGENCE', 'EVIDENCE-GATE',
)
DEST = SITE / 'docs/reference'
# Source links resolve against the tag the website documents.
SOURCE_REF = 'v3.0.0-rc.4'
SHARE_IMAGE = '/assets/share-card.png'
SHARE_ALT = 'Mnemosyne: the next agent starts wiser. Persistent, local-first memory for AI agents.'
LINK = re.compile(r'<a\s+([^>]*?)href="([^"]+)"([^>]*)>(.*?)</a>', re.DOTALL)


def render() -> None:
    sources = {
        (PUBLIC / (name + '.md')).resolve(): '/docs/reference/' + name + '.html'
        for name in GUIDES
    }
    # Never infer publication authority from a link into engineering documents.
    for source in sources:
        if not source.is_relative_to(PUBLIC.resolve()) or not source.is_file():
            raise ValueError(f'Missing curated public guide: {source.name}')
    DEST.mkdir(parents=True, exist_ok=True)

    for source, target in sources.items():
        content = markdown.markdown(source.read_text(), extensions=['fenced_code', 'tables', 'toc'])

        def reference_link(match: re.Match[str]) -> str:
            before, href, after, label = match.groups()
            parsed = urlsplit(href)
            if href.startswith('#') or parsed.scheme in ('https', 'mailto'):
                return match.group(0)
            if parsed.scheme or parsed.netloc:
                return f'<span>{label}</span>'
            if href.startswith('/'):
                return match.group(0)
            path = unquote(parsed.path)
            resolved = (source.parent / path).resolve()
            if resolved in sources:
                new = sources[resolved] + ('#' + parsed.fragment if parsed.fragment else '')
                return f'<a {before}href="{escape(new, quote=True)}"{after}>{label}</a>'
            if resolved.is_relative_to(ROOT) and resolved.is_file():
                relative = resolved.relative_to(ROOT)
                if relative.parts[0] in ('src', 'examples', 'docs'):
                    new = IDENTITY['repository'] + '/blob/' + SOURCE_REF + '/' + quote(relative.as_posix())
                    if parsed.fragment:
                        new += '#' + quote(parsed.fragment, safe='-_.~')
                    return f'<a {before}href="{escape(new, quote=True)}"{after}>{label}</a>'
            return f'<span>{label}</span>'

        content = LINK.sub(reference_link, content)
        title_match = re.search(r'^#\s+(.+)$', source.read_text(), re.MULTILINE)
        title = title_match.group(1) if title_match else source.stem
        site = IDENTITY['site'].rstrip('/')
        repository = IDENTITY['repository']
        page_title = escape(f'{title} — Mnemosyne', quote=True)
        description = escape(f'Mnemosyne reference guide: {title}. Applies to 2.0.0 (stable) and 3.0.0-rc.4 (pre-release).', quote=True)
        alt = escape(SHARE_ALT, quote=True)
        document = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(title)} — Mnemosyne</title><meta name="description" content="{description}"><meta name="theme-color" content="#070b12"><link rel="canonical" href="{escape(site, quote=True)}{target}"><link rel="icon" href="../../favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="../../apple-touch-icon.png"><link rel="stylesheet" href="../../styles.css"><link rel="stylesheet" href="../../launch.css"><link rel="stylesheet" href="../../cinematic.css"><script src="../../launch.js" defer></script>
<meta property="og:type" content="article"><meta property="og:title" content="{page_title}"><meta property="og:description" content="{description}"><meta property="og:url" content="{escape(site, quote=True)}{target}"><meta property="og:site_name" content="Mnemosyne"><meta property="og:image" content="{escape(site, quote=True)}{SHARE_IMAGE}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="{alt}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="{page_title}"><meta name="twitter:description" content="{description}"><meta name="twitter:image" content="{escape(site, quote=True)}{SHARE_IMAGE}"><meta name="twitter:image:alt" content="{alt}">
</head><body><a class="skip" href="#main">Skip to content</a><header class="site-header wrap"><a class="brand" href="../../">mnemosyne</a><nav class="nav" id="main-nav" aria-label="Reference navigation"><a href="../">Documentation</a><a href="../../trust/">Trust</a><a href="../../#company">Company &amp; contact</a></nav></header><main id="main" class="wrap reference-page"><p class="version">Reference · 2.0.0 stable / 3.0.0-rc.4 pre-release</p><aside class="note reference-notice"><strong>2.0.0 is the stable release (npm latest); 3.0.0-rc.4 is the newest pre-release (npm next).</strong> These guides describe the Local Engine and runtime shared by both; any source-file links point to the {SOURCE_REF} tag. From 3.0.0-rc.2 the Vector Engine APIs (<code>createMnemosyne</code> and its subpaths) live in <code>mnemosy-ai-legacy</code>, which is not on npm; see <a href="../#upgrade-3">Upgrading to 3.0.0-rc.4</a>. Test your workload and review the documented operational boundaries before production.</aside><article class="article">{content}</article><p class="reference-return"><a href="../">Return to documentation</a></p></main><footer class="site-footer wrap"><div class="footer-links"><a href="../">Documentation</a><a href="../../trust/">Trust</a><a href="{repository}">GitHub</a><a href="{repository}/releases">Releases</a><a href="{repository}/blob/main/CHANGELOG.md">Changelog</a><a href="{repository}/issues">Support: GitHub issues</a><a href="{repository}/blob/main/SECURITY.md">Security</a><a href="{repository}/blob/main/CONTRIBUTING.md">Contributing</a><a href="{repository}/blob/main/LICENSE">MIT license</a></div><div class="company-footer"><a href="../../#company">Built by {escape(IDENTITY['company'])} · Delaware</a><span>Fully self-funded to date</span><a href="mailto:{escape(IDENTITY['contact'], quote=True)}">Contact</a></div></footer></body></html>
'''
        for name in ('styles.css', 'launch.css', 'cinematic.css'):
            revision = hashlib.sha256((SITE / name).read_bytes()).hexdigest()[:12]
            document = document.replace(f'href="../../{name}"', f'href="../../{name}?v={revision}"')
        # launch.js adds the same compact mobile menu the main pages use; without it the links stay 44px rows.
        revision = hashlib.sha256((SITE / 'launch.js').read_bytes()).hexdigest()[:12]
        document = document.replace('src="../../launch.js"', f'src="../../launch.js?v={revision}"')
        (DEST / Path(target).name).write_text(document)
    print(f'Rendered {len(sources)} curated public guides; engineering documents are not published.')


if __name__ == '__main__':
    render()
