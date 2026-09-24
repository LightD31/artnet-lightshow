// The chosen theme, set before the page paints so a light or red-night screen
// never flashes the dark one first. The picker is in the header (Header.jsx);
// with no choice the page follows the system, dark when it says nothing.
(() => {
  let theme = null;
  try { theme = localStorage.getItem('lightshow.theme'); } catch { /* private mode */ }
  if (theme === 'dark' || theme === 'light' || theme === 'red') document.documentElement.setAttribute('data-theme', theme);
})();
