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

        for index, pts in enumerate(parsed):

            grid = find_grid_size(len(pts))

            if not grid:
                return jsonify({
                    "error":"Points do not form a grid"
                })

            size_u, size_v = grid

            if method == "approximate":

                surf = fitting.approximate_surface(
                    pts,
                    size_u,
                    size_v,
                    min(DEGREE_U,size_u-1),
                    min(DEGREE_V,size_v-1)
                )

            else:

                surf = fitting.interpolate_surface(
                    pts,
                    size_u,
                    size_v,
                    min(DEGREE_U,size_u-1),
                    min(DEGREE_V,size_v-1)
                )

            surf.delta = 0.02

            results.append(
                surface_json(
                    surf,
                    pts,
                    index
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