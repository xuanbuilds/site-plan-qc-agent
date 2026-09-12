"""
Zone classification from skeleton runs.

Deliberately NOT a pure width-threshold classifier. As discussed: a
24 ft wide segment could be a generous drive strip or a standard
two-way backup aisle — the number alone doesn't disambiguate. What
disambiguates is what the segment connects to. This module encodes
that as explicit rules; it is meant to be tuned against real examples,
not treated as final.
"""

from dataclasses import dataclass
from enum import Enum
from typing import List

from .skeleton import SkeletonGraph
from .width_profile import WidthProfile


class Zone(Enum):
    DRIVE_STRIP = "drive_strip"
    MANEUVERING = "maneuvering"
    STALL_BAY = "stall_bay"
    TURNAROUND = "turnaround"
    UNKNOWN = "unknown"


@dataclass
class ClassifiedRun:
    node_indices: List[int]
    avg_width: float
    zone: Zone
    reason: str  # human-readable justification, for QC audit trail


def classify_runs(
    graph: SkeletonGraph,
    profile: WidthProfile,
    runs: List[List[int]],
) -> List[ClassifiedRun]:
    branch_nodes = set(graph.branch_nodes())
    endpoint_nodes = set(graph.endpoint_nodes())

    results = []
    for run in runs:
        widths = [profile.node_width[i] for i in run]
        avg_width = sum(widths) / len(widths)
        start, end = run[0], run[-1]

        touches_endpoint = start in endpoint_nodes or end in endpoint_nodes
        touches_branch = start in branch_nodes or end in branch_nodes
        width_variance = max(widths) - min(widths)

        # These thresholds are placeholders (feet), meant to be replaced
        # with the actual Austin TCM values once real test geometry is
        # available — see docs/approach.md, "not final" note.
        if touches_endpoint and not touches_branch:
            zone = Zone.DRIVE_STRIP
            reason = "run terminates at an unbranched endpoint (candidate street connection)"
        elif width_variance > avg_width * 0.4 and avg_width > 15:
            zone = Zone.TURNAROUND
            reason = "wide, high width-variance run — bulge suggests turnaround/hammerhead"
        elif touches_branch and avg_width < 12:
            zone = Zone.STALL_BAY
            reason = "narrow run off a branch point — candidate stall access"
        elif touches_branch:
            zone = Zone.MANEUVERING
            reason = "run adjacent to a branch (stall or turn) rather than terminating at street"
        else:
            zone = Zone.UNKNOWN
            reason = "no rule matched confidently — needs manual review"

        results.append(ClassifiedRun(
            node_indices=run,
            avg_width=avg_width,
            zone=zone,
            reason=reason,
        ))

    return results
