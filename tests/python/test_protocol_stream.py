"""
The worker's stdout carries its answers and nothing else.

The server reads one JSON reply per line from it. The pipeline runs models on
threads of their own, and two of them swapping `sys.stdout` at once
(`contextlib.redirect_stdout`) once left it pointing at a throwaway buffer:
every reply after that was written into the buffer, and the server waited ten
minutes for analyses that had finished. These pin down that nothing a library
does to stdout can reach the answers again.
"""

import io
import os
import subprocess
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from support import needs_numpy
from analysis import model_adapters as adapters

SRC = Path(__file__).resolve().parents[2] / 'src'

# The interleaving that lost the replies, made deterministic: one thread takes
# stdout for a buffer, a second takes it for stderr, the first puts back what
# it found, then the second puts back what it found — the buffer.
SCRIPT = r'''
import contextlib, io, os, sys, threading
sys.path.insert(0, sys.argv[1])
from analysis import cli

out = cli._claim_stdout()
first_in, second_in, first_out = threading.Event(), threading.Event(), threading.Event()

def first():
    with contextlib.redirect_stdout(io.StringIO()):
        first_in.set()
        second_in.wait()
        print('swallowed or logged, never an answer')
    first_out.set()

def second():
    first_in.wait()
    with contextlib.redirect_stdout(sys.stderr):
        second_in.set()
        first_out.wait()

threads = [threading.Thread(target=first), threading.Thread(target=second)]
for t in threads: t.start()
for t in threads: t.join()

print('a library printing after it all')
os.write(1, b'a native library writing to descriptor 1\n')
out.write('{"id": 1, "result": {}}\n')
out.flush()
'''


@needs_numpy
class TheAnswersHaveStdoutToThemselves(unittest.TestCase):
    def test_threads_swapping_stdout_cannot_take_the_replies(self):
        run = subprocess.run([sys.executable, '-c', SCRIPT, str(SRC)], capture_output=True, timeout=120)
        self.assertEqual(run.returncode, 0, run.stderr.decode(errors='replace'))
        # The answer and nothing else. (A print after that interleaving may
        # land in the first thread's buffer rather than the log; the pipeline
        # no longer swaps stdout for anything but stderr, and it is the
        # answers that must never go.)
        self.assertEqual(run.stdout, b'{"id": 1, "result": {}}\n')
        self.assertIn(b'a native library writing to descriptor 1', run.stderr)


class SKeyKeepsItsChatterToItself(unittest.TestCase):
    def test_its_print_is_silenced_without_touching_stdout(self):
        # A module of its own, as S-KEY's key_detection is: its print is the
        # module's to shadow.
        module = types.ModuleType('key_detection')
        exec(
            "import sys\n"
            "seen = []\n"
            "def detect_key(path, device='cpu'):\n"
            "    seen.append(sys.stdout)\n"
            "    print('\\n✅ Predicted key for track.wav: A minor\\n')\n"
            "    return ['A minor']\n",
            module.__dict__)
        seen = module.seen
        with patch.object(adapters, '_optional', return_value=module), \
                patch('sys.stdout', new=io.StringIO()) as stdout:
            result = adapters.skey_key('track.wav')
        self.assertEqual(result['value'], 'A minor')
        self.assertIs(seen[0], stdout, 'sys.stdout is left as it was while S-KEY runs')
        self.assertEqual(stdout.getvalue(), '', 'and its print goes nowhere')


if __name__ == '__main__':
    unittest.main()
