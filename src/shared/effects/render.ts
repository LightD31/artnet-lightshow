// The one way in for every host that renders: importing this registers every
// kind, so the server, its worker and the rehearsal preview render alike.

import './index.ts';

export { renderEffect } from './render-instance.ts';
