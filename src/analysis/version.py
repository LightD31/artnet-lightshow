"""Schema version for the analysis document.

Bump the *major* part when a consumer that reads the document would break
(a field removed, a unit changed, an event type given new meaning); bump the
*minor* part for additive changes. `analysis-cache` stores the version with
each entry and re-analyses anything older than MIN_COMPATIBLE.
"""

SCHEMA_VERSION = '2.0'

# Documents older than this are re-analysed rather than replayed: the 1.x
# analyser had no event stream, no band detail and no section roles.
MIN_COMPATIBLE = '2.0'
