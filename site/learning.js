(() => {
  'use strict';
  const root = document.getElementById('learning-demo');
  if (!root) return;
  const byId = id => document.getElementById(id);
  const stages = [
    { label: 'Observe', title: 'Keep the evidence behind the lesson.', detail: 'Capture the supplied conversation exactly, then process a source-cited observation through the durable job queue.', ids: ['empty', 'capture', 'observe'] },
    { label: 'Propose', title: 'A promising procedure starts as a candidate.', detail: 'The proposed skill has steps, prerequisites and source dependencies. It stays out of agent context while it is untested.', ids: ['candidate'] },
    { label: 'Test', title: 'Run the procedure. Record the result.', detail: 'The demo controller executes two normalization cases. Passing that external trial makes the candidate eligible for reuse.', ids: ['trial'] },
    { label: 'Share', title: 'The next agent can use the lesson.', detail: 'An explicit workspace publication carries the lesson and its evidence to a second agent. Another workspace stays separate.', ids: ['share', 'peer', 'isolation'] },
    { label: 'Correct', title: 'Changed evidence retires the old advice.', detail: 'Correcting the original source invalidates the learned skill and the shared lesson immediately. The earlier evidence remains inspectable.', ids: ['retire', 'peer-retire', 'inspect'] },
    { label: 'Forget', title: 'A fresh start survives a restart.', detail: 'Forgetting removes the source and derived content from the live store. Its replay tombstone remains after reopening the database.', ids: ['forget', 'restart'] },
  ];
  const node = (tag, className, text) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  };
  function validate(value) {
    if (!value || value.kind !== 'deterministic integration demonstration' || value.mode !== 'recorded' || !Array.isArray(value.steps) || !Array.isArray(value.limitations)) throw new Error('Invalid learning run');
    const expected = stages.flatMap(stage => stage.ids);
    if (value.steps.length !== expected.length || new Set(value.steps.map(step => step.id)).size !== expected.length) throw new Error('Invalid learning steps');
    for (const step of value.steps) if (!expected.includes(step.id) || typeof step.title !== 'string' || typeof step.detail !== 'string' || !['passed', 'failed', 'not-run'].includes(step.status) || typeof step.passed !== 'boolean' || step.passed !== (step.status === 'passed')) throw new Error('Invalid learning check');
    if (value.checksTotal !== value.steps.length || value.checksPassed !== value.steps.filter(step => step.passed).length || value.passed !== (value.checksPassed === value.checksTotal)) throw new Error('Inconsistent learning checks');
    if (value.modelCalls !== 0 || value.externalModelCalls !== 0 || ![0, 1].includes(value.scriptedProposerCalls) || (value.passed && value.scriptedProposerCalls !== 1) || !Number.isSafeInteger(value.trialCasesPassed) || value.trialCasesPassed < 0 || value.limitations.some(item => typeof item !== 'string')) throw new Error('Invalid learning evidence');
    return value;
  }
  async function load() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch('./learning.json', { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) throw new Error('Learning run unavailable');
      const report = validate(await response.json());
      const score = byId('learning-score');
      score.textContent = `${report.checksPassed} / ${report.checksTotal} checks passed`;
      score.className = report.passed ? 'run-score' : 'check-fail';
      let selected = 0;
      function render(announce = true) {
        const stage = stages[selected];
        byId('learning-title').textContent = stage.title;
        byId('learning-detail').textContent = stage.ids.every(id => report.steps.find(item => item.id === id).passed) ? stage.detail : 'This stage did not complete successfully in the recording. Inspect the recorded checks for the failure or steps that did not run.';
        const checks = byId('learning-checks');
        checks.replaceChildren();
        for (const id of stage.ids) {
          const check = report.steps.find(item => item.id === id);
          const block = node('div', 'learning-check');
          block.append(node('span', check.passed ? 'check-icon' : check.status === 'failed' ? 'check-fail' : '', check.status === 'not-run' ? 'Not run' : check.passed ? 'Passed' : 'Failed'), node('h4', '', check.title), node('p', '', check.detail));
          checks.append(block);
        }
        for (const [index, button] of [...byId('learning-nav').children].entries()) {
          if (index === selected) button.setAttribute('aria-current', 'step');
          else button.removeAttribute('aria-current');
        }
        byId('learning-count').textContent = `Stage ${selected + 1} of ${stages.length}`;
        byId('learning-previous').disabled = selected === 0;
        byId('learning-next').disabled = selected === stages.length - 1;
        if (announce) byId('learning-announcement').textContent = `${stage.label}: ${stage.title}`;
      }
      for (const [index, stage] of stages.entries()) {
        const button = node('button', 'step-button');
        button.type = 'button';
        button.append(node('span', '', String(index + 1).padStart(2, '0')), document.createTextNode(stage.label));
        button.addEventListener('click', () => { selected = index; render(); });
        byId('learning-nav').append(button);
      }
      byId('learning-previous').addEventListener('click', () => { selected = Math.max(0, selected - 1); render(); });
      byId('learning-next').addEventListener('click', () => { selected = Math.min(stages.length - 1, selected + 1); render(); });
      byId('learning-trials').textContent = `${report.trialCasesPassed} passed trial cases · ${report.externalModelCalls} LLM calls`;
      for (const limitation of report.limitations) byId('learning-limits').append(node('li', '', limitation));
      render(false);
      byId('learning-loading').hidden = true;
      byId('learning-content').hidden = false;
    } catch {
      byId('learning-score').textContent = 'Recording unavailable';
      byId('learning-loading').textContent = 'Serve this site over HTTP to load the recording. Once the matching source release is published, run npm run demo:learning locally. The raw evidence link below remains available.';
    } finally {
      window.clearTimeout(timeout);
      root.dataset.initialLayout = 'settled';
      window.dispatchEvent(new CustomEvent('mnemosyne:demoready'));
    }
  }
  void load();
})();
