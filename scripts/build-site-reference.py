"""Render linked reference guides for the static release-preview website.

Build-time dependency: Python-Markdown. Does not publish source code or deploy.
"""
from __future__ import annotations

from html import escape
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

import markdown

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'site'
BASE = 'https://github.com/28naem-del/mnemosyne/blob/codex/mnemosyne-2-local-learning/'
PAGES = [SITE / 'index.html', SITE / 'features/index.html', SITE / 'compare/index.html', SITE / 'docs/index.html']
DEST = SITE / 'docs/reference'
LINK = re.compile(r'<a\s+([^>]*?)href="([^"]+)"([^>]*)>(.*?)</a>', re.DOTALL)


def render() -> None:
    sources: dict[Path, str] = {}
    for page in PAGES:
        for href in re.findall(r'href="([^"]+)"', page.read_text()):
            raw = href.removeprefix(BASE)
            if href.startswith(BASE + 'docs/'):
                source = (ROOT / unquote(urlsplit(raw).path)).resolve()
            elif href.startswith('/docs/reference/'):
                source = (ROOT / 'docs' / (Path(urlsplit(href).path).stem + '.md')).resolve()
            else:
                continue
            if source.is_relative_to(ROOT / 'docs') and source.is_file() and source.suffix == '.md':
                sources[source] = '/docs/reference/' + source.stem + '.html'
    DEST.mkdir(parents=True, exist_ok=True)

    for source, target in sources.items():
        content = markdown.markdown(source.read_text(), extensions=['fenced_code', 'tables', 'toc'])

        def reference_link(match: re.Match[str]) -> str:
            before, href, after, label = match.groups()
            parsed = urlsplit(href)
            if href.startswith('#') or (parsed.scheme and not href.startswith(BASE)):
                return match.group(0)
            path = unquote(urlsplit(href.removeprefix(BASE)).path)
            resolved = ((ROOT / path) if href.startswith(BASE) else (source.parent / path)).resolve()
            if resolved in sources:
                new = sources[resolved] + ('#' + parsed.fragment if parsed.fragment else '')
                return f'<a {before}href="{escape(new, quote=True)}"{after}>{label}</a>'
            # Source/example links remain descriptive until public source release.
            return f'<span title="Reference available with the corresponding source release">{label}</span>'

        content = LINK.sub(reference_link, content)
        title_match = re.search(r'^#\s+(.+)$', source.read_text(), re.MULTILINE)
        title = title_match.group(1) if title_match else source.stem
        document = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(title)} — Mnemosyne</title><meta name="description" content="Technical preview documentation for the next Mnemosyne source release."><meta name="theme-color" content="#070b12"><link rel="canonical" href="https://mnemosy.ai{target}"><link rel="icon" href="../../favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="../../styles.css"><link rel="stylesheet" href="../../launch.css"><link rel="stylesheet" href="../../cinematic.css"></head><body><a class="skip" href="#main">Skip to content</a><header class="site-header wrap"><a class="brand" href="../../">mnemosyne</a><nav class="nav" aria-label="Reference navigation"><a href="../">Documentation</a><a href="../../#company">Company &amp; contact</a></nav></header><main id="main" class="wrap reference-page"><p class="version">2.0.0-rc.8 / technical preview</p><aside class="note reference-notice"><strong>Source publication pending.</strong> This guide describes the next release. Code examples require that source revision; the public repository currently contains an earlier version. <a href="../#build">Release access and status</a>.</aside><article class="article">{content}</article><p><a href="../">Return to documentation</a></p></main><footer class="site-footer wrap"><div class="company-footer"><a href="../../#company">Built by Aristotle Intelligence Inc. · Delaware</a><span>Fully self-funded to date</span><a href="mailto:28naem@gmail.com">Contact</a></div></footer></body></html>
'''
        (DEST / Path(target).name).write_text(document)

    for page in PAGES:
        text = page.read_text()
        for source, target in sources.items():
            text = text.replace(BASE + source.relative_to(ROOT).as_posix(), target)
        # Do not link unreleased implementation files as if they were public.
        def page_source_link(match: re.Match[str]) -> str:
            before, href, after, label = match.groups()
            if href.startswith(BASE + 'src/'):
                return '<a href="/docs/#build">Source release access and status</a>'
            return match.group(0)
        page.write_text(LINK.sub(page_source_link, text))
    print(f'Rendered {len(sources)} reference guides; repository source code remains unpublished.')


if __name__ == '__main__':
    render()
