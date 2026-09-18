/**
 * voxelEngine.js — the "Crush" voxel-shatter effect.
 * ---------------------------------------------------------------------------
 * A button's surface is diced into a grid of cubes. Hovering traces hairline
 * fractures along the voxel seams under the pointer; clicking lights up a
 * crack web across the face and then blows the whole thing into little cubes
 * that tumble, hang and snap back together.
 *
 * Deliberately framework agnostic: it only needs a root element (the button),
 * a <canvas> overlay and the element holding the label text (sampled so the
 * letterforms shatter too). The Vue component is a ~25 line wrapper.
 *
 *   const engine = createVoxelEngine({ root, canvas, label, voxelSize: 6 })
 *   engine.on('shatter', () => {})   // cubes are airborne
 *   engine.on('restored', () => {})  // face is coming back
 *   engine.destroy()
 * ---------------------------------------------------------------------------
 */

const TAU = Math.PI * 2

/** Hover fractures stay sparse so the trail reads as a line, not a cloud. */
const MAX_TRAIL_CRACKS = 26

/** Largest slice of wall-clock time one frame may advance. */
const MAX_STEP = 0.25

/** Phase durations in seconds. Total flight time ≈ 1.7s. */
const TIMING = {
  crack: 0.11, // fracture web glows across the still-visible face
  burst: 0.55, // violent scatter
  hang: 0.26, // suspended, drifting
  reform: 0.62, // staggered snap back into place
  settle: 0.18, // mosaic cross-fades into the real face
}

const LEVELS = 5 // depth-shading buckets per colour
const faceCache = new Map()

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const rand = (lo, hi) => lo + Math.random() * (hi - lo)
const lerp = (a, b, t) => a + (b - a) * t
const easeOutCubic = (t) => 1 - (1 - t) ** 3
const easeOutBack = (t, s = 1.1) => {
  const p = t - 1
  return 1 + (s + 1) * p * p * p + s * p * p
}

/** Total flight time of the default timeline, in seconds. */
const BASE_TOTAL = TIMING.crack + TIMING.burst + TIMING.hang + TIMING.reform + TIMING.settle

/** Named time curves for the reassembly. Pass one of these names, or a function. */
const EASINGS = {
  linear: (t) => t,
  in: (t) => t * t,
  out: easeOutCubic,
  inout: (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) ** 2),
  back: (t) => easeOutBack(t, 1.05),
}

function resolveEasing(value) {
  if (typeof value === 'function') return value
  return EASINGS[String(value || 'back').toLowerCase()] || EASINGS.back
}

/* --------------------------------- colours -------------------------------- */

function toRgb(value, fallback) {
  const s = String(value ?? '').trim()
  if (!s) return fallback
  if (s[0] === '#') {
    let hex = s.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.slice(0, 3).split('').map((c) => c + c).join('')
    }
    const n = parseInt(hex.slice(0, 6), 16)
    if (Number.isNaN(n)) return fallback
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const nums = s.match(/-?\d*\.?\d+/g)
  if (!nums || nums.length < 3) return fallback
  return [Number(nums[0]) | 0, Number(nums[1]) | 0, Number(nums[2]) | 0]
}

/** amount > 0 lightens toward white, < 0 darkens toward black. */
function tint(rgb, amount) {
  return amount >= 0
    ? [rgb[0] + (255 - rgb[0]) * amount, rgb[1] + (255 - rgb[1]) * amount, rgb[2] + (255 - rgb[2]) * amount]
    : [rgb[0] * (1 + amount), rgb[1] * (1 + amount), rgb[2] * (1 + amount)]
}

function cssColor(rgb, alpha = 1) {
  const r = rgb[0] | 0
  const g = rgb[1] | 0
  const b = rgb[2] | 0
  return alpha >= 0.999 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${clamp(alpha, 0, 1).toFixed(3)})`
}

/** Five lighting levels (far → near) for one base colour, memoised. */
function faceLevels(rgb) {
  const key = `${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0}`
  let levels = faceCache.get(key)
  if (!levels) {
    levels = []
    for (let i = 0; i < LEVELS; i++) {
      const base = tint(rgb, (i - 2) * 0.07)
      levels.push({
        front: cssColor(base),
        top: cssColor(tint(base, 0.36)),
        side: cssColor(tint(base, -0.34)),
      })
    }
    faceCache.set(key, levels)
  }
  return levels
}

/* -------------------------------- geometry -------------------------------- */

/** Cheap dolly-zoom projection: z > 0 moves toward the camera. */
const Z_NEAR = -5 // multiples of `unit`
const Z_FAR = 9
const project = (z, unit) => clamp(1 + z / (unit * 10), 0.5, 2.2)
const levelFor = (z, unit) =>
  clamp(Math.round(2 + clamp(z, unit * Z_NEAR, unit * Z_FAR) / (unit * 2.6)), 0, LEVELS - 1)

/* ------------------------------- label mask ------------------------------- */

function textRect(el) {
  try {
    const range = document.createRange()
    range.selectNodeContents(el)
    const rect = range.getBoundingClientRect()
    if (rect.width > 1 && rect.height > 1) return rect
  } catch {
    /* fall through */
  }
  return el.getBoundingClientRect()
}

/**
 * Rasterise the label into an offscreen canvas and point-sample it, so the
 * grid knows which voxels are ink (letters) and which are surface.
 * Returns a Uint8Array of cols * rows.
 */
export function sampleMask(rootEl, labelEl, grid) {
  const { cols, rows, cw, ch } = grid
  const mask = new Uint8Array(Math.max(0, cols * rows))
  if (!labelEl) return mask

  const rect = rootEl.getBoundingClientRect()
  const w = Math.max(1, Math.round(rootEl.offsetWidth || rect.width))
  const h = Math.max(1, Math.round(rootEl.offsetHeight || rect.height))

  const off = document.createElement('canvas')
  off.width = w
  off.height = h
  const c = off.getContext('2d')
  if (!c) return mask

  const scaleX = rect.width ? w / rect.width : 1
  const scaleY = rect.height ? h / rect.height : 1
  const cs = getComputedStyle(labelEl)
  const labelRect = textRect(labelEl)

  try {
    c.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
    if ('letterSpacing' in c && cs.letterSpacing && cs.letterSpacing !== 'normal') c.letterSpacing = cs.letterSpacing
  } catch {
    /* keep defaults */
  }
  c.fillStyle = '#fff'
  c.textAlign = 'center'
  c.textBaseline = 'middle'

  // innerText (unlike textContent) reflects text-transform, so uppercase labels
  // are sampled exactly as rendered.
  const text = String(labelEl.innerText || labelEl.textContent || '').replace(/\s+/g, ' ').trim()
  const cx = (labelRect.left - rect.left) * scaleX + (labelRect.width * scaleX) / 2
  const cy = (labelRect.top - rect.top) * scaleY + (labelRect.height * scaleY) / 2
  c.fillText(text, cx, cy)

  let data
  try {
    data = c.getImageData(0, 0, w, h).data
  } catch {
    return mask
  }

  for (let r = 0; r < rows; r++) {
    for (let col = 0; col < cols; col++) {
      const px = clamp(Math.round(col * cw + cw / 2), 0, w - 1)
      const py = clamp(Math.round(r * ch + ch / 2), 0, h - 1)
      if (data[(py * w + px) * 4 + 3] > 80) mask[r * cols + col] = 1
    }
  }
  return mask
}

/* ---------------------------------- engine -------------------------------- */

export function createVoxelEngine({
  root,
  canvas,
  label = null,
  voxelSize = 0, // 0 = auto: derived from the label's font size
  gap = 0.45,
  stressRadius = 26,
  gravity = 7, // vertical acceleration, in multiples of the button's short side per second²
  depth = 1, // camera axis: 1 pops at the viewer, 0 stays flat, -1 falls away
  duration = 0, // total flight time in seconds; 0 = default (≈1.7s). Speeds are
  // rescaled with it, so a longer duration reads as slow motion of the same blast
  easing = 'back', // name from EASINGS, or your own (t) => t for the reassembly
  dissolve = 0, // 0 = off; 0.05 shrinks every cube by 5% per 1/60s until it is gone
  autoReform = true, // false = pieces stay put until reform() is called
} = {}) {
  if (!root || !canvas) throw new Error('[voxelEngine] requires { root, canvas }')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('[voxelEngine] 2d canvas context unavailable')

  let opts = { voxelSize, gap, stressRadius, gravity }

  /* grid + theme */
  let W = 0
  let H = 0
  let unit = 47 // short side of the button: the yardstick for all velocities
  let bleed = 48 // how far debris may travel outside the button box
  let cols = 0
  let rows = 0
  let cw = 0
  let ch = 0
  let voxels = []
  let sorted = []
  // These mirror the fallbacks in the component's `var(--vx-*, ...)` rules, used
  // when nothing (props or CSS) has set the custom properties at all.
  let surface = [109, 59, 245]
  let surfaceAlt = [168, 85, 247]
  let ink = [255, 255, 255]
  let faceRadius = 0
  let lastDpr = 0

  /* simulation */
  let phase = 'idle'
  let phaseT = 0
  let epicenter = { x: 0, y: 0 }
  let cracks = []
  let specks = []
  let ring = null
  let flash = 0
  let pointer = { x: -9999, y: -9999, inside: false, movedAt: 0, lx: -9999, ly: -9999 }
  let reduced = false
  let dormant = false // shattered and holding: the rAF loop is stopped on purpose

  /* loop + plumbing */
  let raf = 0
  let prevT = 0
  let syncRaf = 0
  let disposed = false
  const handlers = new Map()
  let resizeObserver = null

  const emit = (name, payload) => {
    const set = handlers.get(name)
    if (set) for (const fn of [...set]) fn(payload)
  }

  const motion = () => (reduced ? 0.16 : 1)

  /* ------------------------------- theming -------------------------------- */

  function readTheme() {
    const cs = getComputedStyle(root)
    surface = toRgb(cs.getPropertyValue('--vx-surface'), surface)
    surfaceAlt = toRgb(cs.getPropertyValue('--vx-surface-alt'), surfaceAlt)
    ink = toRgb(cs.getPropertyValue('--vx-ink'), ink)
    faceRadius = parseFloat(cs.borderTopLeftRadius) || 0
  }

  /** < 0 = debris falls away from the camera, > 0 = it comes at you. */
  const depthAmount = () => clamp(Number(opts.depth) || 0, -2, 2)

  /** How much smaller each cube gets per 1/60s while dissolving. */
  const dissolveRate = () => clamp(Number(opts.dissolve) || 0, 0, 0.5)

  /**
   * Wall-clock stretch of the whole timeline. Velocities are divided by it, so a
   * longer duration is the same explosion in slow motion rather than a bigger one.
   */
  function tscale() {
    const want = Number(opts.duration) || 0
    return want > 0 ? clamp(want / BASE_TOTAL, 0.15, 8) : 1
  }

  const dur = (name) => TIMING[name] * tscale()
  const vscale = () => 1 / tscale()

  /** Time it takes the cubes to shrink away to nothing. */
  function dissolveTime() {
    const rate = dissolveRate()
    if (rate <= 0) return 0
    return clamp(Math.log(0.06) / Math.log(1 - rate) / 60, 0.12, 6) * tscale()
  }

  /**
   * Auto cube size keeps roughly three voxel rows inside the label's cap
   * height, which is what makes the shattered letterforms still readable.
   */
  function resolveVoxelSize() {
    if (opts.voxelSize > 0) return clamp(opts.voxelSize, 2.5, 24)
    let fontSize = 0
    try {
      fontSize = parseFloat(getComputedStyle(label || root).fontSize) || 0
    } catch {
      /* ignore */
    }
    return clamp(fontSize ? fontSize / 4 : unit / 14, 3, 9)
  }

  /** Face colours sampled per column — the cube mosaic's version of the gradient. */
  function gradientStops() {
    const stops = []
    for (let c = 0; c < cols; c++) {
      const t = cols > 1 ? c / (cols - 1) : 0
      stops.push([
        lerp(surface[0], surfaceAlt[0], t),
        lerp(surface[1], surfaceAlt[1], t),
        lerp(surface[2], surfaceAlt[2], t),
      ])
    }
    return stops
  }

  /** Surface marks (seams, cracks) never spill past the button's rounded face. */
  function clipToFace() {
    ctx.beginPath()
    if (faceRadius > 0 && ctx.roundRect) {
      ctx.roundRect(0, 0, W, H, faceRadius)
    } else if (faceRadius > 0) {
      const r = Math.min(faceRadius, W / 2, H / 2)
      ctx.moveTo(r, 0)
      ctx.arcTo(W, 0, W, H, r)
      ctx.arcTo(W, H, 0, H, r)
      ctx.arcTo(0, H, 0, 0, r)
      ctx.arcTo(0, 0, W, 0, r)
      ctx.closePath()
    } else {
      ctx.rect(0, 0, W, H)
    }
    ctx.clip()
  }

  /* --------------------------------- grid --------------------------------- */

  function build() {
    if (disposed) return
    const rect = root.getBoundingClientRect()
    const w = Math.max(1, Math.round(root.offsetWidth || rect.width))
    const h = Math.max(1, Math.round(root.offsetHeight || rect.height))
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3)
    const target = resolveVoxelSize()
    const nextCols = Math.max(1, Math.round(w / target))
    const nextRows = Math.max(1, Math.round(h / target))
    const nextUnit = clamp(Math.min(w, h) || 32, 20, 140)
    const nextBleed = clamp(Math.round(nextUnit * (1.6 + 0.5 * Math.min(Math.abs(depthAmount()), 2))), 48, 300)

    // Only a real change of shape (or of the auto cube size) needs a new grid.
    // Pure option tweaks — colours, depth, duration, dissolve — just refresh the
    // palette in place, so nudging a slider never interrupts a flight in progress.
    const sameShape =
      w === W && h === H && dpr === lastDpr && nextCols === cols && nextRows === rows && nextBleed === bleed
    if (sameShape && voxels.length) {
      readTheme()
      const across = gradientStops()
      for (const v of voxels) {
        v.rgb = v.ink ? ink : across[v.col]
        v.faces = faceLevels(v.rgb)
      }
      return
    }

    const wasBusy = phase !== 'idle'

    W = w
    H = h
    unit = nextUnit
    bleed = nextBleed
    lastDpr = dpr

    // The canvas is larger than the button so debris is not clipped. All
    // drawing stays in button-local coordinates via the transform below.
    canvas.style.left = `${-bleed}px`
    canvas.style.top = `${-bleed}px`
    canvas.style.width = `${w + bleed * 2}px`
    canvas.style.height = `${h + bleed * 2}px`
    canvas.width = Math.round((w + bleed * 2) * dpr)
    canvas.height = Math.round((h + bleed * 2) * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, bleed * dpr, bleed * dpr)

    cols = nextCols
    rows = nextRows
    cw = w / cols
    ch = h / rows

    readTheme()

    const mask = label ? sampleMask(root, label, { cols, rows, cw, ch }) : null
    const across = gradientStops()

    voxels = []
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const isInk = mask ? mask[r * cols + c] === 1 : false
        const rgb = isInk ? ink : across[c]
        voxels.push({
          col: c,
          rgb,
          hx: c * cw + cw / 2,
          hy: r * ch + ch / 2,
          x: 0, y: 0, z: 0,
          vx: 0, vy: 0, vz: 0,
          rx: 0, ry: 0, rz: 0, // snapshot taken when the reform starts
          size: 1,
          gapScale: 1,
          rot: 0,
          spin: 0,
          delay: 0,
          ink: isInk,
          faces: faceLevels(rgb),
        })
      }
    }

    for (const v of voxels) {
      v.x = v.hx
      v.y = v.hy
    }

    if (wasBusy) {
      finish(true) // a resize mid-flight just cancels the flight
      emit('restored')
    }
  }

  function scheduleSync() {
    if (disposed || syncRaf) return
    syncRaf = requestAnimationFrame(() => {
      syncRaf = 0
      build()
    })
  }

  /* ------------------------------ frame loop ------------------------------ */

  function requestFrame() {
    if (disposed || raf) return
    raf = requestAnimationFrame(frame)
  }

  function busy() {
    // dormant: the shatter is holding, so nothing should redraw
    if (dormant) return false
    return (
      phase !== 'idle' ||
      cracks.length > 0 ||
      specks.length > 0 ||
      flash > 0.001 ||
      !!ring ||
      (pointer.inside && performance.now() - pointer.movedAt < 500)
    )
  }

  function frame(now) {
    raf = 0
    // Phases run on wall-clock time, so a dropped frame stretches nothing; the
    // physics is sub-stepped below to stay stable through the bigger dt.
    const dt = prevT ? clamp((now - prevT) / 1000, 0, MAX_STEP) : 1 / 60
    prevT = now
    step(dt)
    draw(now / 1000)
    if (busy()) raf = requestAnimationFrame(frame)
    else prevT = 0
  }

  function finish(cancelled = false) {
    phase = 'idle'
    phaseT = 0
    dormant = false
    ring = null
    flash = 0
    for (const v of voxels) {
      v.x = v.hx
      v.y = v.hy
      v.z = 0
      v.rot = 0
      v.size = 1
      v.gapScale = 1
    }
    root.classList.remove('is-shattered')
    if (!cancelled) emit('done')
  }

  /* --------------------------------- phases ------------------------------- */

  /** x/y are canvas-local CSS pixels; omit them to detonate in the middle. */
  function explode(x = W / 2, y = H / 2) {
    if (disposed || dormant || phase !== 'idle' || !voxels.length) return
    epicenter = { x: clamp(x, 0, W), y: clamp(y, 0, H) }
    flash = 0
    ring = null
    phase = 'crack'
    phaseT = 0
    pushCrackWeb(epicenter.x, epicenter.y)
    emit('crack', { x: epicenter.x, y: epicenter.y })
    requestFrame()
  }

  function burst() {
    flash = 1
    ring = { t: 0 }
    const m = motion()
    const depthZ = depthAmount()
    const vs = vscale()
    for (const v of voxels) {
      const dx = v.hx - epicenter.x
      const dy = v.hy - epicenter.y
      const d = Math.max(6, Math.hypot(dx, dy))
      const power = unit * (1.3 + 5 / (d * 0.3 + 1)) * rand(0.72, 1.3) * m * vs
      // pieces near the blast lead the move along the camera axis: at the viewer
      // for a positive depth, away for a negative one
      const surge = 3.6 / (1 + d / (unit * 0.7))
      v.x = v.hx
      v.y = v.hy
      v.z = 0
      v.vx = (dx / d) * power + rand(-0.35, 0.35) * unit * m * vs
      v.vy = (dy / d) * power - unit * rand(1.2, 3.0) * m * vs
      v.vz = unit * (rand(0.4, 2.3) + surge) * depthZ * m * vs
      v.spin = rand(-2.6, 2.6) * m
      v.rot = 0
      v.size = 1
      v.gapScale = 1
    }
    spawnSpecks(epicenter.x, epicenter.y, 30, 1)
    phase = 'burst'
    phaseT = 0
    root.classList.add('is-shattered')
    emit('shatter')
  }

  function integrate(seconds, gravityScale, holdSize = false) {
    const steps = clamp(Math.ceil(seconds * 60), 1, 8)
    const h = seconds / steps
    for (let i = 0; i < steps; i++) integrateStep(h, gravityScale, holdSize)
  }

  function integrateStep(dt, gravityScale, holdSize) {
    // every rate below is stretched with the timeline so slow motion stays slow
    const vs = vscale()
    const g = opts.gravity * unit * gravityScale * vs * (reduced ? 0.3 : 1)
    const drag = Math.max(0, 1 - 2.4 * vs * dt)
    for (const v of voxels) {
      v.vy += g * dt
      v.vx *= drag
      v.vz *= drag
      v.vy *= Math.max(0, 1 - 1.1 * vs * dt)
      v.x += v.vx * dt
      v.y += v.vy * dt
      v.z += v.vz * dt
      v.rot = clamp(v.rot + v.spin * dt, -0.42, 0.42)
      v.spin *= Math.max(0, 1 - 1.6 * vs * dt)
      if (holdSize) continue
      v.size = lerp(v.size, 0.93, Math.min(1, dt * 2.4 * vs))
      v.gapScale = lerp(v.gapScale, 1.7, Math.min(1, dt * 3 * vs))
    }
  }

  function beginReform() {
    let maxD = 1
    for (const v of voxels) maxD = Math.max(maxD, Math.hypot(v.hx - epicenter.x, v.hy - epicenter.y))
    for (const v of voxels) {
      v.rx = v.x
      v.ry = v.y
      v.rz = v.z
      v.rsize = v.size
      v.delay = (Math.hypot(v.hx - epicenter.x, v.hy - epicenter.y) / maxD) * 0.22 * tscale()
    }
    dormant = false
    phase = 'reform'
    phaseT = 0
  }

  function updateReform() {
    const span = dur('reform')
    const curve = resolveEasing(opts.easing)
    let done = true
    for (const v of voxels) {
      const p = clamp((phaseT - v.delay) / span, 0, 1)
      if (p < 1) done = false
      const back = curve(p)
      const ease = easeOutCubic(p)
      v.x = lerp(v.rx, v.hx, back)
      v.y = lerp(v.ry, v.hy, back)
      v.z = lerp(v.rz, 0, ease)
      v.rot = lerp(v.rot, 0, Math.min(1, p * 1.8))
      // grew back from whatever size they had — from dust, after a dissolve
      v.size = p >= 1 ? 1 : lerp(v.rsize ?? 0.93, 1, ease)
      v.gapScale = lerp(1.7, 1, ease)
    }
    if (done || phaseT > span + 0.45 * tscale()) {
      phase = 'settle'
      phaseT = 0
      if (pointer.inside) spawnSpecks(pointer.x, pointer.y, 2, 0.4)
      emit('restored')
    }
  }

  function step(dt) {
    flash = Math.max(0, flash - dt * 5.5 / tscale())
    if (ring) {
      ring.t += dt / (0.4 * tscale())
      if (ring.t >= 1) ring = null
    }

    for (const c of cracks) c.life += dt
    if (cracks.length) cracks = cracks.filter((c) => c.life < c.ttl)

    const vs = vscale()
    for (const s of specks) {
      s.life += dt
      s.vy += opts.gravity * unit * 0.5 * vs * dt
      const drag = Math.max(0, 1 - 2.6 * vs * dt)
      s.vx *= drag
      s.vz *= drag
      s.x += s.vx * dt
      s.y += s.vy * dt
      s.z += s.vz * dt
    }
    if (specks.length) specks = specks.filter((s) => s.life < s.ttl && s.y < H + 60)

    if (phase === 'idle') return

    phaseT += dt
    if (phase === 'crack') {
      if (phaseT >= dur('crack')) burst()
      return
    }
    if (phase === 'burst') {
      integrate(dt, 1)
      if (phaseT >= dur('burst')) {
        phase = 'hang'
        phaseT = 0
      }
      return
    }
    if (phase === 'hang') {
      integrate(dt, 0.2)
      if (phaseT >= dur('hang')) {
        if (dissolveRate() > 0) {
          phase = 'dissolve'
          phaseT = 0
        } else if (opts.autoReform === false) {
          phase = 'linger'
          phaseT = 0
        } else {
          beginReform()
        }
      }
      return
    }
    if (phase === 'dissolve') {
      integrate(dt, 0.15, true) // holdSize: the shrink below is the whole point
      const shrink = (1 - dissolveRate()) ** (dt * 60)
      for (const v of voxels) v.size *= shrink
      if (phaseT >= dissolveTime()) {
        if (opts.autoReform === false) {
          phase = 'gone' // stays destroyed until reform() is called
          dormant = true
        } else {
          finish()
        }
      }
      return
    }
    if (phase === 'linger') {
      if (dormant) return
      integrate(dt, 0.12)
      // hold the pieces where they are and stop the loop: the last frame stays
      // on screen until reform() is called
      if (phaseT >= 0.5 * tscale()) dormant = true
      return
    }
    if (phase === 'gone') return
    if (phase === 'reform') {
      updateReform()
      return
    }
    if (phase === 'settle' && phaseT >= dur('settle')) finish()
  }

  /* -------------------------------- particles ----------------------------- */

  function jagged(x, y, angle, length) {
    const steps = 3 + ((Math.random() * 4) | 0)
    const pts = [[x, y]]
    let a = angle
    let cx = x
    let cy = y
    for (let i = 0; i < steps; i++) {
      a += rand(-0.24, 0.24)
      const seg = length / steps
      cx += Math.cos(a) * seg
      cy += Math.sin(a) * seg
      pts.push([cx, cy])
    }
    return pts
  }

  function pushCrack(x, y, angle, len, depth = 0, life = 0) {
    const pts = jagged(x, y, angle, len)
    cracks.push({ pts, life, ttl: rand(0.24, 0.44) + depth * 0.1, w: rand(0.5, 1.15) })
    if (depth < 1 && Math.random() < 0.3 && pts.length > 3) {
      const [bx, by] = pts[1 + ((Math.random() * (pts.length - 2)) | 0)]
      pushCrack(bx, by, angle + (Math.random() < 0.5 ? -1 : 1) * rand(0.5, 1.2), len * rand(0.4, 0.6), depth + 1, life)
    }
  }

  /** Hover trail: small jagged fractures radiating from the cursor. */
  function spawnTrail(x, y) {
    if (cracks.length > MAX_TRAIL_CRACKS) return
    const n = 1 + ((Math.random() * 2) | 0)
    for (let i = 0; i < n; i++) {
      pushCrack(x + rand(-2, 2), y + rand(-2, 2), rand(0, TAU), rand(6, 17))
    }
    if (Math.random() < 0.4) spawnSpecks(x, y, 1, 0.4)
  }

  /** Crack web: axis-aligned fractures running along the seams. */
  function pushCrackWeb(x, y) {
    const rays = 11
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * TAU + rand(-0.28, 0.28)
      const dx = Math.cos(a)
      const dy = Math.sin(a)
      const steps = 3 + ((Math.random() * 6) | 0)
      const pts = [[x, y]]
      let cx = x
      let cy = y
      for (let s = 0; s < steps; s++) {
        const horizontal = Math.abs(dx) > Math.abs(dy)
        const len = (horizontal ? cw : ch) * rand(0.7, 1.25)
        cx += horizontal ? Math.sign(dx) * len : rand(-0.25, 0.25) * len
        cy += horizontal ? rand(-0.25, 0.25) * len : Math.sign(dy) * len
        pts.push([cx, cy])
      }
      cracks.push({ pts, life: 0, ttl: dur('crack') + 0.16 * tscale(), w: rand(0.8, 1.8) })
    }
  }

  function spawnSpecks(x, y, count, boost = 1) {
    const m = motion()
    for (let i = 0; i < count; i++) {
      const a = rand(0, TAU)
      const sp = unit * rand(0.8, 5) * boost * m * vscale()
      specks.push({
        x,
        y,
        z: unit * rand(0.2, 3.4) * depthAmount() * m,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - unit * rand(0.4, 1.9) * m,
        vz: unit * rand(-1.3, 2.5) * m,
        size: rand(1, 3),
        life: 0,
        ttl: rand(0.35, 0.9) * tscale(),
        hot: Math.random() < 0.45,
      })
    }
  }

  /* ---------------------------------- draw -------------------------------- */

  function strokePath(pts) {
    ctx.beginPath()
    ctx.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
    ctx.stroke()
  }

  function drawCracks() {
    if (!cracks.length) return
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const c of cracks) {
      const a = (1 - c.life / c.ttl) ** 1.5 * 0.22
      if (a <= 0.004) continue
      ctx.strokeStyle = `rgba(196,226,255,${a.toFixed(3)})`
      ctx.lineWidth = c.w + 2.8
      strokePath(c.pts)
    }
    for (const c of cracks) {
      const a = (1 - c.life / c.ttl) ** 1.5
      if (a <= 0.004) continue
      ctx.strokeStyle = `rgba(255,255,255,${(a * 0.85).toFixed(3)})`
      ctx.lineWidth = c.w
      strokePath(c.pts)
    }
  }

  /** Hairline fractures along the voxel seams under the pointer. */
  function drawSeams(t) {
    const radius = opts.stressRadius
    const r2 = radius * radius
    for (const v of voxels) {
      const dx = v.hx - pointer.x
      const dy = v.hy - pointer.y
      const d2 = dx * dx + dy * dy
      if (d2 > r2) continue
      const s = 1 - Math.sqrt(d2) / radius
      const a = s * s * 0.8
      const x = v.hx + Math.sin(t * 6.2 + v.hx * 0.7 + v.hy * 0.31) * 0.6 * s
      const y = v.hy + Math.cos(t * 5.1 + v.hy * 0.6) * 0.5 * s

      ctx.fillStyle = `rgba(10,7,24,${(a * 0.5).toFixed(3)})`
      ctx.fillRect(x + cw / 2 - 0.6, y - ch / 2, 1.2, ch)
      ctx.fillRect(x - cw / 2, y + ch / 2 - 0.6, cw, 1.2)

      ctx.fillStyle = `rgba(255,255,255,${(a * 0.18).toFixed(3)})`
      ctx.fillRect(x - cw / 2 - 0.3, y - ch / 2, 0.7, ch)
      ctx.fillRect(x - cw / 2, y - ch / 2 - 0.3, cw, 0.7)
    }
  }

  function drawCube(v, alpha) {
    const z = clamp(v.z, unit * Z_NEAR, unit * Z_FAR)
    const p = project(z, unit)
    const w = cw * v.size * p - opts.gap * v.gapScale
    const h = ch * v.size * p - opts.gap * v.gapScale
    if (w < 0.8 || h < 0.8) return

    const cx = W / 2 + (v.x - W / 2) * p
    const cy = H / 2 + (v.y - H / 2) * p
    const f = v.faces[levelFor(z, unit)]
    const l = cx - w / 2
    const r = cx + w / 2
    const tp = cy - h / 2
    const bt = cy + h / 2

    // fake isometric extrusion; v.rot gives the cube a little tumble
    const d = Math.min(w, h) * 0.44
    const ang = -Math.PI / 2.55 + v.rot
    const ox = Math.cos(ang) * d
    const oy = Math.sin(ang) * d
    const far = ox >= 0 ? r : l

    ctx.fillStyle = f.top
    ctx.beginPath()
    ctx.moveTo(l, tp)
    ctx.lineTo(r, tp)
    ctx.lineTo(r + ox, tp + oy)
    ctx.lineTo(l + ox, tp + oy)
    ctx.closePath()
    ctx.fill()

    ctx.fillStyle = f.side
    ctx.beginPath()
    ctx.moveTo(far, tp)
    ctx.lineTo(far + ox, tp + oy)
    ctx.lineTo(far + ox, bt + oy)
    ctx.lineTo(far, bt)
    ctx.closePath()
    ctx.fill()

    ctx.fillStyle = f.front
    if (alpha >= 0.999) {
      ctx.fillRect(l, tp, w, h)
    } else {
      ctx.globalAlpha = alpha
      ctx.fillRect(l, tp, w, h)
      ctx.globalAlpha = 1
    }
  }

  function drawCubes() {
    sorted = voxels.slice().sort((a, b) => a.z - b.z)
    const alpha = phase === 'settle' ? clamp(1 - phaseT / dur('settle'), 0, 1) : 1
    for (const v of sorted) drawCube(v, alpha)
  }

  function drawSpecks() {
    const fadeFrom = unit * 0.6
    const fadeTo = bleed - unit * 0.25
    for (const s of specks) {
      const a = (1 - s.life / s.ttl) ** 1.4
      if (a <= 0.01) continue
      const p = project(s.z, unit)
      const size = s.size * p
      const x = W / 2 + (s.x - W / 2) * p
      const y = H / 2 + (s.y - H / 2) * p
      // dust dims out before it reaches the edge of the bleed area, so nothing
      // ever pops out of existence at the canvas boundary
      const out = Math.hypot(Math.max(0, -x, x - W), Math.max(0, -y, y - H))
      const edge = 1 - clamp((out - fadeFrom) / (fadeTo - fadeFrom), 0, 1)
      if (edge <= 0.01) continue
      const alpha = a * edge
      ctx.fillStyle = s.hot
        ? `rgba(255,255,255,${(alpha * 0.9).toFixed(3)})`
        : `rgba(226,214,255,${(alpha * 0.8).toFixed(3)})`
      ctx.fillRect(x - size / 2, y - size / 2, size, size)
    }
  }

  function drawImpact() {
    if (flash > 0.001) {
      const r = unit * (0.6 + (1 - flash) * 1.7)
      const grad = ctx.createRadialGradient(epicenter.x, epicenter.y, 0, epicenter.x, epicenter.y, r)
      grad.addColorStop(0, `rgba(255,255,255,${(0.55 * flash).toFixed(3)})`)
      grad.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(epicenter.x, epicenter.y, r, 0, TAU)
      ctx.fill()
    }
    if (ring) {
      // expands on an ease-out and vanishes well inside the bleed area, so the
      // stroke is never sliced off by the edge of the canvas
      const t = clamp(ring.t, 0, 1)
      const a = (1 - t) ** 2 * 0.4
      ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(3)})`
      ctx.lineWidth = 1.5 + a * 6
      ctx.beginPath()
      ctx.arc(epicenter.x, epicenter.y, 4 + easeOutCubic(t) * bleed * 0.9, 0, TAU)
      ctx.stroke()
    }
  }

  function draw(t) {
    ctx.clearRect(-bleed, -bleed, W + bleed * 2, H + bleed * 2)
    if (!W || !H) return

    if ((pointer.inside && phase === 'idle') || cracks.length) {
      ctx.save()
      clipToFace()
      if (pointer.inside && phase === 'idle') drawSeams(t)
      drawCracks()
      ctx.restore()
    }

    if (phase !== 'idle') {
      if (phase === 'settle') {
        // the mosaic is back in place: clip it so the cross-fade into the real
        // face does not show square corners
        ctx.save()
        clipToFace()
        drawCubes()
        ctx.restore()
      } else {
        drawCubes()
      }
    }

    drawSpecks()
    drawImpact()
  }

  /* -------------------------------- listeners ----------------------------- */

  function localPoint(event) {
    const rect = root.getBoundingClientRect()
    const sx = rect.width ? W / rect.width : 1
    const sy = rect.height ? H / rect.height : 1
    return { x: (event.clientX - rect.left) * sx, y: (event.clientY - rect.top) * sy }
  }

  function onPointerEnter(event) {
    const { x, y } = localPoint(event)
    pointer.x = x
    pointer.y = y
    pointer.lx = x
    pointer.ly = y
    pointer.inside = true
    pointer.movedAt = performance.now()
    requestFrame()
  }

  function onPointerMove(event) {
    const { x, y } = localPoint(event)
    pointer.inside = true
    const dist = Math.hypot(x - pointer.lx, y - pointer.ly)
    pointer.x = x
    pointer.y = y
    if (phase === 'idle' && dist > 3.5) {
      pointer.lx = x
      pointer.ly = y
      pointer.movedAt = performance.now()
      spawnTrail(x, y)
    }
    requestFrame()
  }

  function onPointerLeave() {
    pointer.inside = false
    pointer.x = -9999
    pointer.y = -9999
    requestFrame() // one clean frame to wipe the seams
  }

  function onClick(event) {
    if (root.disabled) return
    if (event.detail === 0 && !event.clientX && !event.clientY) {
      explode(W / 2, H / 2) // keyboard activation
      return
    }
    const { x, y } = localPoint(event)
    explode(x, y)
  }

  function onResize() {
    scheduleSync()
  }

  /* --------------------------------- public ------------------------------- */

  root.addEventListener('pointerenter', onPointerEnter)
  root.addEventListener('pointermove', onPointerMove)
  root.addEventListener('pointerleave', onPointerLeave)
  root.addEventListener('click', onClick)
  window.addEventListener('resize', onResize)

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(scheduleSync)
    resizeObserver.observe(root)
  }

  try {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    reduced = mq.matches
    if (mq.addEventListener) mq.addEventListener('change', (e) => (reduced = e.matches))
  } catch {
    /* ignore */
  }

  build()

  return {
    /** Subscribe to 'crack' | 'shatter' | 'restored' | 'done'. */
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, new Set())
      handlers.get(name).add(fn)
      return () => handlers.get(name)?.delete(fn)
    },
    /** Detonate at a point in canvas-local CSS pixels (defaults to the centre). */
    explode,
    /**
     * Send the pieces home now — the way back from `linger`/`gone` when
     * `autoReform` is off, and a useful "recall" mid-flight.
     */
    reform() {
      if (disposed || phase === 'idle' || phase === 'reform' || phase === 'settle' || !voxels.length) return
      beginReform()
      requestFrame()
    },
    /** Re-measure the root element and re-sample the label. */
    sync: scheduleSync,
    setOptions(next = {}) {
      opts = { ...opts, ...next }
      build()
    },
    get phase() {
      return phase
    },
    /** True while a shatter is holding with `autoReform` off. */
    get holding() {
      return dormant
    },
    get grid() {
      return { cols, rows, cellW: cw, cellH: ch }
    },
    destroy() {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      if (syncRaf) cancelAnimationFrame(syncRaf)
      resizeObserver?.disconnect()
      root.removeEventListener('pointerenter', onPointerEnter)
      root.removeEventListener('pointermove', onPointerMove)
      root.removeEventListener('pointerleave', onPointerLeave)
      root.removeEventListener('click', onClick)
      window.removeEventListener('resize', onResize)
      root.classList.remove('is-shattered')
      handlers.clear()
      ctx.clearRect(-bleed, -bleed, W + bleed * 2, H + bleed * 2)
    },
  }
}

export { TIMING as VOXEL_TIMING }
