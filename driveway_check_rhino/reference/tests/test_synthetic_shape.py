"""
Sanity test on a synthetic footprint — NOT a real site plan.

Shape: a 12ft-wide drive strip running 60ft, feeding into a 24ft-wide
backup aisle running 40ft, with one 9x18ft stall notch cut into the
aisle's far side. Dimensions in feet.

This exists purely to prove the skeleton -> width-profile -> classify
pipeline runs end to end and produces plausible output. It is NOT
validation against real Austin TCM geometry, and the classify.py
thresholds are explicitly placeholders.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from shapely.geometry import Polygon
from core.skeleton import extract_skeleton
from core.width_profile import compute_width_profile, constant_width_runs
from core.classify import classify_runs


def build_synthetic_footprint() -> Polygon:
    # Drive strip: x in [0,60], y in [0,12]
    # Aisle: x in [50,90], y in [-6,18]  (wider, overlaps strip's end)
    # Stall notch: a 9x18 rectangle cut into the aisle's north edge
    strip = [(0, 0), (60, 0), (60, 12), (0, 12)]
    aisle = [(50, -6), (90, -6), (90, 18), (50, 18)]

    from shapely.geometry import Polygon as P
    from shapely.ops import unary_union
    combined = unary_union([P(strip), P(aisle)])

    # cut a stall notch into the north (+y) edge of the aisle
    notch = P([(65, 18), (74, 18), (74, 27), (65, 27)])
    combined = combined.union(notch)

    return combined


def main():
    poly = build_synthetic_footprint()
    print(f"Polygon area: {poly.area:.1f} sq ft, valid: {poly.is_valid}")

    graph = extract_skeleton(poly, sample_spacing=2.0)
    print(f"Skeleton: {len(graph.nodes)} nodes, {len(graph.edges)} edges")
    print(f"Branch nodes: {graph.branch_nodes()}")
    print(f"Endpoint nodes: {graph.endpoint_nodes()}")

    profile = compute_width_profile(poly, graph)
    runs = constant_width_runs(graph, profile, tolerance=3.0)
    print(f"\nSegmented into {len(runs)} runs:")

    classified = classify_runs(graph, profile, runs)
    for c in classified:
        print(f"  width~{c.avg_width:5.1f}ft  zone={c.zone.value:12s}  {c.reason}")


if __name__ == "__main__":
    main()
