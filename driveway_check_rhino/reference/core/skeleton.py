"""
Approximate medial axis (skeleton) extraction for a 2D polygon footprint.

No RhinoCommon dependency by design — this operates on plain (x, y) point
lists, so it can be developed and unit-tested standalone. The Rhino-side
adapter (see rhino_adapter/extract.py) is responsible for turning a brep's
boundary into the polygon this module expects, and nothing more.

Method: Voronoi-based approximate medial axis.
  1. Densely sample the polygon boundary (exterior + holes) into points.
  2. Compute the Voronoi diagram of those boundary points.
  3. Keep only Voronoi edges whose both endpoints fall strictly inside
     the polygon. What survives approximates the medial axis.

This is a well-known lightweight approximation, not an exact straight-
skeleton solver. It's adequate for classification (we care about the
*shape* of the skeleton graph and the width profile along it, not
perfect geometric exactness). If the approximation proves too noisy on
real footprints, an exact straight-skeleton library is the fallback —
noted in docs/approach.md.
"""

from dataclasses import dataclass
from typing import List, Tuple

import numpy as np
from scipy.spatial import Voronoi
from shapely.geometry import Polygon, Point
from shapely.prepared import prep

Point2D = Tuple[float, float]


@dataclass
class SkeletonGraph:
    nodes: List[Point2D]
    edges: List[Tuple[int, int]]  # index pairs into `nodes`

    def degree(self, node_idx: int) -> int:
        return sum(1 for a, b in self.edges if a == node_idx or b == node_idx)

    def branch_nodes(self) -> List[int]:
        """Nodes where the skeleton splits (degree >= 3) — candidate
        boundaries between functional zones (e.g. aisle meets stall)."""
        return [i for i in range(len(self.nodes)) if self.degree(i) >= 3]

    def endpoint_nodes(self) -> List[int]:
        """Degree-1 nodes — candidate drive-strip terminations (street
        connection) or dead-end turnarounds."""
        return [i for i in range(len(self.nodes)) if self.degree(i) == 1]


def _sample_boundary(polygon: Polygon, spacing: float) -> np.ndarray:
    """Densely sample points along the exterior and any interior rings."""
    pts = []
    rings = [polygon.exterior] + list(polygon.interiors)
    for ring in rings:
        length = ring.length
        n = max(int(length / spacing), 8)
        for i in range(n):
            p = ring.interpolate(i / n, normalized=True)
            pts.append((p.x, p.y))
    return np.array(pts)


def extract_skeleton(polygon: Polygon, sample_spacing: float) -> SkeletonGraph:
    """
    Build an approximate medial axis for `polygon`.

    sample_spacing: distance between boundary sample points, in the same
    units as the polygon coordinates. Smaller = finer skeleton but more
    compute. As a starting point, use roughly 1/10th of the narrowest
    feature you expect to resolve (e.g. if the drive strip is 10 ft wide,
    try spacing ~1 ft).
    """
    boundary_pts = _sample_boundary(polygon, sample_spacing)
    vor = Voronoi(boundary_pts)

    prepared = prep(polygon)
    nodes: List[Point2D] = []
    node_index = {}

    def get_node_idx(vertex_idx: int):
        if vertex_idx in node_index:
            return node_index[vertex_idx]
        idx = len(nodes)
        nodes.append(tuple(vor.vertices[vertex_idx]))
        node_index[vertex_idx] = idx
        return idx

    edges = []
    for (v1, v2) in vor.ridge_vertices:
        if v1 == -1 or v2 == -1:
            continue  # unbounded ridge, discard
        p1, p2 = vor.vertices[v1], vor.vertices[v2]
        if prepared.contains(Point(p1)) and prepared.contains(Point(p2)):
            i1, i2 = get_node_idx(v1), get_node_idx(v2)
            edges.append((i1, i2))

    return SkeletonGraph(nodes=nodes, edges=edges)
