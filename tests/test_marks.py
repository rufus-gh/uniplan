import pytest

from uniplan.db import Assessment, AssessmentGroup
from uniplan.marks import band, compute


def g(i, w, drop=0, name=None):
    return AssessmentGroup(id=i, course_code="X", name=name or f"G{i}", weight=w, drop_lowest=drop, sort=i)


def a(i, gid, pts=10, score=None):
    return Assessment(id=f"a{i}", course_code="X", source="canvas", name=f"A{i}", group_id=gid, points_possible=pts,
                      score=score, graded=score is not None)


def test_weighted_average_and_bounds():
    groups = [g(1, 40), g(2, 60, name="Exam")]
    asm = [a(1, 1, 10, 8), a(2, 1, 10, None)]  # 20% each inside group 1
    m = compute(groups, asm)
    assert m.total_weight == 100
    assert m.graded_weight == pytest.approx(20)
    assert m.current_avg == pytest.approx(80)
    assert m.min_final == pytest.approx(16)
    assert m.max_final == pytest.approx(96)
    assert m.needed(80) == pytest.approx((80 - 16) / 80 * 100)


def test_points_proportional_within_group():
    m = compute([g(1, 30)], [a(1, 1, 10, 10), a(2, 1, 20, 0)])
    assert m.current_avg == pytest.approx(10 / 30 * 100)


def test_drop_lowest():
    m = compute([g(1, 30, drop=1)], [a(1, 1, 10, 2), a(2, 1, 10, 9), a(3, 1, 10, 7)])
    assert m.current_avg == pytest.approx(80)
    assert m.graded_weight == pytest.approx(30)


def test_empty_group_counts_as_remaining_and_warnings():
    m = compute([g(1, 50), g(2, 50)], [a(1, 1, 10, 5), a(9, None, 10, 10)])
    assert m.remaining_weight == pytest.approx(50)
    assert any("aren't in any weighted group" in w for w in m.warnings)


def test_whatif_and_projection():
    groups = [g(1, 50), g(2, 50)]
    asm = [a(1, 1, 10, 10), a(2, 2, 10, None)]
    m = compute(groups, asm, {"a2": 60})
    assert m.current_avg == pytest.approx(80)
    assert compute(groups, asm).projected(60) == pytest.approx(80)


def test_needed_table_statuses():
    m = compute([g(1, 90), g(2, 10)], [a(1, 1, 10, 10)])
    rows = dict((n, s) for n, _, s in m.needed_table())
    assert rows["HD"] == "secured"
    m2 = compute([g(1, 90), g(2, 10)], [a(1, 1, 10, 1)])
    assert dict((n, s) for n, _, s in m2.needed_table())["P"] == "not possible"


def test_bands():
    assert [band(x) for x in (85, 75, 65, 55, 10, None)] == ["HD", "D", "CR", "P", "N", "–"]


def test_excluded_and_duplicates_ignored():
    x = a(2, 1, 10, 0)
    x.excluded = True
    y = a(3, 1, 10, 0)
    y.duplicate_of = "a1"
    m = compute([g(1, 100)], [a(1, 1, 10, 10), x, y])
    assert m.current_avg == pytest.approx(100)


def test_combined_cap_like_comp3670():
    # A(21) + Q(4) + L(4) = 29% nominal, capped at 22%; mid-sem 23, final 55
    A, Q, L = g(1, 21), g(2, 4), g(3, 4)
    for x in (A, Q, L):
        x.capped = True
    groups = [A, Q, L, g(4, 23), g(5, 55)]
    asm = [a(1, 1, 30, 25.75), a(2, 1, 50, 45.5), a(3, 1, 30, 29.5),  # assignments
           a(4, 2, 10, 9), a(5, 3, 10, 10), a(6, 4, 100, 28 / 30 * 100)]  # quizzes, labs, mid-sem
    m = compute(groups, asm, cap=22)
    assert m.total_weight == pytest.approx(100)
    assert not m.warnings
    raw = 21 * (25.75 + 45.5 + 29.5) / 110 + 4 * 0.9 + 4 * 1.0
    assert m.cap_earned_raw == pytest.approx(raw)
    assert m.contribution == pytest.approx(22 + 23 * 28 / 30)  # bundle maxed at 22
    assert m.graded_weight == pytest.approx(45)
    assert m.max_final == pytest.approx(22 + 23 * 28 / 30 + 55)


def test_cap_not_reached_and_max():
    A = g(1, 29)
    A.capped = True
    m = compute([A, g(2, 78)], [a(1, 1, 10, 5), a(2, 1, 10, None)], cap=22)
    # earned 7.25 of nominal 29 so far; best case 7.25 + 14.5 = 21.75 < 22
    assert m.contribution == pytest.approx(7.25)
    assert m.max_final == pytest.approx((21.75 + 78) / 100 * 100)


def test_cap_ignored_without_value():
    A = g(1, 29)
    A.capped = True
    assert compute([A], [a(1, 1, 10, 10)]).total_weight == 29
