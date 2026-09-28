"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import {
  createBrushedMetalNormal,
  createRoughNormal,
  createHammeredNormal,
  deriveDisplacementFromImage,
  deriveNormalFromImage,
  type DisplacementField,
} from "@/utils/textureGenerators";
import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { mergeGeometries, mergeVertices, toCreasedNormals } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import GrassFur from "./GrassFur";

// Tangent angle threshold at a junction. 0 = perfectly smooth, PI = sharp
// reversal. Round anything sharper than ~15 degrees (0.26 rad).
const CORNER_ANGLE_THRESHOLD = 0.26;

// Below this effective arc radius, the fillet is smaller than a pixel at
// typical viewing scales and tessellates into sliver triangles — worse than
// the sharp corner it was meant to soften.
const MIN_EFFECTIVE_RADIUS = 0.05;

type Curve = THREE.Curve<THREE.Vector2>;

function reverseCurveInPlace(curve: Curve): void {
  if ((curve as THREE.LineCurve).isLineCurve) {
    const line = curve as THREE.LineCurve;
    const start = line.v1.clone();
    line.v1.copy(line.v2);
    line.v2.copy(start);
  } else if ((curve as THREE.CubicBezierCurve).isCubicBezierCurve) {
    const cubic = curve as THREE.CubicBezierCurve;
    const start = cubic.v0.clone();
    const control1 = cubic.v1.clone();
    cubic.v0.copy(cubic.v3);
    cubic.v1.copy(cubic.v2);
    cubic.v2.copy(control1);
    cubic.v3.copy(start);
  } else if ((curve as THREE.QuadraticBezierCurve).isQuadraticBezierCurve) {
    const quadratic = curve as THREE.QuadraticBezierCurve;
    const start = quadratic.v0.clone();
    quadratic.v0.copy(quadratic.v2);
    quadratic.v2.copy(start);
  } else if ((curve as THREE.EllipseCurve).isEllipseCurve) {
    const ellipse = curve as THREE.EllipseCurve;
    const startAngle = ellipse.aStartAngle;
    ellipse.aStartAngle = ellipse.aEndAngle;
    ellipse.aEndAngle = startAngle;
    ellipse.aClockwise = !ellipse.aClockwise;
  }
}

function cloneCurvePath(
  source: THREE.Path,
  reverse: boolean,
  asShape: true,
): THREE.Shape;
function cloneCurvePath(
  source: THREE.Path,
  reverse: boolean,
  asShape?: false,
): THREE.Path;
function cloneCurvePath(
  source: THREE.Path,
  reverse: boolean,
  asShape = false,
): THREE.Path | THREE.Shape {
  const curves = source.curves.map((curve) => curve.clone() as Curve);
  if (reverse) {
    curves.reverse();
    for (const curve of curves) reverseCurveInPlace(curve);
  }

  const target = asShape ? new THREE.Shape() : new THREE.Path();
  target.curves = curves;
  if (curves.length > 0) {
    target.currentPoint.copy(curves[curves.length - 1].getPoint(1));
  }
  return target;
}

function getCurveEnd(curve: Curve): THREE.Vector2 {
  return curve.getPoint(1);
}

function getCurveStart(curve: Curve): THREE.Vector2 {
  return curve.getPoint(0);
}

function isLine(curve: Curve): curve is THREE.LineCurve {
  return (curve as { isLineCurve?: boolean }).isLineCurve === true;
}

function isCubic(curve: Curve): curve is THREE.CubicBezierCurve {
  return (curve as { isCubicBezierCurve?: boolean }).isCubicBezierCurve === true;
}

function isQuadratic(curve: Curve): curve is THREE.QuadraticBezierCurve {
  return (curve as { isQuadraticBezierCurve?: boolean }).isQuadraticBezierCurve === true;
}

/**
 * Unit tangent at parameter t. Uses Three's getTangent (finite-diff in the
 * base class, so good enough for every SVG curve type). Returns null if the
 * sampled direction is degenerate.
 */
function tangentAt(curve: Curve, t: number): THREE.Vector2 | null {
  const v = curve.getTangent(t) as THREE.Vector2;
  if (!v || v.length() === 0) return null;
  return v;
}

function curveLength(curve: Curve): number {
  if (isLine(curve)) {
    return getCurveStart(curve).distanceTo(getCurveEnd(curve));
  }
  return curve.getLength();
}

/**
 * Find t such that arc length from 0 to t equals `dist`. Lines use direct
 * division; other curves delegate to Three's cumulative arc-length table.
 */
function tAtArcLength(curve: Curve, dist: number, totalLen: number): number {
  if (totalLen <= 0) return 0;
  const d = Math.max(0, Math.min(totalLen, dist));
  if (isLine(curve)) return d / totalLen;
  return curve.getUtoTmapping(0, d);
}

/** de Casteljau split at t — used to extract a sub-bezier parametrically. */
function splitCubicAt(
  p0: THREE.Vector2, p1: THREE.Vector2, p2: THREE.Vector2, p3: THREE.Vector2, t: number
): {
  left: [THREE.Vector2, THREE.Vector2, THREE.Vector2, THREE.Vector2];
  right: [THREE.Vector2, THREE.Vector2, THREE.Vector2, THREE.Vector2];
} {
  const q0 = p0.clone().lerp(p1, t);
  const q1 = p1.clone().lerp(p2, t);
  const q2 = p2.clone().lerp(p3, t);
  const r0 = q0.clone().lerp(q1, t);
  const r1 = q1.clone().lerp(q2, t);
  const s = r0.clone().lerp(r1, t);
  return {
    left: [p0.clone(), q0, r0, s.clone()],
    right: [s, r1, q2, p3.clone()],
  };
}

/** Extract the [t0, t1] portion of a cubic bezier as a new cubic. */
function subCubic(
  p0: THREE.Vector2, p1: THREE.Vector2, p2: THREE.Vector2, p3: THREE.Vector2,
  t0: number, t1: number
): [THREE.Vector2, THREE.Vector2, THREE.Vector2, THREE.Vector2] {
  const right = splitCubicAt(p0, p1, p2, p3, t0).right;
  const tRemap = (t1 - t0) / (1 - t0);
  return splitCubicAt(right[0], right[1], right[2], right[3], tRemap).left;
}

function splitQuadAt(
  p0: THREE.Vector2, p1: THREE.Vector2, p2: THREE.Vector2, t: number
): {
  left: [THREE.Vector2, THREE.Vector2, THREE.Vector2];
  right: [THREE.Vector2, THREE.Vector2, THREE.Vector2];
} {
  const q0 = p0.clone().lerp(p1, t);
  const q1 = p1.clone().lerp(p2, t);
  const s = q0.clone().lerp(q1, t);
  return {
    left: [p0.clone(), q0, s.clone()],
    right: [s, q1, p2.clone()],
  };
}

function subQuadratic(
  p0: THREE.Vector2, p1: THREE.Vector2, p2: THREE.Vector2,
  t0: number, t1: number
): [THREE.Vector2, THREE.Vector2, THREE.Vector2] {
  const right = splitQuadAt(p0, p1, p2, t0).right;
  const tRemap = (t1 - t0) / (1 - t0);
  return splitQuadAt(right[0], right[1], right[2], tRemap).left;
}

type CornerRounding = {
  cx: number;
  cy: number;
  radius: number;
  startAngle: number;
  endAngle: number;
  clockwise: boolean;
  // Where on each neighbor the arc begins/ends, in the neighbor's own t-space.
  tEndOnCurr: number;
  tStartOnNext: number;
};

/**
 * Circular-arc fillet at the junction between two curves.
 *
 * For straight edges meeting with deflection β, the tangent points of a
 * radius-R arc sit at distance d = R·tan(β/2) from the corner along each
 * edge. We apply the same formula to curved edges by linearizing at the
 * junction tangents — the arc still meets each neighbor tangentially, but
 * the effective radius along a curved neighbor is approximate.
 *
 * Concave (reflex) corners are skipped because an arc curving into the
 * polygon interior would merge nearby features (e.g. the V-tip of a
 * checkmark would fill in and the two arms would fuse into a triangle).
 */
// β above which the cap-level miter displacement |offset|/cos(β/2) under
// negative bevelOffset exceeds ~3× |offset|, i.e. cos(β/2) < 1/3. Sharper
// than this and reflex notches spike in ExtrudeGeometry; shallower than this
// and the default miter shift is benign. Used to gate the reflex miter-safety
// bump so near-straight reflex joints don't get rounded into teeth.
const REFLEX_MITER_DANGER_BETA = 2 * Math.acos(1 / 3);

function getCornerRounding(
  curr: Curve,
  next: Curve,
  convexRadius: number,
  innerRadius: number,
  reflexMiterSafetyR: number,
  minEffectiveRadius: number,
  windingSign: number
): CornerRounding | null {
  const corner = getCurveEnd(curr);

  const tOut = tangentAt(curr, 1);
  const tIn = tangentAt(next, 0);
  if (!tOut || !tIn) return null;

  const dot = THREE.MathUtils.clamp(tOut.dot(tIn), -1, 1);
  const beta = Math.acos(dot);
  if (beta < CORNER_ANGLE_THRESHOLD) return null;

  // Near-cusps (tangents nearly reversed) get no rounding: the cross-product
  // convexity test becomes numerically unreliable near zero, and any arc we
  // compute here ends up trying to fill a sliver with a near-degenerate
  // circle whose sweep direction can disagree with the polygon's winding —
  // producing a tiny self-crossing that ExtrudeGeometry's bevel turns into
  // a stray perpendicular sheet on sharp tips. Leave those tips sharp.
  if (beta > Math.PI * 0.9) return null;

  // Convex vs reflex: CCW polygons turn left at convex corners (positive
  // cross), CW turn right. Sign mismatch ⇒ reflex/concave corner, which gets
  // filled by an arc sized by innerRadius (convex corners use convexRadius).
  // sideSign below places the arc center on the correct side for both cases;
  // only the sweep direction has to flip, which is what isReflex XOR handles.
  const cross = tOut.x * tIn.y - tOut.y * tIn.x;
  const isReflex = cross * windingSign < 0;
  // Reflex miter-safety bump only kicks in when β is past the danger angle —
  // below that the default miter shift is fine, and applying the bump would
  // needlessly trim near-straight reflex joints into visible teeth.
  const radius = isReflex
    ? Math.max(innerRadius, beta > REFLEX_MITER_DANGER_BETA ? reflexMiterSafetyR : 0)
    : convexRadius;
  if (radius <= 0) return null;

  const len1 = curveLength(curr);
  const len2 = curveLength(next);
  if (len1 <= 0 || len2 <= 0) return null;

  const halfTan = Math.tan(beta / 2);
  if (!isFinite(halfTan) || halfTan <= 0) return null;

  // Figma-style cap: the fillet's trim distance never exceeds 50% of the
  // shortest neighboring edge, and the arc radius scales down with it so the
  // arc still meets both edges tangent-flush (no kink). Tangent-fillet
  // identity d = R·tan(β/2) lets us derive maxR from maxD.
  const maxD = Math.min(len1, len2) * 0.5;
  const maxR = maxD / halfTan;
  const R = Math.min(radius, maxR);
  if (R < minEffectiveRadius) return null;
  const d = R * halfTan;

  const tEndOnCurr = tAtArcLength(curr, len1 - d, len1);
  const tStartOnNext = tAtArcLength(next, d, len2);

  // Use the ACTUAL curve points as arc endpoints so the trimmed curve
  // connects to the arc without three.js auto-inserting a bridging
  // LineCurve. Place the arc center on the perpendicular bisector of the
  // pEnd→pStart chord at the user-consistent R. For straight edges this is
  // identical to a true tangent fillet; for Bezier edges there is a tiny
  // tangent kink but the arc is well-behaved at all radii (no blow-up
  // when trim-point tangents run nearly parallel).
  const pEnd = curr.getPoint(tEndOnCurr);
  const pStart = next.getPoint(tStartOnNext);
  const chordX = pStart.x - pEnd.x;
  const chordY = pStart.y - pEnd.y;
  const chordLen = Math.hypot(chordX, chordY);
  if (chordLen < 1e-9) return null;
  if (chordLen > 2 * R + 1e-6) return null; // chord longer than diameter

  const midX = (pEnd.x + pStart.x) / 2;
  const midY = (pEnd.y + pStart.y) / 2;
  const h = Math.sqrt(Math.max(0, R * R - (chordLen / 2) ** 2));

  // Unit perpendicular to the chord.
  const perpCX = -chordY / chordLen;
  const perpCY = chordX / chordLen;

  // Center sits on the side of the chord OPPOSITE the original corner
  // vertex — i.e., on the polygon interior for a convex rounding.
  const toCornerFromMidX = corner.x - midX;
  const toCornerFromMidY = corner.y - midY;
  const cornerSide = toCornerFromMidX * perpCX + toCornerFromMidY * perpCY;
  const sideSign = cornerSide >= 0 ? -1 : 1;

  const cx = midX + sideSign * h * perpCX;
  const cy = midY + sideSign * h * perpCY;

  const startAngle = Math.atan2(pEnd.y - cy, pEnd.x - cx);
  const endAngle = Math.atan2(pStart.y - cy, pStart.x - cx);
  // Convex fillets sweep in the polygon's own winding direction; reflex
  // fillets sweep the opposite way so the short arc (the one that actually
  // fills the notch) is chosen instead of the long way around the center.
  const clockwise = (windingSign < 0) !== isReflex;

  return { cx, cy, radius: R, startAngle, endAngle, clockwise, tEndOnCurr, tStartOnNext };
}

/**
 * Offset a closed 2D polygon outward by `offset`. Outward = away from the
 * polygon's own interior, determined by signed area. Each new vertex sits
 * on the miter bisector of the two adjacent edges at a distance that puts
 * both offset edges exactly `offset` units from the originals.
 *
 * Spikes are capped at MITER_LIMIT·|offset|: past that, we emit two bevel
 * points (one per edge normal) instead of the runaway miter.
 */
const OFFSET_MITER_LIMIT = 4;

function offsetClosedPolygon(points: THREE.Vector2[], offset: number): THREE.Vector2[] {
  if (points.length < 3 || offset === 0) return points.map((p) => p.clone());

  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    area += p.x * q.y - q.x * p.y;
  }
  // CCW (area > 0) → outward normal rotates edge by −90° (ey, −ex).
  // CW  (area < 0) → outward normal rotates by +90° (−ey, ex).
  const sign = area >= 0 ? 1 : -1;

  const n = points.length;
  const normals: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) {
      normals.push(new THREE.Vector2(0, 0));
    } else {
      normals.push(new THREE.Vector2((ey * sign) / len, (-ex * sign) / len));
    }
  }

  const result: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const curr = points[i];
    const nPrev = normals[(i - 1 + n) % n];
    const nNext = normals[i];
    const bx = nPrev.x + nNext.x;
    const by = nPrev.y + nNext.y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-6) {
      result.push(new THREE.Vector2(curr.x + nPrev.x * offset, curr.y + nPrev.y * offset));
      continue;
    }
    const bxn = bx / bl;
    const byn = by / bl;
    const cosHalf = bxn * nPrev.x + byn * nPrev.y;
    const miterLen = offset / cosHalf;
    if (Math.abs(miterLen) > Math.abs(offset) * OFFSET_MITER_LIMIT) {
      result.push(new THREE.Vector2(curr.x + nPrev.x * offset, curr.y + nPrev.y * offset));
      result.push(new THREE.Vector2(curr.x + nNext.x * offset, curr.y + nNext.y * offset));
    } else {
      result.push(new THREE.Vector2(curr.x + bxn * miterLen, curr.y + byn * miterLen));
    }
  }
  return result;
}

// Max miter length as a multiple of |offset|. At sharp concave corners or
// edges that have nearly-inverted under a big shrink, cosHalf → 0 and the
// raw miter shoots off to infinity. Clamping keeps vertex count stable
// (so ring pairs still align by index) while preventing spike artifacts;
// tight concave features just flatten slightly at extreme insets.
// 1.5 flattens corners once the natural miter exceeds 1.5× the offset
// (turns tighter than ~83°). Above that, rounded-arc sampling starts
// producing per-sample clamped miters that read as short outward spikes
// on the enamel dome surface at every corner of the hole outline.
const STRICT_MITER_LIMIT = 1.5;

/**
 * Strict 1:1 miter offset — preserves vertex count even at sharp corners,
 * which the concave-dome builder needs so corresponding ring vertices can
 * be paired by index. Miter length is clamped (no bevel insertion, since
 * the count must stay fixed), which slightly rounds off sharp features at
 * extreme offsets but eliminates infinite spikes.
 */
function offsetMiterStrict(points: THREE.Vector2[], offset: number): THREE.Vector2[] {
  if (points.length < 3 || offset === 0) return points.map((p) => p.clone());

  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    area += p.x * q.y - q.x * p.y;
  }
  const sign = area >= 0 ? 1 : -1;

  const n = points.length;
  const normals: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-9) {
      normals.push(new THREE.Vector2(0, 0));
    } else {
      normals.push(new THREE.Vector2((ey * sign) / len, (-ex * sign) / len));
    }
  }

  const result: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const curr = points[i];
    const nPrev = normals[(i - 1 + n) % n];
    const nNext = normals[i];
    const bx = nPrev.x + nNext.x;
    const by = nPrev.y + nNext.y;
    const bl = Math.hypot(bx, by);
    if (bl < 1e-6) {
      result.push(new THREE.Vector2(curr.x + nPrev.x * offset, curr.y + nPrev.y * offset));
      continue;
    }
    const cosHalf = (bx * nPrev.x + by * nPrev.y) / bl;
    let miterLen = offset / cosHalf;
    const miterCap = Math.abs(offset) * STRICT_MITER_LIMIT;
    if (miterLen > miterCap) miterLen = miterCap;
    else if (miterLen < -miterCap) miterLen = -miterCap;
    result.push(new THREE.Vector2(curr.x + (bx / bl) * miterLen, curr.y + (by / bl) * miterLen));
  }
  return result;
}

/**
 * Build a domed enamel fill: rim sits at Z=0 (flush with the flat enamel
 * plane), surface curves smoothly inward to a flat inset cap. Positive
 * `dome` dips the cap backward to Z=-dome (concave bowl); negative `dome`
 * pushes the cap forward to Z=+|dome| (convex dome). Ring inset grows
 * linearly with |dome|·t regardless of sign — same footprint profile, just
 * a different Z direction.
 *
 * Profile: quarter-circle parameterized by angle ∈ [0, π/2].
 *   inset(t) = |dome|·(1 − cos(angle)),  z(t) = ±|dome|·sin(angle)
 * At the rim (t=0, angle=0) the tangent is vertical — walls drop/rise
 * perpendicular to the plane, giving a crisp edge where the bowl meets
 * the frame. At the cap (t=1, angle=π/2) the tangent is horizontal — the
 * surface flattens into the cap face. That's the profile of a bowl's
 * inside wall curving into the base, rather than a horn flaring out.
 *
 * `outline` must be CCW. CCW winding yields outward-facing normals for
 * both sign conventions — see the triangle-order comment below.
 */
/** Ray-cast point-in-polygon test. Works on any winding. */
function pointInPolygon(p: THREE.Vector2, poly: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];
    if (
      pi.y > p.y !== pj.y > p.y &&
      p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function signedArea2D(pts: THREE.Vector2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a;
}

function polygonSelfIntersects(points: THREE.Vector2[]): boolean {
  const orient = (a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || j === i + 1 || (i === 0 && j === n - 1)) continue;
      const c = points[j];
      const d = points[(j + 1) % n];
      const abC = orient(a, b, c);
      const abD = orient(a, b, d);
      const cdA = orient(c, d, a);
      const cdB = orient(c, d, b);
      if (abC * abD < -1e-10 && cdA * cdB < -1e-10) return true;
    }
  }
  return false;
}

/**
 * SVGLoader.createShapes relies on authored subpath order and winding to
 * decide which contour is an outer shape and which is a hole. Logo exports
 * commonly put counters first (the Phillies P does), which can invert that
 * relationship and produce a long Earcut bridge across the artwork. Rebuild
 * the same exact Bezier paths into a containment tree instead: even-depth
 * contours are filled shapes and odd-depth contours are their holes.
 */
function createContainmentShapes(path: THREE.ShapePath): THREE.Shape[] {
  if (path.subPaths.length < 2) return SVGLoader.createShapes(path);

  type Contour = {
    path: THREE.Path;
    points: THREE.Vector2[];
    area: number;
    parent: number;
    depth: number;
  };

  const contours: Contour[] = path.subPaths
    .map((subPath) => {
      const sampled = subPath.getPoints(24) as THREE.Vector2[];
      const points = sampled.filter(
        (point, index) => index === 0 || point.distanceToSquared(sampled[index - 1]) > 1e-12,
      );
      return {
        path: subPath,
        points,
        area: Math.abs(signedArea2D(points)),
        parent: -1,
        depth: 0,
      };
    })
    .filter((contour) => contour.points.length >= 3 && contour.area > 1e-8)
    .sort((a, b) => b.area - a.area);

  for (let i = 0; i < contours.length; i++) {
    const sample = contours[i].points[0];
    let parent = -1;
    let parentArea = Infinity;
    for (let j = 0; j < i; j++) {
      if (contours[j].area < parentArea && pointInPolygon(sample, contours[j].points)) {
        parent = j;
        parentArea = contours[j].area;
      }
    }
    contours[i].parent = parent;
    contours[i].depth = parent < 0 ? 0 : contours[parent].depth + 1;
  }

  const cloneCurves = <T extends THREE.Path>(source: THREE.Path, target: T): T => {
    target.curves = source.curves.map((curve) => curve.clone());
    target.currentPoint.copy(source.currentPoint);
    target.autoClose = source.autoClose;
    return target;
  };

  const shapes = new Map<number, THREE.Shape>();
  for (let i = 0; i < contours.length; i++) {
    if (contours[i].depth % 2 === 0) {
      shapes.set(i, cloneCurves(contours[i].path, new THREE.Shape()));
    }
  }
  for (let i = 0; i < contours.length; i++) {
    if (contours[i].depth % 2 === 0) continue;
    let owner = contours[i].parent;
    while (owner >= 0 && contours[owner].depth % 2 !== 0) owner = contours[owner].parent;
    shapes.get(owner)?.holes.push(cloneCurves(contours[i].path, new THREE.Path()));
  }

  return [...shapes.values()];
}

function buildDomeGeometry(
  outline: THREE.Vector2[],
  holes: THREE.Vector2[][],
  dome: number,
  segments: number
): THREE.BufferGeometry | null {
  if (outline.length < 3 || Math.abs(dome) < 1e-6) return null;

  const nOuter = outline.length;
  const nHole = holes.map((h) => h.length);
  const totalPerRing = nOuter + nHole.reduce((a, b) => a + b, 0);

  const domeAbs = Math.abs(dome);
  // dome > 0 → concave (z goes negative); dome < 0 → convex (z goes positive).
  const zSign = dome >= 0 ? -1 : 1;

  // Any offset ring whose signed area drops below this threshold has
  // self-intersected (thin feature inverted under too-large a shrink) —
  // triangulating it would spray spikes across the scene. Freeze rings to
  // the last valid ring once that happens, so the cap just ends early
  // without geometry going wild.
  const origOuterArea = signedArea2D(outline);
  const minValidOuterArea = Math.abs(origOuterArea) * 0.02;

  const outerRings: THREE.Vector2[][] = [];
  const holeRings: THREE.Vector2[][][] = holes.map(() => []);
  const ringZ: number[] = [];

  let frozen = false;
  let lastOuter = outline.map((p) => p.clone());
  let lastHoles = holes.map((h) => h.map((p) => p.clone()));
  let lastValidZ = 0;

  for (let s = 0; s <= segments; s++) {
    const t = s / segments;
    const angle = (t * Math.PI) / 2;
    const insetDist = domeAbs * (1 - Math.cos(angle));
    const z = zSign * domeAbs * Math.sin(angle);

    let outerRing: THREE.Vector2[];
    let holeR: THREE.Vector2[][];
    let zUse: number;
    if (frozen) {
      outerRing = lastOuter.map((p) => p.clone());
      holeR = lastHoles.map((h) => h.map((p) => p.clone()));
      zUse = lastValidZ;
    } else if (s === 0) {
      outerRing = lastOuter.map((p) => p.clone());
      holeR = lastHoles.map((h) => h.map((p) => p.clone()));
      zUse = z;
      lastValidZ = z;
    } else {
      // Outer shrinks inward; holes grow outward. offsetMiterStrict resolves
      // "outward" per-polygon via signed area, so +insetDist grows whichever
      // winding the hole was passed in.
      const outerCand = offsetMiterStrict(outline, -insetDist);
      const holeCand = holes.map((h) => offsetMiterStrict(h, insetDist));
      const outerArea = signedArea2D(outerCand);
      const outerValid =
        outerCand.length === nOuter &&
        Math.sign(outerArea) === Math.sign(origOuterArea) &&
        Math.abs(outerArea) >= minValidOuterArea;
      const holesValid = holeCand.every((hc, i) => hc.length === nHole[i]);

      if (!outerValid || !holesValid) {
        frozen = true;
        outerRing = lastOuter.map((p) => p.clone());
        holeR = lastHoles.map((h) => h.map((p) => p.clone()));
        zUse = lastValidZ;
      } else {
        outerRing = outerCand;
        holeR = holeCand;
        zUse = z;
        lastOuter = outerCand.map((p) => p.clone());
        lastHoles = holeCand.map((h) => h.map((p) => p.clone()));
        lastValidZ = z;
      }
    }

    outerRings.push(outerRing);
    for (let h = 0; h < holes.length; h++) holeRings[h].push(holeR[h]);
    ringZ.push(zUse);
  }

  // Build walls and cap as separate geometries so each gets clean normals.
  // Keeping them as one indexed buffer forces the cap-wall junction vertices
  // to hold a single averaged normal, which mixes cap (+z) and wall (lateral)
  // directions. That averaged normal varies across the cap where earcut's
  // bridge triangles touch vertices influenced by different hole walls, so
  // the cap shades with visible triangulation seams. Rebuilding each surface
  // independently and merging (without a subsequent toCreasedNormals pass)
  // keeps each group's normals pure.
  const parts: THREE.BufferGeometry[] = [];

  const buildRingWall = (
    rings: THREE.Vector2[][],
    nV: number,
  ): THREE.BufferGeometry => {
    const pos = new Array((segments + 1) * nV * 3);
    for (let s = 0; s <= segments; s++) {
      const z = ringZ[s];
      for (let i = 0; i < nV; i++) {
        const idx = (s * nV + i) * 3;
        pos[idx] = rings[s][i].x;
        pos[idx + 1] = rings[s][i].y;
        pos[idx + 2] = z;
      }
    }
    const ix: number[] = [];
    for (let s = 0; s < segments; s++) {
      const rowA = s * nV;
      const rowB = (s + 1) * nV;
      for (let i = 0; i < nV; i++) {
        const j = (i + 1) % nV;
        // CCW order for outer polygons (outward normal); same order on a CW
        // polygon (hole) produces a normal flipped into the hole interior,
        // which is what we want for hole walls.
        ix.push(rowA + i, rowA + j, rowB + j);
        ix.push(rowA + i, rowB + j, rowB + i);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(ix);
    g.computeVertexNormals();
    return g;
  };

  parts.push(buildRingWall(outerRings, nOuter));
  for (let h = 0; h < holes.length; h++) {
    parts.push(buildRingWall(holeRings[h], nHole[h]));
  }

  // Cap: let ShapeGeometry own both the triangulation and its flattened
  // vertex buffer. Rebuilding the buffer independently from Earcut's indices
  // can shift every hole index when a closed contour drops its duplicate end
  // point, producing a long missing wedge across compound logo artwork.
  const capOuter = outerRings[segments];
  const capHoles = holeRings.map((hr) => hr[segments]);
  const capShape = new THREE.Shape(capOuter);
  for (const holePoints of capHoles) {
    capShape.holes.push(new THREE.Path(holePoints));
  }
  const capGeo = new THREE.ShapeGeometry(capShape);
  capGeo.translate(0, 0, ringZ[segments]);
  capGeo.deleteAttribute("uv");
  capGeo.computeVertexNormals();
  parts.push(capGeo);

  return mergeGeometries(parts);
}

/**
 * Split every triangle into 4 by inserting midpoints on each edge, repeated
 * `iterations` times. Needed before applying a displacement map — the GPU
 * only moves vertices that actually exist, so a coarse cap would yield a
 * handful of lumps instead of crumb-scale relief. Quadruples triangle count
 * per iteration. UVs and normals are linearly interpolated at midpoints.
 *
 * Non-indexed input assumed — what ExtrudeGeometry produces.
 */
function subdivideGeometry(
  geo: THREE.BufferGeometry,
  iterations: number,
): THREE.BufferGeometry {
  let current = geo.index ? geo.toNonIndexed() : geo;
  for (let iter = 0; iter < iterations; iter++) {
    const pos = current.attributes.position as THREE.BufferAttribute;
    const uv = current.attributes.uv as THREE.BufferAttribute | undefined;
    const nrm = current.attributes.normal as THREE.BufferAttribute | undefined;
    const triCount = (pos.count / 3) | 0;
    const newPos = new Float32Array(triCount * 4 * 3 * 3);
    const newUv = uv ? new Float32Array(triCount * 4 * 3 * 2) : null;
    const newNrm = nrm ? new Float32Array(triCount * 4 * 3 * 3) : null;
    let pi = 0;
    let ui = 0;
    let ni = 0;
    const emitVert = (
      px: number, py: number, pz: number,
      ux: number, uy: number,
      nx: number, ny: number, nz: number,
    ) => {
      newPos[pi++] = px;
      newPos[pi++] = py;
      newPos[pi++] = pz;
      if (newUv) {
        newUv[ui++] = ux;
        newUv[ui++] = uy;
      }
      if (newNrm) {
        newNrm[ni++] = nx;
        newNrm[ni++] = ny;
        newNrm[ni++] = nz;
      }
    };
    for (let t = 0; t < triCount; t++) {
      const i0 = t * 3;
      const i1 = t * 3 + 1;
      const i2 = t * 3 + 2;
      const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
      const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
      const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);
      const aux = uv ? uv.getX(i0) : 0, auy = uv ? uv.getY(i0) : 0;
      const bux = uv ? uv.getX(i1) : 0, buy = uv ? uv.getY(i1) : 0;
      const cux = uv ? uv.getX(i2) : 0, cuy = uv ? uv.getY(i2) : 0;
      const anx = nrm ? nrm.getX(i0) : 0, any = nrm ? nrm.getY(i0) : 0, anz = nrm ? nrm.getZ(i0) : 0;
      const bnx = nrm ? nrm.getX(i1) : 0, bny = nrm ? nrm.getY(i1) : 0, bnz = nrm ? nrm.getZ(i1) : 0;
      const cnx = nrm ? nrm.getX(i2) : 0, cny = nrm ? nrm.getY(i2) : 0, cnz = nrm ? nrm.getZ(i2) : 0;
      const abx = (ax + bx) * 0.5, aby = (ay + by) * 0.5, abz = (az + bz) * 0.5;
      const bcx = (bx + cx) * 0.5, bcy = (by + cy) * 0.5, bcz = (bz + cz) * 0.5;
      const cax = (cx + ax) * 0.5, cay = (cy + ay) * 0.5, caz = (cz + az) * 0.5;
      const abu = (aux + bux) * 0.5, abv = (auy + buy) * 0.5;
      const bcu = (bux + cux) * 0.5, bcv = (buy + cuy) * 0.5;
      const cau = (cux + aux) * 0.5, cav = (cuy + auy) * 0.5;
      const abnx = (anx + bnx) * 0.5, abny = (any + bny) * 0.5, abnz = (anz + bnz) * 0.5;
      const bcnx = (bnx + cnx) * 0.5, bcny = (bny + cny) * 0.5, bcnz = (bnz + cnz) * 0.5;
      const canx = (cnx + anx) * 0.5, cany = (cny + any) * 0.5, canz = (cnz + anz) * 0.5;
      // 4 sub-triangles: corner A, corner B, corner C, center.
      emitVert(ax, ay, az, aux, auy, anx, any, anz);
      emitVert(abx, aby, abz, abu, abv, abnx, abny, abnz);
      emitVert(cax, cay, caz, cau, cav, canx, cany, canz);

      emitVert(abx, aby, abz, abu, abv, abnx, abny, abnz);
      emitVert(bx, by, bz, bux, buy, bnx, bny, bnz);
      emitVert(bcx, bcy, bcz, bcu, bcv, bcnx, bcny, bcnz);

      emitVert(cax, cay, caz, cau, cav, canx, cany, canz);
      emitVert(bcx, bcy, bcz, bcu, bcv, bcnx, bcny, bcnz);
      emitVert(cx, cy, cz, cux, cuy, cnx, cny, cnz);

      emitVert(abx, aby, abz, abu, abv, abnx, abny, abnz);
      emitVert(bcx, bcy, bcz, bcu, bcv, bcnx, bcny, bcnz);
      emitVert(cax, cay, caz, cau, cav, canx, cany, canz);
    }
    const next = new THREE.BufferGeometry();
    next.setAttribute("position", new THREE.BufferAttribute(newPos, 3));
    if (newUv) next.setAttribute("uv", new THREE.BufferAttribute(newUv, 2));
    if (newNrm) next.setAttribute("normal", new THREE.BufferAttribute(newNrm, 3));
    current = next;
  }
  return current;
}

/**
 * Repeatedly split any triangle whose longest edge exceeds `maxEdgeLen`.
 * Unlike `subdivideGeometry`'s uniform 4-way split, this targets only the
 * long edges produced by earcut's sliver triangles — so the final mesh ends
 * up with roughly uniform triangle size, which is what kills the visible
 * fan pattern when a heightmap is applied to the cap.
 */
function refineLongEdges(
  geo: THREE.BufferGeometry,
  maxEdgeLen: number,
  maxPasses = 6,
): THREE.BufferGeometry {
  let current = geo.index ? geo.toNonIndexed() : geo;
  const maxSq = maxEdgeLen * maxEdgeLen;
  for (let pass = 0; pass < maxPasses; pass++) {
    const pos = current.attributes.position as THREE.BufferAttribute;
    const uv = current.attributes.uv as THREE.BufferAttribute | undefined;
    const nrm = current.attributes.normal as THREE.BufferAttribute | undefined;
    const triCount = (pos.count / 3) | 0;
    const outPos: number[] = [];
    const outUv: number[] | null = uv ? [] : null;
    const outNrm: number[] | null = nrm ? [] : null;
    let didSplit = false;
    for (let t = 0; t < triCount; t++) {
      const i0 = t * 3, i1 = t * 3 + 1, i2 = t * 3 + 2;
      const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
      const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
      const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);
      const dAB = (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2;
      const dBC = (bx - cx) ** 2 + (by - cy) ** 2 + (bz - cz) ** 2;
      const dCA = (cx - ax) ** 2 + (cy - ay) ** 2 + (cz - az) ** 2;
      const maxD = Math.max(dAB, dBC, dCA);
      const au = uv ? uv.getX(i0) : 0, av = uv ? uv.getY(i0) : 0;
      const bu = uv ? uv.getX(i1) : 0, bv = uv ? uv.getY(i1) : 0;
      const cu = uv ? uv.getX(i2) : 0, cv = uv ? uv.getY(i2) : 0;
      const anx = nrm ? nrm.getX(i0) : 0, any = nrm ? nrm.getY(i0) : 0, anz = nrm ? nrm.getZ(i0) : 0;
      const bnx = nrm ? nrm.getX(i1) : 0, bny = nrm ? nrm.getY(i1) : 0, bnz = nrm ? nrm.getZ(i1) : 0;
      const cnx = nrm ? nrm.getX(i2) : 0, cny = nrm ? nrm.getY(i2) : 0, cnz = nrm ? nrm.getZ(i2) : 0;
      if (maxD <= maxSq) {
        outPos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
        if (outUv) outUv.push(au, av, bu, bv, cu, cv);
        if (outNrm) outNrm.push(anx, any, anz, bnx, bny, bnz, cnx, cny, cnz);
        continue;
      }
      didSplit = true;
      // Split only the longest edge; the opposite vertex plus its midpoint
      // forms two smaller triangles. Chained over passes this drives all
      // triangles toward roughly `maxEdgeLen`-scale without compounding
      // density on already-fine triangles.
      let p1x: number, p1y: number, p1z: number;
      let p2x: number, p2y: number, p2z: number;
      let p3x: number, p3y: number, p3z: number;
      let u1: number, v1: number, u2: number, v2: number, u3: number, v3: number;
      let n1x: number, n1y: number, n1z: number;
      let n2x: number, n2y: number, n2z: number;
      let n3x: number, n3y: number, n3z: number;
      if (maxD === dAB) {
        // edge AB, opposite C
        p1x = ax; p1y = ay; p1z = az;
        p2x = bx; p2y = by; p2z = bz;
        p3x = cx; p3y = cy; p3z = cz;
        u1 = au; v1 = av; u2 = bu; v2 = bv; u3 = cu; v3 = cv;
        n1x = anx; n1y = any; n1z = anz;
        n2x = bnx; n2y = bny; n2z = bnz;
        n3x = cnx; n3y = cny; n3z = cnz;
      } else if (maxD === dBC) {
        // edge BC, opposite A
        p1x = bx; p1y = by; p1z = bz;
        p2x = cx; p2y = cy; p2z = cz;
        p3x = ax; p3y = ay; p3z = az;
        u1 = bu; v1 = bv; u2 = cu; v2 = cv; u3 = au; v3 = av;
        n1x = bnx; n1y = bny; n1z = bnz;
        n2x = cnx; n2y = cny; n2z = cnz;
        n3x = anx; n3y = any; n3z = anz;
      } else {
        // edge CA, opposite B
        p1x = cx; p1y = cy; p1z = cz;
        p2x = ax; p2y = ay; p2z = az;
        p3x = bx; p3y = by; p3z = bz;
        u1 = cu; v1 = cv; u2 = au; v2 = av; u3 = bu; v3 = bv;
        n1x = cnx; n1y = cny; n1z = cnz;
        n2x = anx; n2y = any; n2z = anz;
        n3x = bnx; n3y = bny; n3z = bnz;
      }
      const mx = (p1x + p2x) * 0.5, my = (p1y + p2y) * 0.5, mz = (p1z + p2z) * 0.5;
      const mu = (u1 + u2) * 0.5, mv = (v1 + v2) * 0.5;
      const mnx = (n1x + n2x) * 0.5, mny = (n1y + n2y) * 0.5, mnz = (n1z + n2z) * 0.5;
      outPos.push(p1x, p1y, p1z, mx, my, mz, p3x, p3y, p3z);
      outPos.push(mx, my, mz, p2x, p2y, p2z, p3x, p3y, p3z);
      if (outUv) {
        outUv.push(u1, v1, mu, mv, u3, v3);
        outUv.push(mu, mv, u2, v2, u3, v3);
      }
      if (outNrm) {
        outNrm.push(n1x, n1y, n1z, mnx, mny, mnz, n3x, n3y, n3z);
        outNrm.push(mnx, mny, mnz, n2x, n2y, n2z, n3x, n3y, n3z);
      }
    }
    const next = new THREE.BufferGeometry();
    next.setAttribute("position", new THREE.BufferAttribute(new Float32Array(outPos), 3));
    if (outUv) next.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(outUv), 2));
    if (outNrm) next.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(outNrm), 3));
    current = next;
    if (!didSplit) break;
  }
  return current;
}

/**
 * Filter triangles of an extrude-produced geometry by whether every vertex of
 * the triangle sits at min Z. With `mode="keep"` only those triangles survive
 * (useful for extracting the back cap alone); with `mode="drop"` everything
 * else stays (useful for stripping the back cap and swapping in a solid one).
 *
 * Assumes non-indexed input — what `ExtrudeGeometry` produces directly.
 */
function filterMinZCapFaces(
  geo: THREE.BufferGeometry,
  mode: "keep" | "drop",
): THREE.BufferGeometry {
  const source = geo.index ? geo.toNonIndexed() : geo;
  source.computeBoundingBox();
  const bb = source.boundingBox!;
  const zRange = bb.max.z - bb.min.z;
  if (zRange < 1e-6) return source; // flat geo — nothing meaningful to partition
  const minZ = bb.min.z;
  const eps = Math.max(1e-4, zRange * 1e-4);

  const pos = source.attributes.position as THREE.BufferAttribute;
  const uv = source.attributes.uv as THREE.BufferAttribute | undefined;
  const normal = source.attributes.normal as THREE.BufferAttribute | undefined;

  const triCount = (pos.count / 3) | 0;
  const newPos: number[] = [];
  const newUv: number[] = [];
  const newNormal: number[] = [];

  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3;
    const atMin =
      Math.abs(pos.getZ(i0) - minZ) < eps &&
      Math.abs(pos.getZ(i0 + 1) - minZ) < eps &&
      Math.abs(pos.getZ(i0 + 2) - minZ) < eps;
    const keep = mode === "keep" ? atMin : !atMin;
    if (!keep) continue;
    for (let k = 0; k < 3; k++) {
      const idx = i0 + k;
      newPos.push(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
      if (uv) newUv.push(uv.getX(idx), uv.getY(idx));
      if (normal) newNormal.push(normal.getX(idx), normal.getY(idx), normal.getZ(idx));
    }
  }

  const result = new THREE.BufferGeometry();
  result.setAttribute("position", new THREE.Float32BufferAttribute(newPos, 3));
  if (uv) result.setAttribute("uv", new THREE.Float32BufferAttribute(newUv, 2));
  if (normal) result.setAttribute("normal", new THREE.Float32BufferAttribute(newNormal, 3));
  return result;
}

/**
 * Split an ExtrudeGeometry into three buckets: triangles whose vertices all
 * sit on min-Z (back cap), all on max-Z (front cap), and everything else
 * (walls + bevel). Used to keep the flat caps out of `toCreasedNormals`'
 * position-hash weld — otherwise the cap's boundary vertices get their
 * normals averaged with the top-of-wall ring and tilt outward, and since the
 * cap is triangulated from boundary points only (no Steiner points), interior
 * triangulation edges become visible Gouraud seams on the flat face.
 */
function splitByZCaps(geo: THREE.BufferGeometry): {
  minCap: THREE.BufferGeometry | null;
  maxCap: THREE.BufferGeometry | null;
  walls: THREE.BufferGeometry;
} {
  const source = geo.index ? geo.toNonIndexed() : geo;
  source.computeBoundingBox();
  const bb = source.boundingBox!;
  const zRange = bb.max.z - bb.min.z;
  if (zRange < 1e-6) return { minCap: null, maxCap: null, walls: source };
  const eps = Math.max(1e-4, zRange * 1e-4);
  const zMin = bb.min.z;
  const zMax = bb.max.z;

  const pos = source.attributes.position as THREE.BufferAttribute;
  const uv = source.attributes.uv as THREE.BufferAttribute | undefined;

  type Bucket = { pos: number[]; uv: number[] };
  const mk = (): Bucket => ({ pos: [], uv: [] });
  const bMin = mk(), bMax = mk(), bWalls = mk();

  const triCount = (pos.count / 3) | 0;
  for (let t = 0; t < triCount; t++) {
    const i0 = t * 3;
    const z0 = pos.getZ(i0);
    const z1 = pos.getZ(i0 + 1);
    const z2 = pos.getZ(i0 + 2);
    const atMin =
      Math.abs(z0 - zMin) < eps &&
      Math.abs(z1 - zMin) < eps &&
      Math.abs(z2 - zMin) < eps;
    const atMax =
      !atMin &&
      Math.abs(z0 - zMax) < eps &&
      Math.abs(z1 - zMax) < eps &&
      Math.abs(z2 - zMax) < eps;
    const bucket = atMin ? bMin : atMax ? bMax : bWalls;
    for (let k = 0; k < 3; k++) {
      const idx = i0 + k;
      bucket.pos.push(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
      if (uv) bucket.uv.push(uv.getX(idx), uv.getY(idx));
    }
  }

  const toGeo = (b: Bucket): THREE.BufferGeometry | null => {
    if (b.pos.length === 0) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
    if (uv) g.setAttribute("uv", new THREE.Float32BufferAttribute(b.uv, 2));
    return g;
  };

  return {
    minCap: toGeo(bMin),
    maxCap: toGeo(bMax),
    walls: toGeo(bWalls)!,
  };
}

function windingSignOf(curves: Curve[]): number {
  // Shoelace area from segment starts; positive = CCW.
  const pts: THREE.Vector2[] = [];
  for (const c of curves) pts.push(getCurveStart(c));
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    area += p.x * q.y - q.x * p.y;
  }
  return area >= 0 ? 1 : -1;
}

/** Emit a curve into a Shape or Path, preserving its type. */
function emitCurve(path: THREE.Shape | THREE.Path, curve: Curve) {
  if (isLine(curve)) {
    const end = getCurveEnd(curve);
    path.lineTo(end.x, end.y);
  } else if (isQuadratic(curve)) {
    path.quadraticCurveTo(curve.v1.x, curve.v1.y, curve.v2.x, curve.v2.y);
  } else if (isCubic(curve)) {
    path.bezierCurveTo(curve.v1.x, curve.v1.y, curve.v2.x, curve.v2.y, curve.v3.x, curve.v3.y);
  } else {
    const pts = curve.getPoints(32);
    for (let j = 1; j < pts.length; j++) {
      path.lineTo(pts[j].x, pts[j].y);
    }
  }
}

/**
 * Emit the [t0, t1] portion of a curve, preserving bezier/line type so the
 * result tessellates as one smooth curve instead of a line fan.
 */
function emitCurvePortion(
  path: THREE.Shape | THREE.Path,
  curve: Curve,
  t0: number, t1: number,
  fallbackSamples: number
) {
  if (t1 - t0 < 1e-6) return;

  if (t0 <= 1e-6 && t1 >= 1 - 1e-6) {
    emitCurve(path, curve);
    return;
  }

  if (isLine(curve)) {
    const end = curve.v1.clone().lerp(curve.v2, t1);
    path.lineTo(end.x, end.y);
    return;
  }
  if (isCubic(curve)) {
    const sub = subCubic(curve.v0, curve.v1, curve.v2, curve.v3, t0, t1);
    path.bezierCurveTo(sub[1].x, sub[1].y, sub[2].x, sub[2].y, sub[3].x, sub[3].y);
    return;
  }
  if (isQuadratic(curve)) {
    const sub = subQuadratic(curve.v0, curve.v1, curve.v2, t0, t1);
    path.quadraticCurveTo(sub[1].x, sub[1].y, sub[2].x, sub[2].y);
    return;
  }

  // Generic fallback: sample as a line chain.
  for (let s = 1; s <= fallbackSamples; s++) {
    const t = t0 + (s / fallbackSamples) * (t1 - t0);
    const pt = curve.getPoint(t);
    path.lineTo(pt.x, pt.y);
  }
}

/**
 * Round corners of a closed curve path. Pre-computes each junction's arc,
 * then emits every neighbor trimmed parametrically (bezier stays bezier),
 * followed by the circular arc itself as an EllipseCurve.
 */
function roundCurvePath(
  target: THREE.Shape | THREE.Path,
  curves: Curve[],
  convexRadius: number,
  innerRadius: number,
  reflexMiterSafetyR: number,
  minEffectiveRadius: number,
  fallbackSamples: number
) {
  const n = curves.length;
  if (n < 2) {
    const start = getCurveStart(curves[0]);
    target.moveTo(start.x, start.y);
    emitCurve(target, curves[0]);
    return;
  }

  const winding = windingSignOf(curves);

  const roundings: (CornerRounding | null)[] = [];
  for (let i = 0; i < n; i++) {
    roundings.push(
      getCornerRounding(
        curves[i],
        curves[(i + 1) % n],
        convexRadius,
        innerRadius,
        reflexMiterSafetyR,
        minEffectiveRadius,
        winding,
      ),
    );
  }

  // Wrap junction is roundings[n-1]. If it rounds, the path starts at the
  // arc's exit point on curves[0]; otherwise at curves[0]'s raw start.
  const wrap = roundings[n - 1];
  const startPt = wrap ? curves[0].getPoint(wrap.tStartOnNext) : getCurveStart(curves[0]);
  target.moveTo(startPt.x, startPt.y);

  for (let i = 0; i < n; i++) {
    const curr = curves[i];
    const endRounding = roundings[i];
    const startRounding = roundings[(i - 1 + n) % n];

    const t0 = startRounding ? startRounding.tStartOnNext : 0;
    const t1 = endRounding ? endRounding.tEndOnCurr : 1;

    if (t1 > t0 + 1e-6) {
      emitCurvePortion(target, curr, t0, t1, fallbackSamples);
    }

    if (endRounding) {
      target.absarc(
        endRounding.cx, endRounding.cy,
        endRounding.radius,
        endRounding.startAngle, endRounding.endAngle,
        endRounding.clockwise
      );
    }
  }
}

/**
 * Round the corners of a shape. Each convex junction gets a true circular
 * arc (EllipseCurve), and each neighbor is parametrically trimmed so Figma
 * cubics survive through ExtrudeGeometry instead of collapsing into dense
 * line fans. The per-corner edge-length clamp (inside getCornerRounding)
 * prevents one short edge from killing rounding elsewhere on the path.
 */
function roundShapeCorners(
  shape: THREE.Shape,
  outerConvexRadius: number,
  holeConvexRadius: number,
  innerRadius: number,
  reflexMiterSafetyR: number,
  minEffectiveRadius: number,
  fallbackSamples: number = 48,
): THREE.Shape {
  if (
    outerConvexRadius <= 0 &&
    holeConvexRadius <= 0 &&
    innerRadius <= 0 &&
    reflexMiterSafetyR <= 0
  )
    return shape;
  if (shape.curves.length < 2) return shape;

  const rounded = new THREE.Shape();
  roundCurvePath(
    rounded,
    shape.curves as Curve[],
    outerConvexRadius,
    innerRadius,
    reflexMiterSafetyR,
    minEffectiveRadius,
    fallbackSamples,
  );

  if (shape.holes) {
    for (const hole of shape.holes) {
      if (hole.curves.length < 2) {
        rounded.holes.push(hole);
        continue;
      }
      const roundedHole = new THREE.Path();
      roundCurvePath(
        roundedHole,
        hole.curves as Curve[],
        holeConvexRadius,
        innerRadius,
        reflexMiterSafetyR,
        minEffectiveRadius,
        fallbackSamples,
      );
      rounded.holes.push(roundedHole);
    }
  }

  return rounded;
}

interface ExtrudedSVGProps {
  svgString: string;
  extrudeDepth: number;
  bevelEnabled: boolean;
  bevelThickness: number;
  bevelSize: number;
  bevelSegments: number;
  bevelOffset: number;
  curveSegments: number;
  pathResolution: number;
  cornerRadiusOn: boolean;
  cornerRadius: number;
  outerCornerRadius: number;
  innerCornerRadius: number;
  solidify: boolean;
  solidBack: boolean;
  inflation: number;
  extrudeSteps: number;
  smoothShading: boolean;
  creaseAngle: number;
  color: string;
  roughness: number;
  metalness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  envMapIntensity: number;
  transmission: number;
  thickness: number;
  ior: number;
  dispersion: number;
  normalMapOn: boolean;
  normalMapType: string;
  normalScale: number;
  displacementScale: number;
  displacementBias: number;
  uvMap: {
    offsetX: number;
    offsetY: number;
    repeatX: number;
    repeatY: number;
    rotation: number;
    centerX: number;
    centerY: number;
    wrapS: string;
    wrapT: string;
  };
  enamelOn: boolean;
  enamelColor: string;
  enamelOffset: number;
  enamelDome: number;
  enamelZ: number;
  enamelRoughness: number;
  enamelMetalness: number;
  enamelClearcoat: number;
  enamelClearcoatRoughness: number;
  enamelEnvMapIntensity: number;
  rotation: [number, number, number];
  envMapRotation?: number;
  scale: number;
  wireframe?: boolean;
  flipNonce?: number;
  fur?: {
    furOn: boolean;
    furCount: number;
    furLength: number;
    furWidth: number;
    furTipTaper: number;
    furLengthVariation: number;
    furFluff: number;
    furBevelBoost: number;
    furSegments: number;
    furColorBase: string;
    furColorTip: string;
    furRoughness: number;
    furMetalness: number;
    furWindStrength: number;
    furWindSpeed: number;
    furWindFreq: number;
    furWindDirX: number;
    furWindDirZ: number;
    furStiffness: number;
    furGravity: number;
    furInertia: number;
    furInertiaResponse: number;
    furCursorOn: boolean;
    furCursorRadius: number;
    furCursorStrength: number;
  };
}

export default function ExtrudedSVG({
  svgString,
  extrudeDepth,
  bevelEnabled,
  bevelThickness,
  bevelSize,
  bevelSegments,
  bevelOffset,
  curveSegments,
  pathResolution,
  cornerRadiusOn,
  cornerRadius,
  outerCornerRadius,
  innerCornerRadius,
  solidify,
  solidBack,
  inflation,
  extrudeSteps,
  smoothShading,
  creaseAngle,
  color,
  roughness,
  metalness,
  clearcoat,
  clearcoatRoughness,
  envMapIntensity,
  transmission,
  thickness,
  ior,
  dispersion,
  normalMapOn,
  normalMapType,
  normalScale,
  displacementScale,
  displacementBias,
  uvMap,
  enamelOn,
  enamelColor,
  enamelOffset,
  enamelDome,
  enamelZ,
  enamelRoughness,
  enamelMetalness,
  enamelClearcoat,
  enamelClearcoatRoughness,
  enamelEnvMapIntensity,
  rotation,
  envMapRotation = 0,
  scale,
  wireframe,
  flipNonce = 0,
  fur,
}: ExtrudedSVGProps) {
  const { geometry, enamelGeometry, colorEnamelLayers } = useMemo<{
    geometry: THREE.BufferGeometry | null;
    enamelGeometry: THREE.BufferGeometry | null;
    colorEnamelLayers: { geometry: THREE.BufferGeometry; color: string }[];
  }>(() => {
    const loader = new SVGLoader();
    const svgData = loader.parse(svgString);
    const shapes: THREE.Shape[] = [];
    const parsedPaths = svgData.paths.map((path, order) => {
      const node = path.userData?.node as Element | undefined;
      const style = path.userData?.style as { fill?: string; fillOpacity?: number } | undefined;
      const roleNode = node?.closest("[data-enamel-role]");
      const metalBaseNode = node?.closest('[data-metal-base="true"]');
      const authoredRole = roleNode?.getAttribute("data-enamel-role");
      const enamelRole =
        node?.getAttribute("data-enamel") ??
        (authoredRole === "fill" ? "true" : authoredRole === "base" ? "false" : null);
      const isMetalBase =
        Boolean(metalBaseNode) || authoredRole === "base";
      const isFilled = style?.fill !== "none" && (style?.fillOpacity ?? 1) > 0;
      const authoredMetalOffset = Number(metalBaseNode?.getAttribute("data-metal-offset") ?? 0);
      let pathShapes = createContainmentShapes(path);
      if (isMetalBase && Number.isFinite(authoredMetalOffset) && authoredMetalOffset !== 0) {
        pathShapes = pathShapes.map((shape) => {
          const sampled = shape.getPoints(curveSegments) as THREE.Vector2[];
          const points = sampled.filter(
            (point, index) => index === 0 || point.distanceToSquared(sampled[index - 1]) > 1e-12,
          );
          if (points.length > 1 && points[0].distanceToSquared(points[points.length - 1]) < 1e-12) {
            points.pop();
          }
          const offset = offsetClosedPolygon(points, authoredMetalOffset);
          return new THREE.Shape(offset);
        });
      }
      return {
        path,
        order,
        shapes: pathShapes,
        color: `#${path.color.getHexString()}`,
        enamelRole,
        isMetalBase,
        isFilled,
      };
    });
    const hasExplicitMetalBase = parsedPaths.some((entry) => entry.isMetalBase);
    const hasExplicitEnamel = parsedPaths.some((entry) => entry.enamelRole === "true");
    const palette = new Set(
      parsedPaths
        .filter((entry) => entry.isFilled && !entry.isMetalBase && entry.enamelRole !== "false")
        .map((entry) => entry.color),
    );
    const hasColorEnamel = enamelOn && (hasExplicitEnamel || palette.size > 1);
    const colorLayerSources = parsedPaths.filter((entry) => {
      if (!hasColorEnamel || !entry.isFilled || entry.isMetalBase) return false;
      if (entry.enamelRole === "false") return false;
      return hasExplicitEnamel ? entry.enamelRole === "true" : true;
    });

    parsedPaths.forEach(({ path, shapes: pathShapes, isMetalBase }) => {
      // Fix inconsistent hole winding from SVGLoader's evenodd parsing.
      // All holes must have opposite winding to the outer shape.
      for (const s of pathShapes) {
        const outerArea = THREE.ShapeUtils.area(s.getPoints(12));
        const outerCW = outerArea < 0;
        for (const hole of s.holes || []) {
          const holeArea = THREE.ShapeUtils.area(hole.getPoints(12));
          const holeCW = holeArea < 0;
          if (holeCW === outerCW) {
            // Same winding as outer — need to reverse.
            hole.curves.reverse();
            for (const curve of hole.curves) reverseCurveInPlace(curve as Curve);
          }
        }
      }

      if (hasExplicitMetalBase && !isMetalBase) return;
      shapes.push(...pathShapes);
    });

    // Explicit layered pin artwork uses the base silhouette as the metal
    // plate and each enamel path as a true opening in that plate. Nested
    // holes inside an enamel path (for example the baseball) are restored as
    // separate metal islands so they stay connected visually to the frame.
    const hasRecessedColorWells = hasExplicitMetalBase && hasColorEnamel;
    const recessedColorRegions: {
      sourceOrder: number;
      metalShapeIndex: number;
      metalHoleIndex: number;
      islandShapeIndices: number[];
    }[] = [];
    if (hasRecessedColorWells) {
      const metalBases = [...shapes];
      const boundsOf = (points: THREE.Vector2[]) => {
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const point of points) {
          minX = Math.min(minX, point.x);
          maxX = Math.max(maxX, point.x);
          minY = Math.min(minY, point.y);
          maxY = Math.max(maxY, point.y);
        }
        return { minX, maxX, minY, maxY };
      };
      const baseRecords = metalBases.map((shape, shapeIndex) => {
        const points = shape.getPoints(curveSegments) as THREE.Vector2[];
        return {
          shape,
          shapeIndex,
          bounds: boundsOf(points),
          winding: Math.sign(signedArea2D(points)) || 1,
        };
      });

      for (const source of colorLayerSources) {
        for (const sourceShape of source.shapes) {
          const outer = sourceShape.getPoints(curveSegments) as THREE.Vector2[];
          if (outer.length < 3) continue;
          const regionBounds = boundsOf(outer);
          // Pick the tightest containing metal, so enamel nested inside an
          // earlier layer's island (the Cubs C inside the blue ring) is cut
          // from that island rather than from the outer plate beneath it.
          const boundsArea = ({ minX, maxX, minY, maxY }: ReturnType<typeof boundsOf>) =>
            (maxX - minX) * (maxY - minY);
          const owner = baseRecords
            .filter(({ bounds }) =>
              regionBounds.minX >= bounds.minX &&
              regionBounds.maxX <= bounds.maxX &&
              regionBounds.minY >= bounds.minY &&
              regionBounds.maxY <= bounds.maxY,
            )
            .sort((a, b) => boundsArea(a.bounds) - boundsArea(b.bounds))[0];
          if (!owner) continue;

          const reverseOuter =
            (Math.sign(signedArea2D(outer)) || 1) === owner.winding;
          const metalHoleIndex = owner.shape.holes.length;
          owner.shape.holes.push(cloneCurvePath(sourceShape, reverseOuter));

          const islandShapeIndices: number[] = [];
          for (const sourceHole of sourceShape.holes || []) {
            const islandPoints = sourceHole.getPoints(curveSegments) as THREE.Vector2[];
            if (islandPoints.length < 3) continue;
            const reverseIsland =
              (Math.sign(signedArea2D(islandPoints)) || 1) !== owner.winding;
            const island = cloneCurvePath(sourceHole, reverseIsland, true);
            islandShapeIndices.push(shapes.length);
            baseRecords.push({
              shape: island,
              shapeIndex: shapes.length,
              bounds: boundsOf(islandPoints),
              winding: owner.winding,
            });
            shapes.push(island);
          }

          recessedColorRegions.push({
            sourceOrder: source.order,
            metalShapeIndex: owner.shapeIndex,
            metalHoleIndex,
            islandShapeIndices,
          });
        }
      }
    }

    if (shapes.length === 0) {
      return { geometry: null, enamelGeometry: null, colorEnamelLayers: [] };
    }

    // Clean up pathological curves without polygonizing. Operates on
    // shape.curves in-place so real béziers survive to ExtrudeGeometry and
    // render smoothly at curveSegments resolution.
    //
    // 1. Flatten near-straight cubics and quadratics to LineCurves. Figma
    //    encodes straight edges as cubics with collinear control points;
    //    ExtrudeGeometry would otherwise sample them into runs of collinear
    //    vertices, and under bevelOffset each gets its own miter normal,
    //    producing stair-step notches on what should be a flat edge.
    // 2. Drop zero-length curves.
    // 3. Merge adjacent collinear LineCurves into one. Prevents phantom miter
    //    vertices at joins that happen to be collinear (including the wrap
    //    junction of closed paths).
    //
    // Flatness is measured as perpendicular distance from a CP to the chord,
    // relative to chord length. 1e-4 catches Figma's coord drift (CPs rounded
    // to ~4 decimals, perp/chord ≈ 1e-5 in the worst case) without touching
    // visibly-curved cubics.
    const FLATNESS_RATIO = 1e-4;
    const MERGE_ANGLE_EPS = 1e-4;

    function perpDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number, chordLen: number): number {
      return Math.abs((px - ax) * (by - ay) - (py - ay) * (bx - ax)) / chordLen;
    }

    function cleanPath(pathObj: THREE.Shape | THREE.Path) {
      const curves = pathObj.curves;

      // 1. Flatten degenerate béziers
      for (let i = 0; i < curves.length; i++) {
        const c = curves[i];
        if ((c as any).isCubicBezierCurve) {
          const cc = c as THREE.CubicBezierCurve;
          const chordLen = cc.v0.distanceTo(cc.v3);
          if (chordLen < 1e-9) continue;
          const tol = chordLen * FLATNESS_RATIO;
          const d1 = perpDistance(cc.v1.x, cc.v1.y, cc.v0.x, cc.v0.y, cc.v3.x, cc.v3.y, chordLen);
          const d2 = perpDistance(cc.v2.x, cc.v2.y, cc.v0.x, cc.v0.y, cc.v3.x, cc.v3.y, chordLen);
          if (d1 < tol && d2 < tol) {
            curves[i] = new THREE.LineCurve(cc.v0.clone(), cc.v3.clone());
          }
        } else if ((c as any).isQuadraticBezierCurve) {
          const qc = c as THREE.QuadraticBezierCurve;
          const chordLen = qc.v0.distanceTo(qc.v2);
          if (chordLen < 1e-9) continue;
          const tol = chordLen * FLATNESS_RATIO;
          const d1 = perpDistance(qc.v1.x, qc.v1.y, qc.v0.x, qc.v0.y, qc.v2.x, qc.v2.y, chordLen);
          if (d1 < tol) {
            curves[i] = new THREE.LineCurve(qc.v0.clone(), qc.v2.clone());
          }
        }
      }

      // 2. Drop zero-length curves
      const filtered = curves.filter((c) => {
        const a = c.getPoint(0);
        const b = c.getPoint(1);
        return a.distanceTo(b) > 1e-6;
      });

      // 3. Merge consecutive collinear LineCurves
      const merged: Curve[] = [];
      for (const c of filtered) {
        const last = merged[merged.length - 1];
        if (last && (last as any).isLineCurve && (c as any).isLineCurve) {
          const l1 = last as THREE.LineCurve;
          const l2 = c as THREE.LineCurve;
          const d1x = l1.v2.x - l1.v1.x;
          const d1y = l1.v2.y - l1.v1.y;
          const d2x = l2.v2.x - l2.v1.x;
          const d2y = l2.v2.y - l2.v1.y;
          const cross = d1x * d2y - d1y * d2x;
          const dot = d1x * d2x + d1y * d2y;
          const turn = Math.atan2(Math.abs(cross), dot);
          if (turn < MERGE_ANGLE_EPS && dot > 0) {
            l1.v2.copy(l2.v2);
            continue;
          }
        }
        merged.push(c);
      }

      // Wrap-around merge for closed paths
      if (merged.length >= 2) {
        const first = merged[0];
        const last = merged[merged.length - 1];
        if ((first as any).isLineCurve && (last as any).isLineCurve) {
          const l1 = last as THREE.LineCurve;
          const l2 = first as THREE.LineCurve;
          if (l1.v2.distanceTo(l2.v1) < 1e-6) {
            const d1x = l1.v2.x - l1.v1.x;
            const d1y = l1.v2.y - l1.v1.y;
            const d2x = l2.v2.x - l2.v1.x;
            const d2y = l2.v2.y - l2.v1.y;
            const cross = d1x * d2y - d1y * d2x;
            const dot = d1x * d2x + d1y * d2y;
            const turn = Math.atan2(Math.abs(cross), dot);
            if (turn < MERGE_ANGLE_EPS && dot > 0) {
              l2.v1.copy(l1.v1);
              merged.pop();
            }
          }
        }
      }

      pathObj.curves = merged;
      if (merged.length > 0) {
        (pathObj as any).currentPoint = merged[merged.length - 1].getPoint(1).clone();
      }
    }

    for (const s of shapes) {
      cleanPath(s);
      for (const h of s.holes || []) {
        cleanPath(h);
      }
    }

    // Controls were authored against the original 24-unit icon library.
    // Scale all source-space dimensions to the uploaded SVG's coordinate
    // system so a 24-wide icon and a 2400-wide team logo produce the same
    // physical depth, bevel, rounding, and enamel dome after normalization.
    let sourceMinX = Infinity;
    let sourceMaxX = -Infinity;
    let sourceMinY = Infinity;
    let sourceMaxY = -Infinity;
    for (const shape of shapes) {
      for (const point of shape.getPoints(32)) {
        sourceMinX = Math.min(sourceMinX, point.x);
        sourceMaxX = Math.max(sourceMaxX, point.x);
        sourceMinY = Math.min(sourceMinY, point.y);
        sourceMaxY = Math.max(sourceMaxY, point.y);
      }
    }
    const sourceSize = Math.max(sourceMaxX - sourceMinX, sourceMaxY - sourceMinY) || 24;
    const sourceUnitScale = sourceSize / 24;
    const scaledExtrudeDepth = extrudeDepth * sourceUnitScale;
    const scaledBevelThickness = bevelThickness * sourceUnitScale;
    const scaledBevelSize = bevelSize * sourceUnitScale;
    const scaledBevelOffset = bevelOffset * sourceUnitScale;
    const scaledEnamelDome = enamelDome * sourceUnitScale;

    // Simplify shapes to lower-res polygons when pathResolution is reduced
    const simplifiedShapes =
      pathResolution < 12
        ? shapes.map((s) => {
            const pts = s.getPoints(pathResolution);
            const simplified = new THREE.Shape();
            simplified.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) {
              simplified.lineTo(pts[i].x, pts[i].y);
            }
            if (s.holes) {
              for (const hole of s.holes) {
                const hPts = hole.getPoints(pathResolution);
                const sHole = new THREE.Path();
                sHole.moveTo(hPts[0].x, hPts[0].y);
                for (let i = 1; i < hPts.length; i++) {
                  sHole.lineTo(hPts[i].x, hPts[i].y);
                }
                simplified.holes.push(sHole);
              }
            }
            return simplified;
          })
        : shapes;

    // Small floor so tiny arcs that tessellate into a near-point still get
    // skipped, but most refinement passes through.
    const cornerMinR = 0.1 * sourceUnitScale;
    // Respect the user's cornerRadiusOn opt-out: when the toggle is off, zero
    // out every user-supplied radius (outer/hole/inner) so a stale
    // outerCornerRadius or innerCornerRadius from a prior preset can't sneak
    // through. outerCornerRadius overrides cornerRadius on the outer
    // silhouette only when > 0; otherwise the outer outline inherits
    // cornerRadius. Holes always use cornerRadius for their convex corners.
    const effectiveOuterR = cornerRadiusOn
      ? (outerCornerRadius > 0 ? outerCornerRadius : cornerRadius) * sourceUnitScale
      : 0;
    const effectiveHoleR = cornerRadiusOn ? cornerRadius * sourceUnitScale : 0;
    const effectiveInnerR = cornerRadiusOn ? innerCornerRadius * sourceUnitScale : 0;

    // Miter-safety rounding for negative bevelOffset. Three.js's ExtrudeGeometry
    // shrinks the cap by pushing each vertex along its miter normal with no
    // miter limit — at any corner with tangent deflection β, the cap-level
    // displacement is |offset|/cos(β/2), which explodes on sharp corners and
    // produces overlapping planes (convex "beak" tips and reflex-notch spikes
    // alike). Convex: bump minimum radius to |bevelOffset| unconditionally;
    // getCornerRounding's per-corner maxR clamp (50% of the shorter adjacent
    // edge) degrades gracefully on thin walls, and convex rounding across
    // many consecutive joints just smooths the silhouette — no teeth.
    // Reflex: bump is β-gated inside getCornerRounding to only fire on
    // genuinely dangerous notches (β > REFLEX_MITER_DANGER_BETA). Blanket
    // reflex rounding trims every mildly-reflex joint's adjacent edges by
    // R·tan(β/2), which on complex outlines (Car, $) scallops otherwise
    // flat runs into visible teeth.
    // When cornerRadiusOn is off, miter-safety rounding is also suppressed —
    // the user has explicitly chosen sharp corners and accepts the extrude
    // artifacts that come with negative bevelOffset on sharp geometry.
    const miterSafetyR =
      cornerRadiusOn && scaledBevelOffset < 0 ? Math.abs(scaledBevelOffset) : 0;
    const safeOuterR = Math.max(effectiveOuterR, miterSafetyR);
    const safeHoleR = Math.max(effectiveHoleR, miterSafetyR);

    const roundedShapes =
      safeOuterR > 0 ||
      safeHoleR > 0 ||
      effectiveInnerR > 0 ||
      miterSafetyR > 0
        ? simplifiedShapes.map((s) =>
            roundShapeCorners(
              s,
              safeOuterR,
              safeHoleR,
              effectiveInnerR,
              miterSafetyR,
              cornerMinR,
              curveSegments,
            ),
          )
        : simplifiedShapes;

    // Solidify: strip holes from shapes to create solid fills.
    // This eliminates thin-wall issues and allows full-depth bevels.
    const finalShapes = solidify
      ? roundedShapes.map((s) => {
          const solid = new THREE.Shape();
          solid.curves = [...s.curves];
          solid.currentPoint.copy(s.currentPoint);
          // No holes — solid fill
          return solid;
        })
      : roundedShapes;

    // Extrude each shape individually so inflation works per-shape
    const geometries: THREE.BufferGeometry[] = [];

    // Shared shape bbox across all shapes — drives the UV generator below so
    // multi-path icons tile consistently.
    let shMinX = Infinity, shMaxX = -Infinity, shMinY = Infinity, shMaxY = -Infinity;
    for (const s of finalShapes) {
      const pts = s.getPoints(32);
      for (const p of pts) {
        if (p.x < shMinX) shMinX = p.x;
        if (p.x > shMaxX) shMaxX = p.x;
        if (p.y < shMinY) shMinY = p.y;
        if (p.y > shMaxY) shMaxY = p.y;
      }
    }
    const shSize = Math.max(shMaxX - shMinX, shMaxY - shMinY) || 1;
    const uvScale = 1 / shSize;

    // Default WorldUVGenerator emits cap UVs as (x, y) and side-wall UVs as
    // (x|y, 1−z). Caps span the full shape Y (~shSize units); sides span only
    // depth+bevel (often a small fraction of shSize). Renormalizing both into
    // 0..1 after merge — what we used to do — squashes both ranges to the
    // same UV extent, so `repeat.set(N, N)` tiles N times across both. The
    // bevel then gets ~shSize/(depth+bevel)× denser texels than the cap,
    // which reads as a smeared / stretched normal map on the bevel. Fix:
    // scale every axis by the same 1/shSize so tile density is physically
    // consistent across caps and sides.
    // Flat-cap projection: every vertex (cap, bevel, side) gets its UV from
    // its own (x, y), so there is no seam where cap meets bevel meets side.
    // Used when the material is an image/displacement map that should "drape"
    // continuously over the whole shape — any directional scheme would break
    // at corners where the wall axis swaps from X to Y. Since extrusion depth
    // is typically shallow relative to shape size, the slight stretch on
    // near-vertical walls is invisible.
    const capProjectionUVGen = {
      generateTopUV: (
        _geom: THREE.ExtrudeGeometry,
        vertices: number[],
        a: number, b: number, c: number,
      ) => [
        new THREE.Vector2((vertices[a * 3] - shMinX) * uvScale, (vertices[a * 3 + 1] - shMinY) * uvScale),
        new THREE.Vector2((vertices[b * 3] - shMinX) * uvScale, (vertices[b * 3 + 1] - shMinY) * uvScale),
        new THREE.Vector2((vertices[c * 3] - shMinX) * uvScale, (vertices[c * 3 + 1] - shMinY) * uvScale),
      ],
      generateSideWallUV: (
        _geom: THREE.ExtrudeGeometry,
        vertices: number[],
        a: number, b: number, c: number, d: number,
      ) => [
        new THREE.Vector2((vertices[a * 3] - shMinX) * uvScale, (vertices[a * 3 + 1] - shMinY) * uvScale),
        new THREE.Vector2((vertices[b * 3] - shMinX) * uvScale, (vertices[b * 3 + 1] - shMinY) * uvScale),
        new THREE.Vector2((vertices[c * 3] - shMinX) * uvScale, (vertices[c * 3 + 1] - shMinY) * uvScale),
        new THREE.Vector2((vertices[d * 3] - shMinX) * uvScale, (vertices[d * 3 + 1] - shMinY) * uvScale),
      ],
    };

    // Directional UV generator: caps project XY, walls project (x|y, z) with
    // axis chosen by the edge direction. Keeps brushed/directional normal
    // maps aligned, at the cost of a seam at bevel corners.
    const directionalUVGen = {
      generateTopUV: capProjectionUVGen.generateTopUV,
      generateSideWallUV: (
        _geom: THREE.ExtrudeGeometry,
        vertices: number[],
        a: number, b: number, c: number, d: number,
      ) => {
        const ax = vertices[a * 3], ay = vertices[a * 3 + 1], az = vertices[a * 3 + 2];
        const bx = vertices[b * 3], by = vertices[b * 3 + 1], bz = vertices[b * 3 + 2];
        const cx2 = vertices[c * 3], cy2 = vertices[c * 3 + 1], cz = vertices[c * 3 + 2];
        const dx = vertices[d * 3], dy = vertices[d * 3 + 1], dz = vertices[d * 3 + 2];
        if (Math.abs(ay - by) < 0.01) {
          return [
            new THREE.Vector2((ax - shMinX) * uvScale, -az * uvScale),
            new THREE.Vector2((bx - shMinX) * uvScale, -bz * uvScale),
            new THREE.Vector2((cx2 - shMinX) * uvScale, -cz * uvScale),
            new THREE.Vector2((dx - shMinX) * uvScale, -dz * uvScale),
          ];
        }
        return [
          new THREE.Vector2((ay - shMinY) * uvScale, -az * uvScale),
          new THREE.Vector2((by - shMinY) * uvScale, -bz * uvScale),
          new THREE.Vector2((cy2 - shMinY) * uvScale, -cz * uvScale),
          new THREE.Vector2((dy - shMinY) * uvScale, -dz * uvScale),
        ];
      },
    };

    const uvGenerator =
      normalMapOn && normalMapType === "nugget"
        ? capProjectionUVGen
        : directionalUVGen;

    // Three.js applies a negative bevelOffset independently to every sampled
    // hole vertex. On detailed logo cutouts that can fold the final bevel
    // ring across the opening and cover the enamel with coplanar triangles.
    // Keep the authored bevel itself, but clamp only that destabilizing
    // negative offset for explicit multi-color wells.
    const stableBevelOffset = hasRecessedColorWells
      ? Math.max(0, scaledBevelOffset)
      : scaledBevelOffset;

    const extrudeSettings: THREE.ExtrudeGeometryOptions = {
      depth: scaledExtrudeDepth,
      bevelEnabled,
      bevelThickness: scaledBevelThickness,
      bevelSize: scaledBevelSize,
      bevelSegments,
      bevelOffset: stableBevelOffset,
      curveSegments,
      steps: inflation > 0 ? extrudeSteps : 1,
      UVGenerator: uvGenerator,
    };

    for (const shape of finalShapes) {
      let shapeGeo: THREE.BufferGeometry = new THREE.ExtrudeGeometry([shape], extrudeSettings);

      // Solid back: replace the holed back cap with a hole-free one so the
      // cutouts read as pockets (open from the front, closed from the back)
      // instead of see-through tunnels. Done by re-extruding a hole-stripped
      // copy with identical bevel settings and keeping only its min-Z cap —
      // that way the solid cap matches the beveled outer outline exactly.
      if (solidBack && shape.holes && shape.holes.length > 0) {
        const solidShape = new THREE.Shape();
        solidShape.curves = [...shape.curves];
        solidShape.currentPoint.copy(shape.currentPoint);
        const solidExtrude = new THREE.ExtrudeGeometry([solidShape], extrudeSettings);
        const solidBackCap = filterMinZCapFaces(solidExtrude, "keep");
        const withoutBack = filterMinZCapFaces(shapeGeo, "drop");
        const merged = mergeGeometries([withoutBack, solidBackCap]);
        if (merged) shapeGeo = merged;
      }

      if (inflation > 0) {
        shapeGeo.computeBoundingBox();
        const bb = shapeGeo.boundingBox!;
        const minZ = bb.min.z;
        const maxZ = bb.max.z;
        const zRange = maxZ - minZ;
        // Pull target: per-shape XY bbox center. A single global target
        // (vs. per-vertex medial) gives a simple continuous pull field, so
        // the dense vertex clusters introduced by corner rounding don't
        // create discontinuous pull directions and the resulting pinch
        // artifacts on the bulge.
        const cxShape = (bb.min.x + bb.max.x) * 0.5;
        const cyShape = (bb.min.y + bb.max.y) * 0.5;

        const positions = shapeGeo.attributes.position;
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i);
          const y = positions.getY(i);
          const z = positions.getZ(i);

          const t = zRange > 0 ? (z - minZ) / zRange : 0.5;
          // Quintic bell 64·t³·(1−t)³: peaks at 1 at t=0.5 with zero first
          // and second derivatives at the caps, so the bulge meets the flat
          // cap with matching tangent and curvature (G2) — no visible kink
          // at the cap edge.
          const tt = t * (1 - t);
          const bell = 64 * tt * tt * tt;
          const profileScale = 1 - inflation * (1 - bell);

          positions.setX(i, cxShape + (x - cxShape) * profileScale);
          positions.setY(i, cyShape + (y - cyShape) * profileScale);
        }

        positions.needsUpdate = true;
        shapeGeo.computeVertexNormals();
      }

      geometries.push(shapeGeo);
    }

    // Merge all shape geometries
    let geo =
      geometries.length === 1
        ? geometries[0]
        : mergeGeometries(geometries);

    if (!geo) {
      return { geometry: null, enamelGeometry: null, colorEnamelLayers: [] };
    }

    const DEDUP_EPS = 1e-5;
    const dedupConsecutive = (pts: THREE.Vector2[]): THREE.Vector2[] => {
      const out: THREE.Vector2[] = [];
      for (const p of pts) {
        const last = out[out.length - 1];
        if (!last || last.distanceTo(p) > DEDUP_EPS) out.push(p);
      }
      while (
        out.length > 1 &&
        out[0].distanceTo(out[out.length - 1]) < DEDUP_EPS
      ) {
        out.pop();
      }
      return out;
    };

    type ColorGeometryRegion = {
      outer: THREE.Path;
      cuts: THREE.Path[];
    };
    const colorGeometrySources = colorLayerSources.map((source) => {
      const regions: ColorGeometryRegion[] = [];

      if (hasRecessedColorWells) {
        // Reuse the post-simplification, post-corner-radius metal contours.
        // This keeps the enamel rim exactly registered to the rounded well
        // and to any rounded metal islands inside it.
        for (const record of recessedColorRegions) {
          if (record.sourceOrder !== source.order) continue;
          const metalShape = roundedShapes[record.metalShapeIndex];
          const outer = metalShape?.holes[record.metalHoleIndex];
          if (!outer) continue;
          regions.push({
            outer,
            cuts: record.islandShapeIndices
              .map((shapeIndex) => roundedShapes[shapeIndex])
              .filter((shape): shape is THREE.Shape => Boolean(shape)),
          });
        }
      } else {
        for (const sourceShape of source.shapes) {
          regions.push({
            outer: sourceShape,
            cuts: sourceShape.holes || [],
          });
        }
      }

      return {
        color: source.color,
        order: source.order,
        regions,
      };
    });

    // Multi-color logos opt into one enamel surface per filled SVG path.
    // Positive offset tucks enamel beneath the surrounding metal; negative
    // offset pulls it inward to expose a wider metal border around the well.
    const rawColorEnamelLayers: { geometry: THREE.BufferGeometry; color: string; order: number }[] = [];
    if (hasColorEnamel) {
      const TARGET_SIZE = 100;
      const inset = enamelOffset * (shSize / TARGET_SIZE);
      const insetSafe = (points: THREE.Vector2[], amount: number) => {
        if (amount === 0) return points;
        const sourceArea = signedArea2D(points);
        const offset = offsetClosedPolygon(points, amount);
        const offsetArea = signedArea2D(offset);
        if (
          Math.sign(sourceArea) !== Math.sign(offsetArea) ||
          Math.abs(offsetArea) < Math.abs(sourceArea) * 0.03 ||
          polygonSelfIntersects(offset)
        ) {
          return points;
        }
        return offset;
      };

      for (const source of colorGeometrySources) {
        const parts: THREE.BufferGeometry[] = [];
        for (const region of source.regions) {
          let outer = dedupConsecutive(region.outer.getPoints(curveSegments) as THREE.Vector2[]);
          if (outer.length < 3) continue;
          outer = insetSafe(outer, hasRecessedColorWells ? inset : -inset);
          if (signedArea2D(outer) < 0) outer = outer.slice().reverse();

          const cuts: THREE.Vector2[][] = [];
          for (const sourceHole of region.cuts) {
            let cut = dedupConsecutive(sourceHole.getPoints(curveSegments) as THREE.Vector2[]);
            if (cut.length < 3) continue;
            cut = insetSafe(cut, hasRecessedColorWells ? -inset : inset);
            if (signedArea2D(cut) > 0) cut = cut.slice().reverse();
            cuts.push(cut);
          }

          if (Math.abs(scaledEnamelDome) > 0.001) {
            // Recessed color wells use the same positive, concave profile as
            // legacy hole enamel. Generic layered SVGs without an authored
            // metal base retain a shallow outward dome above their backing.
            const dome = buildDomeGeometry(
              outer,
              cuts,
              hasRecessedColorWells
                ? scaledEnamelDome
                : -Math.abs(scaledEnamelDome) * 0.08,
              8,
            );
            if (dome) parts.push(dome);
          } else {
            const layerShape = new THREE.Shape();
            layerShape.moveTo(outer[0].x, outer[0].y);
            for (let i = 1; i < outer.length; i++) {
              layerShape.lineTo(outer[i].x, outer[i].y);
            }
            for (const cut of cuts) {
              const hole = new THREE.Path();
              hole.moveTo(cut[0].x, cut[0].y);
              for (let i = 1; i < cut.length; i++) hole.lineTo(cut[i].x, cut[i].y);
              layerShape.holes.push(hole);
            }
            parts.push(new THREE.ShapeGeometry(layerShape, curveSegments));
          }
        }
        // A malformed or non-contained authored enamel region can legitimately
        // yield no tessellated parts. Avoid passing an empty list to
        // mergeGeometries, which assumes at least one geometry and otherwise
        // throws while reading the first item's index.
        const layerGeometry =
          parts.length === 0
            ? null
            : parts.length === 1
              ? parts[0]
              : mergeGeometries(parts);
        if (layerGeometry) {
          rawColorEnamelLayers.push({ geometry: layerGeometry, color: source.color, order: source.order });
        }
      }
    }

    // Enamel fill: one plane (or low-profile lens when enamelDome > 0) per
    // hole in the SVG — the "cutout" regions. Each hole's boundary is
    // expanded outward by `enamelOffset` so the enamel tucks under the
    // surrounding metal frame instead of showing a seam at the hole edge.
    // Offset is in pre-normalized SVG units, scaled by shSize/TARGET_SIZE so
    // the slider reads consistently (≈1 unit per % of icon) across SVGs.
    let enamelGeo: THREE.BufferGeometry | null = null;
    if (enamelOn && !hasColorEnamel) {
      const TARGET_SIZE = 100;
      const strokeOffset = enamelOffset * (shSize / TARGET_SIZE);

      // Three's Path.absellipse auto-inserts a bridging lineTo whenever the
      // arc's start coord doesn't exactly === currentPoint (Vector2 uses
      // strict equality in .equals). Every rounded-corner junction in
      // roundShapeCorners is subject to sub-epsilon float drift between the
      // trim point and the arc's computed endpoint, so the sampled outline
      // ends up sprinkled with zero-length micro-edges. In offsetMiterStrict
      // a zero-length edge yields a zero normal, which collapses cosHalf to
      // 0 at the neighbor vertex and triggers the 4×offset miter clamp —
      // visible as an outward shard at rounded corners of the enamel. Drop
      // consecutive points that are within a small epsilon before offsetting.
      // Offset an outline with vertex-preserving strict miter, falling back
      // to the raw outline if the offset inverted or collapsed the polygon
      // (too-sharp concavity + large offset).
      const offsetPoly = (pts: THREE.Vector2[], delta: number): THREE.Vector2[] => {
        if (delta === 0) return pts;
        const srcArea = signedArea2D(pts);
        const out = offsetMiterStrict(pts, delta);
        const offArea = signedArea2D(out);
        if (
          Math.sign(offArea) !== Math.sign(srcArea) ||
          Math.abs(offArea) < Math.abs(srcArea) * 0.05
        ) {
          return pts;
        }
        return out;
      };
      // For hole boundaries, +strokeOffset grows the enamel region past the
      // hole edge (enamel tucks under the surrounding frame). For inner cuts
      // sitting inside the enamel, the direction flips: −strokeOffset shrinks
      // the cutout so the enamel extends *under* the inner metal instead of
      // receding from it with a halo.
      const expand = (pts: THREE.Vector2[]) => offsetPoly(pts, strokeOffset);
      const tuckUnder = (pts: THREE.Vector2[]) => offsetPoly(pts, -strokeOffset);

      // Catalog every top-level shape's outline so we can decide which ones
      // sit inside each hole region and should be subtracted as inner
      // cutouts from the enamel. Tracking the source shape lets us skip a
      // hole's own parent (whose centroid typically sits inside that hole).
      const topLevelOutlines: {
        owner: THREE.Shape;
        pts: THREE.Vector2[];
        centroid: THREE.Vector2;
        bounds: { minX: number; maxX: number; minY: number; maxY: number };
      }[] = [];
      for (const shape of roundedShapes) {
        let pts = shape.getPoints(curveSegments) as THREE.Vector2[];
        pts = dedupConsecutive(pts);
        if (pts.length < 3) continue;
        let cx = 0;
        let cy = 0;
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const p of pts) {
          cx += p.x;
          cy += p.y;
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        topLevelOutlines.push({
          owner: shape,
          pts,
          centroid: new THREE.Vector2(cx / pts.length, cy / pts.length),
          bounds: { minX, maxX, minY, maxY },
        });
      }

      // Each enamel region = a hole boundary (outer) + any top-level shapes
      // sitting inside that hole (inner cuts, expanded the same way so the
      // enamel also tucks under those inner shapes' metal).
      type Region = { outer: THREE.Vector2[]; cuts: THREE.Vector2[][] };
      const regions: Region[] = [];
      for (const s of roundedShapes) {
        for (const hole of s.holes || []) {
          let pts = hole.getPoints(curveSegments) as THREE.Vector2[];
          pts = dedupConsecutive(pts);
          if (pts.length < 3) continue;

          const outline = expand(pts);
          const outerCCW =
            signedArea2D(outline) < 0 ? outline.slice().reverse() : outline;

          // Hole bbox gates the candidate search — only shapes whose bbox
          // fits entirely inside the hole's bbox can possibly be inner cuts,
          // which also rules out this hole's own parent shape.
          let hMinX = Infinity;
          let hMaxX = -Infinity;
          let hMinY = Infinity;
          let hMaxY = -Infinity;
          for (const p of outerCCW) {
            if (p.x < hMinX) hMinX = p.x;
            if (p.x > hMaxX) hMaxX = p.x;
            if (p.y < hMinY) hMinY = p.y;
            if (p.y > hMaxY) hMaxY = p.y;
          }

          const cuts: THREE.Vector2[][] = [];
          for (const cand of topLevelOutlines) {
            if (cand.owner === s) continue;
            if (
              cand.bounds.minX < hMinX ||
              cand.bounds.maxX > hMaxX ||
              cand.bounds.minY < hMinY ||
              cand.bounds.maxY > hMaxY
            )
              continue;
            if (!pointInPolygon(cand.centroid, outerCCW)) continue;
            const cutTucked = tuckUnder(cand.pts);
            // Holes fed to the dome builder and ShapeUtils.triangulateShape
            // must have winding opposite to the outer (CW).
            const cutCW =
              signedArea2D(cutTucked) > 0
                ? cutTucked.slice().reverse()
                : cutTucked;
            cuts.push(cutCW);
          }

          regions.push({ outer: outerCCW, cuts });
        }
      }

      if (regions.length > 0) {
        const parts: THREE.BufferGeometry[] = [];
        if (Math.abs(scaledEnamelDome) > 0.001) {
          // Domed bowl per region. Rim sits at Z=0 (flush with frame); cap
          // dips to Z=-enamelDome when positive (concave) or pops forward
          // to Z=+|enamelDome| when negative (convex). Inner cuts punch
          // through the dome, with walls flaring outward toward the cap.
          for (const r of regions) {
            const bowl = buildDomeGeometry(r.outer, r.cuts, scaledEnamelDome, 8);
            if (bowl) parts.push(bowl);
          }
        } else {
          for (const r of regions) {
            const shape = new THREE.Shape();
            shape.moveTo(r.outer[0].x, r.outer[0].y);
            for (let i = 1; i < r.outer.length; i++) {
              shape.lineTo(r.outer[i].x, r.outer[i].y);
            }
            for (const cut of r.cuts) {
              const h = new THREE.Path();
              h.moveTo(cut[0].x, cut[0].y);
              for (let i = 1; i < cut.length; i++) {
                h.lineTo(cut[i].x, cut[i].y);
              }
              shape.holes.push(h);
            }
            parts.push(new THREE.ShapeGeometry([shape], curveSegments));
          }
        }
        if (parts.length > 0) {
          enamelGeo = parts.length === 1 ? parts[0] : mergeGeometries(parts);
        }
      }
    }

    // Center the geometry
    geo.computeBoundingBox();
    const bb2 = geo.boundingBox!;
    const cx = (bb2.max.x + bb2.min.x) / 2;
    const cy = (bb2.max.y + bb2.min.y) / 2;
    const cz = (bb2.max.z + bb2.min.z) / 2;
    geo.translate(-cx, -cy, -cz);
    // Enamel plane uses the same XY centering but keeps Z=0 so it ends up at
    // the mid-thickness of the centered extrude.
    if (enamelGeo) enamelGeo.translate(-cx, -cy, 0);
    for (const layer of rawColorEnamelLayers) {
      layer.geometry.translate(-cx, -cy, 0);
    }

    // Normalize size: scale so the largest XY dimension fits in a target size
    const TARGET_SIZE = 100;
    geo.computeBoundingBox();
    const bb3 = geo.boundingBox!;
    const w = bb3.max.x - bb3.min.x;
    const h = bb3.max.y - bb3.min.y;
    const maxDim = Math.max(w, h);
    if (maxDim > 0) {
      const normScale = TARGET_SIZE / maxDim;
      geo.scale(normScale, normScale, normScale);
      if (enamelGeo) enamelGeo.scale(normScale, normScale, normScale);
      for (const layer of rawColorEnamelLayers) {
        layer.geometry.scale(normScale, normScale, normScale);
      }
    }

    // Flip Y since SVG has inverted Y
    geo.scale(1, -1, 1);
    if (enamelGeo) enamelGeo.scale(1, -1, 1);
    for (const layer of rawColorEnamelLayers) {
      layer.geometry.scale(1, -1, 1);
    }

    // Shift the enamel layer along Z in final render units. Positive values
    // push the layer forward (toward the camera on an unrotated scene).
    if (enamelGeo && enamelZ !== 0) enamelGeo.translate(0, 0, enamelZ);
    const colorEnamelLayers = rawColorEnamelLayers
      .sort((a, b) => a.order - b.order)
      .map((layer, index) => {
        // Preserve SVG painter order for the uncommon case where paths
        // overlap. This offset is invisible but prevents coplanar flicker.
        layer.geometry.translate(0, 0, enamelZ + index * 0.002);
        return { geometry: layer.geometry, color: layer.color };
      });

    // UVs are already in shape-space-normalized units (see UV generator
    // above), so `normalRepeat` means "tiles across the icon" as intended,
    // with matching tile density on caps and sides.

    // Smooth shading: average vertex normals across low-angle edges and keep
    // sharp creases at high-angle edges (e.g., flat face meeting bevel).
    // Phong interpolation is already in the fragment shader, so this is
    // essentially free at runtime — only the normal attribute changes.
    //
    // Split the flat front/back caps off before creasing. toCreasedNormals
    // welds by position hash, so a cap-boundary vertex gets averaged with its
    // top-of-wall twin and ends up tilted outward. Since caps are triangulated
    // from boundary points only, those tilted normals Gouraud-interpolate
    // across long fan triangles and the triangulation edges show up as
    // streaks on what should be a flat face. Caps are coplanar so a single
    // computeVertexNormals gives the correct uniform normal; only the walls
    // need creasing.
    if (smoothShading) {
      const split = splitByZCaps(geo);
      toCreasedNormals(split.walls, (creaseAngle * Math.PI) / 180);
      const parts: THREE.BufferGeometry[] = [split.walls];
      if (split.minCap) {
        split.minCap.computeVertexNormals();
        parts.push(split.minCap);
      }
      if (split.maxCap) {
        split.maxCap.computeVertexNormals();
        parts.push(split.maxCap);
      }
      const merged = mergeGeometries(parts);
      if (merged) geo = merged;
    }

    // buildDomeGeometry (inflation path) already sets consistent per-surface
    // normals — smooth walls, pure +z on the cap — so it skips the creasing
    // pass entirely.

    // For image-based displacement (nugget material), tessellate enough for
    // the heightmap to drive visible relief, then weld duplicate vertices so
    // the geometry becomes indexed. The weld is the important bit: once
    // indexed, `computeVertexNormals` averages each vertex normal across
    // every face it touches instead of giving per-triangle face normals, so
    // the cap reads as smoothly pebbled rather than flat-shaded facets —
    // which is the real cause of the triangular look. Density can drop
    // significantly as a result: smooth shading hides the seams and a
    // ~4% edge-length target keeps total tri count low for performance.
    if (normalMapOn && normalMapType === "nugget") {
      geo = subdivideGeometry(geo, 1);
      geo.computeBoundingBox();
      const bb = geo.boundingBox!;
      const span = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y);
      geo = refineLongEdges(geo, span * 0.04, 6);

      // Before welding: (1) strip normals — toCreasedNormals gave cap and
      // bevel different per-face normals, and mergeVertices hashes every
      // attribute, so without stripping the seam verts refuse to weld and
      // displacement pushes the two sides in different normal directions,
      // tearing a visible gap at the cap↔bevel boundary; (2) rebuild UVs
      // from XY so seam verts also agree on UVs (same reason).
      const bx = bb.min.x;
      const by = bb.min.y;
      const brx = bb.max.x - bb.min.x || 1;
      const bry = bb.max.y - bb.min.y || 1;
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) {
        uv.setXY(i, (pos.getX(i) - bx) / brx, (pos.getY(i) - by) / bry);
      }
      uv.needsUpdate = true;
      geo.deleteAttribute("normal");

      geo = mergeVertices(geo, 1e-4);
      geo.computeVertexNormals();
    }

    return { geometry: geo, enamelGeometry: enamelGeo, colorEnamelLayers };
  }, [
    svgString,
    extrudeDepth,
    bevelEnabled,
    bevelThickness,
    bevelSize,
    bevelSegments,
    bevelOffset,
    curveSegments,
    pathResolution,
    cornerRadiusOn,
    cornerRadius,
    outerCornerRadius,
    innerCornerRadius,
    solidify,
    solidBack,
    inflation,
    extrudeSteps,
    smoothShading,
    creaseAngle,
    enamelOn,
    enamelOffset,
    enamelDome,
    enamelZ,
    normalMapOn,
    normalMapType,
  ]);

  // Procedural normal maps (synchronous — canvas-generated).
  const proceduralNormal = useMemo(() => {
    if (!normalMapOn) return null;
    if (normalMapType === "nugget") return null; // handled via image below
    let tex: THREE.CanvasTexture;
    switch (normalMapType) {
      case "brushed-h":
        tex = createBrushedMetalNormal(512, 512, 1, "horizontal");
        break;
      case "brushed-v":
        tex = createBrushedMetalNormal(512, 512, 1, "vertical");
        break;
      case "rough":
        tex = createRoughNormal(512, 512, 1);
        break;
      case "hammered":
        tex = createHammeredNormal(512, 512, 1);
        break;
      default:
        return null;
    }
    return tex;
  }, [normalMapOn, normalMapType]);

  // Image-backed "nugget": load the PNG once, use it as the diffuse map,
  // derive a matching normal map, and extract the raw height field for CPU
  // displacement (applied below). Going through the CPU instead of three's
  // displacementMap + onBeforeCompile means the vertex push shows up in the
  // silhouette regardless of shader program caching quirks.
  const [nuggetMaps, setNuggetMaps] = useState<{
    colorMap: THREE.Texture;
    normalMap: THREE.Texture;
    displacementField: DisplacementField;
  } | null>(null);
  useEffect(() => {
    if (!normalMapOn || normalMapType !== "nugget") {
      setNuggetMaps(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      const colorMap = new THREE.Texture(img);
      colorMap.wrapS = THREE.RepeatWrapping;
      colorMap.wrapT = THREE.RepeatWrapping;
      colorMap.colorSpace = THREE.SRGBColorSpace;
      colorMap.needsUpdate = true;
      const { field } = deriveDisplacementFromImage(img);
      const normalMap = deriveNormalFromImage(img, 1);
      setNuggetMaps({ colorMap, normalMap, displacementField: field });
    };
    img.src = "/textures/chicken-nugget.png";
    return () => {
      cancelled = true;
    };
  }, [normalMapOn, normalMapType]);

  const normalMap = nuggetMaps?.normalMap ?? proceduralNormal;
  const colorMap = nuggetMaps?.colorMap ?? null;
  const displacementField = nuggetMaps?.displacementField ?? null;

  useEffect(() => {
    const wrapMode = (mode: string) =>
      mode === "clamp"
        ? THREE.ClampToEdgeWrapping
        : mode === "mirrored"
          ? THREE.MirroredRepeatWrapping
          : THREE.RepeatWrapping;
    const applyUV = (tex: THREE.Texture | null) => {
      if (!tex) return;
      tex.offset.set(uvMap.offsetX, uvMap.offsetY);
      tex.repeat.set(uvMap.repeatX, uvMap.repeatY);
      tex.center.set(uvMap.centerX, uvMap.centerY);
      tex.rotation = (uvMap.rotation * Math.PI) / 180;
      tex.wrapS = wrapMode(uvMap.wrapS);
      tex.wrapT = wrapMode(uvMap.wrapT);
      tex.needsUpdate = true;
    };
    applyUV(normalMap);
    applyUV(colorMap);
  }, [normalMap, colorMap, uvMap]);

  // Apply heightmap displacement on the CPU once the nugget field has loaded.
  // Clone the already-subdivided base geometry so retuning scale/bias doesn't
  // compound pushes across renders. Push each vertex along the sign of its
  // own Z normal — so both caps bulge outward — scaled by |normal.z|, which
  // is ~1 on flat caps and ~0 on walls. Pushing along the *signed* normal
  // direction (not a fixed +Z) is what fixes displacement landing on the
  // back after the geo.scale(1,-1,1) flip inverts surface winding.
  const displacedGeometry = useMemo(() => {
    if (!geometry) return null;
    if (!displacementField || !(normalMapOn && normalMapType === "nugget")) {
      return geometry;
    }
    const g = geometry.clone();
    const positions = g.attributes.position as THREE.BufferAttribute;
    const normals = g.attributes.normal as THREE.BufferAttribute;
    const { heights, width: fw, height: fh } = displacementField;

    // Triplanar sampling: the old (x, y)-based UV collapsed every wall vertex
    // stacked along Z to one UV column, so the crumb pattern ran as vertical
    // streaks around the silhouette. Instead, sample the heightmap from three
    // axis-aligned planes (YZ, XZ, XY) and blend by |n|^k so whichever plane
    // the surface most faces dominates. Scale by 1/maxBboxXY * repeatX so the
    // same world-space crumb density maps to front, back, *and* wall.
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    const bcx = (bb.min.x + bb.max.x) * 0.5;
    const bcy = (bb.min.y + bb.max.y) * 0.5;
    const bcz = (bb.min.z + bb.max.z) * 0.5;
    const bbxy = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y) || 1;
    const triScale = uvMap.repeatX / bbxy;
    const triScaleY = uvMap.repeatY / bbxy;
    const BLEND_POW = 4;

    const wrap = (idx: number, n: number) => ((idx % n) + n) % n;
    const sampleHeight = (u: number, v: number) => {
      const tu = u - Math.floor(u);
      const tv = v - Math.floor(v);
      const fx = tu * fw - 0.5;
      const fy = tv * fh - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const sx = fx - x0;
      const sy = fy - y0;
      const x0w = wrap(x0, fw);
      const x1w = wrap(x0 + 1, fw);
      const y0w = wrap(y0, fh);
      const y1w = wrap(y0 + 1, fh);
      const h00 = heights[y0w * fw + x0w];
      const h10 = heights[y0w * fw + x1w];
      const h01 = heights[y1w * fw + x0w];
      const h11 = heights[y1w * fw + x1w];
      return h00 * (1 - sx) * (1 - sy) + h10 * sx * (1 - sy) + h01 * (1 - sx) * sy + h11 * sx * sy;
    };

    for (let i = 0; i < positions.count; i++) {
      const nxRaw = normals.getX(i);
      const nyRaw = normals.getY(i);
      const nzRaw = normals.getZ(i);
      const nlen = Math.hypot(nxRaw, nyRaw, nzRaw) || 1;
      const nx = nxRaw / nlen;
      const ny = nyRaw / nlen;
      const nz = nzRaw / nlen;

      const px = (positions.getX(i) - bcx) * triScale;
      const py = (positions.getY(i) - bcy) * triScaleY;
      const pz = (positions.getZ(i) - bcz) * triScale;

      const ax = Math.abs(nx) ** BLEND_POW;
      const ay = Math.abs(ny) ** BLEND_POW;
      const az = Math.abs(nz) ** BLEND_POW;
      const as = ax + ay + az + 1e-6;
      const wx = ax / as;
      const wy = ay / as;
      const wz = az / as;

      const hYZ = sampleHeight(py, pz);
      const hXZ = sampleHeight(px, pz);
      const hXY = sampleHeight(px, py);
      const h = hYZ * wx + hXZ * wy + hXY * wz;

      const mag = h * displacementScale + displacementBias;
      positions.setXYZ(
        i,
        positions.getX(i) + nx * mag,
        positions.getY(i) + ny * mag,
        positions.getZ(i) + nz * mag,
      );
    }

    // Laplacian smoothing: average each vertex with the neighbours it shares
    // a triangle with, then nudge it a fraction toward that average. A couple
    // of passes round off the triangular ridges that remain after per-vertex
    // displacement so the surface reads as pebbled rather than faceted, at
    // zero extra triangle cost. Only runs on the indexed mesh; neighbour
    // lookup needs the shared-vertex info the weld produced.
    const idx = g.getIndex();
    if (idx) {
      const idxArr = idx.array;
      const nCount = positions.count;
      const counts = new Int32Array(nCount);
      for (let t = 0; t < idxArr.length; t++) counts[idxArr[t]] += 2;
      const offsets = new Int32Array(nCount + 1);
      for (let i = 0; i < nCount; i++) offsets[i + 1] = offsets[i] + counts[i];
      const list = new Int32Array(offsets[nCount]);
      const cur = new Int32Array(nCount);
      for (let t = 0; t < idxArr.length; t += 3) {
        const a = idxArr[t], b = idxArr[t + 1], c = idxArr[t + 2];
        list[offsets[a] + cur[a]++] = b;
        list[offsets[a] + cur[a]++] = c;
        list[offsets[b] + cur[b]++] = a;
        list[offsets[b] + cur[b]++] = c;
        list[offsets[c] + cur[c]++] = a;
        list[offsets[c] + cur[c]++] = b;
      }
      const lambda = 0.5;
      const passes = 2;
      const buf = new Float32Array(nCount * 3);
      for (let pass = 0; pass < passes; pass++) {
        for (let i = 0; i < nCount; i++) {
          const start = offsets[i];
          const end = offsets[i + 1];
          if (end === start) {
            buf[i * 3] = positions.getX(i);
            buf[i * 3 + 1] = positions.getY(i);
            buf[i * 3 + 2] = positions.getZ(i);
            continue;
          }
          let sx = 0, sy = 0, sz = 0;
          for (let k = start; k < end; k++) {
            const j = list[k];
            sx += positions.getX(j);
            sy += positions.getY(j);
            sz += positions.getZ(j);
          }
          const inv = 1 / (end - start);
          const ax = sx * inv, ay = sy * inv, az = sz * inv;
          buf[i * 3] = positions.getX(i) + (ax - positions.getX(i)) * lambda;
          buf[i * 3 + 1] = positions.getY(i) + (ay - positions.getY(i)) * lambda;
          buf[i * 3 + 2] = positions.getZ(i) + (az - positions.getZ(i)) * lambda;
        }
        for (let i = 0; i < nCount; i++) {
          positions.setXYZ(i, buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]);
        }
      }
    }

    positions.needsUpdate = true;
    g.computeVertexNormals();
    return g;
  }, [
    geometry,
    displacementField,
    displacementScale,
    displacementBias,
    uvMap,
    normalMapOn,
    normalMapType,
  ]);

  // Three's WebGLMaterials.refreshUniformsStandard only copies
  // material.envMapIntensity into the shader uniform when material.envMap is
  // truthy (three/src/renderers/webgl/WebGLMaterials.js, line ~404). Relying
  // on scene.environment alone leaves the uniform stuck at its default (1),
  // so the envMapIntensity slider has no effect. Mirroring scene.environment
  // onto material.envMap each frame makes the check pass and lets the prop
  // reach the GPU. It's a plain reference assignment — same texture object
  // already being used for IBL — so no shader recompile is triggered.
  const mainMatRef = useRef<THREE.MeshPhysicalMaterial>(null);
  const enamelMatRef = useRef<THREE.MeshPhysicalMaterial>(null);
  const colorEnamelMatRefs = useRef<Array<THREE.MeshPhysicalMaterial | null>>([]);

  // Triplanar shader injection for the nugget color map. Planar (x, y) UVs
  // collapse every wall vertex stacked along Z to the same UV column, which
  // streaks the crumb texture vertically around the silhouette. Instead,
  // sample the texture from three axis-aligned planes (YZ/XZ/XY) using the
  // vertex's object-space position, blended by |n|^4 so each face picks the
  // plane it most faces. Uniforms are refs so mutating them propagates every
  // frame without forcing a shader recompile.
  const triplanarCenterRef = useRef(new THREE.Vector3());
  const triplanarScaleRef = useRef(new THREE.Vector2(1, 1));
  useEffect(() => {
    if (!colorMap || !displacedGeometry) return;
    displacedGeometry.computeBoundingBox();
    const bb = displacedGeometry.boundingBox!;
    const span = Math.max(bb.max.x - bb.min.x, bb.max.y - bb.min.y) || 1;
    triplanarCenterRef.current.set(
      (bb.min.x + bb.max.x) * 0.5,
      (bb.min.y + bb.max.y) * 0.5,
      (bb.min.z + bb.max.z) * 0.5,
    );
    triplanarScaleRef.current.set(uvMap.repeatX / span, uvMap.repeatY / span);
  }, [colorMap, displacedGeometry, uvMap.repeatX, uvMap.repeatY]);

  const handleBeforeCompile = useCallback((shader: THREE.WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uTriplanarCenter = { value: triplanarCenterRef.current };
    shader.uniforms.uTriplanarScale = { value: triplanarScaleRef.current };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vTriplanarPos;
varying vec3 vTriplanarNrm;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
vTriplanarPos = position;
vTriplanarNrm = normal;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vTriplanarPos;
varying vec3 vTriplanarNrm;
uniform vec3 uTriplanarCenter;
uniform vec2 uTriplanarScale;`,
      )
      .replace(
        "#include <map_fragment>",
        `#ifdef USE_MAP
  vec3 tpP = vec3(
    (vTriplanarPos.x - uTriplanarCenter.x) * uTriplanarScale.x,
    (vTriplanarPos.y - uTriplanarCenter.y) * uTriplanarScale.y,
    (vTriplanarPos.z - uTriplanarCenter.z) * uTriplanarScale.x
  );
  vec3 tpN = normalize(vTriplanarNrm);
  vec3 tpW = pow(abs(tpN), vec3(4.0));
  tpW /= (tpW.x + tpW.y + tpW.z + 1e-6);
  vec4 sampledDiffuseColor =
    texture2D(map, tpP.yz) * tpW.x +
    texture2D(map, tpP.xz) * tpW.y +
    texture2D(map, tpP.xy) * tpW.z;
  diffuseColor *= sampledDiffuseColor;
#endif`,
      );
  }, []);

  // Flip animation: each change of flipNonce adds +PI to the target Y
  // rotation on an inner group, eased with an out-back "spring bounce".
  const flipGroupRef = useRef<THREE.Group>(null);
  const flipStartRef = useRef(0);
  const flipTargetRef = useRef(0);
  const flipElapsedRef = useRef(Infinity);
  const flipDurationRef = useRef(0.7 / 0.3);
  const prevFlipNonceRef = useRef(flipNonce);
  if (prevFlipNonceRef.current !== flipNonce) {
    prevFlipNonceRef.current = flipNonce;
    flipStartRef.current = flipTargetRef.current;
    flipTargetRef.current = flipTargetRef.current + Math.PI * 2;
    flipElapsedRef.current = 0;
  }

  useFrame(({ scene }, delta) => {
    if (flipGroupRef.current) {
      if (flipElapsedRef.current < flipDurationRef.current) {
        flipElapsedRef.current += delta;
        const t = Math.min(1, flipElapsedRef.current / flipDurationRef.current);
        const c1 = 1.70158;
        const c3 = c1 + 1;
        const eased = 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
        flipGroupRef.current.rotation.y =
          flipStartRef.current + (flipTargetRef.current - flipStartRef.current) * eased;
      } else {
        flipGroupRef.current.rotation.y = flipTargetRef.current;
      }
    }

    const env = scene.environment;
    const rad = (envMapRotation * Math.PI) / 180;
    if (mainMatRef.current) {
      if (mainMatRef.current.envMap !== env) {
        mainMatRef.current.envMap = env;
        mainMatRef.current.needsUpdate = true;
      }
      mainMatRef.current.envMapRotation.set(0, rad, 0);
    }
    if (enamelMatRef.current) {
      if (enamelMatRef.current.envMap !== env) {
        enamelMatRef.current.envMap = env;
        enamelMatRef.current.needsUpdate = true;
      }
      enamelMatRef.current.envMapRotation.set(0, rad, 0);
    }
    for (const material of colorEnamelMatRefs.current) {
      if (!material) continue;
      if (material.envMap !== env) {
        material.envMap = env;
        material.needsUpdate = true;
      }
      material.envMapRotation.set(0, rad, 0);
    }
  });

  if (!geometry) return null;

  return (
    <group
      name="YankeesEnamelPin"
      userData={{
        exportLogo: svgString.includes("Yankees monogram enamel pin artwork")
          ? "yankees"
          : svgString.includes("Philadelphia Phillies insignia enamel pin artwork")
            ? "phillies"
            : "other",
      }}
      rotation={rotation.map((r) => (r * Math.PI) / 180) as unknown as THREE.Euler}
      scale={scale}
    >
      <group ref={flipGroupRef} name="PinFlipRoot">
      <mesh name="MetalBacking" geometry={displacedGeometry ?? geometry}>
        <meshPhysicalMaterial
          ref={mainMatRef}
          key={`mat-${normalMap ? "nm" : "n"}-${colorMap ? "cm" : "c"}`}
          // When a color map is supplied, three multiplies it by `color`,
          // so keep the tint white to preserve the texture's palette.
          color={colorMap ? "#ffffff" : color}
          map={colorMap}
          roughness={roughness}
          metalness={metalness}
          clearcoat={clearcoat}
          clearcoatRoughness={clearcoatRoughness}
          envMapIntensity={envMapIntensity}
          transmission={transmission}
          thickness={thickness}
          ior={ior}
          dispersion={dispersion}
          normalMap={normalMap}
          normalScale={normalMap ? new THREE.Vector2(normalScale, normalScale) : undefined}
          transparent={transmission > 0}
          side={THREE.DoubleSide}
          wireframe={wireframe}
          onBeforeCompile={colorMap ? handleBeforeCompile : undefined}
        />
      </mesh>
      {enamelGeometry && (
        <mesh name="EnamelFill" geometry={enamelGeometry}>
          <meshPhysicalMaterial
            ref={enamelMatRef}
            color={enamelColor}
            roughness={enamelRoughness}
            metalness={enamelMetalness}
            clearcoat={enamelClearcoat}
            clearcoatRoughness={enamelClearcoatRoughness}
            envMapIntensity={enamelEnvMapIntensity}
            side={THREE.DoubleSide}
            wireframe={wireframe}
          />
        </mesh>
      )}
      {colorEnamelLayers.map((layer, index) => (
        <mesh name={`Enamel_${index}`} key={`${layer.color}-${index}`} geometry={layer.geometry}>
          <meshPhysicalMaterial
            ref={(material) => {
              colorEnamelMatRefs.current[index] = material;
            }}
            color={layer.color}
            emissive={layer.color}
            emissiveIntensity={0.08}
            roughness={enamelRoughness}
            metalness={enamelMetalness}
            clearcoat={enamelClearcoat}
            clearcoatRoughness={enamelClearcoatRoughness}
            envMapIntensity={enamelEnvMapIntensity}
            side={THREE.DoubleSide}
            wireframe={wireframe}
          />
        </mesh>
      ))}
      {fur?.furOn && (displacedGeometry ?? geometry) && (
        <GrassFur
          geometry={displacedGeometry ?? geometry}
          count={fur.furCount}
          length={fur.furLength}
          width={fur.furWidth}
          tipTaper={fur.furTipTaper}
          lengthVariation={fur.furLengthVariation}
          fluff={fur.furFluff}
          bevelBoost={fur.furBevelBoost}
          segments={fur.furSegments}
          colorBase={fur.furColorBase}
          colorTip={fur.furColorTip}
          roughness={fur.furRoughness}
          metalness={fur.furMetalness}
          windStrength={fur.furWindStrength}
          windSpeed={fur.furWindSpeed}
          windFreq={fur.furWindFreq}
          windDirX={fur.furWindDirX}
          windDirZ={fur.furWindDirZ}
          stiffness={fur.furStiffness}
          gravity={fur.furGravity}
          inertia={fur.furInertia}
          inertiaResponse={fur.furInertiaResponse}
          cursorOn={fur.furCursorOn}
          cursorRadius={fur.furCursorRadius}
          cursorStrength={fur.furCursorStrength}
        />
      )}
      </group>
    </group>
  );
}
