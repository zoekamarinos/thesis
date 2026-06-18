#!/usr/bin/env python
# -*- coding: utf-8 -*-

"""
    Flask API wrapping the NURBS-python (geomdl) surface fitting script.
    Serves the fitted surface's evaluated points and original data points
    as JSON so a React frontend can render them (e.g. with three.js).

    Run:
        pip install flask flask-cors geomdl
        python server.py
    Then hit:
        GET http://localhost:5000/surface
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
from geomdl import construct, fitting
import numpy as np

app = Flask(__name__)
CORS(app)  # allow requests from the React dev server (e.g. localhost:3000)

SIZE_U = 5
SIZE_V = 7
DEGREE_U = 2
DEGREE_V = 3


def build_points(shape="saddle"):
    if shape == "saddle":
        points = []
        x_start = -5
        x_step = 2.5
        num_x = 7
        y_vals = [-5, 0, 5, 7.5, 10]

        for y in y_vals:
            if y == 0:
                z = 3
            elif y == 7.5:
                z = -3
            else:
                z = 0

            for i in range(num_x):
                x = x_start + i * x_step
                points.append((x, y, z))

        return points

    # The remaining shapes use a SIZE_U x SIZE_V grid over [-1, 1] to match
    # the same control-point layout used in server2.py.
    x_vals = np.linspace(-1.0, 1.0, SIZE_U)
    y_vals = np.linspace(-1.0, 1.0, SIZE_V)
    points = []

    if shape == "curved_plate":
        for x in x_vals:
            for y in y_vals:
                z = 0.5 * x ** 2 + 0.25 * y ** 2  # smooth curved surface
                points.append((x, y, z))

    elif shape == "dome":
        for x in x_vals:
            for y in y_vals:
                r2 = x * x + y * y
                z = np.sqrt(max(0.0, 1.0 - r2))  # upper hemisphere
                points.append((x, y, z))

    elif shape == "cylinder":
        theta_vals = np.linspace(0, 2 * np.pi, SIZE_U)
        z_vals = np.linspace(-1.0, 1.0, SIZE_V)
        radius = 1.0
        for theta in theta_vals:
            for z in z_vals:
                x = radius * np.cos(theta)
                y = radius * np.sin(theta)
                points.append((x, y, z))

    else:
        raise ValueError(f"Unknown shape: {shape}")

    return points


@app.route("/surface")
def get_surface():
    shape = request.args.get("shape", "saddle")

    try:
        points = build_points(shape)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    # Global surface approximation
    surf = fitting.approximate_surface(points, SIZE_U, SIZE_V, DEGREE_U, DEGREE_V)

    # Extract isocurves (u and v) for optional wireframe-style rendering
    surf_curves = construct.extract_curves(surf)

    surf.delta = 0.05  # evaluation resolution, mirrors the original script

    return jsonify({
        "evalpts": surf.evalpts,                       # [[x,y,z], ...] fitted surface samples
        "datapts": points,                              # original (red) data points
        "size_u": SIZE_U,
        "size_v": SIZE_V,
        "uCurvePts": surf_curves['u'][0].evalpts,        # cyan curve
        "vCurvePts": surf_curves['v'][0].evalpts,        # magenta curve
    })


if __name__ == "__main__":
    app.run(port=5000, debug=True)
