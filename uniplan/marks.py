"""Weighted mark calculations, grade bands and what-if projections."""
from __future__ import annotations

from dataclasses import dataclass, field

from .db import Assessment, AssessmentGroup

# ANU grade bands (percentage lower bounds)
BANDS = [("HD", 80.0), ("D", 70.0), ("CR", 60.0), ("P", 50.0)]


def band(pct: float | None) -> str:
    if pct is None:
        return "–"
    for name, lo in BANDS:
        if pct >= lo - 1e-9:
            return name
    return "N"


@dataclass
class ItemResult:
    assessment: Assessment
    weight: float  # share of the course total (same units as group weights)
    pct: float | None  # 0..1, None if not graded
    dropped: bool = False
    hypothetical: bool = False


@dataclass
class GroupResult:
    group: AssessmentGroup
    items: list[ItemResult] = field(default_factory=list)
    graded_weight: float = 0.0
    contribution: float = 0.0
    empty: bool = False

    @property
    def pct(self) -> float | None:
        return self.contribution / self.graded_weight * 100 if self.graded_weight > 0 else None


@dataclass
class CourseMarks:
    total_weight: float
    graded_weight: float
    contribution: float
    groups: list[GroupResult]
    unassigned: list[Assessment]
    warnings: list[str]
    max_contribution: float | None = None
    cap: float = 0.0  # combined cap (0 = none)
    cap_nominal: float = 0.0  # sum of the capped groups' weights
    cap_earned_raw: float = 0.0  # what you've earned in the capped groups before the cap

    @property
    def remaining_weight(self) -> float:
        return max(0.0, self.total_weight - self.graded_weight)

    @property
    def current_avg(self) -> float | None:
        return self.contribution / self.graded_weight * 100 if self.graded_weight > 0 else None

    @property
    def graded_share(self) -> float:
        return self.graded_weight / self.total_weight * 100 if self.total_weight else 0.0

    @property
    def min_final(self) -> float | None:
        return self.contribution / self.total_weight * 100 if self.total_weight else None

    @property
    def max_final(self) -> float | None:
        if not self.total_weight:
            return None
        best = self.max_contribution if self.max_contribution is not None else self.contribution + self.remaining_weight
        return best / self.total_weight * 100

    def needed(self, target: float) -> float | None:
        """Average % needed on everything remaining to reach `target` final. <=0 secured, >100 impossible."""
        if not self.total_weight or self.remaining_weight <= 1e-9:
            return None
        return (target / 100 * self.total_weight - self.contribution) / self.remaining_weight * 100

    def projected(self, remaining_pct: float) -> float | None:
        if not self.total_weight:
            return None
        return (self.contribution + self.remaining_weight * remaining_pct / 100) / self.total_weight * 100

    @property
    def secured_band(self) -> str | None:
        lo_final = self.min_final or 0
        return next((name for name, lo in BANDS if lo_final >= lo - 1e-9), None)

    @property
    def target(self) -> tuple[str, float] | None:
        """Highest band still reachable but not yet secured, with the average needed on what's left."""
        for name, lo in BANDS:
            n = self.needed(lo)
            if n is not None and 0 < n <= 100:
                return name, n
        return None

    @property
    def bar(self) -> tuple[float, float, float]:
        """(earned, lost, remaining) as % of the course, for a segmented progress bar."""
        if not self.total_weight:
            return 0.0, 0.0, 100.0
        earned = self.contribution / self.total_weight * 100
        lost = max(0.0, (self.graded_weight - self.contribution) / self.total_weight * 100)
        return earned, lost, max(0.0, 100 - earned - lost)

    def needed_table(self) -> list[tuple[str, float, str]]:
        rows = []
        for name, lo in BANDS:
            n = self.needed(lo)
            if n is None:
                status = "secured" if (self.min_final or 0) >= lo else "missed"
            elif n <= 0:
                status = "secured"
            elif n > 100:
                status = "not possible"
            else:
                status = f"{n:.1f}%"
            rows.append((name, lo, status))
        return rows


def _counts(a: Assessment) -> bool:
    return not a.excluded and not a.hidden and a.duplicate_of is None


def compute(groups: list[AssessmentGroup], assessments: list[Assessment],
            whatif: dict[str, float] | None = None, cap: float = 0.0) -> CourseMarks:
    """whatif maps assessment id -> hypothetical percentage (0-100) for ungraded items.
    cap > 0: groups with capped=True together contribute at most `cap` % (e.g. COMP3670: 29% nominal capped at 22%)."""
    whatif = whatif or {}
    cap = cap or 0.0
    active_groups = [g for g in groups if (g.weight or 0) > 0]
    capped = [g for g in active_groups if g.capped] if cap > 0 else []
    total = sum(g.weight for g in active_groups if g not in capped) + (cap if capped else 0)
    warnings = []
    if active_groups and abs(total - 100) > 0.5:
        warnings.append(f"Weights add up to {total:g}%, not 100% (results are scaled to {total:g}).")
    by_group: dict[int, list[Assessment]] = {g.id: [] for g in groups}
    unassigned = []
    for a in assessments:
        if not _counts(a):
            continue
        if a.group_id in by_group:
            by_group[a.group_id].append(a)
        else:
            unassigned.append(a)
    results, graded_w, contrib, max_c = [], 0.0, 0.0, 0.0
    raw_graded = raw_earned = raw_left = 0.0
    for g in sorted(active_groups, key=lambda g: g.sort):
        members = by_group.get(g.id, [])
        gr = GroupResult(group=g, empty=not members)
        if members:
            pts = [a.points_possible or 0 for a in members]
            use_points = all(p > 0 for p in pts)
            denom = sum(pts) if use_points else len(members)
            items = []
            for a, p in zip(members, pts):
                w = g.weight * ((p / denom) if use_points else 1 / denom)
                pct, hyp = None, False
                if a.graded and a.score is not None and a.points_possible:
                    pct = a.score / a.points_possible
                elif a.id in whatif:
                    pct, hyp = whatif[a.id] / 100, True
                items.append(ItemResult(a, w, pct, hypothetical=hyp))
            if g.drop_lowest > 0:
                graded = sorted([i for i in items if i.pct is not None], key=lambda i: i.pct)
                if len(graded) > g.drop_lowest:
                    for i in graded[: g.drop_lowest]:
                        i.dropped = True
                    kept = [i for i in items if not i.dropped]
                    kept_w = sum(i.weight for i in kept)
                    for i in kept:
                        i.weight = i.weight / kept_w * g.weight if kept_w else 0
            for i in items:
                if i.pct is not None and not i.dropped:
                    gr.graded_weight += i.weight
                    gr.contribution += i.weight * i.pct
            gr.items = items
        if g in capped:
            raw_graded += gr.graded_weight
            raw_earned += gr.contribution
            raw_left += g.weight - gr.graded_weight
        else:
            graded_w += gr.graded_weight
            contrib += gr.contribution
            max_c += gr.contribution + (g.weight - gr.graded_weight)
        results.append(gr)
    if capped:
        graded_w += min(raw_graded, cap)
        contrib += min(raw_earned, cap)
        max_c += min(raw_earned + raw_left, cap)
    if unassigned and active_groups:
        warnings.append(f"{len(unassigned)} assessment(s) aren't in any weighted group, so they don't count yet.")
    if not active_groups:
        warnings.append("No assessment weightings yet - add them on this page.")
    return CourseMarks(total, graded_w, contrib, results, unassigned, warnings, max_c, cap if capped else 0.0,
                       sum(g.weight for g in capped), raw_earned)
