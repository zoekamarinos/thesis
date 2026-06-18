#!/usr/bin/env python
# -*- coding: utf-8 -*-

import numpy as np
from flask import Flask, jsonify, request
from flask_cors import CORS
from geomdl import fitting, BSpline, utilities

app = Flask(__name__)
CORS(app)

M, N = 5, 6  # rows, columns


def build_points():
    """Cylinder point cloud (swap this out for real data later)."""
    points_list = []
    theta_vals = np.linspace(0, 2 * np.pi, M)
    z_vals = np.linspace(-1.0, 1.0, N)
    radius = 1.0

    for i in range(M):
        for j in range(N):
            theta = theta_vals[i]
            z = z_vals[j]
            x = radius * np.cos(theta)
            y = radius * np.sin(theta)
            points_list.append([x, y, z])

    return points_list


def fit_surface():
    points_list = build_points()
    surf = fitting.approximate_surface(
        points_list, size_u=M, size_v=N, degree_u=3, degree_v=3
    )
    return surf


def order_points(pts, size_u, size_v):
    """Same simple X-then-Y ordering used in the original script."""
    order_x = np.argsort(pts[:, 0])
    pts = pts[order_x]
    rows = np.array_split(pts, size_u)
    ordered = []
    for row in rows:
        row = row[np.argsort(row[:, 1])]
        ordered.extend(row.tolist())
    return ordered


@app.route("/control-points")
def control_points():
    surf = fit_surface()
    ctrlpts = np.array(surf.ctrlpts2d).reshape(-1, 3)

    surf.delta = 0.05  # for evalpts resolution

    return jsonify({
        "controlPoints": ctrlpts.tolist(),
        "evalpts": surf.evalpts,
        "dataPoints": build_points(),
    })


@app.route("/bezier", methods=["POST"])
def bezier():
    """
    Expects JSON body:
      {
        "points": [[x,y,z], ...],   # selected control points, in order selected
        "degreeU": 3,
        "degreeV": 3
      }
    """
    body = request.get_json()
    pts = np.asarray(body["points"], dtype=float)
    degree_u = int(body["degreeU"])
    degree_v = int(body["degreeV"])

    size_u = degree_u + 1
    size_v = degree_v + 1

    if pts.shape[0] != size_u * size_v:
        return jsonify({
            "error": f"Expected {size_u * size_v} points for degree_u={degree_u}, "
                     f"degree_v={degree_v}, got {pts.shape[0]}"
        }), 400

    ordered = order_points(pts, size_u, size_v)

    surf = BSpline.Surface()
    surf.degree_u = degree_u
    surf.degree_v = degree_v
    surf.set_ctrlpts(ordered, size_u, size_v)
    surf.knotvector_u = utilities.generate_knot_vector(degree_u, size_u)
    surf.knotvector_v = utilities.generate_knot_vector(degree_v, size_v)
    surf.sample_size = 30
    surf.evaluate()

    return jsonify({
        "evalpts": surf.evalpts,
        "controlPoints": ordered,
    })


if __name__ == "__main__":
    app.run(port=5000, debug=True)