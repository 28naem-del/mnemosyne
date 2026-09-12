(() => {
  'use strict';

  const element = (tag, className, value) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  };

  for (const button of document.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
      const target = document.getElementById(button.dataset.copy);
      if (!target) return;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(target.textContent);
        button.textContent = 'Copied';
      } catch {
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        button.textContent = 'Text selected';
      }
      window.setTimeout(() => { button.textContent = 'Copy'; }, 2500);
    });
  }

  const demo = document.getElementById('memory-demo');
  if (!demo) return;
  const byId = id => document.getElementById(id);
  const labels = ['Evidence', 'A useful lesson', 'Handoff', 'Correction', 'Recovery', 'Forget'];
  let report;
  let stepIndex = 0;
  let selectedRecordId;
  let view = 'context';

  function checkpointText(record) {
    const checkpoint = record.metadata?.checkpoint;
    return checkpoint ? `${checkpoint.goal}. Next: ${checkpoint.nextAction}` : record.text;
  }

  function selectView(nextView, focus = false) {
    view = nextView;
    for (const tab of demo.querySelectorAll('[data-view]')) {
      const selected = tab.dataset.view === view;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (selected && focus) tab.focus();
    }
    byId('inspector-panel').setAttribute('aria-labelledby', `tab-${view}`);
    renderInspector();
  }

  function addDetail(list, label, value) {
    list.append(element('dt', '', label), element('dd', '', value ?? 'None'));
  }

  function renderInspector() {
    const step = report.steps[stepIndex];
    const panel = byId('inspector-panel');
    panel.replaceChildren();
    panel.scrollTop = 0;
    if (view === 'checks') {
      panel.append(element('p', 'context-summary', `Step ${stepIndex + 1} verification`));
      const checks = element('ul', 'checks');
      if (!step.checks.length) panel.append(element('p', 'context-empty', 'No checks were recorded for this step.'));
      for (const check of step.checks) {
        const item = element('li');
        item.append(element('span', check.passed ? 'check-icon' : 'check-fail', check.passed ? '✓' : '×'), element('span', '', `${check.passed ? 'Passed' : 'Failed'}: ${check.label}`));
        checks.append(item);
      }
      panel.append(checks, element('p', 'context-instruction', 'These checks exercise the memory engine with synthetic data. They do not measure language-model performance.'));
      return;
    }
    if (view === 'record') {
      const record = step.memories.find(memory => memory.id === selectedRecordId) ?? step.memories[0];
      if (!record) { panel.append(element('p', 'context-empty', 'No visible records at this step.')); return; }
      panel.append(element('p', 'context-summary', 'Selected record · persisted fields'));
      const list = element('dl', 'detail-list');
      for (const [label, value] of [
        ['Record ID', record.id], ['Owner', record.agentId], ['Visibility', record.visibility],
        ['Status', record.status], ['Trust', record.trust], ['Source', record.source.uri],
        ['Depends on', record.dependencies.length ? record.dependencies.join(', ') : 'No dependencies'],
        ['Supersedes', record.supersedes ?? 'No earlier record'], ['Updated', record.updatedAt],
      ]) addDetail(list, label, value);
      panel.append(list);
      const raw = element('details', 'demo-disclosure');
      raw.append(element('summary', '', 'Raw record JSON'));
      raw.append(element('pre', '', JSON.stringify(record, null, 2)));
      panel.append(raw);
      return;
    }
    const packet = step.context;
    const summary = element('div', 'context-summary');
    summary.append(element('span', '', `${packet.items.length} cited records`), element('span', '', `${packet.tokens.toLocaleString()} / ${packet.tokenBudget.toLocaleString()} budget units`));
    panel.append(summary, element('p', 'context-instruction', 'Retrieved memory is reference data, never permission to act. This run uses the default UTF-8 byte upper bound for its context budget.'));
    if (!packet.items.length) panel.append(element('p', 'context-empty', 'No eligible evidence fits this context. The engine abstains instead of inventing a memory.'));
    for (const item of packet.items) {
      const block = element('div', 'context-item');
      block.append(element('p', '', checkpointText(item)), element('code', '', item.source.uri));
      panel.append(block);
    }
    if (packet.uncertainty.length) {
      const uncertainty = element('details', 'demo-disclosure');
      uncertainty.append(element('summary', '', `Uncertainty (${packet.uncertainty.length})`));
      const list = element('ul');
      for (const note of packet.uncertainty) list.append(element('li', '', note));
      uncertainty.append(list);
      panel.append(uncertainty);
    }
    const raw = element('details', 'demo-disclosure');
    raw.append(element('summary', '', 'Exact compiled agent context'));
    raw.append(element('pre', '', packet.text));
    panel.append(raw);
    const diagnostics = element('details', 'demo-disclosure');
    diagnostics.append(element('summary', '', 'Citations and exclusions'));
    diagnostics.append(element('pre', '', JSON.stringify({ citations: packet.citations, excluded: packet.excluded, conflicts: packet.conflicts, abstained: packet.abstained }, null, 2)));
    panel.append(diagnostics);
  }

  function renderStep(announce = true) {
    const step = report.steps[stepIndex];
    const current = step.memories.find(memory => memory.id === selectedRecordId);
    if (!current) selectedRecordId = step.memories[0]?.id;
    byId('demo-agent').textContent = `Viewing as ${step.agent}`;
    byId('step-title').textContent = step.title;
    byId('step-description').textContent = step.description;
    byId('step-count').textContent = `Step ${stepIndex + 1} of ${report.steps.length} · ${step.memories.length} visible records`;
    for (const button of byId('step-nav').querySelectorAll('button')) {
      if (Number(button.dataset.step) === stepIndex) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
    }
    byId('step-previous').disabled = stepIndex === 0;
    byId('step-next').disabled = stepIndex === report.steps.length - 1;
    const list = byId('memory-list');
    list.replaceChildren();
    if (!step.memories.length) list.append(element('p', 'context-empty', 'No visible records at this step.'));
    for (const record of step.memories) {
      const button = element('button', `memory-record${record.status === 'active' ? '' : ' is-inactive'}`);
      button.type = 'button';
      button.setAttribute('aria-pressed', String(record.id === selectedRecordId));
      button.setAttribute('aria-label', `Inspect ${record.kind}: ${checkpointText(record)}`);
      const head = element('span', 'record-head');
      head.append(element('span', '', `${record.kind} / ${record.visibility}`), element('span', 'record-state', record.status));
      button.append(head, element('span', 'record-copy', checkpointText(record)), element('span', 'record-source', record.source.uri));
      button.addEventListener('click', () => {
        selectedRecordId = record.id;
        for (const sibling of list.children) sibling.setAttribute('aria-pressed', String(sibling === button));
        selectView('record');
        byId('demo-announcement').textContent = `Inspecting ${record.kind}, ${record.status}. Record details are in the inspector.`;
      });
      list.append(button);
    }
    list.scrollTop = 0;
    renderInspector();
    if (announce) byId('demo-announcement').textContent = `Step ${stepIndex + 1}: ${step.title}. Viewing as ${step.agent}.`;
  }

  function validateReport(data) {
    if (!data || data.mode !== 'recorded' || !Array.isArray(data.steps) || data.steps.length !== 6 || !Array.isArray(data.limitations)) throw new Error('Invalid recorded run');
    for (const step of data.steps) {
      if (typeof step.title !== 'string' || typeof step.description !== 'string' || typeof step.agent !== 'string' || !Array.isArray(step.memories) || !Array.isArray(step.checks)) throw new Error('Invalid step');
      if (!step.context || typeof step.context.text !== 'string' || !Array.isArray(step.context.items) || !Array.isArray(step.context.uncertainty)) throw new Error('Invalid context');
      if (!Number.isFinite(step.context.tokens) || !Number.isFinite(step.context.tokenBudget)) throw new Error('Invalid context budget');
      for (const record of [...step.memories, ...step.context.items]) {
        if (typeof record.id !== 'string' || typeof record.text !== 'string' || typeof record.source?.uri !== 'string' || !Array.isArray(record.dependencies)) throw new Error('Invalid record');
      }
      for (const check of step.checks) if (typeof check.label !== 'string' || typeof check.passed !== 'boolean') throw new Error('Invalid check');
    }
    const checks = data.steps.flatMap(step => step.checks);
    if (data.checksTotal !== checks.length || data.checksPassed !== checks.filter(check => check.passed).length) throw new Error('Inconsistent verification totals');
    return data;
  }

  async function loadDemo() {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(demo.dataset.demoUrl, { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) throw new Error('Recorded run unavailable');
      report = validateReport(await response.json());
      byId('run-score').textContent = `${report.checksPassed} / ${report.checksTotal} checks passed`;
      byId('run-score').className = report.checksPassed === report.checksTotal ? 'run-score' : 'check-fail';
      for (const [index, step] of report.steps.entries()) {
        const button = element('button', 'step-button');
        button.type = 'button';
        button.dataset.step = String(index);
        button.append(element('span', '', String(index + 1).padStart(2, '0')), document.createTextNode(labels[index]));
        button.setAttribute('aria-label', `Step ${index + 1}: ${step.title}`);
        button.addEventListener('click', () => { stepIndex = index; selectedRecordId = undefined; renderStep(); });
        byId('step-nav').append(button);
      }
      for (const tab of demo.querySelectorAll('[data-view]')) {
        tab.addEventListener('click', () => selectView(tab.dataset.view));
        tab.addEventListener('keydown', event => {
          const views = ['context', 'record', 'checks'];
          const index = views.indexOf(view);
          let next;
          if (event.key === 'ArrowRight') next = (index + 1) % views.length;
          if (event.key === 'ArrowLeft') next = (index + views.length - 1) % views.length;
          if (event.key === 'Home') next = 0;
          if (event.key === 'End') next = views.length - 1;
          if (next !== undefined) { event.preventDefault(); selectView(views[next], true); }
        });
      }
      byId('step-previous').addEventListener('click', () => { stepIndex = Math.max(0, stepIndex - 1); selectedRecordId = undefined; renderStep(); });
      byId('step-next').addEventListener('click', () => { stepIndex = Math.min(report.steps.length - 1, stepIndex + 1); selectedRecordId = undefined; renderStep(); });
      const evidence = byId('demo-evidence');
      evidence.replaceChildren();
      const generated = new Date(report.generatedAt);
      evidence.append(element('p', '', `Recorded ${Number.isNaN(generated.getTime()) ? 'date unavailable' : generated.toISOString()}. ${report.checksPassed} of ${report.checksTotal} checks passed.`));
      const list = element('ul');
      for (const step of report.steps) for (const check of step.checks) list.append(element('li', '', `${check.passed ? 'Passed' : 'Failed'}: ${check.label}`));
      evidence.append(list, element('p', '', 'Limits of this run:'));
      const limits = element('ul');
      for (const limitation of report.limitations) limits.append(element('li', '', limitation));
      evidence.append(limits);
      const rawLink = element('a', '', 'Download the complete recorded run');
      rawLink.href = './demo.json';
      rawLink.download = 'mnemosyne-demo.json';
      evidence.append(rawLink);
      renderStep(false);
      byId('demo-loading').hidden = true;
      byId('demo-content').hidden = false;
    } catch {
      byId('run-score').textContent = 'Recording unavailable';
      const loading = byId('demo-loading');
      loading.replaceChildren(element('p', '', 'The recorded run could not be loaded. Serve this site over HTTP, then reload the page, or reproduce the run locally with npm run demo.'));
      const link = element('a', '', 'Open the raw evidence file');
      link.href = './demo.json';
      loading.append(link);
    } finally { window.clearTimeout(timeout); }
  }
  void loadDemo();
})();
