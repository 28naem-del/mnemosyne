import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkPublicMetadata } from './check-public-metadata.mjs';

const identity = { company: 'Example Memory Inc.', contact: 'team@example.test', site: 'https://memory.example.test', repository: 'https://github.com/example/memory' };
const contact = `[${identity.contact}](mailto:${identity.contact})`;
const html = `<footer><a href="mailto:team%40example.test">team&#64;example.test</a></footer>`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mnemosyne-public-metadata-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = {
    'scripts/public-identity.json': JSON.stringify(identity),
    'package.json': JSON.stringify({ version: '1.2.3', author: { name: identity.company, email: identity.contact, url: identity.site }, homepage: identity.site, repository: { url: identity.repository }, bugs: { url: `${identity.repository}/issues` } }),
    'python/pyproject.toml': `[project]\nname = "example"\nauthors = [{name = "${identity.company}", email = "${identity.contact}"}]\n\n[project.urls]\nHomepage = "${identity.site}"\nRepository = "${identity.repository}"\nIssues = "${identity.repository}/issues"\n`,
    'README.md': `${contact}\n[Source](${identity.repository}/releases/tag/v1.2.3)\n\n\`\`\`sh\nnpm install @upstream/client\necho developer@upstream.test\n\`\`\``,
    'CONTRIBUTING.md': contact,
    'SECURITY.md': contact,
    'CODE_OF_CONDUCT.md': contact,
    'docs/UPGRADE-STATUS.md': contact,
    '.github/ISSUE_TEMPLATE/config.yml': `about: Contact ${identity.contact}`,
    '.github/ISSUE_TEMPLATE/bug_report.yml': `Contact **${identity.contact}** privately.`,
    '.github/ISSUE_TEMPLATE/feature_request.yml': `Contact **${identity.contact}** privately.`,
    'site/index.html': html,
    'site/docs/index.html': html,
    'site/features/index.html': html,
    'site/compare/index.html': html,
    'site/docs/reference/RECALL.html': `${html}<pre><code>developer@upstream.test</code></pre>`,
    'site/release-evidence.json': JSON.stringify({ release: '1.2.3 source release candidate', publication: { githubRelease: `${identity.repository}/releases/tag/v1.2.3`, registriesPublished: false } }),
    'NOTICE.md': 'Copyright upstream@vendor.test',
    'site/vendor/library/LICENSE.html': '<a href="mailto:upstream@vendor.test">upstream@vendor.test</a>',
    'docs/RESEARCH.md': `[Historical branch](${identity.repository}/tree/codex/old-work) author@upstream.test`,
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

function replace(root, file, before, after) {
  const path = join(root, file), original = readFileSync(path, 'utf8');
  assert.ok(original.includes(before), `fixture must contain ${before}`);
  writeFileSync(path, original.replace(before, after));
}

test('accepts current identity, encoded contact, unpublished registries and third-party technical notices', t => {
  assert.deepEqual(checkPublicMetadata(fixture(t)).errors, []);
});

test('rejects displayed contact drift even when the HTML link still sends to the correct recipient', t => {
  const root = fixture(t);
  replace(root, 'site/index.html', 'team&#64;example.test</a>', 'old&#64;example.test</a>');
  assert.match(checkPublicMetadata(root).errors.join('\n'), /site\/index.html: displayed contact/);
});

test('rejects a Markdown mailto recipient hidden behind the correct displayed address', t => {
  const root = fixture(t);
  replace(root, 'SECURITY.md', 'mailto:team@example.test', 'mailto:old@example.test');
  assert.match(checkPublicMetadata(root).errors.join('\n'), /SECURITY.md: mailto recipient/);
});

test('decodes percent and HTML entity recipients before checking where email is sent', async t => {
  for (const recipient of ['old%40example.test', 'old&#64;example.test', 'old&#x40;example.test']) await t.test(recipient, t => {
    const root = fixture(t);
    replace(root, 'site/index.html', 'team%40example.test', recipient);
    assert.match(checkPublicMetadata(root).errors.join('\n'), /site\/index.html: mailto recipient/);
  });
});

test('requires contacts on security pages, issue templates and generated reference pages', async t => {
  for (const file of ['SECURITY.md', 'docs/UPGRADE-STATUS.md', '.github/ISSUE_TEMPLATE/config.yml', 'site/docs/reference/RECALL.html']) await t.test(file, t => {
    const root = fixture(t);
    writeFileSync(join(root, file), 'Contact information was accidentally removed.');
    assert.ok(checkPublicMetadata(root).errors.some(error => error === `${file}: missing public support contact`));
  });
});

test('checks destinations in HTML, Markdown references and issue-template URL fields', async t => {
  for (const link of [
    '<a href=mailto:wrong%40example.test>Contact</a>',
    '<mailto:wrong%40example.test>',
    '[Contact][support]\n[support]: mailto:wrong%40example.test',
    'url: mailto:wrong%40example.test',
  ]) await t.test(link, t => {
    const root = fixture(t);
    writeFileSync(join(root, '.github/ISSUE_TEMPLATE/config.yml'), `about: Contact ${identity.contact}\n${link}`);
    assert.match(checkPublicMetadata(root).errors.join('\n'), /config.yml: mailto recipient/);
  });
});

test('rejects drift in JavaScript and Python package author metadata', async t => {
  for (const file of ['package.json', 'python/pyproject.toml']) await t.test(file, t => {
    const root = fixture(t);
    replace(root, file, identity.contact, 'former@example.test');
    assert.ok(checkPublicMetadata(root).errors.some(error => error.startsWith(`${file}: author.email`)));
  });
});

test('rejects stale publication text while retaining a separate unpublished registry state', t => {
  const root = fixture(t);
  replace(root, 'site/release-evidence.json', '1.2.3 source release candidate', '1.2.3 source candidate; publication pending');
  assert.match(checkPublicMetadata(root).errors.join('\n'), /publication pending contradicts the available tagged source/);
});

test('rejects retired branch links on company surfaces but permits main and source release tags', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'CONTRIBUTING.md'), `${contact}\n[Current](${identity.repository}/blob/main/SECURITY.md)\n[Source](${identity.repository}/tree/v1.2.3/docs)`);
  assert.deepEqual(checkPublicMetadata(root).errors, []);
  replace(root, 'CONTRIBUTING.md', '/tree/v1.2.3/docs', '/tree/codex/retired-branch/docs');
  assert.match(checkPublicMetadata(root).errors.join('\n'), /CONTRIBUTING.md: retired branch link/);
});

test('current security and contributor policies cannot resolve to an old release snapshot', async t => {
  for (const policy of ['SECURITY', 'CONTRIBUTING']) await t.test(policy, t => {
    const root = fixture(t);
    writeFileSync(join(root, 'site/index.html'), `${html}<a href="${identity.repository}/blob/v1.2.3/${policy}.md">Policy</a>`);
    assert.match(checkPublicMetadata(root).errors.join('\n'), /current support policy must link to main/);
  });
});
