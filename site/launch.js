(() => {
  'use strict';

  // Navigation remains fully available when JavaScript is disabled.
  const navigation = document.getElementById('main-nav');
  const header = navigation?.closest('.site-header');
  if (navigation && header) {
    const narrow = window.matchMedia('(max-width: 760px)');
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'nav-toggle';
    toggle.textContent = 'Menu';
    toggle.setAttribute('aria-controls', navigation.id);
    toggle.setAttribute('aria-expanded', 'false');
    header.insertBefore(toggle, navigation);
    header.classList.add('nav-enhanced');
    let open = false;

    const renderNavigation = () => {
      toggle.hidden = !narrow.matches;
      navigation.hidden = narrow.matches && !open;
      toggle.setAttribute('aria-expanded', String(narrow.matches && open));
      toggle.textContent = open && narrow.matches ? 'Close' : 'Menu';
    };
    toggle.addEventListener('click', () => {
      open = !open;
      renderNavigation();
    });
    navigation.addEventListener('click', event => {
      if (event.target instanceof Element && event.target.closest('a')) {
        open = false;
        renderNavigation();
      }
    });
    header.addEventListener('keydown', event => {
      if (event.key === 'Escape' && narrow.matches && open) {
        open = false;
        renderNavigation();
        toggle.focus();
      }
    });
    document.addEventListener('click', event => {
      if (open && event.target instanceof Node && !header.contains(event.target)) {
        open = false;
        renderNavigation();
      }
    });
    narrow.addEventListener('change', () => {
      const focusWillHide = narrow.matches && navigation.contains(document.activeElement);
      const toggleWillHide = !narrow.matches && document.activeElement === toggle;
      open = false;
      renderNavigation();
      if (focusWillHide) toggle.focus();
      if (toggleWillHide) navigation.querySelector('a')?.focus();
    });
    renderNavigation();
  }

  // This explains the bridge policy; it never connects to a memory store.
  const explainer = document.querySelector('[data-bridge-explainer]');
  if (!explainer) return;
  const tablist = explainer.querySelector('.bridge-stages');
  const tabs = Array.from(explainer.querySelectorAll('.bridge-stage'));
  const panels = tabs.map(tab => document.getElementById(tab.hash.slice(1)));
  if (!tablist || tabs.length === 0 || panels.some(panel => !panel)) return;

  tablist.setAttribute('role', 'tablist');
  tabs.forEach((tab, index) => {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panels[index].id);
    panels[index].setAttribute('role', 'tabpanel');
    panels[index].setAttribute('aria-labelledby', tab.id);
    panels[index].tabIndex = 0;
  });

  const select = (selectedIndex, focus = false) => {
    tabs.forEach((tab, index) => {
      const selected = selectedIndex === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[index].hidden = !selected;
      if (selected && focus) tab.focus();
    });
  };
  const selectFromHash = () => {
    const index = tabs.findIndex(tab => tab.hash === window.location.hash);
    if (index >= 0) select(index);
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', event => {
      event.preventDefault();
      select(index);
    });
    tab.addEventListener('keydown', event => {
      let nextIndex;
      if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') nextIndex = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      if (event.key === ' ') nextIndex = index;
      if (nextIndex === undefined) return;
      event.preventDefault();
      select(nextIndex, true);
    });
  });
  select(0);
  selectFromHash();
  window.addEventListener('hashchange', selectFromHash);
})();
