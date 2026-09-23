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

        # EXPANDED STRUCTURAL MANIFEST: Demands deeper scientific/geometric surface metrics
        structural_manifest = """
        You have direct programmatic tool access to the un-truncated geometric arrays:
        - `approximate_patches`: list of dictionaries
        - `interpolate_patches`: list of dictionaries
        - `legacy_patches`: list of dictionaries
        
        Each individual patch dictionary contains fields such as 'datapts', 'ctrlpts', 'evalpts', 'u_curve_points', etc.
        
        DEEP GEOMETRIC ANALYSIS EXPECTATIONS:
        Do not settle for basic truncation indexing. Write sophisticated Python routines to compute and compare:
        1. **True Spatial Proximity (Nearest Neighbor Deviations)**: For each point in 'datapts', write a quick distance matrix computation to find its shortest Euclidean distance to *any* point in 'evalpts'. This avoids broadcasting/indexing errors and gives true geometric deviation.
        2. **Comprehensive Error Statistical Suite**:
           - **Root Mean Squared Error (RMSE)** across the surface.
           - **Maximum Deviation / Hausdorff Distance** (critical for finding surface fitting peaks, ripples, or tears).
           - **Mean Absolute Error (MAE)**.
           - **Variance and Standard Deviation** of the error distribution.
        3. **Control Point Efficiency / Sparsity**: Compare the total number of control points used (`ctrlpts`) versus the quality of the fit. Which algorithm achieves a tighter fit with fewer control parameters?
        4. **Surface Bounds Context**: Compute the bounding boxes of the patches to contextualize the absolute error metrics relative to the overall physical scale of the object.
        5. **Algorithmic Trade-offs**: Use your domain knowledge to write a thorough comparison discussing surface fairness, smoothness, continuity, and localized distortion profiles.
        
        Write your mathematical execution blocks via the `run_python_analysis_sandbox` tool. Your custom script block must explicitly 'return' a highly detailed string output summary or numerical report mapping your discoveries.
        """

        # Define the processing function following the standard chat specification
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "run_python_analysis_sandbox",
                    "description": "Runs localized NumPy/Pandas processing code blocks over full global geometric datasets to extract deep deviations or fit statistics.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "code_string": {
                                "type": "string",
                                "description": "The pure Python code block to execute. Must compute complex comparative geometric metrics and explicitly return a detailed string summary or data dictionary."
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
                "content": f"You are a specialized mathematical NURBS geometric evaluator and data scientist. {structural_manifest}\nDo not approximate values. Write robust evaluation code to run comprehensive math comparisons."
            },
            {
                "role": "user",
                "content": f"Perform an extremely thorough, multi-metric comparative error and surface analysis on these algorithms matching this goal: {prompt}"
            }
        ]

        # First inference step: Model figures out what error math scripts it wants to create
        response = client.chat.completions.create(
            model=MODEL,
            messages=messages,
            tools=tools,
            tool_choice="auto"
        )

        # FIXED: Added [0] index targeting to resolve 'list' object error during initial turn
        response_message = response.choices[0].message

        # Process function execution loop if the AI requests code resolution
        if response_message.tool_calls:
            # 1. Append the model's message containing all parallel tool calls first
            messages.append(response_message)
            
            # 2. Iterate over and fulfill EVERY single tool call requested by the turn
            for tool_call in response_message.tool_calls:
                if tool_call.function.name == "run_python_analysis_sandbox":
                    arguments = json.loads(tool_call.function.arguments)
                    code_to_run = arguments.get("code_string")
                    
                    # Execute math script locally
                    computation_result = run_python_analysis_sandbox(code_to_run)
                    
                    # Append individual tool answers corresponding exactly to each tool ID
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "name": "run_python_analysis_sandbox",
                        "content": computation_result
                    })
            
            # Second inference step: Hand computed matrix results back to the LLM for translation
            final_response = client.chat.completions.create(
                model=MODEL,
                messages=messages
            )
            
            # FIXED: Kept [0] index targeting intact for the second validation choice loop
            return jsonify({"response": final_response.choices[0].message.content}), 200

        # Fallback response if no algorithmic execution was triggered
        return jsonify({"response": response_message.content}), 200

    except Exception as e:
        print("Pipeline execution failed:", str(e))
        return jsonify({
            "error": "Mathematical compilation error.",
            "details": str(e)
        }), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
