'use strict';

// Describe the models that produced this track, including cached analyses.
// Missing provenance in an older document must not imply a model ran.
function describeModelUsage(analysis) {
  const meta = analysis?.meta || {};
  const usage = meta.modelUsage || {};
  const named = (role, value, names, fallbacks = {}) => {
    if (typeof value !== 'string' || !value) return { role, model: 'Unknown', status: 'unknown' };
    if (fallbacks[value]) return { role, model: fallbacks[value], status: 'fallback' };
    return { role, model: names[value] || value, status: 'used' };
  };
  const optional = (role, model, used) => ({
    role, model, status: used === true ? 'used' : used === false ? 'unused' : 'unknown',
  });
  const tagger = usage.tagger ?? (meta.taggerUsed === true ? 'panns'
    : meta.taggerUsed === false ? 'none' : null);
  // Documents cached before the zero-shot classifier landed record only
  // whether the tagger ran, and back then that was the genre classifier.
  const genre = usage.genre ?? (tagger === 'panns' ? 'panns'
    : tagger === 'none' ? 'signal' : null);
  return [
    named('Rhythm', usage.rhythm, { beat_this: 'Beat This!', model: 'Beat This!' },
      { fallback: 'Signal processing' }),
    named('Separation', usage.separation, { bs_roformer: 'BS-RoFormer', demucs: 'Demucs' },
      { none: 'Frequency bands' }),
    named('Key', usage.key, { 's-key': 'S-KEY' }, { internal_perception: 'Internal perception' }),
    named('Genre', genre, { 'muq-mulan': 'MuQ-MuLan (zero-shot)', panns: 'PANNs (Cnn14)' },
      { signal: 'Tempo / arousal' }),
    named('Tagging', tagger, { panns: 'PANNs (Cnn14)' }, { none: 'Not used' }),
    optional('Embeddings', 'MuQ', usage.muq),
    optional('Semantics', 'MuQ-MuLan', usage.muqMulan),
  ];
}

function formatModelUsage(analysis) {
  return describeModelUsage(analysis).map(({ role, model, status }) => {
    const suffix = { used: '', fallback: ' (fallback)', unused: ' (not used)', unknown: ' (not recorded)' }[status];
    return `${role}: ${model}${suffix}`;
  }).join('; ');
}

module.exports = { describeModelUsage, formatModelUsage };
