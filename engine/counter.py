"""Timestamp-based observation of visible curl cycles, not exercise assessment.

References Good-GYM's elbow-angle counting approach; the state machine below is
new and counts a *completed* extension -> flexion -> extension sequence.
Thresholds are demonstration heuristics, not clinical or coaching standards.
"""
from __future__ import annotations

import math


class CurlCounter:
    def __init__(self, extended=150.0, flexed=70.0, dwell=0.20,
                 min_cycle=0.8, max_cycle=12.0, max_gap=0.30):
        self.extended = extended
        self.flexed = flexed
        self.dwell = dwell
        self.min_cycle = min_cycle
        self.max_cycle = max_cycle
        self.max_gap = max_gap
        self.count = 0
        self.last_t = None
        self.phase = "waiting"
        self.cycle_start = None
        self.zone = None
        self.zone_since = None

    def reset_observation(self):
        self.phase = "waiting"
        self.cycle_start = None
        self.zone = None
        self.zone_since = None

    def update(self, t, angle, valid=True):
        """Return event type or None. Never bridge occlusion or unordered time."""
        if not isinstance(t, (float, int)) or not math.isfinite(t) or t < 0:
            raise ValueError("timestamp must be finite and nonnegative")
        if self.last_t is not None and t <= self.last_t:
            self.reset_observation()
            raise ValueError("timestamps must be strictly increasing")
        gap = self.last_t is not None and t - self.last_t > self.max_gap
        self.last_t = t
        if gap:
            self.reset_observation()
        if (not valid or angle is None or not isinstance(angle, (float, int))
                or not math.isfinite(angle) or not 0 <= angle <= 180):
            self.reset_observation()
            return "observation_lost"

        zone = "extended" if angle >= self.extended else (
            "flexed" if angle <= self.flexed else "middle")
        if zone != self.zone:
            self.zone = zone
            self.zone_since = t
        stable = t - self.zone_since >= self.dwell - 1e-8

        if self.phase == "waiting":
            if zone == "extended" and stable:
                self.phase = "ready"
            return None

        if self.phase == "ready":
            if zone != "extended" and self.cycle_start is None:
                self.cycle_start = t
            if zone == "extended" and stable:
                self.cycle_start = None  # a partial curl returned to start
            if zone == "flexed" and stable:
                self.phase = "flexed"
            return None

        # A cycle may not last indefinitely or span a new unrelated gesture.
        if self.cycle_start is None or t - self.cycle_start > self.max_cycle:
            self.reset_observation()
            return "cycle_expired"
        if zone == "extended" and stable:
            elapsed = t - self.cycle_start
            self.phase = "ready"
            self.cycle_start = None
            if elapsed >= self.min_cycle:
                self.count += 1
                return "cycle_completed"
            return "cycle_too_fast"
        return None


def elbow_angle(points, side, min_score=0.5, min_segment=0.015):
    """COCO17 points use normalized coordinates; returns a 2D projected angle.

    Caller must supply aspect-correct coordinates for angle calculation (pixel
    coordinates divided by one common image dimension), not independently
    stretched x/y. min_segment is measured in those same units.
    """
    if side not in ("left", "right"):
        raise ValueError("side must be left or right")
    indices = (5, 7, 9) if side == "left" else (6, 8, 10)
    if len(points) < 17:
        return None
    selected = [points[i] for i in indices]
    if any(len(p) < 3 or not all(math.isfinite(float(v)) for v in p[:3])
           or p[2] < min_score for p in selected):
        return None
    a, b, c = selected
    u = (a[0] - b[0], a[1] - b[1])
    v = (c[0] - b[0], c[1] - b[1])
    lu, lv = math.hypot(*u), math.hypot(*v)
    if min(lu, lv) < min_segment:
        return None
    cosine = max(-1.0, min(1.0, (u[0]*v[0] + u[1]*v[1]) / (lu*lv)))
    return math.degrees(math.acos(cosine))
