from flask import Flask, jsonify, request
from flask_cors import CORS
from geomdl import fitting, construct, BSpline
import math

app = Flask(__name__)
CORS(app)

DEGREE_U = 3
DEGREE_V = 3

def parse_file(text):
    if "# NURBS PATCH" in text:
        return parse_nurbs(text), True
    return parse_points(text), False

def parse_points(text):
    patches = []
    current = []

    for line in text.splitlines():
        line = line.strip()

        if not line:
            continue

        if line.startswith("# PATCH"):
            if current:
                patches.append(current)
            current = []
            continue

        parts = line.split(",")

        if len(parts) == 3:
            current.append([
                float(parts[0]),
                float(parts[1]),
                float(parts[2])
            ])

    if current:
        patches.append(current)

    return patches

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

def find_grid_size(n):

    best = None
    diff = float("inf")

    for i in range(2, int(math.sqrt(n))+1):

        if n % i == 0:

            j = n // i

            if abs(i-j) < diff:
                best = (i,j)
                diff = abs(i-j)

    return best

def near_square_factors(n):
    """
    Return (u, v) with u * v == n, as close to a square split as possible.
    Used to turn a single "how many sub-patches for this block" count into
    a 2D split for split_grid.
    """

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
    """
    Split `total` items as evenly as possible across `n` buckets.
    Returns a list of length n whose values sum to `total`.
    """

    base = total // n
    extra = total % n

    return [
        base + (1 if i < extra else 0)
        for i in range(n)
    ]

def split_indices(size, n):
    """
    Split `size` points (size-1 cells) along one axis into `n` pieces.
    Returns a list of (start_idx, end_idx) index pairs, INCLUSIVE on both
    ends, so adjacent pieces share their boundary row/column (this keeps
    the resulting sub-surfaces stitched together with no visible seam).
    """

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
    """
    Cut a flat, row-major (u-major) point grid into a patches_u x patches_v
    arrangement of overlapping sub-grids. Returns a list of
    (sub_pts, sub_size_u, sub_size_v) tuples.
    """

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
    """
    Merge a list of point-cloud blocks (each a list of [x,y,z] points) down
    to `total_groups` groups by concatenating neighboring blocks together.
    Used only when the user explicitly asks for fewer total patches than
    there are # PATCH blocks in the raw import (e.g. 2 instead of the
    sphere's natural 6). Concatenated points are then re-gridded and fit
    as a single surface per group, same as any other point cloud.
    """

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

def surface_json(surf, datapts, index):

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

        "sample_size_u": surf.sample_size_u,
        "sample_size_v": surf.sample_size_v,

        "knot_u": surf.knotvector_u,
        "knot_v": surf.knotvector_v,

        "uCurvePts": curves["u"][0].evalpts,
        "vCurvePts": curves["v"][0].evalpts
    }

@app.route("/surface", methods=["POST"])
def surface():

    file = request.files.get("file")
    method = request.form.get(
        "method",
        "approximate"
    )

    # Only used for raw point-cloud imports. Re-imported NURBS exports
    # (files with "# NURBS PATCH" markers) always rebuild exactly the
    # patches they were exported with, so this is ignored for those.
    # Blank/omitted = natural patch count for the file (1 per # PATCH
    # block, or 1 total if the file has no blocks). A number lower than
    # the natural block count merges blocks together; a number higher
    # splits blocks further — either way the output is exactly that many
    # patches.
    total_raw = request.form.get("totalPatches", "")
    total_patches = (
        int(total_raw) if total_raw not in ("", None) else None
    )

    if not file:
        return jsonify({
            "error":"No file uploaded"
        })

    text = file.read().decode("utf-8")

    parsed, is_nurbs = parse_file(text)

    results = []

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
                    index
                )
            )

    else:

        num_blocks = len(parsed)

        if total_patches is None:
            # No override: natural behavior, one patch per block.
            blocks_to_process = [(pts, 1, 1) for pts in parsed]

        elif total_patches <= num_blocks:
            # Fewer patches requested than there are blocks: merge
            # neighboring blocks together (e.g. sphere's 6 faces -> 2).
            merged = merge_blocks(parsed, max(1, total_patches))
            blocks_to_process = [(pts, 1, 1) for pts in merged]

        else:
            # More patches requested than there are blocks: split each
            # block up, distributing the extra patches as evenly as
            # possible across blocks so the total comes out exact.
            per_block_targets = distribute_counts(num_blocks, total_patches)

            blocks_to_process = []

            for pts, block_target in zip(parsed, per_block_targets):
                u, v = near_square_factors(max(1, block_target))
                blocks_to_process.append((pts, u, v))

        for pts, split_u, split_v in blocks_to_process:

            grid = find_grid_size(len(pts))

            if not grid:
                return jsonify({
                    "error":"Points do not form a grid"
                })

            size_u, size_v = grid

            sub_iter = split_grid(pts, size_u, size_v, split_u, split_v)

            for sub_pts, sub_u, sub_v in sub_iter:

                du = min(DEGREE_U, sub_u - 1)
                dv = min(DEGREE_V, sub_v - 1)

                if du < 1 or dv < 1:
                    return jsonify({
                        "error": (
                            "Requested patch count is too high for this "
                            "grid — a sub-patch ended up with fewer than "
                            "2 points along one axis. Lower the total "
                            "patch count."
                        )
                    })

                if method == "approximate":

                    # geomdl defaults ctrlpts_size to (size - 1) when not
                    # given, i.e. it reduces control points below the data
                    # point count. On small sub-patches that reduced count
                    # can end up equal to the degree, which divides by zero
                    # in geomdl's knot vector calc. Passing the sizes
                    # explicitly (matching the data point count) avoids
                    # that reduction and keeps ctrlpts_size > degree.
                    surf = fitting.approximate_surface(
                        sub_pts,
                        sub_u,
                        sub_v,
                        du,
                        dv,
                        ctrlpts_size_u=sub_u,
                        ctrlpts_size_v=sub_v
                    )

                else:

                    surf = fitting.interpolate_surface(
                        sub_pts,
                        sub_u,
                        sub_v,
                        du,
                        dv
                    )

                surf.delta = 0.02

                results.append(
                    surface_json(
                        surf,
                        sub_pts,
                        len(results)
                    )
                )

    print("Returned patches:", len(results))

    return jsonify({
        "patches": results
    })


if __name__ == "__main__":
    app.run(
        port=5000,
        debug=True
    )