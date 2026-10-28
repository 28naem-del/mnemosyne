(() => {
  'use strict';
  const root = document.getElementById('moments-demo');
  if (!root) return;
  const byId = id => document.getElementById(id);
  // Site-written headings and summaries, keyed by moment id. The recording's own
  // lines, proof values and timings are shown exactly as recorded.
  const moments = {
    1: { label: 'Replay', title: 'A past belief, replayed exactly.', detail: 'The belief state is hashed at 1,000 seeded (asOf, knownAt) cut points by two readers: the recording process, then a separate process opening the same file cold. Every as-of answer is checked against ground truth computed from the seeded plan, never from the store.' },
    2: { label: 'Correct', title: 'One correction reaches dependents nobody linked.', detail: 'Dependencies are inferred from successful co-use (rule co-use-success-v1, no model) and accepted by a synthetic reviewer. One correct() call then invalidates every dependent, including three that were never declared. A decoy used only in failed tasks survives. The premise guard is not used here.' },
    3: { label: 'Bisect', title: 'Bisect names the record that made it wrong.', detail: 'One confident, false record among 2,000 displaces a verified answer. bisect delta-debugs the store, names that record with its source and trust, then re-runs recall without it to confirm the right answer returns to rank 1.' },
    4: { label: 'Poisoning', title: 'A poisoning attempt, caught where you can see it.', detail: 'A synthetic web page carrying an instruction for AI assistants is stored as untrusted. The caller sets that tier; the kernel does not infer it. Default recall stays clean, an auditor can still find the record, promotion through copied corroboration is refused by rule ancestry-disjoint-v1, and poisoning suite v1 runs in full.' },
    5: { label: 'Consolidate', title: 'One consolidation kept, two rolled back, the kept one undone.', detail: 'Three consolidation passes go through the outcome gate on a scratch copy. One is kept and two are rolled back with named reasons. The kept pass is undone in one call, back to the identical state hash, and the signed receipt chain verifies. This covers the ten recorded tasks it replays, not tasks that were never recorded.' },
  };
  const ids = Object.keys(moments).map(Number);
  const node = (tag, className, text) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };
  const isText = value => typeof value === 'string';
  const seconds = ms => `${(ms / 1000).toFixed(2)} s`;
  function validate(value) {
    if (!value || value.mode !== 'recorded' || !Array.isArray(value.moments) || !Array.isArray(value.limitations) || !Array.isArray(value.pending)) throw new Error('Invalid recording');
    if (!isText(value.generatedAt) || Number.isNaN(Date.parse(value.generatedAt)) || !Number.isFinite(value.durationMs) || value.durationMs < 0) throw new Error('Invalid recording time');
    if (value.moments.length !== ids.length || value.moments.some((moment, index) => moment.id !== ids[index])) throw new Error('Invalid moments');
    for (const moment of value.moments) {
      const proof = moment.proof;
      if (!Array.isArray(moment.lines) || !moment.lines.length || moment.lines.some(line => !isText(line)) || !Number.isFinite(moment.durationMs) || moment.durationMs < 0) throw new Error('Invalid moment');
      if (!proof || !isText(proof.label) || !isText(proof.measured) || !isText(proof.threshold) || typeof proof.passed !== 'boolean' || !moment.lines[moment.lines.length - 1].startsWith('PROOF')) throw new Error('Invalid proof');
    }
    if (value.total !== value.moments.length || value.passed !== value.moments.filter(moment => moment.proof.passed).length || value.pending.length !== 0 || value.limitations.some(item => !isText(item))) throw new Error('Inconsistent recording');
    return value;
  }
  async function load() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(root.dataset.demoUrl || './demo-five.json', { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) throw new Error('Recording unavailable');
      const report = validate(await response.json());
      const recordedOn = report.generatedAt.slice(0, 10);
      byId('moments-label').textContent = `Recorded on the built 3.0.0-rc.2 engine on ${recordedOn}; not a live model · synthetic corpora · lexical path · no LLM`;
      const score = byId('moments-score');
      score.textContent = `${report.passed} / ${report.total} proofs passed · recorded run ${seconds(report.durationMs)}`;
      score.className = report.passed === report.total ? 'run-score' : 'check-fail';
      const nav = byId('moments-nav');
      const transcript = byId('moments-lines');
      let selected = 0;
      function render(announce = true) {
        const moment = report.moments[selected];
        const copy = moments[moment.id];
        byId('moments-meta').textContent = `Moment ${moment.id} of ${report.total} · recorded in ${seconds(moment.durationMs)}`;
        byId('moments-title').textContent = copy.title;
        byId('moments-detail').textContent = copy.detail;
        const proof = byId('moments-proof');
        const status = node('span', moment.proof.passed ? 'check-icon' : 'check-fail', moment.proof.passed ? 'Passed in this recording' : 'Failed in this recording');
        const facts = node('dl', 'moments-proof-facts');
        facts.append(node('dt', '', 'Measured'), node('dd', '', moment.proof.measured), node('dt', '', 'Bar'), node('dd', '', moment.proof.threshold));
        proof.replaceChildren(node('p', 'moments-proof-label', `PROOF · ${moment.proof.label}`), status, facts);
        const body = moment.lines.slice(0, -1).join('\n');
        transcript.replaceChildren(document.createTextNode(body ? `${body}\n` : ''), node('span', 'moments-proof-line', moment.lines[moment.lines.length - 1]));
        transcript.scrollTop = 0;
        transcript.classList.remove('is-entering');
        void transcript.offsetWidth;
        transcript.classList.add('is-entering');
        for (const [index, button] of [...nav.children].entries()) {
          if (index === selected) button.setAttribute('aria-current', 'step');
          else button.removeAttribute('aria-current');
        }
        byId('moments-count').textContent = `Moment ${selected + 1} of ${report.moments.length}`;
        byId('moments-previous').disabled = selected === 0;
        byId('moments-next').disabled = selected === report.moments.length - 1;
        if (announce) byId('moments-announcement').textContent = `Moment ${moment.id}: ${copy.title} Proof ${moment.proof.passed ? 'passed' : 'failed'}: ${moment.proof.measured}.`;
      }
      const select = (index, focus = false) => {
        selected = Math.max(0, Math.min(report.moments.length - 1, index));
        render();
        if (focus) nav.children[selected].focus();
      };
      for (const [index, moment] of report.moments.entries()) {
        const button = node('button', 'step-button');
        button.type = 'button';
        button.append(node('span', '', String(moment.id).padStart(2, '0')), document.createTextNode(moments[moment.id].label));
        button.addEventListener('click', () => select(index));
        nav.append(button);
      }
      nav.addEventListener('keydown', event => {
        const keys = { ArrowRight: selected + 1, ArrowDown: selected + 1, ArrowLeft: selected - 1, ArrowUp: selected - 1, Home: 0, End: report.moments.length - 1 };
        if (!(event.key in keys)) return;
        event.preventDefault();
        select(keys[event.key], true);
      });
      byId('moments-previous').addEventListener('click', () => select(selected - 1));
      byId('moments-next').addEventListener('click', () => select(selected + 1));
      for (const limitation of report.limitations) byId('moments-limits').append(node('li', '', limitation));
      render(false);
      byId('moments-loading').hidden = true;
      byId('moments-content').hidden = false;
      root.dataset.moments = String(report.moments.length);
    } catch {
      byId('moments-score').textContent = 'Recording unavailable';
      byId('moments-loading').textContent = 'Serve this site over HTTP to load the recording, or run npx -y -p mnemosy-ai@next mnemosy demo to measure the five moments on your own machine. The raw recording link below remains available.';
    } finally {
      window.clearTimeout(timeout);
      root.dataset.initialLayout = 'settled';
      window.dispatchEvent(new CustomEvent('mnemosyne:demoready'));
    }
  }
  void load();
})();
