"""
Guards the ordering that makes PANNs usable on Windows.

panns_inference fetches its own data files with `wget` — at *import* time, in
config.py — and then reads the labels CSV unconditionally. On a machine without
wget (i.e. stock Windows) the import prints a shell error and raises
FileNotFoundError.

The trap is that any bootstrap placed after the import can never run, because
there is no "after". These tests pin the invariants that keep the bootstrap
reachable. They are all offline.
"""

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def load_analyzer():
    """Load essentia-analyze.py by path — it is a script, not an importable
    module name."""
    spec = importlib.util.spec_from_file_location(
        'essentia_analyze', REPO / 'src' / 'essentia-analyze.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules['essentia_analyze'] = module
    spec.loader.exec_module(module)
    return module


class PannsBootstrapOrdering(unittest.TestCase):
    def setUp(self):
        self.ea = load_analyzer()

    def test_installed_check_does_not_execute_the_package(self):
        """The whole point: asking 'is it installed?' must not import it.

        Importing is what triggers the wget call, so a check implemented with
        `import panns_inference` would cause the very failure it is meant to
        detect.
        """
        with tempfile.TemporaryDirectory() as tmp:
            pkg = Path(tmp) / 'panns_inference'
            pkg.mkdir()
            marker = Path(tmp) / 'was-imported'
            # A stand-in whose import has an observable side effect.
            (pkg / '__init__.py').write_text(
                f'open({str(marker)!r}, "w").close()\n'
                'raise RuntimeError("import should not have happened")\n'
            )
            sys.path.insert(0, tmp)
            try:
                importlib.invalidate_caches()
                self.assertTrue(self.ea._panns_installed(),
                                'must detect the package')
                self.assertFalse(marker.exists(),
                                 '__init__.py must not have been executed')
            finally:
                sys.path.remove(tmp)
                sys.modules.pop('panns_inference', None)

    def test_installed_check_is_false_when_absent(self):
        self.assertFalse(
            importlib.util.find_spec('panns_inference') is not None
            and not self.ea._panns_installed())

    def test_existing_labels_are_not_re_downloaded(self):
        calls = []
        self.ea._run_panns_setup = lambda *a, **k: calls.append(a)
        with tempfile.TemporaryDirectory() as tmp:
            labels = Path(tmp) / 'class_labels_indices.csv'
            labels.write_text('index,mid,display_name\n')
            self.ea._PANNS_LABELS = str(labels)
            self.assertTrue(self.ea._ensure_panns_labels())
            self.assertEqual(calls, [], 'a present file needs no download')

    def test_missing_labels_trigger_the_labels_only_fetch(self):
        """Startup must never be able to kick off the 310 MB checkpoint."""
        calls = []
        self.ea._run_panns_setup = lambda args, note: calls.append(list(args))
        with tempfile.TemporaryDirectory() as tmp:
            self.ea._PANNS_LABELS = str(Path(tmp) / 'nope.csv')
            self.assertFalse(self.ea._ensure_panns_labels())
            self.assertEqual(calls, [['--labels-only']])

    def test_preload_skips_without_a_checkpoint_and_never_imports(self):
        """No checkpoint means no model, so preload must bail out before doing
        anything that could touch the package or the network."""
        calls = []
        self.ea._run_panns_setup = lambda args, note: calls.append(list(args))
        self.ea._panns_installed = lambda: True
        with tempfile.TemporaryDirectory() as tmp:
            self.ea._PANNS_CKPT = str(Path(tmp) / 'absent.pth')
            self.ea._preload_panns()
            self.assertEqual(calls, [], 'no download at server startup')
            self.assertIsNone(self.ea._PANNS_AT)

    def test_analysis_path_asks_for_both_files(self):
        calls = []
        self.ea._run_panns_setup = lambda args, note: calls.append(list(args))
        with tempfile.TemporaryDirectory() as tmp:
            self.ea._PANNS_LABELS = str(Path(tmp) / 'nope.csv')
            self.ea._PANNS_CKPT = str(Path(tmp) / 'absent.pth')
            self.assertFalse(self.ea._ensure_panns_files())
            self.assertEqual(calls, [[]], 'full setup, not --labels-only')

    def test_setup_script_accepts_labels_only(self):
        """The analyzer shells out with this flag; it has to exist."""
        setup = (REPO / 'scripts' / 'setup-panns.py').read_text()
        self.assertIn("'--labels-only'", setup)

    def test_setup_dependency_check_does_not_import_panns(self):
        """Same trap, other script: importing to check would report an
        installed package as missing on exactly the machines this fixes."""
        setup = (REPO / 'scripts' / 'setup-panns.py').read_text()
        check = setup.split('def check_python_deps')[1].split('\ndef ')[0]
        self.assertNotIn('import panns_inference', check)
        self.assertIn('find_spec', check)


if __name__ == '__main__':
    unittest.main()
