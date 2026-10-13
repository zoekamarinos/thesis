import os
import json
import numpy as np
import pandas as pd
from flask import Flask, request, jsonify
from flask_cors import CORS
from openai import OpenAI
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

app = Flask(__name__)
CORS(app)

api_key = os.environ.get("OPENAI_API_KEY")
if not api_key:
    raise RuntimeError("OPENAI_API_KEY environment variable is not set.")

client = OpenAI(api_key=api_key)
MODEL = "gpt-4o"  # Flagship model optimized for high-level mathematical scripting

# Global dictionary acting as an in-memory data layer for sandboxed scripts
ACTIVE_DATASET = {}


# ---------------------------------------------------------------------
# Pure-NumPy geometric helpers.
#
# The sandbox used to hand the LLM nothing but `np`/`pd` and expect it
# to write correct nearest-neighbor / RMSE / Hausdorff code from
# scratch every time. That failed in two compounding ways: the model
# reached for `scipy.spatial.cKDTree`, which was never installed in
# this environment, so the `import` raised ModuleNotFoundError inside
# the exec'd script; and because that happened partway through the
# generated code, later lines that were supposed to define things
# like `mse` never ran, surfacing as a separate "undefined variable"
# error that looked unrelated but had the same root cause.
#
# Rather than hoping the model writes bug-free distance-matrix code
# (and happens to have scipy available) every single time, these
# helpers implement the exact metrics the system prompt asks for,
# using only NumPy. The model calls these instead of reinventing them.
# ---------------------------------------------------------------------

def _nearest_neighbor_deviations(data_points, eval_points):
    """
    For each point in data_points, the Euclidean distance to its
    nearest point in eval_points. Pure NumPy (no scipy.spatial
    required) -- done in row chunks so the pairwise distance matrix
    never gets large enough to be a memory problem.
    """
    data = np.asarray(data_points, dtype=float)
    evals = np.asarray(eval_points, dtype=float)

    if data.size == 0 or evals.size == 0:
        return np.array([])

    chunk = 200
    mins = []

    for i in range(0, len(data), chunk):
        block = data[i:i + chunk]
        diffs = block[:, None, :] - evals[None, :, :]
        dists = np.linalg.norm(diffs, axis=-1)
        mins.append(dists.min(axis=1))

    return np.concatenate(mins)


def error_report(data_points, eval_points, label=""):
    """
    The full error statistical suite the system prompt asks for --
    RMSE, MAE, max deviation (one-directional Hausdorff: how far the
    data strays from the fitted surface), variance, and standard
    deviation -- computed once, correctly, so the model doesn't have
    to assemble it by hand (and can't leave a variable undefined
    partway through).
    """
    deviations = _nearest_neighbor_deviations(data_points, eval_points)

    if deviations.size == 0:
        return {"label": label, "error": "No points available to compare."}

    return {
        "label": label,
        "point_count": int(deviations.size),
        "rmse": float(np.sqrt(np.mean(deviations ** 2))),
        "mae": float(np.mean(np.abs(deviations))),
        "max_deviation": float(deviations.max()),
        "std": float(deviations.std()),
        "variance": float(deviations.var()),
    }


def hausdorff_distance(points_a, points_b):
    """
    Symmetric Hausdorff distance between two point sets: the worst
    (largest) nearest-neighbor gap in either direction.
    """
    a_to_b = _nearest_neighbor_deviations(points_a, points_b)
    b_to_a = _nearest_neighbor_deviations(points_b, points_a)

    if a_to_b.size == 0 or b_to_a.size == 0:
        return float("nan")

    return float(max(a_to_b.max(), b_to_a.max()))


def bounding_box(points):
    """Min/max/diagonal of a point set, for scaling error metrics against."""
    pts = np.asarray(points, dtype=float)

    if pts.size == 0:
        return {}

    mins = pts.min(axis=0)
    maxs = pts.max(axis=0)

    return {
        "min": mins.tolist(),
        "max": maxs.tolist(),
        "diagonal": float(np.linalg.norm(maxs - mins)),
    }


def count_ctrlpts(patch_list):
    """Total control points used across a list of patches."""
    return sum(len(p.get("ctrlpts", [])) for p in patch_list)


def patch_error_summary(patches, label=""):
    """
    Runs error_report across every patch in a patch list (comparing
    each patch's own datapts against its own evalpts) and rolls the
    per-patch results up into one summary dict, plus a total
    control-point count -- the two things the system prompt's
    "control point efficiency" comparison needs side by side.
    """
    per_patch = []

    for i, patch in enumerate(patches):
        datapts = patch.get("datapts", [])
        evalpts = patch.get("evalpts", [])
        per_patch.append(error_report(datapts, evalpts, label=f"{label} patch {i}"))

    valid = [p for p in per_patch if "rmse" in p]

    # overall_rmse / overall_max_deviation are ALWAYS present (never a
    # conditionally-missing key), even when there's nothing valid to
    # compute them from -- that's what the KeyError-style failures
    # upstream amounted to: code written against a dict that didn't
    # always have the same shape. None here means "not computable",
    # which calling code can check for explicitly rather than hitting
    # a KeyError.
    overall = {
        "label": label,
        "patch_count": len(patches),
        "total_ctrlpts": count_ctrlpts(patches),
        "per_patch": per_patch,
        "overall_rmse": None,
        "overall_max_deviation": None,
    }

    if valid:
        overall["overall_rmse"] = float(
            np.sqrt(np.mean([p["rmse"] ** 2 for p in valid]))
        )
        overall["overall_max_deviation"] = float(
            max(p["max_deviation"] for p in valid)
        )

    return overall


def compare_fits(approximate_patches, interpolate_patches):
    """
    The full approximate-vs-interpolate comparison in a single safe
    call: runs patch_error_summary on each side and rolls the headline
    numbers up into unambiguous, always-present top-level keys, so
    there's no nested dict key name to guess and no need to zip or
    index two patch lists by hand (they're allowed to have different
    lengths or be empty -- this never raises for that reason).

    Returns a dict with (all always present, None where not
    computable):
        approximate, interpolate            -- full patch_error_summary() dicts
        overall_rmse_approximate            -- float or None
        overall_rmse_interpolate            -- float or None
        overall_max_deviation_approximate   -- float or None
        overall_max_deviation_interpolate   -- float or None
        total_ctrlpts_approximate           -- int
        total_ctrlpts_interpolate           -- int
        better_fit_by_rmse                  -- "approximate" | "interpolate" | "tie" | None
        better_fit_by_max_deviation         -- "approximate" | "interpolate" | "tie" | None
        more_efficient_by_ctrlpts           -- "approximate" | "interpolate" | "tie"
    """
    approx_summary = patch_error_summary(approximate_patches or [], label="approximate")
    interp_summary = patch_error_summary(interpolate_patches or [], label="interpolate")

    def _pick_better(a, b):
        if a is None or b is None:
            return None
        if a == b:
            return "tie"
        return "approximate" if a < b else "interpolate"

    a_ctrl = approx_summary["total_ctrlpts"]
    i_ctrl = interp_summary["total_ctrlpts"]
    ctrl_winner = "tie" if a_ctrl == i_ctrl else ("approximate" if a_ctrl < i_ctrl else "interpolate")

    return {
        "approximate": approx_summary,
        "interpolate": interp_summary,
        "overall_rmse_approximate": approx_summary["overall_rmse"],
        "overall_rmse_interpolate": interp_summary["overall_rmse"],
        "overall_max_deviation_approximate": approx_summary["overall_max_deviation"],
        "overall_max_deviation_interpolate": interp_summary["overall_max_deviation"],
        "total_ctrlpts_approximate": a_ctrl,
        "total_ctrlpts_interpolate": i_ctrl,
        "better_fit_by_rmse": _pick_better(
            approx_summary["overall_rmse"], interp_summary["overall_rmse"]
        ),
        "better_fit_by_max_deviation": _pick_better(
            approx_summary["overall_max_deviation"], interp_summary["overall_max_deviation"]
        ),
        "more_efficient_by_ctrlpts": ctrl_winner,
    }


def per_patch_method_comparison(approximate_patches, interpolate_patches):
    """
    compare_fits() above only compares the two methods in aggregate.
    This compares them PATCH BY PATCH (matched by index), since one
    method can fit some parts of a multi-patch object better and
    other parts worse -- useful for deciding whether to mix methods
    across patches rather than picking one globally.

    Patches are paired up to the shorter list's length; any patches
    beyond that are reported as unmatched counts rather than raising
    (the two lists are allowed to differ, e.g. if one fit failed on a
    block the other handled -- see the backend's own per-block
    warnings).
    """
    approximate_patches = approximate_patches or []
    interpolate_patches = interpolate_patches or []
    n = min(len(approximate_patches), len(interpolate_patches))

    per_patch = []

    for i in range(n):
        a_patch = approximate_patches[i]
        b_patch = interpolate_patches[i]

        a = error_report(
            a_patch.get("datapts", []), a_patch.get("evalpts", []),
            label=f"approximate patch {i}"
        )
        b = error_report(
            b_patch.get("datapts", []), b_patch.get("evalpts", []),
            label=f"interpolate patch {i}"
        )

        winner = None
        if "rmse" in a and "rmse" in b:
            if a["rmse"] == b["rmse"]:
                winner = "tie"
            else:
                winner = "approximate" if a["rmse"] < b["rmse"] else "interpolate"

        per_patch.append({
            "patch_index": i,
            "approximate_rmse": a.get("rmse"),
            "interpolate_rmse": b.get("rmse"),
            "approximate_ctrlpts": len(a_patch.get("ctrlpts", [])),
            "interpolate_ctrlpts": len(b_patch.get("ctrlpts", [])),
            "better_by_rmse": winner,
        })

    return {
        "per_patch": per_patch,
        "unmatched_approximate_patches": len(approximate_patches) - n,
        "unmatched_interpolate_patches": len(interpolate_patches) - n,
    }


# ---------------------------------------------------------------------
# Seam / connectivity diagnostics.
#
# Mirrors the frontend's own shared-edge detection (Clouds.tsx compares
# patch boundary points pairwise within a tolerance to find seams to
# stitch) so the chatbot can report the same connections as numbers,
# rather than requiring someone to click around the viewer to spot a
# gap.
# ---------------------------------------------------------------------

_BOUNDARY_SIDES = ("u_start", "u_end", "v_start", "v_end")


def _grid_boundary(points, size_u, size_v, side):
    """One edge (as an (N, 3) array) of a size_u x size_v point grid."""
    pts = np.asarray(points, dtype=float).reshape(int(size_u), int(size_v), 3)

    if side == "u_start":
        return pts[0, :, :]
    if side == "u_end":
        return pts[-1, :, :]
    if side == "v_start":
        return pts[:, 0, :]
    if side == "v_end":
        return pts[:, -1, :]

    raise ValueError(f"Unknown side: {side!r}. Must be one of {_BOUNDARY_SIDES}.")


def patch_boundary(patch, side, use="datapts"):
    """
    One edge of a patch as a (N, 3) array, for seam comparisons.

    use="datapts" (default) uses the original fitted input points and
    their actual data grid shape (data_size_u/data_size_v) -- this is
    usually what you want when checking whether two patches were
    MEANT to share a seam, since it reflects the source geometry
    rather than how densely each patch happens to be evaluated.
    use="evalpts" uses the dense evaluated surface instead
    (sample_size_u/sample_size_v).

    Returns an empty (0, 3) array -- never raises -- if the patch is
    missing the fields needed to reshape it (e.g. an older patch
    dict without data_size_u/data_size_v).
    """
    if use == "datapts":
        size_u = patch.get("data_size_u")
        size_v = patch.get("data_size_v")
        points = patch.get("datapts")
    else:
        size_u = patch.get("sample_size_u")
        size_v = patch.get("sample_size_v")
        points = patch.get("evalpts")

    if not size_u or not size_v or not points:
        return np.empty((0, 3))

    try:
        return _grid_boundary(points, size_u, size_v, side)
    except Exception:
        return np.empty((0, 3))


def seam_report(patches, tolerance_frac=0.02, use="datapts"):
    """
    Checks every side of every patch against every side of every
    other patch for a shared seam, the same way the frontend's own
    boundary-matching does for its click-to-smooth edges -- but as
    numbers you can read directly instead of a UI you have to click
    around.

    For each pair of patch sides, computes the mean nearest-neighbor
    distance between their boundary points (the two sides don't need
    the same point count or order) and calls it "connected" if that
    gap is small relative to the overall scene scale
    (tolerance_frac x the combined bounding-box diagonal -- 0.02 is
    the same fraction the frontend itself uses).

    Returns a dict:
        connections -- every side pair whose gap is at least in the
                        right ballpark to plausibly be a seam (within
                        5x tolerance), each with mean_gap and a
                        connected True/False verdict
        gaps        -- the subset of connections that are close but
                        NOT within tolerance: a seam that looks like
                        it was meant to touch but doesn't quite
        tolerance_used -- the actual distance threshold used

    Never raises for missing/malformed patches -- sides without
    enough information to check are silently skipped.
    """
    patches = patches or []

    all_points = []
    for p in patches:
        pts = p.get("datapts") if use == "datapts" else p.get("evalpts")
        if pts:
            all_points.extend(pts)

    if not all_points:
        return {"connections": [], "gaps": [], "error": "No points to check."}

    scale = bounding_box(all_points).get("diagonal") or 1.0
    tolerance = tolerance_frac * scale

    connections = []
    gaps = []

    for i in range(len(patches)):
        for side_a in _BOUNDARY_SIDES:
            bound_a = patch_boundary(patches[i], side_a, use=use)
            if bound_a.size == 0:
                continue

            for j in range(i + 1, len(patches)):
                for side_b in _BOUNDARY_SIDES:
                    bound_b = patch_boundary(patches[j], side_b, use=use)
                    if bound_b.size == 0:
                        continue

                    d_ab = _nearest_neighbor_deviations(bound_a, bound_b)
                    d_ba = _nearest_neighbor_deviations(bound_b, bound_a)
                    mean_gap = float(np.mean(np.concatenate([d_ab, d_ba])))

                    # Only worth reporting if it's in the right ballpark
                    # to plausibly be a shared seam at all.
                    if mean_gap > tolerance * 5:
                        continue

                    entry = {
                        "patch_a": i,
                        "side_a": side_a,
                        "patch_b": j,
                        "side_b": side_b,
                        "mean_gap": mean_gap,
                        "connected": mean_gap <= tolerance,
                    }
                    connections.append(entry)
                    if not entry["connected"]:
                        gaps.append(entry)

    return {
        "connections": connections,
        "gaps": gaps,
        "tolerance_used": tolerance,
    }


def boundary_on_surface_report(patches, tolerance_frac=0.02):
    """
    seam_report only finds connections at patch EDGES -- it can't see
    a protrusion emerging from the middle of a closed surface (e.g. a
    cylinder meeting a sphere at a latitude ring), because that
    junction is an INTERIOR row of the sphere's grid, not one of its
    u/v boundaries. There's no edge there for seam_report to match
    against.

    This checks the complementary case: for every patch's edge,
    whether it lies on top of some OTHER patch's full surface (its
    dense evalpts, not just that other patch's own edges). Covers
    exactly the "protrusion from a closed surface" shape that
    seam_report structurally can't.

    Returns a dict:
        matches -- list of {patch_a, side_a, patch_b, mean_gap,
                             on_surface} for every pair whose gap is
                   at least in the right ballpark (patch_b here means
                   "patch_a's side_a sits on patch_b's surface")
        tolerance_used
    """
    patches = patches or []

    all_points = []
    for p in patches:
        if p.get("evalpts"):
            all_points.extend(p["evalpts"])

    if not all_points:
        return {"matches": [], "error": "No surface points to check."}

    scale = bounding_box(all_points).get("diagonal") or 1.0
    tolerance = tolerance_frac * scale

    matches = []

    for i in range(len(patches)):
        for side_a in _BOUNDARY_SIDES:
            bound = patch_boundary(patches[i], side_a, use="datapts")
            if bound.size == 0:
                continue

            for j in range(len(patches)):
                if j == i:
                    continue

                target_surface = patches[j].get("evalpts")
                if not target_surface:
                    continue

                dists = _nearest_neighbor_deviations(bound, target_surface)
                if dists.size == 0:
                    continue

                mean_gap = float(dists.mean())
                if mean_gap > tolerance * 5:
                    continue

                matches.append({
                    "patch_a": i,
                    "side_a": side_a,
                    "patch_b": j,
                    "mean_gap": mean_gap,
                    "on_surface": mean_gap <= tolerance,
                })

    return {"matches": matches, "tolerance_used": tolerance}


def run_python_analysis_sandbox(code_string: str) -> str:
    """
    Executes Python data analysis code written autonomously by the LLM
    against the full, un-truncated NURBS patch arrays.
    """
    # Unified dictionary for globals and locals to resolve Python's exec closure behavior
    scope = {
        "approximate_patches": ACTIVE_DATASET.get("approximatePatches", []),
        "interpolate_patches": ACTIVE_DATASET.get("interpolatePatches", []),
        "legacy_patches": ACTIVE_DATASET.get("patches", []),
        "np": np,
        "pd": pd,
        # Pre-built, numpy-only metric helpers -- see the block above.
        # The model should prefer these over hand-rolling scipy-based
        # distance matrices, which aren't guaranteed to be installed
        # in this sandbox.
        "nearest_neighbor_deviations": _nearest_neighbor_deviations,
        "error_report": error_report,
        "hausdorff_distance": hausdorff_distance,
        "bounding_box": bounding_box,
        "count_ctrlpts": count_ctrlpts,
        "patch_error_summary": patch_error_summary,
        "compare_fits": compare_fits,
        "per_patch_method_comparison": per_patch_method_comparison,
        "seam_report": seam_report,
        "boundary_on_surface_report": boundary_on_surface_report,
        "patch_boundary": patch_boundary,
    }

    # Wrap code block into an internal function execution structure
    indented_code = "\n    ".join(code_string.split("\n"))
    wrapper_code = f"""
def __run_analysis():
    {indented_code}

output = __run_analysis()
"""
    try:
        # Passing 'scope' as a single argument uses it as BOTH globals and locals
        exec(wrapper_code, scope)

        execution_result = scope.get("output")
        if execution_result is None:
            return "Code executed successfully but returned a void/None value. Please ensure your Python scripts explicitly 'return' a statistical report string, a dict, or metric strings."

        return str(execution_result)
    except ModuleNotFoundError as e:
        return (
            f"Runtime Execution Error: {str(e)}. This sandbox only has "
            "numpy and pandas installed -- scipy and other third-party "
            "packages are not available. Use the provided helper "
            "functions instead (error_report, hausdorff_distance, "
            "bounding_box, count_ctrlpts, patch_error_summary, "
            "nearest_neighbor_deviations), which compute the same "
            "metrics without needing scipy."
        )
    except KeyError as e:
        return (
            f"Runtime Execution Error: no key {str(e)} in that dict. "
            "Don't guess a key name -- the helper functions always "
            "return exactly these keys: compare_fits() returns "
            "approximate, interpolate, overall_rmse_approximate, "
            "overall_rmse_interpolate, overall_max_deviation_approximate, "
            "overall_max_deviation_interpolate, total_ctrlpts_approximate, "
            "total_ctrlpts_interpolate, better_fit_by_rmse, "
            "better_fit_by_max_deviation, more_efficient_by_ctrlpts. "
            "patch_error_summary() returns label, patch_count, "
            "total_ctrlpts, per_patch, overall_rmse, "
            "overall_max_deviation. error_report() returns label, "
            "point_count, rmse, mae, max_deviation, std, variance. "
            "per_patch_method_comparison() returns per_patch, "
            "unmatched_approximate_patches, unmatched_interpolate_patches "
            "-- each per_patch entry has patch_index, approximate_rmse, "
            "interpolate_rmse, approximate_ctrlpts, interpolate_ctrlpts, "
            "better_by_rmse. seam_report() returns connections, gaps, "
            "tolerance_used -- each entry has patch_a, side_a, patch_b, "
            "side_b, mean_gap, connected. boundary_on_surface_report() "
            "returns matches, tolerance_used -- each entry has "
            "patch_a, side_a, patch_b, mean_gap, on_surface. "
            "Re-check the exact key name against this list."
        )
    except Exception as e:
        return f"Runtime Execution Error: {str(e)}"


@app.route("/analyze-control-points", methods=["POST"])
def analyze_control_points():
    global ACTIVE_DATASET
    try:
        body = request.get_json()
        if not body:
            return jsonify({"error": "Request body is empty."}), 400

        prompt = body.get("prompt")
        if not prompt:
            return jsonify({"error": "Prompt is required."}), 400

        # Store the un-truncated client payload safely in memory (keeps text prompt clear)
        ACTIVE_DATASET = {
            "approximatePatches": body.get("approximatePatches") or [],
            "interpolatePatches": body.get("interpolatePatches") or [],
            "patches": body.get("patches") or []
        }

        # Describes what's available in the sandbox -- a toolkit the
        # model can draw on, NOT a checklist it has to run every time.
        # Earlier this told the model to always produce a fixed,
        # exhaustive comparison; that made every answer look the same
        # regardless of what was actually asked. Now it's reference
        # material plus explicit permission to answer however the
        # question actually calls for -- a quick fact, a focused
        # calculation, a conceptual explanation with no code at all,
        # or a custom script for something none of the helpers cover.
        structural_manifest = """
        You have direct programmatic tool access to the un-truncated geometric arrays:
        - `approximate_patches`: list of dictionaries
        - `interpolate_patches`: list of dictionaries
        - `legacy_patches`: list of dictionaries

        Each individual patch dictionary contains fields such as 'datapts', 'ctrlpts', 'evalpts', 'data_size_u', 'data_size_v', 'sample_size_u', 'sample_size_v', 'uCurvePts', 'vCurvePts', etc.

        This sandbox has ONLY numpy (as `np`) and pandas (as `pd`) installed.
        scipy and every other third-party package are NOT available --
        do not `import scipy` or anything else third-party, it will
        raise ModuleNotFoundError and abort your whole script before it
        can return a result.

        Instead, use these pre-built helper functions, already available
        in scope, which compute the exact metrics below without scipy.
        Their return dicts ALWAYS have exactly the keys listed here --
        never guess a different key name (e.g. there is no
        "overall_maxdev", the key is literally "overall_max_deviation")
        and never index into approximate_patches/interpolate_patches by
        hand assuming they're the same length -- use compare_fits for
        that, it's safe against mismatched or empty lists.

        - `compare_fits(approximate_patches, interpolate_patches)` --
          PREFER THIS for any approximate-vs-interpolate comparison.
          One call, handles mismatched/empty lists safely, returns a
          dict with exactly these top-level keys (all always present):
          approximate, interpolate (full patch_error_summary() dicts),
          overall_rmse_approximate, overall_rmse_interpolate,
          overall_max_deviation_approximate, overall_max_deviation_interpolate,
          total_ctrlpts_approximate, total_ctrlpts_interpolate,
          better_fit_by_rmse, better_fit_by_max_deviation,
          more_efficient_by_ctrlpts.
        - `patch_error_summary(patches, label="")` -> dict with exactly:
          label, patch_count, total_ctrlpts, per_patch (list),
          overall_rmse (float or None), overall_max_deviation (float or None)
        - `error_report(data_points, eval_points, label="")` -> dict with
          exactly: label, point_count, rmse, mae, max_deviation, std, variance
        - `hausdorff_distance(points_a, points_b)` -> float
        - `bounding_box(points)` -> dict with exactly: min, max, diagonal
        - `count_ctrlpts(patch_list)` -> int
        - `nearest_neighbor_deviations(data_points, eval_points)` -> raw
          numpy array, if you want to build custom statistics on top
        - `per_patch_method_comparison(approximate_patches, interpolate_patches)`
          -> dict with exactly: per_patch (list of {patch_index,
          approximate_rmse, interpolate_rmse, approximate_ctrlpts,
          interpolate_ctrlpts, better_by_rmse}),
          unmatched_approximate_patches, unmatched_interpolate_patches.
          Use this when asked whether one method is better for SOME
          patches and the other better for others, rather than only
          an overall winner.
        - `seam_report(patches, tolerance_frac=0.02, use="datapts")` ->
          dict with exactly: connections (list of
          {patch_a, side_a, patch_b, side_b, mean_gap, connected}),
          gaps (the subset of connections that are close but not
          within tolerance -- a seam that looks like it should touch
          but doesn't quite), tolerance_used. Use this when asked
          whether patches are actually connected/watertight at their
          shared edges, not just independently well-fitted. side_a/
          side_b are one of "u_start", "u_end", "v_start", "v_end".
        - `boundary_on_surface_report(patches, tolerance_frac=0.02)` ->
          dict with exactly: matches (list of {patch_a, side_a,
          patch_b, mean_gap, on_surface}), tolerance_used. Use this
          IN ADDITION to seam_report whenever one patch could be a
          protrusion emerging from the middle of another closed
          surface (e.g. a cylinder meeting a sphere) -- seam_report
          only matches edge-to-edge, so it cannot see a junction that
          sits on an interior row of another patch's grid, which is
          exactly what that kind of join looks like.
        - `patch_boundary(patch, side, use="datapts")` -> one edge of a
          single patch as a raw point array, if you want to inspect a
          specific seam yourself rather than the full seam_report scan.

        WHAT YOU CAN DO WITH THIS -- these are tools, not a mandatory
        checklist. Answer the question actually asked:
        - If it's a quick factual question (e.g. "how many control
          points does the sphere patch use?"), just answer it --
          directly, or with one small targeted script, whichever is
          faster. You don't need to run every helper every time.
        - If it's a conceptual question (e.g. "why does interpolation
          use more control points?", "what does RMSE mean here?"),
          you can often answer from your own domain knowledge with no
          code execution at all.
        - If it calls for something none of the helpers cover (a
          specific statistic, a custom filter, a what-if comparison,
          plotting-style summaries, anything), write your own code
          against approximate_patches/interpolate_patches/
          legacy_patches directly -- you are not limited to the
          provided helper functions, they just save you from
          reinventing common error/seam math (and from reaching for
          scipy, which isn't installed).
        - If it's a genuinely broad "compare everything" ask, THEN
          reach for compare_fits, per_patch_method_comparison,
          seam_report, and boundary_on_surface_report together, plus
          the fuller suite (RMSE/MAE/max deviation/variance/std,
          bounding boxes, control-point efficiency, seam
          connectivity, and your own domain judgment on fairness,
          smoothness and trade-offs).
        - You can call the sandbox tool more than once in a row if it
          helps to look at an intermediate result before deciding
          what to compute next -- you don't have to get everything
          right in one script.

        Write execution blocks via the `run_python_analysis_sandbox` tool. Each script must explicitly 'return' its result (a string, dict, or number) -- but only write one when the question actually needs computed numbers.
        """

        # Define the processing function following the standard chat specification
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "run_python_analysis_sandbox",
                    "description": "Runs localized NumPy/Pandas processing code blocks over full global geometric datasets to extract deep deviations or fit statistics. Pre-built helpers are already in scope -- compare_fits(approximate_patches, interpolate_patches) for the full safe method comparison in one call, per_patch_method_comparison for a patch-by-patch breakdown, seam_report/boundary_on_surface_report for checking whether patches actually connect at their edges or at an interior row of another patch, plus error_report/hausdorff_distance/bounding_box/count_ctrlpts/patch_error_summary for custom analysis. No scipy or other third-party packages are available.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "code_string": {
                                "type": "string",
                                "description": "The pure Python code block to execute. Must compute complex comparative geometric metrics and explicitly return a detailed string summary or data dictionary. Only numpy/pandas and the provided helper functions are available -- no scipy or other third-party imports."
                            }
                        },
                        "required": ["code_string"]
                    }
                }
            }
        ]

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a NURBS geometric data analyst helping someone inspect and compare "
                    "surface fits produced by this app. You have a Python sandbox tool for exact "
                    "computation over the real point/control-point arrays, and your own domain "
                    "knowledge for everything else. "
                    f"{structural_manifest}\n"
                    "Answer the question that was actually asked -- not a fixed template. Match "
                    "the depth of your answer to the depth of the question: a short question gets "
                    "a short answer, a broad one gets a thorough one. Never approximate or guess "
                    "a number you could compute exactly."
                )
            },
            {
                "role": "user",
                "content": prompt
            }
        ]

        # Tool-use loop: the model can run the sandbox more than once
        # before answering -- e.g. look at one intermediate result,
        # then decide what to compute next -- rather than being
        # forced to get everything right in a single shot. Capped so
        # a confused loop can't run forever against the API.
        MAX_TOOL_ROUNDS = 5
        response_message = None

        for _ in range(MAX_TOOL_ROUNDS):
            response = client.chat.completions.create(
                model=MODEL,
                messages=messages,
                tools=tools,
                tool_choice="auto"
            )

            response_message = response.choices[0].message

            if not response_message.tool_calls:
                # Model is ready to answer in plain text -- done.
                break

            messages.append(response_message)

            for tool_call in response_message.tool_calls:
                if tool_call.function.name == "run_python_analysis_sandbox":
                    arguments = json.loads(tool_call.function.arguments)
                    code_to_run = arguments.get("code_string")

                    computation_result = run_python_analysis_sandbox(code_to_run)

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": "run_python_analysis_sandbox",
                        "content": computation_result
                    })
        else:
            # Hit MAX_TOOL_ROUNDS without the model settling on an
            # answer -- ask it to wrap up with whatever it has rather
            # than silently returning the last unfinished tool call.
            messages.append({
                "role": "user",
                "content": "Please give your final answer now based on what you've computed so far."
            })
            final_response = client.chat.completions.create(model=MODEL, messages=messages)
            response_message = final_response.choices[0].message

        return jsonify({"response": response_message.content}), 200

    except Exception as e:
        print("Pipeline execution failed:", str(e))
        return jsonify({
            "error": "Mathematical compilation error.",
            "details": str(e)
        }), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)