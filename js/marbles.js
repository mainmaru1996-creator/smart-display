import { createMachine, stepMachine, MARBLE_RADIUS, PEG_RADIUS } from './marble-machine.js';

const STORAGE_KEY = 'marble-background';

const PHYSICS_STEP = 1 / 120;         // 仕掛けをすり抜けないよう物理は細かく刻む
const MAX_FRAME_DELTA_MS = 200;       // 復帰直後の巨大なdtで暴れないための上限
const HINT_DURATION_MS = 2600;

// 常時表示の背景は控えめ・低フレームレート、演出モードは主役として明るく描く
const STYLES = {
  background: {
    fps: 30,
    lineWidth: 4,
    trail: 4,
    frame: 'rgba(255, 255, 255, 0.10)',
    slope: 'rgba(255, 255, 255, 0.11)',
    step: 'rgba(255, 255, 255, 0.11)',
    chute: 'rgba(255, 255, 255, 0.11)',
    shelf: 'rgba(255, 255, 255, 0.05)',
    peg: 'rgba(255, 255, 255, 0.08)',
    gear: 'rgba(255, 255, 255, 0.13)',
    lift: 'rgba(255, 255, 255, 0.12)',
    marbleCore: 'rgba(255, 255, 255, 0.40)',
    marbleGlow: [[255, 255, 255, 0.22], [190, 205, 255, 0.09]],
    marbleTints: null,
  },
  machine: {
    fps: 45,
    lineWidth: 4.5,
    trail: 0,
    frame: 'rgba(255, 255, 255, 0.24)',
    slope: 'rgba(214, 226, 255, 0.30)',
    step: 'rgba(214, 226, 255, 0.30)',
    chute: 'rgba(255, 168, 102, 0.44)',
    shelf: 'rgba(255, 255, 255, 0.10)',
    peg: 'rgba(255, 255, 255, 0.22)',
    gear: 'rgba(120, 224, 214, 0.46)',
    lift: 'rgba(255, 255, 255, 0.32)',
    marbleCore: 'rgba(255, 255, 255, 0.92)',
    marbleGlow: [[255, 255, 255, 0.45], [150, 190, 255, 0.2]],
    marbleTints: [
      [255, 255, 255],
      [255, 176, 112],
      [126, 224, 214],
      [235, 150, 190],
    ],
  },
};

let canvas = null;
let ctx = null;
let staticLayer = null;
let gearSprites = new Map();
let machine = null;
let mode = 'background';
let style = STYLES.background;
let width = 0;
let height = 0;
let dpr = 1;
let rafId = null;
let lastTimestamp = 0;
let frameAccumulator = 0;
let enabled = true;
let hintTimer = null;
let trails = [];

function prefersReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function isMarbleBackgroundEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/* ---------------- 描画 ---------------- */

function makeGearSprite(radius) {
  const toothHeight = Math.max(3, radius * 0.16);
  const size = (radius + toothHeight + 2) * 2;
  const sprite = document.createElement('canvas');
  sprite.width = Math.max(1, Math.round(size * dpr));
  sprite.height = Math.max(1, Math.round(size * dpr));

  const g = sprite.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.translate(size / 2, size / 2);
  g.strokeStyle = style.gear;
  g.lineWidth = 1.5;
  g.lineJoin = 'round';

  g.beginPath();
  g.arc(0, 0, radius, 0, Math.PI * 2);
  g.stroke();

  const teeth = Math.max(8, Math.round(radius / 3.5));
  for (let i = 0; i < teeth; i++) {
    g.save();
    g.rotate((i / teeth) * Math.PI * 2);
    g.beginPath();
    g.moveTo(-toothHeight * 0.45, -radius);
    g.lineTo(-toothHeight * 0.3, -radius - toothHeight);
    g.lineTo(toothHeight * 0.3, -radius - toothHeight);
    g.lineTo(toothHeight * 0.45, -radius);
    g.stroke();
    g.restore();
  }

  const hub = radius * 0.22;
  g.beginPath();
  g.arc(0, 0, hub, 0, Math.PI * 2);
  g.stroke();
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    g.beginPath();
    g.moveTo(Math.cos(a) * hub, Math.sin(a) * hub);
    g.lineTo(Math.cos(a) * radius * 0.92, Math.sin(a) * radius * 0.92);
    g.stroke();
  }

  return { canvas: sprite, size };
}

function gearSprite(radius) {
  const key = Math.round(radius);
  if (!gearSprites.has(key)) gearSprites.set(key, makeGearSprite(key));
  return gearSprites.get(key);
}

function buildStaticLayer() {
  staticLayer = document.createElement('canvas');
  staticLayer.width = Math.max(1, Math.round(width * dpr));
  staticLayer.height = Math.max(1, Math.round(height * dpr));

  const layer = staticLayer.getContext('2d');
  layer.setTransform(dpr, 0, 0, dpr, 0, 0);
  layer.lineCap = 'round';
  layer.lineJoin = 'round';

  // 多層フレームの外枠と棚板、リフトのレール
  for (const d of machine.decorations) {
    if (d.type === 'box') {
      layer.strokeStyle = style.frame;
      layer.lineWidth = 2;
      layer.strokeRect(d.x, d.y, d.w, d.h);
    } else if (d.type === 'shelf') {
      layer.strokeStyle = style.shelf;
      layer.lineWidth = 1.5;
      layer.beginPath();
      layer.moveTo(d.x1, d.y);
      layer.lineTo(d.x2, d.y);
      layer.stroke();
    } else if (d.type === 'lift-rail') {
      layer.strokeStyle = style.lift;
      layer.lineWidth = 1.5;
      for (const side of [-1, 1]) {
        layer.beginPath();
        layer.moveTo(d.x + side * d.halfWidth, d.top);
        layer.lineTo(d.x + side * d.halfWidth, d.bottom);
        layer.stroke();
      }
    }
  }

  // カーブは弧として描くので、当たり判定用の折れ線は描かない
  layer.lineWidth = style.lineWidth;
  for (const s of machine.segments) {
    if (s.role === 'chute') continue;
    layer.strokeStyle = s.role === 'frame' ? style.frame : s.role === 'step' ? style.step : style.slope;
    layer.beginPath();
    layer.moveTo(s.x1, s.y1);
    layer.lineTo(s.x2, s.y2);
    layer.stroke();
  }

  layer.strokeStyle = style.chute;
  for (const a of machine.arcs) {
    layer.beginPath();
    layer.arc(a.cx, a.cy, a.radius, Math.min(a.a0, a.a1), Math.max(a.a0, a.a1));
    layer.stroke();
  }

  layer.fillStyle = style.peg;
  for (const p of machine.pegs) {
    layer.beginPath();
    layer.arc(p.x, p.y, PEG_RADIUS, 0, Math.PI * 2);
    layer.fill();
  }
}

function drawFixtures() {
  ctx.clearRect(0, 0, width, height);
  if (staticLayer) ctx.drawImage(staticLayer, 0, 0, width, height);

  for (const g of machine.gears) {
    const sprite = gearSprite(g.r);
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(g.angle);
    ctx.drawImage(sprite.canvas, -sprite.size / 2, -sprite.size / 2, sprite.size, sprite.size);
    ctx.restore();
  }

  // リフトのバケット
  ctx.strokeStyle = style.lift;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  for (const lift of machine.lifts) {
    const w = lift.halfWidth;
    for (const bucket of lift.buckets) {
      ctx.beginPath();
      ctx.moveTo(lift.x - w, bucket.y - w);
      ctx.lineTo(lift.x - w, bucket.y);
      ctx.lineTo(lift.x + w, bucket.y);
      ctx.lineTo(lift.x + w, bucket.y - w);
      ctx.stroke();
    }
  }
}

function drawMarbles() {
  const [inner, outer] = style.marbleGlow;

  // 30fpsだと速い玉の動きが飛んで見えるので、短い軌跡を残して動きを読みやすくする
  if (style.trail > 0) {
    machine.marbles.forEach((m, index) => {
      const trail = trails[index] ?? (trails[index] = []);
      trail.push(m.x, m.y);
      if (trail.length > style.trail * 2) trail.splice(0, trail.length - style.trail * 2);

      for (let i = 0; i < trail.length - 2; i += 2) {
        const fade = (i / 2 + 1) / (style.trail + 1);
        ctx.fillStyle = `rgba(${inner[0]}, ${inner[1]}, ${inner[2]}, ${(inner[3] * fade * 0.5).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(trail[i], trail[i + 1], MARBLE_RADIUS * (0.35 + fade * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  machine.marbles.forEach((m, index) => {
    const tint = style.marbleTints ? style.marbleTints[index % style.marbleTints.length] : null;
    const glowInner = tint
      ? `rgba(${tint[0]}, ${tint[1]}, ${tint[2]}, ${inner[3]})`
      : `rgba(${inner[0]}, ${inner[1]}, ${inner[2]}, ${inner[3]})`;
    const glowOuter = tint
      ? `rgba(${tint[0]}, ${tint[1]}, ${tint[2]}, ${outer[3]})`
      : `rgba(${outer[0]}, ${outer[1]}, ${outer[2]}, ${outer[3]})`;
    const fade = tint ? `rgba(${tint[0]}, ${tint[1]}, ${tint[2]}, 0)` : `rgba(${outer[0]}, ${outer[1]}, ${outer[2]}, 0)`;

    const glow = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, MARBLE_RADIUS * 2.4);
    glow.addColorStop(0, glowInner);
    glow.addColorStop(0.45, glowOuter);
    glow.addColorStop(1, fade);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(m.x, m.y, MARBLE_RADIUS * 2.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = style.marbleCore;
    ctx.beginPath();
    ctx.arc(m.x, m.y, MARBLE_RADIUS, 0, Math.PI * 2);
    ctx.fill();
  });
}

function draw() {
  drawFixtures();
  drawMarbles();
}

/* ---------------- ループ ---------------- */

function tick(timestamp) {
  rafId = requestAnimationFrame(tick);

  const elapsed = Math.min(timestamp - lastTimestamp, MAX_FRAME_DELTA_MS);
  lastTimestamp = timestamp;
  frameAccumulator += elapsed;
  if (frameAccumulator < 1000 / style.fps) return;

  const dt = Math.min(frameAccumulator, MAX_FRAME_DELTA_MS) / 1000;
  frameAccumulator = 0;

  let remaining = dt;
  while (remaining > 0) {
    stepMachine(machine, Math.min(PHYSICS_STEP, remaining));
    remaining -= PHYSICS_STEP;
  }
  draw();
}

function startLoop() {
  if (rafId !== null || width <= 0 || height <= 0) return;
  lastTimestamp = performance.now();
  frameAccumulator = 1000 / style.fps;
  rafId = requestAnimationFrame(tick);
}

function stopLoop() {
  if (rafId === null) return;
  cancelAnimationFrame(rafId);
  rafId = null;
}

function rebuild() {
  width = canvas.clientWidth;
  height = canvas.clientHeight;
  if (width <= 0 || height <= 0) return;

  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  style = STYLES[mode];
  gearSprites = new Map();
  machine = createMachine(width, height, mode);
  trails = machine.marbles.map(() => []);
  buildStaticLayer();
}

function applyState() {
  if (!canvas) return;

  if (!enabled) {
    stopLoop();
    canvas.hidden = true;
    if (width > 0 && height > 0) ctx.clearRect(0, 0, width, height);
    return;
  }

  canvas.hidden = false;
  if (!machine || width <= 0 || height <= 0) rebuild();

  if (prefersReducedMotion()) {
    stopLoop();
    drawFixtures();
    return;
  }

  if (document.visibilityState === 'visible') {
    startLoop();
  } else {
    stopLoop();
  }
}

/* ---------------- モード切り替え ---------------- */

function showHint(text) {
  const hint = document.getElementById('machine-hint');
  if (!hint) return;
  clearTimeout(hintTimer);
  if (!text) {
    hint.classList.remove('visible');
    return;
  }
  hint.textContent = text;
  hint.classList.add('visible');
  hintTimer = setTimeout(() => hint.classList.remove('visible'), HINT_DURATION_MS);
}

function setMode(next) {
  if (mode === next || !enabled) return;
  mode = next;
  document.body.classList.toggle('machine-mode', mode === 'machine');
  rebuild();
  applyState();
  showHint(mode === 'machine' ? 'マーブルマシン — タップで戻る' : '');
}

export function toggleMachineMode() {
  setMode(mode === 'machine' ? 'background' : 'machine');
}

export function setMarbleBackgroundEnabled(value) {
  enabled = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? 'on' : 'off');
  } catch {
    // 保存できない環境でも今回の表示切り替えだけは反映する
  }
  if (!enabled && mode === 'machine') {
    mode = 'background';
    document.body.classList.remove('machine-mode');
  }
  applyState();
}

export function startMarbleBackground() {
  canvas = document.getElementById('marble-canvas');
  if (!canvas) return;
  ctx = canvas.getContext('2d');
  if (!ctx) return;

  enabled = isMarbleBackgroundEnabled();
  rebuild();

  window.addEventListener('resize', () => {
    rebuild();
    if (enabled && prefersReducedMotion()) drawFixtures();
  });

  // 画面のタップで演出モードと通常表示を行き来する（設定UIの操作は除く）
  document.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('#settings-button, #settings-modal')) return;
    toggleMachineMode();
  });

  // 常時表示アプリなので、画面が隠れている間は描画を止めて電力を使わない
  document.addEventListener('visibilitychange', applyState);
  window.matchMedia?.('(prefers-reduced-motion: reduce)').addEventListener?.('change', applyState);

  applyState();
}
