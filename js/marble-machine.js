/*
 * マーブルマシンの仕掛けの生成と物理。描画は marbles.js が担当する。
 *
 * 2Dの重力では螺旋シュートは成立しない（1周の半分が上り坂になり玉が登れない）ため、
 * カーブは2枚の壁で挟んだ管（チャンネル）として作り、下りカーブだけで構成する。
 */

export const MARBLE_RADIUS = 7;
export const PEG_RADIUS = 2.5;
export const SEGMENT_HALF_THICKNESS = 2;

const GRAVITY = 420;
const MAX_SPEED = 300;
const AIR_DRAG = 0.05;

const SURFACE_RESTITUTION = 0.22;   // 跳ねすぎず転がるくらい
const ROLL_RESISTANCE = 1.0;        // 転がり抵抗（毎秒。接触回数に依存させない）
const WALL_RESTITUTION = 0.4;

const PEG_RESTITUTION = 0.45;
const PEG_JITTER = 20;
const PEG_JITTER_MIN_SPEED = 20;    // 転がり接触では散らさず、跳ね返りのときだけ散らす

const GEAR_SPEED = 1.4;             // rad/s
const GEAR_RESTITUTION = 0.3;
const GEAR_GRIP = 0.2;              // 歯車が玉を連れていく強さ

const MIN_SLOPE_RATIO = 0.14;       // 斜面が緩すぎて玉が止まらないための下限勾配
const MIN_FREE_GAP = MARBLE_RADIUS * 3;  // 玉が挟まる隙間を作らないための最小クリアランス
const FLOOR_OVERLAP = MARBLE_RADIUS * 6; // 次の段は着地点より手前から始める（先端に着地して外すのを防ぐ）
const CHANNEL_HALF_WIDTH = MARBLE_RADIUS * 2.6;  // 内外の壁の間に玉の中心が通る回廊を残す
const ARC_SAMPLES_PER_QUARTER = 6;

const STUCK_SPEED = 14;             // この速さ未満が続いたら詰まりと見なす
const STUCK_LIMIT_S = 3.5;

const LIFT_SPEED = 115;             // px/s。搬送が遅いと玉が受け皿に溜まって機械が空になる

// 通常表示: 閉じた周回コースの上をビー玉が順繰りに流れていく
const ROUTE_SPEED = 78;             // コース上を進む基準の速さ（px/s）
// 速度差を付けすぎるとビー玉の間隔が坂で開いてしまうので、控えめにする
const ROUTE_DOWNHILL_GAIN = 0.45;   // 下り坂でどれだけ速くなるか
const ROUTE_UPHILL_LOSS = 0.3;      // 上り坂でどれだけ遅くなるか
const ROUTE_MIN_SPEED_SCALE = 0.35; // 上りでも止まらないための下限

// 演出モードの仕掛けを落ちるビー玉に使う物理
const PHYSICS = {
  gravity: {
    gravity: GRAVITY, drag: AIR_DRAG, maxSpeed: MAX_SPEED,
    surface: SURFACE_RESTITUTION, roll: ROLL_RESISTANCE, wall: WALL_RESTITUTION,
    peg: PEG_RESTITUTION, gear: GEAR_RESTITUTION, grip: GEAR_GRIP,
  },
};

// 段の種類。必要な段間隔（floorGap）が足りないものは使わない
const FLOOR_SLOPE = 'slope';
const FLOOR_SLOPE_ELBOW = 'slope-elbow';
const FLOOR_STAIRCASE = 'staircase';
const FLOOR_SLOPE_GEAR = 'slope-gear';
const FLOOR_SLOPE_PEGS = 'slope-pegs';

const FLOOR_KINDS = {
  [FLOOR_SLOPE]: { minGap: 40, extent: (gap) => gap * 0.42 },
  [FLOOR_SLOPE_ELBOW]: { minGap: 76, extent: (gap) => gap * 0.7 + CHANNEL_HALF_WIDTH },
  [FLOOR_STAIRCASE]: { minGap: 66, extent: (gap) => gap * 0.7 },
  [FLOOR_SLOPE_GEAR]: { minGap: 72, extent: (gap) => gap * 1.3 },
  [FLOOR_SLOPE_PEGS]: { minGap: 110, extent: (gap) => gap * 0.42 + 90 },
};

// 予定の種類が下の余白に収まらない段では、収まる種類に差し替える
function pickFloorKind(kinds, index, remaining, floorGap) {
  const planned = kinds[index % kinds.length];
  if (FLOOR_KINDS[planned].extent(floorGap) <= remaining) return planned;
  for (let i = 1; i < kinds.length; i++) {
    const alternative = kinds[(index + i) % kinds.length];
    if (FLOOR_KINDS[alternative].extent(floorGap) <= remaining) return alternative;
  }
  return FLOOR_SLOPE;
}

export const PRESETS = {
  // 常時表示の背景。控えめに、決まった周回コースをビー玉が順繰りに回る
  background: {
    motion: 'route',
    marbleCount: 12,
  },
  // 演出モード。多層フレームとリフトで玉が循環する
  machine: {
    motion: 'gravity',
    laneTargetWidth: 470,
    marbleCount: 18,
    floorDivisor: 6.5,
    frame: true,
    lift: true,
    order: [FLOOR_SLOPE_ELBOW, FLOOR_SLOPE_GEAR, FLOOR_STAIRCASE, FLOOR_SLOPE_PEGS],
  },
};

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

/* ---------------- 仕掛けの部品 ---------------- */

function makeSegment(x1, y1, x2, y2, role) {
  const abx = x2 - x1;
  const aby = y2 - y1;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1) return null;
  return {
    x1, y1, x2, y2, abx, aby, lenSq, role,
    minX: Math.min(x1, x2), maxX: Math.max(x1, x2),
    minY: Math.min(y1, y2), maxY: Math.max(y1, y2),
  };
}

function addSegment(m, x1, y1, x2, y2, role) {
  const segment = makeSegment(x1, y1, x2, y2, role);
  if (segment) m.segments.push(segment);
}

// 円弧は描画では滑らかな弧、当たり判定では折れ線として扱う
function addArc(m, cx, cy, radius, a0, a1, role) {
  if (radius <= 0) return;
  m.arcs.push({ cx, cy, radius, a0, a1, role });

  const sweep = Math.abs(a1 - a0);
  const steps = Math.max(2, Math.ceil((sweep / (Math.PI / 2)) * ARC_SAMPLES_PER_QUARTER));
  let prevX = cx + Math.cos(a0) * radius;
  let prevY = cy + Math.sin(a0) * radius;
  for (let i = 1; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const x = cx + Math.cos(a) * radius;
    const y = cy + Math.sin(a) * radius;
    addSegment(m, prevX, prevY, x, y, role);
    prevX = x;
    prevY = y;
  }
}

// 玉を挟んで導く管。内壁が玉を支え、外壁が遠心方向を受け止める
function addChannel(m, cx, cy, radius, a0, a1, role) {
  addArc(m, cx, cy, radius + CHANNEL_HALF_WIDTH, a0, a1, role);
  addArc(m, cx, cy, radius - CHANNEL_HALF_WIDTH, a0, a1, role);
}

// 斜面の端で玉を受け、真下へ向きを変えるエルボ。入口は中心の真上、出口は真横
function addElbow(m, x, y, dir, radius) {
  const cx = x;
  const cy = y + radius;
  const a0 = -Math.PI / 2;
  const a1 = dir > 0 ? 0 : -Math.PI;
  addChannel(m, cx, cy, radius, a0, a1, 'chute');
  return { x: cx + dir * radius, y: cy };
}

function addPeg(m, x, y) {
  if (x < PEG_RADIUS * 2 || x > m.width - PEG_RADIUS * 2) return;
  if (y > m.height) return;
  m.pegs.push({ x, y });
}

function addGear(m, x, y, radius, omega) {
  m.gears.push({
    x: clamp(x, radius + 4, Math.max(radius + 4, m.width - radius - 4)),
    y,
    r: radius,
    omega,
    angle: Math.random() * Math.PI * 2,
  });
}

/* ---------------- 段の組み立て ---------------- */

// 段差の階段。ほぼ水平だが必ず少し傾けて、玉が止まらないようにする
function addStaircase(m, startX, run, dir, y, drop) {
  const steps = 4;
  const span = (dir * run) / steps;
  const rise = drop / steps;
  for (let i = 0; i < steps; i++) {
    const x1 = startX + span * i;
    const stepY = y + rise * i;
    addSegment(m, x1, stepY, x1 + span * 1.12, stepY + rise * 0.34, 'step');
  }
  return { x: startX + span * (steps - 1) + span * 1.12, y: y + drop };
}

// 釘の散らし。落ちてきた玉をばらけさせる
function addPegScatter(m, x, y, dir, laneWidth) {
  const spacing = clamp(laneWidth / 14, 20, 34);
  const rows = 3;
  for (let row = 0; row < rows; row++) {
    const count = row + 2;
    for (let i = 0; i < count; i++) {
      addPeg(m, x - dir * spacing * 0.6 + (i - (count - 1) / 2) * spacing, y + row * spacing * 0.8);
    }
  }
  return y + (rows - 1) * spacing * 0.8;
}

function buildFloor(m, kind, cursor, dir, floorY, floorGap, bounds, laneWidth, dropClearance) {
  const slopeDrop = floorGap * 0.42;
  const elbowRadius = clamp(floorGap * 0.28, 14, 54);
  const forward = dir > 0 ? bounds.right - cursor.x : cursor.x - bounds.left;
  const reserve = kind === FLOOR_SLOPE_ELBOW ? elbowRadius + CHANNEL_HALF_WIDTH + 4 : 8;
  const run = Math.min(slopeDrop / MIN_SLOPE_RATIO, Math.max(30, forward - reserve));
  const startX = cursor.x;
  const endX = startX + dir * run;

  switch (kind) {
    case FLOOR_STAIRCASE: {
      return addStaircase(m, startX, run, dir, floorY, floorGap * 0.7);
    }
    case FLOOR_SLOPE_GEAR: {
      // 斜面 → 端から歯車の肩に落ち、外側の歯に沿って下へ送り出される。
      // 歯車は玉を下流へ運ぶ向きに回し、斜面からは玉1個分以上離す（挟まり防止）
      addSegment(m, startX, floorY, endX, floorY + slopeDrop, 'slope');
      const radius = clamp(Math.min(laneWidth, m.height) / 12, 14, Math.max(14, (floorGap - slopeDrop) / 1.6));
      // 歯車は落下点の真下に少し外側へずらして置く。斜面の終端と接線の位置に置くと
      // 玉が歯車の縁を外してそのまま落ちてしまう
      const gearX = endX + dir * radius * 0.35;
      const gearY = floorY + slopeDrop + radius + MARBLE_RADIUS * 2.5;
      addGear(m, gearX, gearY, radius, dir * GEAR_SPEED);
      // 外側のガードレール。歯車の上端から張り、外へ弾かれた玉を下へ落とす
      const guardX = gearX + dir * (radius + MIN_FREE_GAP + SEGMENT_HALF_THICKNESS + 3);
      addSegment(m, guardX, gearY - radius, guardX, gearY + radius + dropClearance + MARBLE_RADIUS * 2, 'frame');
      return { x: gearX + dir * radius * 0.7, y: gearY + radius * 0.85 };
    }
    case FLOOR_SLOPE: {
      addSegment(m, startX, floorY, endX, floorY + slopeDrop, 'slope');
      return { x: endX, y: floorY + slopeDrop };
    }
    case FLOOR_SLOPE_PEGS: {
      addSegment(m, startX, floorY, endX, floorY + slopeDrop, 'slope');
      const pegBottom = addPegScatter(m, endX, floorY + slopeDrop + MIN_FREE_GAP + 10, dir, laneWidth);
      return { x: endX, y: pegBottom };
    }
    default: {
      // 斜面 → 管状のカーブ（エルボ）で真下へ向きを変える
      addSegment(m, startX, floorY, endX, floorY + slopeDrop, 'slope');
      // 入口は玉の中心が通る高さに合わせる。斜面の表面に合わせると外壁の端に正面衝突する
      const exit = addElbow(m, endX, floorY + slopeDrop - MARBLE_RADIUS - SEGMENT_HALF_THICKNESS, dir, elbowRadius);
      // 出口の外側のガードレール。これが無いと玉が横に流れて次の段を飛び越える
      const guardX = exit.x + dir * CHANNEL_HALF_WIDTH;
      addSegment(m, guardX, exit.y, guardX, exit.y + dropClearance + MARBLE_RADIUS * 2, 'frame');
      return exit;
    }
  }
}

/* ---------------- レーン（機械1台）の組み立て ---------------- */

function addFrame(m, laneX, laneWidth, top, bottom) {
  const left = laneX + 2;
  const right = laneX + laneWidth - 2;
  addSegment(m, left, top, left, bottom, 'frame');
  addSegment(m, right, top, right, bottom, 'frame');
  addSegment(m, left, bottom, right, bottom, 'frame');
  m.decorations.push({ type: 'box', x: left, y: top, w: right - left, h: bottom - top });
}

function addLift(m, x, top, bottom, releaseDir) {
  const travel = bottom - top;
  if (travel < 80) return null;

  const count = clamp(Math.round(travel / 85), 3, 10);
  const lift = {
    x,
    top,
    bottom,
    travel,
    speed: LIFT_SPEED,
    phase: 0,
    releaseDir,
    halfWidth: MARBLE_RADIUS * 3,
    buckets: [],
  };
  for (let i = 0; i < count; i++) {
    lift.buckets.push({ offset: (travel * i) / count, marble: null, y: bottom });
  }
  m.lifts.push(lift);

  m.decorations.push({ type: 'lift-rail', x, top, bottom, halfWidth: lift.halfWidth });
  return lift;
}

function buildLane(m, laneX, laneWidth, preset) {
  const pad = preset.frame ? clamp(Math.min(laneWidth, m.height) * 0.05, 8, 26) : 0;
  const top = pad;
  const bottom = m.height - pad;

  if (preset.frame) addFrame(m, laneX, laneWidth, top, bottom);

  let bounds = { left: laneX + pad + 10, right: laneX + laneWidth - pad - 10 };
  // 段の始点は壁まで許す（壁との間に隙間を残すと、そこを玉が落ちてしまう）。
  // ただしリフトの列には食い込ませない
  const wallBounds = { left: laneX + 10, right: laneX + laneWidth - 10 };
  let lift = null;
  let cursor;
  let dir = 1;

  const floorGap = clamp(m.height / preset.floorDivisor, preset.frame ? 80 : 84, 190);
  let floorY;
  let limitY = m.height;

  if (preset.lift) {
    const liftWidth = clamp(Math.min(laneWidth, m.height) * 0.09, 26, 54);
    const liftX = laneX + pad + liftWidth / 2;
    lift = addLift(m, liftX, top + floorGap * 0.45, bottom - 34, 1);
    bounds = { left: liftX + liftWidth / 2 + 12, right: bounds.right };
    wallBounds.left = liftX + 2;
    cursor = { x: bounds.left + 6, y: top + floorGap * 0.5 };
    floorY = cursor.y + 14;
  } else {
    // 上部の投入口（漏斗）。玉を中央へ集めて最初の斜面へ落とす
    const funnelY = Math.max(24, m.height * 0.05);
    const funnelSpread = laneWidth * 0.3;
    const centerX = laneX + laneWidth / 2;
    addSegment(m, centerX - funnelSpread, funnelY, centerX - 14, funnelY + funnelSpread * 0.3, 'slope');
    addSegment(m, centerX + funnelSpread, funnelY, centerX + 14, funnelY + funnelSpread * 0.3, 'slope');
    floorY = clamp(m.height * 0.13, 70, 160);
    cursor = { x: bounds.left, y: floorY };
  }

  // 縦の余裕が足りない種類は使わない
  const kinds = preset.order.filter((kind) => floorGap >= FLOOR_KINDS[kind].minGap);
  if (kinds.length === 0) kinds.push(FLOOR_STAIRCASE);

  if (lift) {
    // 回収路の上端より下には仕掛けを作らない（画面外や回収路の下に張り出させない）
    const frameRight = laneX + laneWidth - 4;
    limitY = lift.bottom + MARBLE_RADIUS + 3 - (frameRight - lift.x) * MIN_SLOPE_RATIO;
  }

  // 出口から次の段までの落差。固定グリッドで段を置くと、仕掛けの出口の高さと
  // 次の段の高さが食い違って玉が段の外を落ちてしまう
  const dropClearance = clamp(floorGap * 0.22, 26, 46);

  let index = 0;
  let previousKind = null;
  while (floorY < limitY - floorGap * 0.35) {
    const forward = dir > 0 ? bounds.right - cursor.x : cursor.x - bounds.left;
    if (forward < floorGap * 0.5) dir = -dir;   // 壁際まで来たら向きを変える

    const kind = pickFloorKind(kinds, index, limitY - floorY, floorGap);
    // 前の段の出口より手前から始めて、玉が段の先端を外して脇へ落ちるのを防ぐ。
    // 釘で散らした直後は落下位置が定まらないので、壁から始めて幅いっぱいで受ける
    const startX = previousKind === FLOOR_SLOPE_PEGS
      ? (dir > 0 ? wallBounds.left : wallBounds.right)
      : clamp(cursor.x - dir * FLOOR_OVERLAP, wallBounds.left, wallBounds.right);
    const start = { x: startX, y: cursor.y };
    cursor = buildFloor(m, kind, start, dir, floorY, floorGap, bounds, laneWidth, dropClearance);
    previousKind = kind;
    dir = -dir;
    floorY = cursor.y + dropClearance;
    index++;
  }

  if (lift) {
    // 最下部はV字の回収路。落ちてきた玉はすべて谷（リフトの真下）へ集まる
    const valleyY = lift.bottom + MARBLE_RADIUS + 3;
    const frameRight = laneX + laneWidth - 4;
    const pocket = lift.halfWidth;
    addSegment(m, frameRight, valleyY - (frameRight - lift.x - pocket) * MIN_SLOPE_RATIO, lift.x + pocket, valleyY - 2, 'slope');
    addSegment(m, lift.x + pocket, valleyY - 2, lift.x - pocket, valleyY, 'slope');
    addSegment(m, laneX + 4, valleyY - 26, lift.x - pocket, valleyY, 'slope');
    m.spawn = { x: bounds.left + 10, y: top + 20, dir: 1 };
  } else {
    m.spawn = null;
  }

  // 多層フレームの棚板は見た目だけの装飾（当たり判定には入れない）
  if (preset.frame) {
    for (let y = top + floorGap; y < bottom - 8; y += floorGap) {
      m.decorations.push({ type: 'shelf', x1: laneX + pad + 6, x2: laneX + laneWidth - pad - 6, y });
    }
  }
}

/* ---------------- 周回コース（通常表示） ---------------- */

function routeSpeedScale(dy, length) {
  // 下りでは速く、上りでは遅く。重力で流れている感じを出すが、上りでも止まらない
  const slope = length > 0 ? dy / length : 0;
  const scale = slope >= 0
    ? 1 + slope * ROUTE_DOWNHILL_GAIN
    : 1 + slope * ROUTE_UPHILL_LOSS;
  return Math.max(ROUTE_MIN_SPEED_SCALE, scale);
}

// 折れ線の頂点から、距離で位置を引ける閉じたコースを作る
function makeRoute(points) {
  const legs = [];
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const from = points[i];
    const to = points[(i + 1) % points.length];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) continue;
    legs.push({
      x: from.x, y: from.y, dx, dy, length, start: total,
      speedScale: routeSpeedScale(dy, length),
    });
    total += length;
  }
  return { legs, total };
}

export function routePosition(route, distance) {
  const wrapped = ((distance % route.total) + route.total) % route.total;
  let low = 0;
  let high = route.legs.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (route.legs[mid].start <= wrapped) low = mid;
    else high = mid - 1;
  }
  const leg = route.legs[low];
  const t = (wrapped - leg.start) / leg.length;
  return { x: leg.x + leg.dx * t, y: leg.y + leg.dy * t, speedScale: leg.speedScale };
}

// 画面を蛇行しながら下り、片側の直線を通って上に戻る一本の閉じたコース。
// 折り返しごとに向きが変わるので、画面全体をビー玉が順繰りに回る
function buildRoute(m) {
  const margin = clamp(Math.min(m.width, m.height) * 0.07, 14, 46);
  const returnLane = clamp(m.width * 0.1, 26, 60);
  const left = margin + returnLane;
  const right = m.width - margin;
  const top = margin;
  const bottom = m.height - margin;

  const rows = clamp(Math.round((bottom - top) / clamp(m.height / 5, 90, 190)), 2, 6);
  const rowGap = (bottom - top) / rows;

  const points = [{ x: left, y: top }];
  for (let row = 0; row < rows; row++) {
    const y = top + rowGap * row;
    const nextY = Math.min(bottom, y + rowGap);
    const forward = row % 2 === 0;
    const far = forward ? right : left;
    points.push({ x: far, y: y + rowGap * 0.35 });   // 蛇行の横棒（わずかに下る）
    if (row < rows - 1) {
      // 落差の到達点が、そのまま次の横棒（逆向き）の始点になる
      points.push({ x: far, y: nextY });
      // 折り返しには歯車を飾りに置く
      if (row % 2 === 0) {
        const radius = clamp(rowGap * 0.22, 12, 26);
        addGear(m, far + (forward ? -radius * 1.6 : radius * 1.6), nextY + radius * 1.4, radius,
          (forward ? 1 : -1) * GEAR_SPEED);
      }
    }
  }

  // 最後の横棒の端から下端を通り、戻りの直線で上まで戻って始点に戻る
  const lastForward = (rows - 1) % 2 === 0;
  const lastFar = lastForward ? right : left;
  points.push({ x: lastFar, y: bottom });
  points.push({ x: margin, y: bottom });
  points.push({ x: margin, y: top });

  m.route = makeRoute(points);

  // コースは描画のためだけに区間として持つ（通常表示では当たり判定を使わない）
  for (const leg of m.route.legs) {
    addSegment(m, leg.x, leg.y, leg.x + leg.dx, leg.y + leg.dy, 'slope');
  }
}

/* ---------------- 隙間の検証 ---------------- */

function clipSegmentOutsideCircle(seg, cx, cy, radius) {
  const fx = seg.x1 - cx;
  const fy = seg.y1 - cy;
  const a = seg.lenSq;
  const b = 2 * (fx * seg.abx + fy * seg.aby);
  const c = fx * fx + fy * fy - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant <= 0) return seg;

  const root = Math.sqrt(discriminant);
  const t1 = (-b - root) / (2 * a);
  const t2 = (-b + root) / (2 * a);
  if (t2 <= 0 || t1 >= 1) return seg;

  const head = clamp(t1, 0, 1);
  const tail = clamp(t2, 0, 1);
  if (Math.max(head, 1 - tail) < 0.25) return null;

  if (head >= 1 - tail) {
    return makeSegment(seg.x1, seg.y1, seg.x1 + seg.abx * head, seg.y1 + seg.aby * head, seg.role);
  }
  return makeSegment(seg.x1 + seg.abx * tail, seg.y1 + seg.aby * tail, seg.x2, seg.y2, seg.role);
}

function distanceToSegment(x, y, s) {
  let t = ((x - s.x1) * s.abx + (y - s.y1) * s.aby) / s.lenSq;
  t = clamp(t, 0, 1);
  return Math.hypot(x - (s.x1 + s.abx * t), y - (s.y1 + s.aby * t));
}

// 仕掛け同士が玉1個分未満の隙間で並ぶと玉が挟まるので、組み立て後に間引く
function pruneTightGaps(m) {
  const trimmed = [];
  for (const seg of m.segments) {
    let current = seg;
    for (const g of m.gears) {
      current = clipSegmentOutsideCircle(current, g.x, g.y, g.r + SEGMENT_HALF_THICKNESS + MIN_FREE_GAP);
      if (!current) break;
    }
    if (current) trimmed.push(current);
  }
  m.segments = trimmed;

  m.pegs = m.pegs.filter((p) => {
    for (const s of m.segments) {
      if (distanceToSegment(p.x, p.y, s) - PEG_RADIUS - SEGMENT_HALF_THICKNESS < MIN_FREE_GAP) return false;
    }
    for (const g of m.gears) {
      if (Math.hypot(p.x - g.x, p.y - g.y) - PEG_RADIUS - g.r < MIN_FREE_GAP) return false;
    }
    return true;
  });
}

/* ---------------- 玉 ---------------- */

function resetMarble(m, marble, spread) {
  if (m.preset.motion === 'route') {
    marble.distance = Math.random() * m.route.total;
    const spot = routePosition(m.route, marble.distance);
    marble.x = spot.x;
    marble.y = spot.y;
    marble.vx = 0;
    marble.vy = 0;
    marble.stillTime = 0;
    marble.carried = false;
    return;
  }

  const lane = m.lanes.length > 0 ? m.lanes[Math.floor(Math.random() * m.lanes.length)] : { x: 0, width: m.width };
  marble.x = m.spawn
    ? m.spawn.x + Math.random() * 20
    : lane.x + lane.width / 2 + (Math.random() - 0.5) * lane.width * 0.4;
  marble.y = m.spawn
    ? m.spawn.y + Math.random() * 16
    : (spread ? -Math.random() * (m.height + MARBLE_RADIUS * 2) : -MARBLE_RADIUS * 4);
  marble.vx = m.spawn ? m.spawn.dir * 40 : (Math.random() - 0.5) * 30;
  marble.vy = 0;
  marble.stillTime = 0;
  marble.carried = false;
}

/* ---------------- 当たり判定 ---------------- */

function collideSegment(m, s, dt, phys) {
  const minDist = MARBLE_RADIUS + SEGMENT_HALF_THICKNESS;
  if (m.y < s.minY - minDist || m.y > s.maxY + minDist) return;
  if (m.x < s.minX - minDist || m.x > s.maxX + minDist) return;

  let t = ((m.x - s.x1) * s.abx + (m.y - s.y1) * s.aby) / s.lenSq;
  t = clamp(t, 0, 1);
  const px = s.x1 + s.abx * t;
  const py = s.y1 + s.aby * t;
  const dx = m.x - px;
  const dy = m.y - py;
  const distSq = dx * dx + dy * dy;
  if (distSq >= minDist * minDist) return;

  const dist = Math.sqrt(distSq);
  const nx = dist < 0.0001 ? 0 : dx / dist;
  const ny = dist < 0.0001 ? -1 : dy / dist;
  m.x = px + nx * minDist;
  m.y = py + ny * minDist;

  const vn = m.vx * nx + m.vy * ny;
  if (vn >= 0) return;
  m.vx -= (1 + phys.surface) * vn * nx;
  m.vy -= (1 + phys.surface) * vn * ny;

  // 転がり抵抗。接触回数ではなく経過時間に比例させないと、斜面上で玉が止まってしまう
  const tx = -ny;
  const ty = nx;
  const vt = m.vx * tx + m.vy * ty;
  const resistance = Math.min(1, phys.roll * dt);
  m.vx -= tx * vt * resistance;
  m.vy -= ty * vt * resistance;
}

function collidePeg(m, p, phys) {
  const minDist = MARBLE_RADIUS + PEG_RADIUS;
  const dx = m.x - p.x;
  const dy = m.y - p.y;
  const distSq = dx * dx + dy * dy;
  if (distSq === 0 || distSq >= minDist * minDist) return;

  const dist = Math.sqrt(distSq);
  const nx = dx / dist;
  const ny = dy / dist;
  m.x = p.x + nx * minDist;
  m.y = p.y + ny * minDist;

  const vn = m.vx * nx + m.vy * ny;
  if (vn >= 0) return;
  m.vx -= (1 + phys.peg) * vn * nx;
  m.vy -= (1 + phys.peg) * vn * ny;

  // 釘の頂点に乗って止まらないよう、接線方向へわずかに散らす（転がり接触では加えない）
  if (-vn < PEG_JITTER_MIN_SPEED) return;
  const jitter = (Math.random() - 0.5) * PEG_JITTER;
  m.vx += -ny * jitter;
  m.vy += nx * jitter;
}

function collideGear(m, g, phys) {
  const minDist = MARBLE_RADIUS + g.r;
  const dx = m.x - g.x;
  const dy = m.y - g.y;
  const distSq = dx * dx + dy * dy;
  if (distSq === 0 || distSq >= minDist * minDist) return;

  const dist = Math.sqrt(distSq);
  const nx = dx / dist;
  const ny = dy / dist;
  m.x = g.x + nx * minDist;
  m.y = g.y + ny * minDist;

  // 接触点の周速度。これで歯車が玉を運ぶ
  const surfaceX = -g.omega * ny * g.r;
  const surfaceY = g.omega * nx * g.r;
  let rvx = m.vx - surfaceX;
  let rvy = m.vy - surfaceY;

  const vn = rvx * nx + rvy * ny;
  if (vn >= 0) return;
  rvx -= (1 + phys.gear) * vn * nx;
  rvy -= (1 + phys.gear) * vn * ny;

  const tx = -ny;
  const ty = nx;
  const vt = rvx * tx + rvy * ty;
  rvx -= tx * vt * phys.grip;
  rvy -= ty * vt * phys.grip;

  m.vx = rvx + surfaceX;
  m.vy = rvy + surfaceY;
}

/* ---------------- リフト ---------------- */

function inIntake(lift, marble) {
  return Math.abs(marble.x - lift.x) < lift.halfWidth + MARBLE_RADIUS * 3
    && marble.y > lift.bottom - MARBLE_RADIUS * 5
    && marble.y < lift.bottom + MARBLE_RADIUS * 6;
}

// バケットは玉を「掴んで」運ぶ。動く床の上で玉を釣り合わせるより確実で、見た目は同じ
function stepLift(machine, lift, dt) {
  lift.phase = (lift.phase + lift.speed * dt) % lift.travel;

  for (const bucket of lift.buckets) {
    const previousY = bucket.y;
    bucket.y = lift.bottom - ((bucket.offset + lift.phase) % lift.travel);
    const wrapped = bucket.y > previousY + lift.travel * 0.5;

    if (bucket.marble !== null) {
      const marble = bucket.marble;
      if (bucket.y <= lift.top + 6 || wrapped) {
        // 頂上で解放し、最上段へ送り出す
        marble.carried = false;
        marble.vx = lift.releaseDir * 90;
        marble.vy = 10;
        bucket.marble = null;
      } else {
        marble.x = lift.x;
        marble.y = bucket.y - MARBLE_RADIUS - 2;
        marble.vx = 0;
        marble.vy = -lift.speed;
        marble.stillTime = 0;
      }
      continue;
    }

    if (Math.abs(bucket.y - lift.bottom) > MARBLE_RADIUS * 5) continue;
    for (const marble of machine.marbles) {
      if (marble.carried || !inIntake(lift, marble)) continue;
      marble.carried = true;
      bucket.marble = marble;
      break;
    }
  }
}

/* ---------------- 公開API ---------------- */

export function createMachine(width, height, mode) {
  const preset = PRESETS[mode] ?? PRESETS.background;
  const machine = {
    width, height, mode, preset,
    segments: [], arcs: [], pegs: [], gears: [], lifts: [], decorations: [],
    lanes: [], marbles: [], spawn: null, route: null,
  };

  if (preset.motion === 'route') {
    machine.lanes.push({ x: 0, width });
    buildRoute(machine);
  } else {
    const laneCount = Math.max(1, Math.round(width / preset.laneTargetWidth));
    const laneWidth = width / laneCount;
    for (let i = 0; i < laneCount; i++) {
      machine.lanes.push({ x: laneWidth * i, width: laneWidth });
      buildLane(machine, laneWidth * i, laneWidth, preset);
    }
  }

  pruneTightGaps(machine);

  for (let i = 0; i < preset.marbleCount; i++) {
    const marble = { x: 0, y: 0, vx: 0, vy: 0, stillTime: 0, carried: false, wanderTime: 0, checkX: 0, checkY: 0, distance: 0 };
    resetMarble(machine, marble, true);
    machine.marbles.push(marble);
  }

  // コース上では等間隔に並べて、順繰りに流れて見えるようにする
  if (machine.route) {
    machine.marbles.forEach((marble, index) => {
      marble.distance = (machine.route.total * index) / machine.marbles.length;
      const spot = routePosition(machine.route, marble.distance);
      marble.x = spot.x;
      marble.y = spot.y;
    });
  }

  return machine;
}

// 決まった周回コースの上を順繰りに流れる。跳ね返りも詰まりもない
function stepRoute(machine, dt) {
  for (const m of machine.marbles) {
    const spot = routePosition(machine.route, m.distance);
    m.distance += ROUTE_SPEED * spot.speedScale * dt;
    const next = routePosition(machine.route, m.distance);
    m.x = next.x;
    m.y = next.y;
  }
}

export function stepMachine(machine, dt) {
  for (const g of machine.gears) {
    g.angle += g.omega * dt;
  }

  if (machine.preset.motion === 'route') {
    stepRoute(machine, dt);
    return;
  }

  for (const lift of machine.lifts) {
    stepLift(machine, lift, dt);
  }

  for (const m of machine.marbles) {
    if (m.carried) continue;

    m.vy += PHYSICS.gravity.gravity * dt;
    const damping = Math.max(0, 1 - PHYSICS.gravity.drag * dt);
    m.vx *= damping;
    m.vy *= damping;

    const speed = Math.hypot(m.vx, m.vy);
    if (speed > PHYSICS.gravity.maxSpeed) {
      m.vx = (m.vx / speed) * PHYSICS.gravity.maxSpeed;
      m.vy = (m.vy / speed) * PHYSICS.gravity.maxSpeed;
    }

    m.x += m.vx * dt;
    m.y += m.vy * dt;

    if (m.x < MARBLE_RADIUS) {
      m.x = MARBLE_RADIUS;
      m.vx = Math.abs(m.vx) * PHYSICS.gravity.wall;
    } else if (m.x > machine.width - MARBLE_RADIUS) {
      m.x = machine.width - MARBLE_RADIUS;
      m.vx = -Math.abs(m.vx) * PHYSICS.gravity.wall;
    }

    for (const s of machine.segments) collideSegment(m, s, dt, PHYSICS.gravity);
    for (const p of machine.pegs) collidePeg(m, p, PHYSICS.gravity);
    for (const g of machine.gears) collideGear(m, g, PHYSICS.gravity);

    // 受け皿でバケットを待っている玉は、止まっていても詰まりではない
    let waiting = false;
    for (const lift of machine.lifts) {
      if (inIntake(lift, m)) { waiting = true; break; }
    }
    m.stillTime = !waiting && Math.hypot(m.vx, m.vy) < STUCK_SPEED ? m.stillTime + dt : 0;

    const outOfBounds = m.y - MARBLE_RADIUS > machine.height || m.x < -40 || m.x > machine.width + 40;
    if (outOfBounds || m.stillTime > STUCK_LIMIT_S || !Number.isFinite(m.x) || !Number.isFinite(m.y)) {
      resetMarble(machine, m, false);
    }
  }
}
