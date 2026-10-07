const post = (path, body) => ({ path, method: 'POST', ...(body ? { body } : {}) });

export function showActive(s) {
  return !!(s.showOn || s.autoShow?.startPending || s.autoShow?.status === 'playing');
}

export function startShow(s) {
  if (s.autoShow?.status === 'ready') return post('/api/auto/start');
  const requested = s.autoSource || 'auto';
  const source = requested === 'auto' ? s.activeSource || 'timer' : requested;
  const service = source === 'hybrid' ? 'spotify' : source;
  return ['spotify', 'deezer', 'nowplaying', 'prolink'].includes(service)
    ? post(`/api/auto/analyze-${service}`, { start: true }) : post('/api/auto/start');
}

export function driverOf(s, chosen = null) {
  if (chosen === 'auto') return 'auto';
  if (s.sequence?.loaded) return 'sequence';
  if (showActive(s)) return 'auto';
  return chosen === 'sequence' ? 'sequence' : 'look';
}

export function chooseDriver(value, s) {
  if (value.startsWith('sequence:')) return [{ path: '/api/sequence', method: 'PUT', body: { id: value.slice(9) } }];
  const requests = [];
  if (s.sequence?.loaded) requests.push({ path: '/api/sequence', method: 'DELETE' });
  if (value === 'look' && (showActive(s) || ['downloading', 'analyzing'].includes(s.autoShow?.status))) requests.push(post('/api/auto/stop'));
  return requests;
}

export function transportButtons(driver, s) {
  if (driver === 'sequence') {
    const q = s.sequence, loaded = !!q?.loaded, playing = !!(q?.playing && !q.paused), loop = q?.loop;
    return [
      { id: playing ? 'pause' : 'play', label: playing ? 'Pause' : 'Play', enabled: loaded },
      { id: 'stop', label: 'Stop', enabled: loaded },
      { id: 'next', label: 'Next', enabled: loaded },
      { id: 'shuffle', label: 'Shuffle', enabled: loaded },
      { id: 'loop', label: 'Loop', enabled: loaded && !!loop, pressed: !!loop?.on },
    ].map((button) => ({ ...button, request: post(`/api/sequence/${button.id}`,
      button.id === 'loop' && loop ? { ...loop, on: !loop.on } : null) }));
  }
  if (driver === 'auto') {
    const busy = ['downloading', 'analyzing'].includes(s.autoShow?.status), running = showActive(s);
    return [
      { id: 'play', label: busy ? 'Analysing…' : 'Start show', enabled: !busy && !running, request: startShow(s) },
      { id: 'stop', label: 'Stop show', enabled: running || busy, request: post('/api/auto/stop') },
      ...(busy ? [{ id: 'cancel', label: 'Cancel analysis', enabled: true, request: post('/api/auto/cancel') }] : []),
    ];
  }
  return [
    { id: s.running ? 'pause' : 'play', label: s.running ? 'Freeze look' : 'Play look', enabled: true, request: { set: { running: !s.running } } },
    { id: 'stop', label: 'Stop look', enabled: !!s.running, request: { set: { running: false } } },
  ];
}
