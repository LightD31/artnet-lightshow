// The old settings page's tabs, and the views that hold them now.
(() => {
  const moved = {
    check: 'preflight',
    rig: 'rig/plan',
    output: 'rig/outputs',
    control: 'settings',
    music: 'sources',
    server: 'settings',
  };
  const tab = window.location.hash.slice(1);
  window.location.replace(`/${window.location.search}#${moved[tab] || 'rig'}`);
})();
