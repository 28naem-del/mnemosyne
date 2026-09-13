(() => {
  'use strict';
  const routes = { '/features.html': '/features/', '/docs.html': '/docs/', '/compare.html': '/compare/' };
  const target = routes[window.location.pathname];
  if (target) window.location.replace(target + window.location.search + window.location.hash);
})();
