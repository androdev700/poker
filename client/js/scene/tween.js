export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
};

/**
 * Tweens advance only from the render loop's `update(dt)`. Every promise resolves to `true` when it ran
 * to completion and `false` when `cancelAll()` cut it short, so animation code can bail out with
 * `if (!(await tw.run(...))) return;` instead of carrying on against a scene that sync() rebuilt.
 */
export class Tweener {
  constructor() {
    this.active = [];
    this.generation = 0;
  }

  get busy() {
    return this.active.length > 0;
  }

  /** @param {(k:number)=>void} step called with eased progress 0..1 */
  run(ms, step, easing = ease.inOutQuad, delay = 0) {
    return new Promise((resolve) => {
      this.active.push({ elapsed: -delay, ms: Math.max(1, ms), step, easing, resolve });
    });
  }

  wait(ms) {
    return this.run(ms, noop, ease.linear);
  }

  update(dt) {
    const list = this.active;
    let w = 0;
    for (let i = 0; i < list.length; i++) {
      const tw = list[i];
      tw.elapsed += dt;
      if (tw.elapsed < 0) {
        list[w++] = tw;
        continue;
      }
      const t = tw.elapsed >= tw.ms ? 1 : tw.elapsed / tw.ms;
      tw.step(tw.easing(t));
      if (t >= 1) tw.resolve(true);
      else list[w++] = tw;
    }
    list.length = w;
  }

  cancelAll() {
    this.generation++;
    const list = this.active;
    this.active = [];
    for (const tw of list) tw.resolve(false);
  }
}

function noop() {}

export const lerp = (a, b, t) => a + (b - a) * t;
