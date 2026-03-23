#!/usr/bin/env python3
"""Ableton Link bridge for Node.js.

Communicates via stdin/stdout using newline-delimited JSON.

Inbound commands (stdin):
  { "cmd": "enable" }
  { "cmd": "disable" }
  { "cmd": "setTempo", "bpm": 120 }
  { "cmd": "getTempo" }            -> responds { "type": "tempo", "bpm": ... }
  { "cmd": "getNumPeers" }         -> responds { "type": "peers", "peers": ... }

Outbound events (stdout):
  { "type": "tempo",  "bpm": 120.0 }
  { "type": "peers",  "peers": 2 }
  { "type": "status", "enabled": true }
"""

import asyncio
import json
import sys

import aalink


async def main():
    link = aalink.Link(120.0)
    enabled = False
    poll_task = None

    def send(obj):
        line = json.dumps(obj, separators=(',', ':'))
        sys.stdout.write(line + '\n')
        sys.stdout.flush()

    last_peers = -1
    last_bpm = -1.0

    async def poll_link():
        nonlocal last_peers, last_bpm
        while True:
            peers = link.numPeers()
            bpm = round(link.tempo(), 2)
            if peers != last_peers:
                last_peers = peers
                send({'type': 'peers', 'peers': peers})
            if bpm != last_bpm:
                last_bpm = bpm
                send({'type': 'tempo', 'bpm': bpm})
            await asyncio.sleep(0.05)

    async def read_stdin():
        nonlocal enabled, poll_task
        loop = asyncio.get_event_loop()
        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, sys.stdin)

        while True:
            line = await reader.readline()
            if not line:
                break
            try:
                msg = json.loads(line.decode().strip())
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue

            cmd = msg.get('cmd')

            if cmd == 'enable':
                if not enabled:
                    link.enabled = True
                    enabled = True
                    if poll_task is None or poll_task.done():
                        poll_task = asyncio.ensure_future(poll_link())
                    send({'type': 'status', 'enabled': True})

            elif cmd == 'disable':
                if enabled:
                    if poll_task and not poll_task.done():
                        poll_task.cancel()
                        try:
                            await poll_task
                        except asyncio.CancelledError:
                            pass
                    link.enabled = False
                    enabled = False
                    send({'type': 'status', 'enabled': False})

            elif cmd == 'setTempo':
                bpm = msg.get('bpm', 120)
                link.tempo = float(bpm)

            elif cmd == 'getTempo':
                send({'type': 'tempo', 'bpm': round(link.tempo(), 2)})

            elif cmd == 'getNumPeers':
                send({'type': 'peers', 'peers': link.numPeers()})

    # Signal ready
    send({'type': 'ready'})

    await read_stdin()


if __name__ == '__main__':
    asyncio.run(main())
