from flask import Flask, jsonify, request
from flask_cors import CORS
from geomdl import construct, fitting
import random
import math

app = Flask(__name__)
CORS(app)

DEGREE_U = 3
DEGREE_V = 3

# -----------------------------
# Noise
# -----------------------------
def add_noise(pt, scale=0.1):
    x, y, z = pt

    return (
        x + random.uniform(-scale, scale),
        y + random.uniform(-scale, scale),
        z + random.uniform(-scale, scale),
    )

def maybe_noise(points, noise):
    if not noise:
        return points

    return [add_noise(p) for p in points]

# -----------------------------
# Parse multiple patches
# -----------------------------
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

        if len(parts) != 3:
            continue

        try:
            current.append(
                (
                    float(parts[0]),
                    float(parts[1]),
                    float(parts[2])
                )
            )

        except:
            pass

    if current:
        patches.append(current)

    return patches

# -----------------------------
# Find grid size
# -----------------------------
def find_grid_size(number_points):
    best_u = None
    best_v = None
    difference = float("inf")

    for i in range(2, int(math.sqrt(number_points)) + 1):
        if number_points % i == 0:
            j = number_points // i

            if abs(i - j) < difference:
                best_u = i
                best_v = j
                difference = abs(i - j)

    return best_u, best_v

# -----------------------------
# API
# -----------------------------
@app.route("/surface", methods=["POST"])
def surface():

    method = request.form.get(
        "method",
        "approximate"
    )

    noise = request.form.get(
        "noise",
        "false"
    ) == "true"

    file = request.files.get("file")

    if not file:
        return jsonify(
            {
                "error": "No point file uploaded"
            }
        )

    text = file.read().decode("utf-8")

    patches_in = parse_points(text)

    results = []

    for index, pts in enumerate(patches_in):
        print("\nPATCH", index)

        pts = maybe_noise(
            pts,
            noise
        )

        size_u, size_v = find_grid_size(
            len(pts)
        )

        print(
            "Points:",
            len(pts)
        )

        print(
            "Grid:",
            size_u,
            size_v
        )

        if size_u is None:
            return jsonify(
                {
                    "error":
                    "Patch does not form a grid"
                }
            )

        try:
            degree_u = min(
                DEGREE_U,
                size_u - 1
            )

            degree_v = min(
                DEGREE_V,
                size_v - 1
            )

            if method == "approximate":
                surf = fitting.approximate_surface(
                    pts,
                    size_u,
                    size_v,
                    degree_u,
                    degree_v
                )

            else:
                surf = fitting.interpolate_surface(
                    pts,
                    size_u,
                    size_v,
                    degree_u,
                    degree_v
                )

            print(
                "Eval points:",
                len(surf.evalpts)
            )

        except Exception as e:
            print(
                "FIT ERROR:",
                e
            )
            return jsonify(
                {
                    "error": str(e)
                }
            )

        surf.delta = 0.05

        curves = construct.extract_curves(
            surf
        )

        results.append(
            {
                "evalpts": surf.evalpts,
                "datapts": pts,
                "ctrlpts": surf.ctrlpts,
                "uCurvePts": curves["u"][0].evalpts,
                "vCurvePts": curves["v"][0].evalpts
            }
        )

    return jsonify(
        {
            "patches": results
        }
    )

if __name__ == "__main__":
    app.run(
        port=5000,
        debug=True
    )