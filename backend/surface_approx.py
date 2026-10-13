from flask import Flask, jsonify, request
from flask_cors import CORS
from geomdl import fitting, construct, BSpline
import math
import re

try:
    import numpy as np
    from sklearn.manifold import Isomap
    from scipy.spatial.distance import pdist
    REORDER_AVAILABLE = True
except ImportError:
    # numpy/scikit-learn/scipy aren't installed -- the geometric
    # reorder fallback (fix_grid_order) is skipped and stated
    # dimensions are trusted as-is, same as before this feature existed.
    REORDER_AVAILABLE = False

app = Flask(__name__)
CORS(app)

DEGREE_U = 3
DEGREE_V = 3

# Row detection looks ahead this many points to make an initial guess
# at which axis is "held constant" for a new row, and treats a change
# smaller than this as no change at all. Kept small so the lookahead
# doesn't overrun into the next row on short rows.
ROW_LOOKAHEAD = 2
ROW_TOL = 1e-6

# How far around the pole the padded ring points are spread, as a
# fraction of the distance to the adjacent ring. Small enough to be
# visually indistinguishable from a true point, large enough to avoid
# an ill-conditioned fit (see pad_pole_row).
POLE_PAD_RADIUS_FRAC = 0.01


def parse_file(text, warnings=None):
    if "# NURBS PATCH" in text:
        return parse_nurbs(text), True
    return parse_points(text, warnings=warnings), False


# ---------------------------------------------------------------------
# Automatic row/grid detection (used whenever a block has no explicit
# size_u=/size_v= on its "# PATCH" line -- including when there are no
# "# PATCH" markers in the file at all).
# ---------------------------------------------------------------------

def group_rows_auto(pts, tol=ROW_TOL, lookahead=ROW_LOOKAHEAD):
    """
    Split a flat, ordered point list into rows without any markers,
    by detecting -- independently for each new row -- which axis stays
    constant over the next couple of points. This adapts per-segment,
    so a file that switches shape partway through (e.g. a sphere's
    rings are constant in z, a cylinder's rings are constant in x) is
    still read correctly, rather than assuming one axis for the whole
    file.

    A point where no axis is near-constant going forward (e.g. a
    sphere's pole, where every direction immediately curves away)
    becomes its own single-point row.
    """

    n = len(pts)

    # An axis that never changes across the *entire* point cloud (e.g.
    # a flat test grid where z is 0 for every point) carries no row/
    # column information -- every point trivially satisfies "z is
    # constant," so it would always look like the best axis and
    # swallow every row into one. Exclude axes like that, unless
    # literally all three are constant (a degenerate case).
    global_range = [
        max(p[a] for p in pts) - min(p[a] for p in pts)
        for a in range(3)
    ]
    eligible_axes = [a for a in range(3) if global_range[a] > tol]
    if not eligible_axes:
        eligible_axes = [0, 1, 2]

    rows = []
    i = 0

    while i < n:
        window = min(lookahead, n - 1 - i)

        if window <= 0:
            rows.append([pts[i]])
            i += 1
            continue

        best_axis = None
        best_total = None

        for axis in eligible_axes:
            total = sum(
                abs(pts[i + k][axis] - pts[i + k - 1][axis])
                for k in range(1, window + 1)
            )
            if best_total is None or total < best_total:
                best_total = total
                best_axis = axis

        if best_total / window > tol:
            rows.append([pts[i]])
            i += 1
            continue

        # Grow the row, re-checking at each step that the chosen axis
        # is still the smallest-changing axis (not just "below tol")
        # -- this stops a row from overrunning into the next one when
        # the chosen axis also happens to change slowly for a point
        # or two past the true boundary.
        row = [pts[i]]
        j = i + 1

        while j < n:
            deltas = [
                abs(pts[j][a] - pts[j - 1][a])
                for a in range(3)
            ]
            eligible_deltas = [deltas[a] for a in eligible_axes]

            if (
                deltas[best_axis] > tol
                or deltas[best_axis] != min(eligible_deltas)
            ):
                break

            row.append(pts[j])
            j += 1

        rows.append(row)
        i = j

    return rows


def split_repeated_loops(row):
    """
    If a row contains an exact repeat of its own first point partway
    through, it's really multiple identical loops back to back (e.g.
    an accidentally duplicated ring in the source file) rather than
    one genuine row -- split at each repeat.
    """

    if len(row) < 2:
        return [row]

    start = row[0]
    split_points = [0]

    for idx in range(1, len(row)):
        if row[idx] == start:
            split_points.append(idx)

    split_points.append(len(row))

    if len(split_points) <= 2:
        return [row]

    return [
        row[a:b]
        for a, b in zip(split_points[:-1], split_points[1:])
    ]


def pad_pole_row(pole_point, neighbor_row, radius_frac=POLE_PAD_RADIUS_FRAC):
    """
    Expand a single-point "pole" row into a full row matching a
    neighboring ring's width, by spreading each copy slightly toward
    the corresponding neighbor point (in full 3D, not just one axis).
    This gives the row real, well-separated geometry -- a tiny cone
    tip rather than a line of near-duplicate points -- which a global
    least-squares surface fit (approximate_surface) needs in order to
    stay numerically well-conditioned. A line of exact or near-exact
    duplicates instead produces a singular or near-singular system,
    either erroring outright or (worse) silently returning a wildly
    distorted surface.
    """

    px, py, pz = pole_point

    return [
        [
            px + (nx - px) * radius_frac,
            py + (ny - py) * radius_frac,
            pz + (nz - pz) * radius_frac,
        ]
        for (nx, ny, nz) in neighbor_row
    ]


def normalize_rows(rows):
    """
    Clean up raw rows before grouping them into grid blocks:

    - Split any row that's really multiple duplicated loops back to
      back (see split_repeated_loops).
    - Drop a row that's an exact duplicate of the one immediately
      before it (accidental duplicate block in the source data).
    - Pad a single-point row (e.g. a sphere's pole) up to match a
      neighboring row's width (see pad_pole_row).
    """

    expanded = []
    for row in rows:
        expanded.extend(split_repeated_loops(row))
    rows = expanded

    cleaned = []
    for row in rows:
        if cleaned and row == cleaned[-1]:
            continue
        cleaned.append(row)

    for i, row in enumerate(cleaned):
        if len(row) == 1:
            neighbor_row = None

            if i > 0 and len(cleaned[i - 1]) > 1:
                neighbor_row = cleaned[i - 1]
            elif i < len(cleaned) - 1 and len(cleaned[i + 1]) > 1:
                neighbor_row = cleaned[i + 1]

            if neighbor_row:
                cleaned[i] = pad_pole_row(row[0], neighbor_row)

    return cleaned


def split_into_grid_blocks(rows):
    """
    Group consecutive rows of equal width into rectangular u x v
    blocks. A change in row width marks a new block -- this is what
    lets multiple distinct shapes in one file (e.g. a sphere and a
    cylinder) be auto-split into separate patches with no markers.
    """

    blocks = []
    current_rows = [rows[0]]

    for row in rows[1:]:
        if len(row) == len(current_rows[-1]):
            current_rows.append(row)
        else:
            blocks.append(current_rows)
            current_rows = [row]

    blocks.append(current_rows)

    grids = []

    for block_rows in blocks:
        width = len(block_rows[0])
        flat = [pt for row in block_rows for pt in row]
        grids.append((flat, len(block_rows), width))

    return grids


def auto_grid_blocks(pts):
    """
    Turn a flat, ordered point list into a list of
    (points, size_u, size_v) rectangular grid blocks, entirely from
    point order -- no "# PATCH" markers or explicit dimensions
    required. This is the fallback used whenever a block doesn't state
    its own size_u/size_v.
    """

    if len(pts) < 2:
        return [(pts, 1, len(pts))]

    rows = group_rows_auto(pts)
    rows = normalize_rows(rows)

    return split_into_grid_blocks(rows)


def grid_order_score(pts, size_u, size_v):
    """
    How well a flat point list, laid out as a size_u x size_v grid in
    the order given, actually looks like a grid -- independent of
    axis alignment, so it works for curved-quad patches (e.g. a
    cube-projected sphere face) where no single x/y/z coordinate
    stays constant along any row, unlike group_rows_auto.

    Measures the mean step size between grid-adjacent points (one
    step in u, one step in v), normalized by the overall spread of
    the point cloud. A correctly-ordered grid takes small, steady
    steps between neighbors; a scrambled one jumps around, so its
    score comes out much higher. Lower is better.
    """
    pts = np.asarray(pts, dtype=float)
    grid = pts.reshape(size_u, size_v, 3)
    du = np.linalg.norm(grid[1:, :, :] - grid[:-1, :, :], axis=-1)
    dv = np.linalg.norm(grid[:, 1:, :] - grid[:, :-1, :], axis=-1)
    scale = pdist(pts).mean()
    if scale <= 0:
        return 0.0
    return float((du.mean() + dv.mean()) / 2 / scale)


# A grid_order_score at or below this is treated as "already a
# reasonable grid" -- no reorder attempted. Found empirically: a
# correctly-ordered curved-quad patch scores well under this, while a
# shuffled one scores roughly 3-6x higher.
GRID_ORDER_GOOD_ENOUGH = 0.45

# n_neighbors values tried when hunting for the best Isomap embedding.
# 10 was the standout in testing (consistently recovered the true
# order on a shuffled 5x7 curved patch), but several values are tried
# since the right neighborhood size can shift with patch shape/size.
ISOMAP_NEIGHBOR_CANDIDATES = (10, 8, 12, 6, 14)


def reorder_via_isomap(pts, size_u, size_v, n_neighbors):
    """
    Recover a size_u x size_v row-major ordering for pts using pure
    geometry (no reliance on the order pts are already in). Builds a
    2D Isomap embedding -- a nearest-neighbor graph plus geodesic
    (manifold) distances -- which, for points sampled from a curved
    quad surface, tends to lay out roughly like the surface's own
    (u, v) parameter space. Points are then bucketed into size_u
    groups by their position along the embedding's first axis, and
    each group is sorted along the second axis to get the size_v
    ordering within it.

    This is a heuristic, not a guarantee -- see fix_grid_order, which
    actually checks the result before trusting it.
    """
    pts = np.asarray(pts, dtype=float)
    iso = Isomap(n_neighbors=n_neighbors, n_components=2)
    embedding = iso.fit_transform(pts)

    order_u = np.argsort(embedding[:, 0])
    groups = np.array_split(order_u, size_u)

    reordered_idx = []
    for g in groups:
        g_sorted = g[np.argsort(embedding[g, 1])]
        reordered_idx.extend(g_sorted.tolist())

    return pts[reordered_idx]


def fix_grid_order(pts, size_u, size_v, warnings=None, label=""):
    """
    Given a block whose dimensions (size_u, size_v) are already known
    -- stated in a "# PATCH size_u=.. size_v=.." marker -- but whose
    point ORDER may not actually be row-major (a user's file doesn't
    have to list points in the right order for this to work), try to
    repair the ordering using geometry alone.

    Scores the as-given order with grid_order_score; if it already
    looks like a sane grid, it's left untouched. Otherwise tries a
    handful of Isomap embeddings and keeps whichever one scores best,
    but only adopts it if it's a clear improvement -- if nothing beats
    the original, the original is kept and a warning is recorded
    rather than silently handing back a still-scrambled block.
    """
    pts_arr = [[float(c) for c in p] for p in pts]

    if not REORDER_AVAILABLE or size_u < 2 or size_v < 2:
        return pts_arr

    try:
        original_score = grid_order_score(pts_arr, size_u, size_v)
    except Exception:
        return pts_arr

    if original_score <= GRID_ORDER_GOOD_ENOUGH:
        return pts_arr

    best_pts, best_score = pts_arr, original_score

    for nn in ISOMAP_NEIGHBOR_CANDIDATES:
        if nn >= len(pts_arr):
            continue
        try:
            candidate = reorder_via_isomap(pts_arr, size_u, size_v, nn)
            candidate_score = grid_order_score(candidate, size_u, size_v)
        except Exception:
            continue

        if candidate_score < best_score:
            best_score, best_pts = candidate_score, candidate.tolist()

    if best_score < original_score:
        if warnings is not None:
            warnings.append(
                f"{label}points weren't in grid order -- "
                f"re-ordered automatically from point geometry"
            )
        return best_pts

    if warnings is not None:
        warnings.append(
            f"{label}points don't look like a clean "
            f"{size_u}x{size_v} grid and automatic re-ordering didn't "
            f"confidently fix it -- results may be distorted"
        )
    return pts_arr


def parse_points(text, warnings=None):
    """
    Parse a plain point-cloud file into one or more (points, size_u,
    size_v) grid blocks.

    A block starts at "# PATCH" (or at the start of the file). The
    marker line can optionally state the block's own dimensions:

        # PATCH size_u=8 size_v=20

    When given, those dimensions are trusted for size_u/size_v, but
    the point ORDER itself is no longer taken on faith: fix_grid_order
    checks whether the points actually fall into a sane grid in that
    order and, if not, repairs the ordering from geometry alone. This
    is what lets a user hand in points with the right dimensions
    stated but listed in any order -- including curved-quad patches
    (e.g. a cube-projected sphere face) where no coordinate axis stays
    constant along a row, so the older axis-based auto-detection could
    never have ordered them in the first place.
    """

    marker_blocks = []
    current = []
    current_dims = None

    def flush():
        if current:
            marker_blocks.append((current[:], current_dims))

    for line in text.splitlines():
        line = line.strip()

        if not line:
            continue

        if line.startswith("# PATCH"):
            flush()
            current = []

            m_u = re.search(r"size_u\s*=\s*(\d+)", line)
            m_v = re.search(r"size_v\s*=\s*(\d+)", line)

            current_dims = (
                (int(m_u.group(1)), int(m_v.group(1)))
                if (m_u and m_v) else None
            )
            continue

        parts = line.split(",")

        if len(parts) == 3:
            current.append([
                float(parts[0]),
                float(parts[1]),
                float(parts[2])
            ])

    flush()

    grids = []

    for i, (block_pts, dims) in enumerate(marker_blocks):
        if dims:
            size_u, size_v = dims

            if size_u * size_v != len(block_pts):
                # Stated dimensions don't match the actual point count
                # -- fall back to auto-detection rather than silently
                # misreading the block.
                grids.extend(auto_grid_blocks(block_pts))
            else:
                label = f"patch {i + 1}: " if len(marker_blocks) > 1 else ""
                fixed_pts = fix_grid_order(
                    block_pts, size_u, size_v, warnings=warnings, label=label
                )
                grids.append((fixed_pts, size_u, size_v))
        else:
            grids.extend(auto_grid_blocks(block_pts))

    return grids


def parse_nurbs(text):
    patches = []
    current = {
        "degree_u": None,
        "degree_v": None,
        "size_u": None,
        "size_v": None,
        "ctrlpts": [],
        "knot_u": [],
        "knot_v": []
    }

    section = None

    for line in text.splitlines():

        line = line.strip()

        if not line:
            continue

        if line.startswith("# NURBS PATCH"):

            if current["ctrlpts"]:
                patches.append(current)

            current = {
                "degree_u": None,
                "degree_v": None,
                "size_u": None,
                "size_v": None,
                "ctrlpts": [],
                "knot_u": [],
                "knot_v": []
            }

            section = None
            continue

        if line.startswith("degree_u"):
            current["degree_u"] = int(line.split("=")[1])

        elif line.startswith("degree_v"):
            current["degree_v"] = int(line.split("=")[1])

        elif line.startswith("size_u"):
            current["size_u"] = int(line.split("=")[1])

        elif line.startswith("size_v"):
            current["size_v"] = int(line.split("=")[1])

        elif line == "ctrlpts":
            section = "ctrlpts"

        elif line == "knotvector_u":
            section = "knot_u"

        elif line == "knotvector_v":
            section = "knot_v"

        elif section == "ctrlpts":

            parts = line.split(",")

            if len(parts) == 3:
                current["ctrlpts"].append([
                    float(parts[0]),
                    float(parts[1]),
                    float(parts[2])
                ])

        elif section == "knot_u":

            current["knot_u"] = [
                float(x)
                for x in line.split(",")
            ]

            section = None

        elif section == "knot_v":

            current["knot_v"] = [
                float(x)
                for x in line.split(",")
            ]

            section = None

    if current["ctrlpts"]:
        patches.append(current)

    return patches


def near_square_factors(n):

    if n <= 1:
        return (1, 1)

    best = (n, 1)
    diff = n - 1

    for i in range(1, int(math.sqrt(n)) + 1):

        if n % i == 0:

            j = n // i

            if abs(i - j) < diff:
                best = (j, i)
                diff = abs(i - j)

    return best


def distribute_counts(n, total):

    base = total // n
    extra = total % n

    return [
        base + (1 if i < extra else 0)
        for i in range(n)
    ]


def split_indices(size, n):

    total_cells = size - 1

    if total_cells <= 0:
        return [(0, 0)]

    n = max(1, min(n, total_cells))

    base = total_cells // n
    extra = total_cells % n

    bounds = []
    start = 0

    for i in range(n):

        cells = base + (1 if i < extra else 0)
        end = start + cells

        bounds.append((start, end))

        start = end

    return bounds


def split_grid(pts, size_u, size_v, patches_u, patches_v):

    u_bounds = split_indices(size_u, patches_u)
    v_bounds = split_indices(size_v, patches_v)

    subgrids = []

    for (u0, u1) in u_bounds:
        for (v0, v1) in v_bounds:

            sub_pts = []

            for u in range(u0, u1 + 1):
                for v in range(v0, v1 + 1):
                    sub_pts.append(pts[u * size_v + v])

            subgrids.append((
                sub_pts,
                u1 - u0 + 1,
                v1 - v0 + 1
            ))

    return subgrids


def merge_blocks(blocks, total_groups):

    n = len(blocks)
    total_groups = max(1, min(total_groups, n))

    base = n // total_groups
    extra = n % total_groups

    groups = []
    idx = 0

    for g in range(total_groups):

        take = base + (1 if g < extra else 0)
        merged = []

        for _ in range(take):
            merged.extend(blocks[idx])
            idx += 1

        groups.append(merged)

    return groups


def find_grid_size(n):
    """Only used as a last-resort fallback when merging blocks down to
    fewer patches than were detected (see merge_blocks' caller) --
    merging concatenates points from different blocks together, which
    loses their individual known shapes."""

    best = None
    diff = float("inf")

    for i in range(2, int(math.sqrt(n)) + 1):

        if n % i == 0:

            j = n // i

            if abs(i - j) < diff:
                best = (i, j)
                diff = abs(i - j)

    return best


def surface_json(surf, datapts, index, data_size_u=None, data_size_v=None):

    curves = construct.extract_curves(surf)

    return {
        "patchIndex": index,
        "evalpts": surf.evalpts,
        "datapts": datapts,
        "ctrlpts": surf.ctrlpts,

        "degree_u": surf.degree_u,
        "degree_v": surf.degree_v,

        "size_u": surf.ctrlpts_size_u,
        "size_v": surf.ctrlpts_size_v,

        # The grid shape of `datapts` itself -- NOT the same as
        # size_u/size_v above, which describe the control-point grid.
        # Without this, nothing downstream (e.g. a seam/boundary
        # check) can safely reshape datapts back into rows and
        # columns to find its edges.
        "data_size_u": data_size_u,
        "data_size_v": data_size_v,

        "sample_size_u": surf.sample_size_u,
        "sample_size_v": surf.sample_size_v,

        "knot_u": surf.knotvector_u,
        "knot_v": surf.knotvector_v,

        "uCurvePts": curves["u"][0].evalpts,
        "vCurvePts": curves["v"][0].evalpts
    }


def safe_ctrlpts_size(data_size, degree):
    """
    How many control points to request from approximate_surface along
    one axis. Two failure modes to avoid:

    - Too few (<= degree) divides by zero in geomdl's knot vector
      calculation.
    - Too many -- in particular, close to the full data size -- turns
      the global least-squares fit into a near-singular system
      whenever the data loops back on itself (e.g. a ring of points
      going all the way around a sphere or cylinder). That doesn't
      error, it just silently returns wildly distorted control points
      (seen directly: an x range of roughly [-1.4e6, 1.9e5] on sphere
      data that should range roughly [-1, 1]), which is worse than an
      error because nothing flags it.

    Halving the data size is a reasonably safe middle ground: enough
    points to represent real curvature, well short of forcing a
    near-exact (and, for closed loops, near-singular) fit.
    """

    return max(degree + 1, min(data_size, data_size // 2))


def fit_block(pts, size_u, size_v, split_u, split_v, method, results, warnings):
    """
    Fit and append surfaces for one grid block. A sub-patch that's too
    small to fit (fewer than 2 points along an axis -- typically a
    malformed or duplicated section in the source data) is skipped
    with a warning rather than aborting the whole request, so the rest
    of a mostly-good file still comes back as valid patches.
    """

    sub_iter = split_grid(pts, size_u, size_v, split_u, split_v)

    for sub_pts, sub_u, sub_v in sub_iter:

        du = min(DEGREE_U, sub_u - 1)
        dv = min(DEGREE_V, sub_v - 1)

        if du < 1 or dv < 1:
            warnings.append(
                f"Skipped a {sub_u} x {sub_v} block -- fewer than 2 "
                "points along one axis, so no surface could be fit "
                "to it. This usually means that section of the "
                "source data is malformed or duplicated."
            )
            continue

        try:

            if method == "approximate":

                cu = safe_ctrlpts_size(sub_u, du)
                cv = safe_ctrlpts_size(sub_v, dv)

                surf = fitting.approximate_surface(
                    sub_pts,
                    sub_u,
                    sub_v,
                    du,
                    dv,
                    ctrlpts_size_u=cu,
                    ctrlpts_size_v=cv
                )

            else:

                surf = fitting.interpolate_surface(
                    sub_pts,
                    sub_u,
                    sub_v,
                    du,
                    dv
                )

        except Exception as exc:
            warnings.append(
                f"Skipped a {sub_u} x {sub_v} block -- fitting "
                f"failed ({exc})."
            )
            continue

        surf.delta = 0.02

        results.append(
            surface_json(
                surf,
                sub_pts,
                len(results),
                data_size_u=sub_u,
                data_size_v=sub_v
            )
        )


@app.route("/surface", methods=["POST"])
def surface():

    file = request.files.get("file")
    method = request.form.get(
        "method",
        "approximate"
    )

    total_raw = request.form.get("totalPatches", "")
    total_patches = (
        int(total_raw) if total_raw not in ("", None) else None
    )

    if not file:
        return jsonify({
            "error": "No file uploaded"
        })

    text = file.read().decode("utf-8")

    results = []
    warnings = []

    parsed, is_nurbs = parse_file(text, warnings=warnings)

    if is_nurbs:

        for index, patch in enumerate(parsed):

            surf = BSpline.Surface()

            surf.degree_u = patch["degree_u"]
            surf.degree_v = patch["degree_v"]

            surf.set_ctrlpts(
                patch["ctrlpts"],
                patch["size_u"],
                patch["size_v"]
            )

            surf.knotvector_u = patch["knot_u"]
            surf.knotvector_v = patch["knot_v"]

            surf.delta = 0.02

            results.append(
                surface_json(
                    surf,
                    patch["ctrlpts"],
                    index,
                    data_size_u=patch["size_u"],
                    data_size_v=patch["size_v"]
                )
            )

    else:

        if not parsed:
            return jsonify({
                "error": "No points found in file."
            })

        num_blocks = len(parsed)

        if total_patches is None:

            blocks_to_process = [
                (pts, size_u, size_v, 1, 1)
                for pts, size_u, size_v in parsed
            ]

        elif total_patches <= num_blocks:

            flat_blocks = [pts for pts, _, _ in parsed]
            merged = merge_blocks(flat_blocks, max(1, total_patches))

            blocks_to_process = []

            for pts in merged:

                grid = find_grid_size(len(pts))

                if not grid:
                    return jsonify({
                        "error": (
                            "Merging these blocks down to "
                            f"{total_patches} patch(es) doesn't "
                            "produce a point count that forms a "
                            "rectangular grid. Try a different "
                            "patch count."
                        )
                    })

                size_u, size_v = grid

                blocks_to_process.append(
                    (pts, size_u, size_v, 1, 1)
                )

        else:

            per_block_targets = distribute_counts(
                num_blocks,
                total_patches
            )

            blocks_to_process = []

            for (pts, size_u, size_v), block_target in zip(
                parsed,
                per_block_targets
            ):

                u, v = near_square_factors(max(1, block_target))

                blocks_to_process.append(
                    (pts, size_u, size_v, u, v)
                )

        for pts, size_u, size_v, split_u, split_v in blocks_to_process:

            fit_block(
                pts,
                size_u,
                size_v,
                split_u,
                split_v,
                method,
                results,
                warnings
            )

        if not results:
            return jsonify({
                "error": (
                    "No valid surface could be fit from this file."
                ),
                "warnings": warnings
            })

    print("Returned patches:", len(results))

    response = {
        "patches": results
    }

    if warnings:
        response["warnings"] = warnings

    return jsonify(response)


if __name__ == "__main__":
    app.run(
        port=5000,
        debug=True
    )
