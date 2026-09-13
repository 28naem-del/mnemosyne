"""Render explicitly curated public guides for the product website.

Build-time dependency: Python-Markdown. Does not publish source code or deploy.
"""
from __future__ import annotations

from html import escape
import hashlib
from pathlib import Path
import re
from urllib.parse import quote, unquote, urlsplit

import markdown

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'site'
PUBLIC = ROOT / 'docs/site'
GUIDES = (
    'BRIDGE', 'RUNTIME', 'MAINTENANCE', 'deployment', 'MIGRATION-v2',
    'MIGRATION', 'AGENT-EVALUATION', 'PROFILES', 'AGENT', 'CONTEXT',
    'OPERATIONS', 'PROVIDER-TOOLS', 'ANTHROPIC-MEMORY', 'RECALL',
    'TIMELINE', 'LOCAL-INTELLIGENCE', 'EVIDENCE-GATE',
)
DEST = SITE / 'docs/reference'
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
                    new = 'https://github.com/28naem-del/mnemosyne/blob/v2.0.0-rc.8/' + quote(relative.as_posix())
                    if parsed.fragment:
                        new += '#' + quote(parsed.fragment, safe='-_.~')
                    return f'<a {before}href="{escape(new, quote=True)}"{after}>{label}</a>'
            return f'<span>{label}</span>'

        content = LINK.sub(reference_link, content)
        title_match = re.search(r'^#\s+(.+)$', source.read_text(), re.MULTILINE)
        title = title_match.group(1) if title_match else source.stem
        document = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(title)} — Mnemosyne</title><meta name="description" content="Documentation for the Mnemosyne 2.0 source release candidate."><meta name="theme-color" content="#070b12"><link rel="canonical" href="https://mnemosy.ai{target}"><link rel="icon" href="../../favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="../../styles.css"><link rel="stylesheet" href="../../launch.css"><link rel="stylesheet" href="../../cinematic.css"></head><body><a class="skip" href="#main">Skip to content</a><header class="site-header wrap"><a class="brand" href="../../">mnemosyne</a><nav class="nav" aria-label="Reference navigation"><a href="../">Documentation</a><a href="../../#company">Company &amp; contact</a></nav></header><main id="main" class="wrap reference-page"><p class="version">2.0.0-rc.8 / technical preview</p><aside class="note reference-notice"><strong>2.0 release candidate.</strong> These examples match the tagged source release. Test your workload and review the documented operational boundaries before production. <a href="../#build">Release access and status</a>.</aside><article class="article">{content}</article><p><a href="../">Return to documentation</a></p></main><footer class="site-footer wrap"><div class="company-footer"><a href="../../#company">Built by Aristotle Intelligence Inc. · Delaware</a><span>Fully self-funded to date</span><a href="mailto:28naem@gmail.com">Contact</a></div></footer></body></html>
'''
        for name in ('styles.css', 'launch.css', 'cinematic.css'):
            revision = hashlib.sha256((SITE / name).read_bytes()).hexdigest()[:12]
            document = document.replace(f'href="../../{name}"', f'href="../../{name}?v={revision}"')
        (DEST / Path(target).name).write_text(document)
    print(f'Rendered {len(sources)} curated public guides; engineering documents are not published.')


if __name__ == '__main__':
    render()
