import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(join(root, file), 'utf8');
const contact = '28naem@gmail.com';

test('public vulnerability guidance uses the established contact, not unconfirmed channels', () => {
  const identity = JSON.parse(read('scripts/public-identity.json'));
  assert.equal(identity.contact, contact);
  assert.equal(identity.securityContact, undefined);
  for (const file of ['SECURITY.md', 'CONTRIBUTING.md', 'GOVERNANCE.md', 'MAINTAINERS.md',
    '.github/ISSUE_TEMPLATE/bug_report.yml', '.github/ISSUE_TEMPLATE/config.yml', '.github/PULL_REQUEST_TEMPLATE.md']) {
    const text = read(file);
    assert.ok(text.includes(contact), file);
    assert.ok(!text.includes('security@mnemosy.ai'), file);
    assert.ok(!text.includes('/security/advisories/new'), file);
  }
  assert.ok(read('SECURITY.md').includes('not established reporting channels'));
});

test('security.txt lists only the established reporting email', () => {
  const contacts = [...read('site/.well-known/security.txt').matchAll(/^Contact: (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(contacts, ['mailto:' + contact]);
});

test('the issue vulnerability entry routes through the maintained security policy', () => {
  const entry = read('.github/ISSUE_TEMPLATE/config.yml').split('  - name: Report a vulnerability privately')[1];
  assert.ok(entry);
  assert.ok(entry.includes('url: https://github.com/28naem-del/mnemosyne/blob/main/SECURITY.md'));
});
