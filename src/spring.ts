/**
 * Tiny critically-tunable spring in Apple's two-parameter form:
 *   damping ratio ζ (1.0 = no overshoot, 0.8 = a little bounce) and response T (seconds).
 * Mass 1, semi-implicit Euler. Interruptible by design: retarget or reset at any time and the
 * motion continues from the current value and velocity.
 */
export class Spring {
  x: number
  v = 0
  target: number
  private k: number
  private c: number
  done = true

  constructor(x: number, damping = 1, response = 0.4) {
    this.x = x; this.target = x
    const w = (2 * Math.PI) / response
    this.k = w * w
    this.c = 2 * damping * w
  }

  set(damping: number, response: number) {
    const w = (2 * Math.PI) / response
    this.k = w * w; this.c = 2 * damping * w
  }

  /** Aim at a new target, optionally handing off a velocity (units/s). Starts from the live value. */
  to(target: number, velocity?: number) {
    this.target = target
    if (velocity !== undefined) this.v = velocity
    this.done = false
  }

  /** Snap without motion. */
  jump(x: number) { this.x = x; this.target = x; this.v = 0; this.done = true }

  step(dt: number, eps = 1e-3) {
    if (this.done) return
    dt = Math.min(dt, 1 / 30)
    const a = -this.k * (this.x - this.target) - this.c * this.v
    this.v += a * dt
    this.x += this.v * dt
    if (Math.abs(this.x - this.target) < eps && Math.abs(this.v) < eps * 40) { this.x = this.target; this.v = 0; this.done = true }
  }
}

/** Apple's momentum projection (Designing Fluid Interfaces): where a flick would coast to. */
export function project(velocity: number, decelerationRate = 0.998) {
  return (velocity / 1000) * decelerationRate / (1 - decelerationRate)
}

/** Progressive resistance past a boundary. `dimension` sets how far the rubber can stretch. */
export function rubberband(overshoot: number, dimension: number, constant = 0.55) {
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot))
}

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
