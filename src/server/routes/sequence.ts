import { HttpError } from '../../errors.ts';
import { newUserId } from '../effect-library.ts';
import type { Express, Request, Response } from 'express';
import type { RouteContext } from './common.ts';

/**
 * The sequencer: the sequence loaded on the transport (GET/PUT
 * /api/sequence), the shelf of saved ones (/api/sequences), and the
 * transport's controls, each answered with its status.
 *
 * The loaded sequence is edited apart from the shelf: PUT /api/sequence
 * loads a whole sequence, or `{ id }` of one on the shelf, and saving it
 * back is a PUT to /api/sequences/:id. Nothing here arms the outputs.
 *
 * Hue Dynamics' patterns are kept on the shelf beside the sequences
 * (/api/sequence/patterns), dropped into the loaded sequence at a beat and
 * captured from it; a punch recording writes pad hits into it as clips.
 *
 * Errors fall through to the error handler: 400 for a sequence or a value
 * that does not validate, 404 for an id nothing has, 409 for a control with
 * nothing loaded, a clip that waits for the photosensitivity
 * acknowledgement, or an id the shelf has already.
 */
export function attachSequenceRoutes(app: Express, ctx: RouteContext): void {
  // Read when a request comes, as the other domains read theirs.
  const sequencer = () => ctx.integrations.sequence.sequencer;
  const shelf = () => ctx.integrations.sequence.store;
  /** A control taken: every page hears of it, and the caller gets the status. */
  const answer = (res: Response) => {
    ctx.integrations.broadcast();
    res.json({ ok: true, status: sequencer().status() });
  };

  app.get('/api/sequence', (_req, res) => {
    res.json({ ok: true, sequence: sequencer().current(), status: sequencer().status() });
  });

  app.put('/api/sequence', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    let raw: unknown = body;
    // Only an id: the one on the shelf.
    if (Object.keys(body).length === 1 && typeof body.id === 'string') {
      raw = shelf().get(body.id);
      if (!raw) return res.status(404).json({ ok: false, error: 'No such sequence' });
    }
    const sequence = sequencer().load(raw);
    ctx.integrations.broadcast();
    res.json({ ok: true, sequence, status: sequencer().status() });
  });

  app.get('/api/sequence/status', (_req, res) => res.json({ ok: true, status: sequencer().status() }));

  // ─── The shelf ────────────────────────────────────────────────────────────
  app.get('/api/sequences', (_req, res) => res.json({ ok: true, sequences: shelf().list() }));

  app.get('/api/sequences/:id', (req, res) => {
    const sequence = shelf().get(req.params.id);
    if (!sequence) return res.status(404).json({ ok: false, error: 'No such sequence' });
    res.json({ ok: true, sequence });
  });

  // A new one: its own id, or one made for it.
  app.post('/api/sequences', (req, res) => {
    const body = { ...((req.body ?? {}) as Record<string, unknown>) };
    if (body.id === undefined) {
      let id = newUserId();
      while (shelf().get(id)) id = newUserId();
      body.id = id;
    } else if (typeof body.id === 'string' && shelf().get(body.id)) {
      throw new HttpError(409, 'A sequence with that id is saved already: PUT /api/sequences/:id replaces it');
    }
    res.status(201).json({ ok: true, sequence: shelf().save(body) });
  });

  app.put('/api/sequences/:id', (req, res) => {
    if (!shelf().get(req.params.id)) return res.status(404).json({ ok: false, error: 'No such sequence' });
    res.json({ ok: true, sequence: shelf().save({ ...((req.body ?? {}) as Record<string, unknown>), id: req.params.id }) });
  });

  app.delete('/api/sequences/:id', (req, res) => {
    if (!shelf().remove(req.params.id)) return res.status(404).json({ ok: false, error: 'No such sequence' });
    res.json({ ok: true });
  });

  // ─── The transport ────────────────────────────────────────────────────────
  app.post('/api/sequence/play', (_req, res) => {
    sequencer().play();
    answer(res);
  });
  app.post('/api/sequence/pause', (_req, res) => {
    sequencer().pause();
    answer(res);
  });
  // ?blackout=1, or { "blackout": true }: black under every fixture rather than the last picture held.
  app.post('/api/sequence/stop', (req: Request, res) => {
    const flag = req.query.blackout;
    const blackout = (req.body as { blackout?: unknown } | undefined)?.blackout === true || flag === '1' || flag === 'true';
    sequencer().stop({ blackout });
    answer(res);
  });
  app.post('/api/sequence/next', (_req, res) => {
    sequencer().next();
    answer(res);
  });
  app.post('/api/sequence/prev', (_req, res) => {
    sequencer().prev();
    answer(res);
  });
  app.post('/api/sequence/shuffle', (_req, res) => {
    sequencer().shuffle();
    answer(res);
  });
  app.post('/api/sequence/resync/:boundary', (req, res) => {
    sequencer().resync(req.params.boundary as 'beat' | 'bar');
    answer(res);
  });
  app.post('/api/sequence/seek/:beat', (req, res) => {
    // A blank is no beat (Number() would read it as 0).
    const raw = req.params.beat.trim();
    sequencer().seek(raw === '' ? NaN : Number(raw));
    answer(res);
  });
  app.post('/api/sequence/jump/:clipId', (req, res) => {
    sequencer().jump(req.params.clipId);
    answer(res);
  });
  // The loop region, { on, startBeat, endBeat }, on the loaded sequence.
  app.post('/api/sequence/loop', (req, res) => {
    sequencer().setLoop(req.body ?? null);
    answer(res);
  });

  // ─── Patterns ─────────────────────────────────────────────────────────────
  app.get('/api/sequence/patterns', (_req, res) => res.json({ ok: true, patterns: shelf().listPatterns() }));

  app.get('/api/sequence/patterns/:id', (req, res) => {
    const pattern = shelf().getPattern(req.params.id);
    if (!pattern) return res.status(404).json({ ok: false, error: 'No such pattern' });
    res.json({ ok: true, pattern });
  });

  app.post('/api/sequence/patterns', (req, res) => {
    const body = { ...((req.body ?? {}) as Record<string, unknown>) };
    if (body.id === undefined) {
      let id = newUserId();
      while (shelf().getPattern(id)) id = newUserId();
      body.id = id;
    } else if (typeof body.id === 'string' && shelf().getPattern(body.id)) {
      throw new HttpError(409, 'A pattern with that id is saved already: PUT /api/sequence/patterns/:id replaces it');
    }
    res.status(201).json({ ok: true, pattern: shelf().savePattern(body) });
  });

  app.put('/api/sequence/patterns/:id', (req, res) => {
    if (!shelf().getPattern(req.params.id)) return res.status(404).json({ ok: false, error: 'No such pattern' });
    res.json({ ok: true, pattern: shelf().savePattern({ ...((req.body ?? {}) as Record<string, unknown>), id: req.params.id }) });
  });

  app.delete('/api/sequence/patterns/:id', (req, res) => {
    if (!shelf().removePattern(req.params.id)) return res.status(404).json({ ok: false, error: 'No such pattern' });
    res.json({ ok: true });
  });

  // { id, atBeat }: the clips it added.
  app.post('/api/sequence/insert-pattern', (req, res) => {
    const { id, atBeat } = (req.body ?? {}) as { id?: unknown; atBeat?: unknown };
    if (typeof id !== 'string') throw new HttpError(400, 'id names a saved pattern');
    const clips = sequencer().insertPattern(id, atBeat as number);
    ctx.integrations.broadcast();
    res.json({ ok: true, clips, status: sequencer().status() });
  });

  // { fromBeat, toBeat, laneIds, name }: saved as a new pattern, with the range it took.
  app.post('/api/sequence/capture-pattern', (req, res) => {
    const { fromBeat, toBeat, laneIds, name } = (req.body ?? {}) as Record<string, unknown>;
    if (name !== undefined && typeof name !== 'string') throw new HttpError(400, 'name is text');
    const taken = sequencer().captureWithBounds(fromBeat as number, toBeat as number, laneIds as string[], name ?? '');
    let { pattern } = taken;
    while (shelf().getPattern(pattern.id)) pattern = { ...pattern, id: newUserId() };
    res.status(201).json({ ok: true, pattern: shelf().savePattern(pattern), fromBeat: taken.fromBeat, toBeat: taken.toBeat });
  });

  // ─── Punch recording ──────────────────────────────────────────────────────
  app.post('/api/sequence/record', (req, res) => {
    sequencer().startRecording(req.body ?? {});
    answer(res);
  });

  // { keep }: kept, the take lands in the loaded sequence; otherwise it goes.
  app.post('/api/sequence/record/stop', (req, res) => {
    const keep = (req.body as { keep?: unknown } | undefined)?.keep === true;
    const { added, removed } = sequencer().stopRecording(keep);
    ctx.integrations.broadcast();
    res.json({ ok: true, added, removed, status: sequencer().status() });
  });
}
