"""Validation helpers for the stable, model-agnostic analysis document."""

REQUIRED = ('track', 'beats', 'sections', 'events')

def validate(document):
    missing = [field for field in REQUIRED if field not in document]
    if missing:
        raise ValueError('analysis document missing: ' + ', '.join(missing))
    track = document['track']
    if not isinstance(track, dict) or not track.get('hash'):
        raise ValueError('analysis document requires track.hash')
    if float(track.get('duration', 0)) <= 0:
        raise ValueError('analysis document requires a positive duration')
    return document

def timing(elapsed_sec, duration_sec):
    elapsed = max(0.0, float(elapsed_sec)); duration = max(0.001, float(duration_sec))
    return {'analysisDuration': round(elapsed, 3), 'ratio': round(elapsed / duration, 4), 'withinRealtimeBudget': elapsed < duration}
