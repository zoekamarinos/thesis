from flask import Flask, jsonify, request
from flask_cors import CORS
from geomdl import fitting, construct, BSpline
import numpy as np
import math
import re

app = Flask(__name__)
CORS(app)

DEGREE_U = 3
DEGREE_V = 3

ROW_LOOKAHEAD = 2
ROW_TOL = 1e-6
POLE_PAD_RADIUS_FRAC = 0.01
MAX_AXIS = 80

NUM_SPLIT = re.compile(r"[,\s;]+")


def parse_file(text, warnings=None):
    if "# NURBS PATCH" in text:
        return parse_nurbs(text), True
    return parse_points(text, warnings=warnings), False


# ---------------------------------------------------------------------
# Row / grid detection
# ---------------------------------------------------------------------

def group_rows_auto(pts, tol=ROW_TOL, lookahead=ROW_LOOKAHEAD):
    """Split an ordered point list into rows by finding which axis stays constant."""

    n = len(pts)

    # An axis that never changes in the whole cloud carries no row information
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
    """Split a row that repeats its own first point into separate loops."""

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
    """Turn a single pole point into a tiny ring matching its neighbour row."""

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
    """Split repeated loops, drop duplicate rows and pad single-point pole rows."""

    expanded = []
    for row in rows:
        expanded.extend(split_repeated_loops(row))

    cleaned = []
    for row in expanded:
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
    """Group consecutive rows of equal width into (points, size_u, size_v) blocks."""

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


def auto_grid_blocks(pts, warnings=None):
    if len(pts) < 2:
        return [(pts, 1, len(pts))]

    rows = normalize_rows(group_rows_auto(pts))
    grids = split_into_grid_blocks(rows)

    # Warn if under half the points ended up in usable (3 x 3 or larger) grids
    total = sum(len(g[0]) for g in grids) or 1
    usable = sum(len(g[0]) for g in grids if g[1] >= 3 and g[2] >= 3)

    if usable / total < 0.5 and warnings is not None:
        warnings.append(
            "The points don't form a clear grid (rows of equal length "
            "listed in order), so the surface may be distorted. Check "
            "the point order in the file."
        )

    return grids


# ---------------------------------------------------------------------
# File parsing
# ---------------------------------------------------------------------

def parse_coordinate_line(line):
    """Read one line as numbers. Returns None for headers, comments and faces."""

    if line.startswith("#") or line.startswith("//"):
        return None

    tokens = [t for t in NUM_SPLIT.split(line.strip(" ,;\t")) if t != ""]

    if tokens and tokens[0] == "v":
        tokens = tokens[1:]

    if len(tokens) < 3:
        return None

    values = []

    for t in tokens:
        try:
            values.append(float(t))
        except ValueError:
            break

    if len(values) < 3:
        return None

    if not all(math.isfinite(v) for v in values[:3]):
        return None

    return values


def parse_points(text, warnings=None):
    """
    Parse a point-cloud file into (points, size_u, size_v) grid blocks.
    A block starts at "# PATCH" (optionally "# PATCH size_u=N size_v=M")
    or at the start of the file.
    """

    marker_blocks = []
    current = []
    current_dims = None

    def flush():
        if current:
            marker_blocks.append((current[:], current_dims))

    lines = text.lstrip("﻿").splitlines()

    # ASCII PLY: only read the vertex block
    if lines and lines[0].strip().lower() == "ply":
        n_vertex = None
        header_end = None
        for k, ln in enumerate(lines):
            tok = ln.split()
            if len(tok) == 3 and tok[0] == "element" and tok[1] == "vertex":
                n_vertex = int(tok[2])
            if ln.strip() == "end_header":
                header_end = k
                break
        if header_end is not None:
            lines = lines[header_end + 1:]
            if n_vertex is not None:
                lines = lines[:n_vertex]

    for line in lines:
        line = line.strip().lstrip("﻿")

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

        row = parse_coordinate_line(line)

        if row is not None:
            current.append(row)

    flush()

    marker_blocks = [([r[:3] for r in b], d) for b, d in marker_blocks]

    grids = []

    for block_pts, dims in marker_blocks:
        if dims:
            size_u, size_v = dims

            if size_u * size_v != len(block_pts):
                # Stated size doesn't match the point count: detect instead
                grids.extend(auto_grid_blocks(block_pts, warnings=warnings))
            else:
                grids.append((block_pts, size_u, size_v))
        else:
            grids.extend(auto_grid_blocks(block_pts, warnings=warnings))

    return grids


def parse_nurbs(text):
    patches = []

    def new_patch():
        return {
            "degree_u": None,
            "degree_v": None,
            "size_u": None,
            "size_v": None,
            "ctrlpts": [],
            "knot_u": [],
            "knot_v": []
        }

    current = new_patch()
    section = None

    for line in text.splitlines():

        line = line.strip()

        if not line:
            continue

        if line.startswith("# NURBS PATCH"):
            if current["ctrlpts"]:
                patches.append(current)
            current = new_patch()
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
                current["ctrlpts"].append([float(p) for p in parts])

        elif section == "knot_u":
            current["knot_u"] = [float(x) for x in line.split(",")]
            section = None

        elif section == "knot_v":
            current["knot_v"] = [float(x) for x in line.split(",")]
            section = None

    if current["ctrlpts"]:
        patches.append(current)

    return patches


# ---------------------------------------------------------------------
# Patch splitting and merging
# ---------------------------------------------------------------------

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
    """Cut a grid into sub-grids that share their boundary points."""

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


# ---------------------------------------------------------------------
# Fitting
# ---------------------------------------------------------------------

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

        # grid shape of datapts (not the control-point grid)
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
    """Control points to request: half the data size, but at least degree + 1."""

    return max(degree + 1, min(data_size, data_size // 2))


def fit_block(pts, size_u, size_v, split_u, split_v, method, results, warnings):
    """Fit and append surfaces for one grid block, skipping any that fail."""

    for sub_pts, sub_u, sub_v in split_grid(pts, size_u, size_v, split_u, split_v):

        du = min(DEGREE_U, sub_u - 1)
        dv = min(DEGREE_V, sub_v - 1)

        if du < 1 or dv < 1:
            warnings.append(
                f"Skipped a {sub_u} x {sub_v} block -- fewer than 2 "
                "points along one axis, so no surface could be fit to it."
            )
            continue

        fit_pts = sub_pts
        fit_u, fit_v = sub_u, sub_v

        if max(sub_u, sub_v) > MAX_AXIS:
            su = max(1, math.ceil(sub_u / MAX_AXIS))
            sv = max(1, math.ceil(sub_v / MAX_AXIS))
            rows_i = sorted(set(list(range(0, sub_u, su)) + [sub_u - 1]))
            cols_j = sorted(set(list(range(0, sub_v, sv)) + [sub_v - 1]))
            fit_pts = [sub_pts[i * sub_v + j] for i in rows_i for j in cols_j]
            fit_u, fit_v = len(rows_i), len(cols_j)
            du = min(DEGREE_U, fit_u - 1)
            dv = min(DEGREE_V, fit_v - 1)
            warnings.append(
                f"A {sub_u} x {sub_v} block was thinned to "
                f"{fit_u} x {fit_v} points for fitting."
            )

        try:

            if method == "approximate":
                surf = fitting.approximate_surface(
                    fit_pts,
                    fit_u,
                    fit_v,
                    du,
                    dv,
                    ctrlpts_size_u=safe_ctrlpts_size(fit_u, du),
                    ctrlpts_size_v=safe_ctrlpts_size(fit_v, dv)
                )
            else:
                surf = fitting.interpolate_surface(fit_pts, fit_u, fit_v, du, dv)

        except Exception as exc:
            surf = None

            if method == "approximate":
                # Retry once with interpolation
                try:
                    surf = fitting.interpolate_surface(
                        fit_pts, fit_u, fit_v, du, dv
                    )
                except Exception:
                    surf = None

                if surf is not None:
                    warnings.append(
                        f"A {sub_u} x {sub_v} block couldn't be "
                        f"approximated ({exc}); interpolated instead."
                    )

            if surf is None:
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
    method = request.form.get("method", "approximate")

    total_raw = request.form.get("totalPatches", "")
    total_patches = (
        int(total_raw) if total_raw not in ("", None) else None
    )

    if not file:
        return jsonify({"error": "No file uploaded"})

    raw = file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")

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
                "error": (
                    "No points found in file. Expected one point per "
                    "line as x,y,z (comma, space, tab or semicolon "
                    "separated; extra columns and header lines are "
                    "ignored)."
                )
            })

        num_blocks = len(parsed)

        # Counts at or below the detected number of blocks are ignored
        if total_patches is None or total_patches <= num_blocks:

            blocks_to_process = [
                (pts, size_u, size_v, 1, 1)
                for pts, size_u, size_v in parsed
            ]

        else:

            per_block_targets = distribute_counts(num_blocks, total_patches)

            blocks_to_process = []

            for (pts, size_u, size_v), block_target in zip(
                parsed,
                per_block_targets
            ):
                u, v = near_square_factors(max(1, block_target))
                blocks_to_process.append((pts, size_u, size_v, u, v))

        for pts, size_u, size_v, split_u, split_v in blocks_to_process:
            fit_block(
                pts, size_u, size_v, split_u, split_v,
                method, results, warnings
            )

        if not results:
            return jsonify({
                "error": (
                    "No valid surface could be fit from this file. "
                    + " ".join(warnings[:2])
                ).strip(),
                "warnings": warnings
            })

    print("Returned patches:", len(results))

    response = {"patches": results}

    if warnings:
        response["warnings"] = warnings

    return jsonify(response)


if __name__ == "__main__":
    app.run(port=5000, debug=True)
