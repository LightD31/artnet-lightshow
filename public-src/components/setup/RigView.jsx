import { useSettings } from '../../setup-state.js';
import { SubTabs, SubPanel, useSubTab } from './SubTabs.jsx';
import { PlanEditor } from './PlanEditor.jsx';
import { Inspector } from './Inspector.jsx';
import { PatchTable } from './PatchTable.jsx';
import { Profiles } from './Profiles.jsx';
import { Outputs, ShowFile } from './Outputs.jsx';

/**
 * The rig: what is hung where and what it is, and where its DMX goes.
 *
 *   plan      the pixel map and the patch, one selection between them
 *   profiles  the fixture library
 *   outputs   Art-Net, sACN, WLED and Hue, and finding them on the network
 */
const TABS = [
  { id: 'plan', label: 'Plan & patch' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'outputs', label: 'Outputs' },
];

export function RigView() {
  useSettings();
  const [tab, setTab] = useSubTab('rig', TABS);
  return (
    <div class="setup-view rig-view">
      <SubTabs view="rig" tabs={TABS} tab={tab} setTab={setTab} label="Rig" />
      <SubPanel view="rig" tab={tab}>
        {tab === 'plan' && (
          <div class="rig-plan">
            <div class="rig-plan-top">
              <PlanEditor />
              <Inspector />
            </div>
            <PatchTable />
            <ShowFile />
          </div>
        )}
        {tab === 'profiles' && <Profiles />}
        {tab === 'outputs' && <Outputs />}
      </SubPanel>
    </div>
  );
}
