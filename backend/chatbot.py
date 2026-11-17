import os
import json
import numpy as np
import pandas as pd
from flask import Flask, request, jsonify
from flask_cors import CORS
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
CORS(app)

api_key = os.environ.get("OPENAI_API_KEY")
if not api_key:
    raise RuntimeError("OPENAI_API_KEY environment variable is not set.")

client = OpenAI(api_key=api_key)
MODEL = "gpt-4o"

PORT = 5001
MAX_TOOL_ROUNDS = 5

# Patches sent by the frontend, available to the sandboxed scripts
ACTIVE_DATASET = {}

# For each of the original data points, it finds the distance to the closest point on the fitted surface.
def _nearest_neighbor_deviations(data_points, eval_points):
    """Distance from each data point to its nearest evaluated surface point."""

    data = np.asarray(data_points, dtype=float)
    evals = np.asarray(eval_points, dtype=float)

    if data.size == 0 or evals.size == 0:
        return np.array([])

    chunk = 200
    mins = []

    for i in range(0, len(data), chunk):
        block = data[i:i + chunk]
        diffs = block[:, None, :] - evals[None, :, :]
        mins.append(np.linalg.norm(diffs, axis=-1).min(axis=1))

    return np.concatenate(mins)

# Turns those distances into a summary for one patch: the number of points, RMSE, mean error, maximum deviation, standard deviation and variance.
def error_report(data_points, eval_points, label=""):
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

# Adds up the control points across a list of patches.
def count_ctrlpts(patch_list):
    """Total control points across a list of patches."""
    return sum(len(p.get("ctrlpts", [])) for p in patch_list)

# Runs error_report on every patch in one fit (approximate or interpolate) and combines the results. 
# It returns the per-patch reports, the patch count, the total control points, and an overall RMSE and maximum deviation for the whole fit.
def patch_error_summary(patches, label=""):
    per_patch = [
        error_report(
            patch.get("datapts", []),
            patch.get("evalpts", []),
            label=f"{label} patch {i}",
        )
        for i, patch in enumerate(patches)
    ]

    valid = [p for p in per_patch if "rmse" in p]

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

# Compares the approximate fit with the interpolate fit. 
# It builds a summary for each, then reports which one has the lower RMSE, which has the lower maximum deviation, and which uses fewer control points.
def compare_fits(approximate_patches, interpolate_patches):
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
            approx_summary["overall_max_deviation"],
            interp_summary["overall_max_deviation"],
        ),
        "more_efficient_by_ctrlpts": _pick_better(a_ctrl, i_ctrl),
    }

# Runs analysis code written by the AI against actual patch data. 
# The code can use numpy, pandas and the helpers above and must return a result.
def run_python_analysis_sandbox(code_string: str) -> str:
    """Run analysis code written by the model against the full patch arrays."""

    scope = {
        "approximate_patches": ACTIVE_DATASET.get("approximatePatches", []),
        "interpolate_patches": ACTIVE_DATASET.get("interpolatePatches", []),
        "np": np,
        "pd": pd,
        "nearest_neighbor_deviations": _nearest_neighbor_deviations,
        "error_report": error_report,
        "count_ctrlpts": count_ctrlpts,
        "patch_error_summary": patch_error_summary,
        "compare_fits": compare_fits,
    }

    indented_code = "\n    ".join(code_string.split("\n"))
    wrapper_code = f"""
def __run_analysis():
    {indented_code}

output = __run_analysis()
"""
    try:
        exec(wrapper_code, scope)

        result = scope.get("output")
        if result is None:
            return (
                "Code ran but returned None. Make sure the script "
                "explicitly returns a string, dict or number."
            )

        return str(result)
    except ModuleNotFoundError as e:
        return (
            f"Runtime Execution Error: {e}. Only numpy and pandas are "
            "available. Use the provided helper functions instead."
        )
    except KeyError as e:
        return (
            f"Runtime Execution Error: no key {e} in that dict. Check the "
            "key names listed for the helper functions and try again."
        )
    except Exception as e:
        return f"Runtime Execution Error: {e}"


MANIFEST = """
You can run Python through the `run_python_analysis_sandbox` tool. In scope:
- `approximate_patches`, `interpolate_patches`: lists of patch dicts, each with
  'datapts', 'ctrlpts', 'evalpts', 'data_size_u', 'data_size_v',
  'sample_size_u', 'sample_size_v', 'uCurvePts', 'vCurvePts', etc.
- `np` (numpy) and `pd` (pandas). Nothing else is installed (no scipy).

Helpers (these return exactly these keys, so don't guess others):
- `compare_fits(approximate_patches, interpolate_patches)`: use this for any
  approximate-vs-interpolate comparison. Keys: approximate, interpolate,
  overall_rmse_approximate, overall_rmse_interpolate,
  overall_max_deviation_approximate, overall_max_deviation_interpolate,
  total_ctrlpts_approximate, total_ctrlpts_interpolate, better_fit_by_rmse,
  better_fit_by_max_deviation, more_efficient_by_ctrlpts.
- `patch_error_summary(patches, label="")`: label, patch_count, total_ctrlpts,
  per_patch, overall_rmse, overall_max_deviation.
- `error_report(data_points, eval_points, label="")`: label, point_count,
  rmse, mae, max_deviation, std, variance.
- `count_ctrlpts(patch_list)`: int.
- `nearest_neighbor_deviations(data_points, eval_points)`: raw numpy array.

Answer the question actually asked. A quick fact or a conceptual question
needs little or no code. A broad "compare everything" question can use
compare_fits plus your own calculations. You may call the tool several times.
Every script must explicitly `return` its result.
"""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "run_python_analysis_sandbox",
            "description": (
                "Runs NumPy/Pandas code over the full patch arrays to compute "
                "fit statistics. The helper functions (compare_fits, "
                "patch_error_summary, error_report, count_ctrlpts, "
                "nearest_neighbor_deviations) are already in scope. No scipy "
                "or other third-party packages."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "code_string": {
                        "type": "string",
                        "description": (
                            "Python code that explicitly returns a string, "
                            "dict or number. Only numpy, pandas and the "
                            "provided helpers are available."
                        ),
                    }
                },
                "required": ["code_string"],
            },
        },
    }
]

SYSTEM_PROMPT = (
    "You are a NURBS geometric data analyst helping someone inspect and "
    "compare surface fits produced by this app. You have a Python sandbox "
    "for exact computation over the real point and control-point arrays, and "
    "your own domain knowledge for everything else. "
    f"{MANIFEST}\n"
    "Match the depth of your answer to the question: a short question gets a "
    "short answer, a broad one gets a thorough one. Never guess a number you "
    "could compute exactly."
)

# The chatbot’s endpoint. It receives the question and both sets of patches, stores the patches for the sandbox, and sends the question to the AI with the system prompt and the sandbox tool.
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

        ACTIVE_DATASET = {
            "approximatePatches": body.get("approximatePatches") or [],
            "interpolatePatches": body.get("interpolatePatches") or [],
        }

        messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]

        response_message = None

        for _ in range(MAX_TOOL_ROUNDS):
            response = client.chat.completions.create(
                model=MODEL,
                messages=messages,
                tools=TOOLS,
                tool_choice="auto",
            )

            response_message = response.choices[0].message

            if not response_message.tool_calls:
                break

            messages.append(response_message)

            for tool_call in response_message.tool_calls:
                if tool_call.function.name == "run_python_analysis_sandbox":
                    arguments = json.loads(tool_call.function.arguments)
                    result = run_python_analysis_sandbox(
                        arguments.get("code_string")
                    )

                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": "run_python_analysis_sandbox",
                        "content": result,
                    })
        else:
            # Tool rounds ran out: ask for a final answer with what it has
            messages.append({
                "role": "user",
                "content": "Please give your final answer now based on what you've computed so far.",
            })
            final_response = client.chat.completions.create(
                model=MODEL, messages=messages
            )
            response_message = final_response.choices[0].message

        return jsonify({"response": response_message.content}), 200

    except Exception as e:
        print("Pipeline execution failed:", str(e))
        return jsonify({
            "error": "Mathematical compilation error.",
            "details": str(e),
        }), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=True)
