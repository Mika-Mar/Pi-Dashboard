import assert from "node:assert/strict";
import { test } from "node:test";
import { initPlayer } from "../static/js/player.js";

const snapshot = (playing = true, progress = 30000, id = "track") => ({
  is_playing: playing, progress_ms: progress, duration_ms: 180000,
  track: { id, name: id, artists: [] },
});
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function setup(t, initial = snapshot()) {
  let now = 100000;
  let server = initial;
  let nextRead = null;
  let nextPost = null;
  const posts = [];
  const timers = new Map();
  let timerId = 0;
  const bar = { style: {} };
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", () => ++timerId);
  t.mock.method(globalThis, "clearInterval", () => {});
  t.mock.method(globalThis, "setTimeout", (fn, delay) => {
    const id = ++timerId;
    timers.set(id, { fn, delay });
    return id;
  });
  t.mock.method(globalThis, "clearTimeout", id => timers.delete(id));
  // Only the animation scheduling and browser image constructor need DOM shims.
  const restoreGlobals = [];
  for (const [name, value] of Object.entries({
    Image: class {}, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restoreGlobals.push(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (options?.method === "POST") {
      posts.push({ url, body: JSON.parse(options.body) });
      const pending = nextPost;
      nextPost = null;
      const ok = pending ? await pending.promise : true;
      return { ok, status: ok ? 200 : 502, json: async () => ({ ok }) };
    }
    const pending = nextRead;
    nextRead = null;
    const data = pending ? await pending.promise : structuredClone(server);
    return { ok: true, json: async () => data };
  });
  const player = initPlayer({ progressBarEl: bar });
  t.after(() => {
    player.destroy();
    restoreGlobals.forEach(restore => restore());
  });
  await flush();
  return {
    player, posts, bar,
    advance(ms) { now += ms; },
    setServer(value) { server = value; },
    holdRead() { nextRead = deferred(); return nextRead; },
    holdPost() { nextPost = deferred(); return nextPost; },
    async runTimer(delay) {
      const timer = [...timers.values()].find(entry => entry.delay === delay);
      assert.ok(timer, `missing ${delay} ms reconciliation timer`);
      timer.fn();
      await flush();
    },
  };
}

test("pause freezes displayed progress; resume excludes time spent paused", async t => {
  const f = await setup(t);
  f.advance(5000);
  await f.player.toggle();
  assert.equal(f.player.state.isPlaying, false);
  assert.equal(f.player.state.progressMs, 35000);
  assert.equal(Number.parseFloat(f.bar.style.width), 19.444);
  f.setServer(snapshot(false, 35100));
  await f.player.refresh();
  f.advance(60000);
  assert.equal(f.player.state.progressMs, 35000);
  await f.player.toggle();
  assert.equal(f.player.state.isPlaying, true);
  assert.equal(f.player.state.progressMs, 35000);
  f.advance(1000);
  assert.equal(f.player.state.progressMs, 36000);
  assert.deepEqual(f.posts.map(post => post.body), [{ is_playing: false }, { is_playing: true }]);
});

test("a poll started before pause cannot overwrite the new state", async t => {
  const f = await setup(t);
  f.advance(5000);
  const stale = f.holdRead();
  const refresh = f.player.refresh();
  await f.player.toggle();
  stale.resolve(snapshot(true, 31000));
  await refresh;
  assert.equal(f.player.state.isPlaying, false);
  assert.equal(f.player.state.progressMs, 35000);
});

test("out-of-order polling responses cannot rewind newer playback", async t => {
  const f = await setup(t);
  const stale = f.holdRead();
  const refresh = f.player.refresh();
  f.setServer(snapshot(true, 70000));
  await f.player.refresh();
  stale.resolve(snapshot(true, 30000));
  await refresh;
  assert.equal(f.player.state.progressMs, 70000);
});

test("stale post-command snapshots cannot reverse pause, even after confirmation", async t => {
  const f = await setup(t);
  f.advance(5000);
  await f.player.toggle();
  f.setServer(snapshot(false, 35000));
  await f.player.refresh();
  f.setServer(snapshot(true, 35000));
  f.advance(800);
  await f.runTimer(800);
  assert.equal(f.player.state.isPlaying, false);
  assert.equal(f.player.state.progressMs, 35000);
  f.setServer({ is_playing: false, progress_ms: 0, track: null });
  await f.player.refresh();
  assert.equal(f.player.state.progressMs, 35000);
  // A later remote change must still be honored once the grace period ends.
  f.advance(2700);
  f.setServer(snapshot(true, 38000));
  await f.runTimer(3500);
  assert.equal(f.player.state.isPlaying, true);
  assert.equal(f.player.state.progressMs, 38000);
});

test("small polling jitter stays smooth while real seeks and track changes apply", async t => {
  const f = await setup(t);
  f.advance(1000);
  f.setServer(snapshot(true, 30700));
  await f.player.refresh();
  assert.equal(f.player.state.progressMs, 31000);
  f.setServer(snapshot(true, 10000));
  await f.player.refresh();
  assert.equal(f.player.state.progressMs, 10000);
  f.setServer(snapshot(true, 1000, "next-track"));
  await f.player.refresh();
  assert.equal(f.player.state.trackId, "next-track");
  assert.equal(f.player.state.progressMs, 1000);
});

test("duplicate clicks and polls during a command cannot interfere", async t => {
  const f = await setup(t);
  f.advance(5000);
  const post = f.holdPost();
  const toggle = f.player.toggle();
  await f.player.toggle();
  await f.player.refresh();
  assert.equal(f.posts.length, 1);
  assert.equal(f.player.state.isPlaying, false);
  const stale = f.holdRead();
  const refresh = f.player.refresh();
  post.resolve(true);
  await toggle;
  stale.resolve(snapshot(true, 30000));
  await refresh;
  assert.equal(f.player.state.isPlaying, false);
  assert.equal(f.player.state.progressMs, 35000);
});

test("failed commands restore the previous running clock", async t => {
  const f = await setup(t);
  f.advance(5000);
  const post = f.holdPost();
  const toggle = f.player.toggle();
  f.advance(500);
  f.setServer(snapshot(true, 35500));
  post.resolve(false);
  await toggle;
  await flush();
  assert.equal(f.player.state.isPlaying, true);
  assert.equal(f.player.state.progressMs, 35500);
});
