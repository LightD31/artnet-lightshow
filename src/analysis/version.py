"""Schema version for the analysis document.

Bump the *major* part when a consumer that reads the document would break
(a field removed, a unit changed, an event type given new meaning); bump the
*minor* part for additive changes. `analysis-cache` stores the version with
each entry and re-analyses anything older than MIN_COMPATIBLE.
"""

# 2.1: sections may carry a SongFormer `function` and the `prechorus` role,
# `sectionSource` is always set, and `pulse` holds the stem envelopes and the
# drum lanes. Additive: 2.0 documents still play, without them.
# 2.2: `pulse.detector` says which lane rules found the drum hits. Additive.
SCHEMA_VERSION = '2.2'

# Documents older than this are re-analysed rather than replayed: the 1.x
# analyser had no event stream, no band detail and no section roles.
MIN_COMPATIBLE = '2.0'
