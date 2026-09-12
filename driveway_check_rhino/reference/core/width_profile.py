"""
Local width measurement along a skeleton.

For each skeleton node, the distance to the nearest polygon boundary is
half the local footprint width at that point (this is the standard
medial-axis property: every skeleton point is equidistant from at least
two boundary points, and that distance is the inscribed-circle radius).

This module has no RhinoCommon dependency, same rationale as skeleton.py.
"""

from dataclasses import dataclass
from typing import Dict, List

from shapely.geometry import Polygon, Point

from .skeleton import SkeletonGraph


@dataclass
class WidthProfile:
    # width at each skeleton node, keyed by node index
    node_width: Dict[int, float]

    def edge_width(self, graph: SkeletonGraph, edge_idx: int) -> float:
        """Average width along one skeleton edge (its two endpoints)."""
        a, b = graph.edges[edge_idx]
        return (self.node_width[a] + self.node_width[b]) / 2.0


def compute_width_profile(polygon: Polygon, graph: SkeletonGraph) -> WidthProfile:
    boundary = polygon.exterior
    node_width = {}
    for i, (x, y) in enumerate(graph.nodes):
        d = boundary.distance(Point(x, y))
        node_width[i] = 2.0 * d
    return WidthProfile(node_width=node_width)


def constant_width_runs(
    graph: SkeletonGraph,
    profile: WidthProfile,
    tolerance: float,
) -> List[List[int]]:
    """
    Walk the skeleton graph and group contiguous edges into runs where
    width stays within `tolerance` of the run's starting width.

    A new run starts at every branch node (degree >= 3) and every
    endpoint (degree 1), since those are natural zone-boundary
    candidates regardless of width — see docs/approach.md on why width
    alone under-determines the label (a drive strip and an aisle can
    have overlapping width ranges; what changes is what the segment
    connects to).

    Returns a list of runs, each run a list of node indices in order.
    This is intentionally a *segmentation* step, not a *classification*
    step — labeling a run as "drive strip" vs "aisle" vs "turnaround"
    needs adjacency context (see classify.py) beyond width alone.
    """
    # Build adjacency
    adjacency: Dict[int, List[int]] = {i: [] for i in range(len(graph.nodes))}
    for a, b in graph.edges:
        adjacency[a].append(b)
        adjacency[b].append(a)

    visited_edges = set()
    runs = []

    def edge_key(a, b):
        return tuple(sorted((a, b)))

    # Start runs from every branch/endpoint node
    seed_nodes = [i for i in range(len(graph.nodes))
                  if len(adjacency[i]) != 2]
    if not seed_nodes:
        seed_nodes = [0]  # closed loop with no branches; arbitrary start

    for start in seed_nodes:
        for neighbor in adjacency[start]:
            key = edge_key(start, neighbor)
            if key in visited_edges:
                continue
            run = [start]
            prev, curr = start, neighbor
            run_start_width = profile.node_width[start]
            while True:
                visited_edges.add(edge_key(prev, curr))
                run.append(curr)
                if abs(profile.node_width[curr] - run_start_width) > tolerance:
                    break
                if len(adjacency[curr]) != 2:
                    break  # hit another branch/endpoint, run ends here
                nxts = [n for n in adjacency[curr] if n != prev]
                if not nxts:
                    break
                prev, curr = curr, nxts[0]
            runs.append(run)

    return runs
