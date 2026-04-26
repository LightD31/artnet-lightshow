import { render } from 'preact';
import { stateSig } from './state.js';

import { Header } from './components/Header.jsx';
import { Tempo } from './components/Tempo.jsx';
import { Transport } from './components/Transport.jsx';
import { Colors } from './components/Colors.jsx';
import { Strobe } from './components/Strobe.jsx';
import { Prolink } from './components/Prolink.jsx';
import { AutoMode } from './components/AutoMode.jsx';
import { Energy } from './components/Energy.jsx';
import { Patterns } from './components/Patterns.jsx';
import { Fixtures } from './components/Fixtures.jsx';
import { DmxMonitor } from './components/DmxMonitor.jsx';

function Root() {
  // Touch the signal so the whole tree re-renders on every state push.
  // (Granular subscriptions are overkill for a 10 Hz state stream.)
  void stateSig.value;

  return (
    <>
      <Header />
      <main>
        <aside>
          <Tempo />
          <Transport />
          <Colors />
          <Strobe />
          <Prolink />
        </aside>
        <div class="right-panel">
          <AutoMode />
          <Energy />
          <Patterns />
          <Fixtures />
          <DmxMonitor />
        </div>
      </main>
    </>
  );
}

render(<Root />, document.getElementById('app'));
