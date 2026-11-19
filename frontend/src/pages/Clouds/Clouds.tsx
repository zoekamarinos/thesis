import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Typography, FormControlLabel, Checkbox } from "@mui/material";
import "./Clouds.css";

const API_BASE = "http://localhost:5000";

const EDGE_COLOR = 0xff6600;

interface Patch {
  evalpts: number[][];
  datapts: number[][];
  ctrlpts: number[][];
  degree_u: number;
  degree_v: number;
  size_u: number;
  size_v: number;
  sample_size_u?: number;
  sample_size_v?: number;
  knot_u: number[];
  knot_v: number[];
  uCurvePts?: number[][];
  vCurvePts?: number[][];
}

interface SurfaceResponse {
  patches?: Patch[];
  warnings?: string[];
  error?: string;
}

interface CloudsProps {
  method: string;
  file: File | null;
  exportFunction: React.RefObject<(() => void) | null>;
  onPatchesChange?: (patches: Patch[]) => void;
}

interface LayerObjects {
  cloud: THREE.Object3D[];
  control: THREE.Object3D[];
  model: THREE.Object3D[];
  edges: THREE.Object3D[];
}

type Side = "uStart" | "uEnd" | "vStart" | "vEnd";

interface PatchInfo {
  sizeU: number;
  sizeV: number;
  evalpts: number[][];
}

// Finds two whole numbers that multiply to a given point count and are as close together as possible, to guess a grid’s rows and columns. 
// Used when server doesn’t say how big the sampled grid is.
function findGridSize(n: number): [number, number] | null {
  let best: [number, number] | null = null;
  let diff = Infinity;

  for (let i = 2; i <= Math.sqrt(n); i++) {
    if (n % i === 0) {
      const j = n / i;
      if (Math.abs(i - j) < diff) {
        best = [i, j];
        diff = Math.abs(i - j);
      }
    }
  }

  return best;
}

// Returns the straight-line distance between two 3D points.
function dist3(a: number[], b: number[]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Decides whether a surface wraps all the way around or has an open edge. 
// It compares the gap between the last and first column of points and treats small values as completely closed in.
function isClosedInV(pts: number[][], sizeU: number, sizeV: number): boolean {
  if (sizeV < 3) return false;

  let wrapTotal = 0;
  let typicalTotal = 0;
  let typicalCount = 0;

  for (let i = 0; i < sizeU; i++) {
    const first = pts[i * sizeV];
    const last = pts[i * sizeV + (sizeV - 1)];
    wrapTotal += dist3(first, last);

    for (let j = 0; j < sizeV - 1; j++) {
      typicalTotal += dist3(pts[i * sizeV + j], pts[i * sizeV + j + 1]);
      typicalCount++;
    }
  }

  const wrapAvg = wrapTotal / sizeU;
  const typicalAvg = typicalCount > 0 ? typicalTotal / typicalCount : 0;

  return typicalAvg > 0 && wrapAvg <= typicalAvg * 2.5;
}

// Turns the grid of surface points into a 3D mesh by joining each group of four neighbouring points with two triangles. 
// If the surface wraps around it also joins the last column back to the first.
function buildSurfaceGeometry(
  pts: number[][],
  sizeU: number,
  sizeV: number
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();

  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(pts.flat(), 3)
  );

  const indices: number[] = [];

  for (let i = 0; i < sizeU - 1; i++) {
    for (let j = 0; j < sizeV - 1; j++) {
      const a = i * sizeV + j;
      const b = i * sizeV + (j + 1);
      const c = (i + 1) * sizeV + j;
      const d = (i + 1) * sizeV + (j + 1);

      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  if (isClosedInV(pts, sizeU, sizeV)) {
    for (let i = 0; i < sizeU - 1; i++) {
      const a = i * sizeV + (sizeV - 1);
      const b = i * sizeV + 0;
      const c = (i + 1) * sizeV + (sizeV - 1);
      const d = (i + 1) * sizeV + 0;

      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  return geometry;
}

// Returns the positions of the points along one of a patch’s four edges. 
// These are used to find edges that two patches share.
function boundaryIndices(sizeU: number, sizeV: number, side: Side): number[] {
  const out: number[] = [];

  if (side === "uStart") {
    for (let j = 0; j < sizeV; j++) out.push(j);
  } else if (side === "uEnd") {
    for (let j = 0; j < sizeV; j++) out.push((sizeU - 1) * sizeV + j);
  } else if (side === "vStart") {
    for (let i = 0; i < sizeU; i++) out.push(i * sizeV);
  } else {
    for (let i = 0; i < sizeU; i++) out.push(i * sizeV + (sizeV - 1));
  }

  return out;
}

// Looks up a point by its index and returns it as a ThreeJS vector.
function toVec3(evalpts: number[][], index: number): THREE.Vector3 {
  const p = evalpts[index];
  return new THREE.Vector3(p[0], p[1], p[2]);
}

// Builds the box that encloses every surface, control and data point from all the patches. 
// It is used to centre the camera on the model.
function computeBoundingBox(patches: Patch[]): THREE.Box3 {
  const box = new THREE.Box3();

  patches.forEach((p) => {
    [p.evalpts, p.ctrlpts, p.datapts].forEach((arr) => {
      arr?.forEach((pt) => {
        box.expandByPoint(new THREE.Vector3(pt[0], pt[1], pt[2]));
      });
    });
  });

  return box;
}

// Returns the length of that box’s diagonal, which is the model’s overall size. 
// Camera distance, point size and edge-tube thickness are all scaled from it.
function computeBoundingDiagonal(patches: Patch[]): number {
  const box = computeBoundingBox(patches);

  if (box.isEmpty()) {
    return 1;
  }

  const size = new THREE.Vector3();
  box.getSize(size);

  return size.length() || 1;
}

// Draws a smooth tube along a list of points, using a curve through them. 
// It is used to highlight the shared edge between two patches.
function buildEdgeTube(
  points: THREE.Vector3[],
  radius: number,
  color: number
): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal");
  const segments = Math.max(points.length - 1, 2);
  const geometry = new THREE.TubeGeometry(curve, segments, radius, 6, false);
  const material = new THREE.MeshBasicMaterial({ color });

  return new THREE.Mesh(geometry, material);
}

export default function Clouds({
  method,
  file,
  exportFunction,
  onPatchesChange,
}: CloudsProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const patchesRef = useRef<Patch[]>([]);
  const layersRef = useRef<LayerObjects>({
    cloud: [],
    control: [],
    model: [],
    edges: [],
  });

  const patchInfosRef = useRef<(PatchInfo | null)[]>([]);

  const [totalPatches, setTotalPatches] = useState<string>("");
  const [autoCount, setAutoCount] = useState<number>(0);

  const [showCloud, setShowCloud] = useState<boolean>(true);
  const [showControl, setShowControl] = useState<boolean>(true);
  const [showModel, setShowModel] = useState<boolean>(true);
  const [showEdges, setShowEdges] = useState<boolean>(true);

  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

  // Writes every patch’s degrees, control points and knot vectors into a text file and downloads it as surface_export.txt
  const exportSurface = (): void => {
    if (patchesRef.current.length === 0) {
      return;
    }

    let output = "";

    patchesRef.current.forEach((p, index) => {
      output += `# NURBS PATCH ${index}\n`;
      output += `degree_u=${p.degree_u}\n`;
      output += `degree_v=${p.degree_v}\n`;
      output += `size_u=${p.size_u}\n`;
      output += `size_v=${p.size_v}\n\n`;
      output += "ctrlpts\n";

      p.ctrlpts.forEach((pt) => {
        output += `${pt[0]},${pt[1]},${pt[2]}\n`;
      });

      output += "\nknotvector_u\n";
      output += p.knot_u.join(",") + "\n";
      output += "\nknotvector_v\n";
      output += p.knot_v.join(",") + "\n\n";
    });

    const blob = new Blob([output], {
      type: "text/plain",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "surface_export.txt";
    link.click();
    URL.revokeObjectURL(url);
  };

  exportFunction.current = exportSurface;

  // Step the patch count from the current value (or the auto count while
  // the box is blank). It can't go below the auto-detected count.
  const stepPatches = (delta: number): void => {
    const parsed = parseInt(totalPatches, 10);
    const current = Number.isNaN(parsed) ? autoCount : parsed;
    setTotalPatches(String(Math.max(autoCount, current + delta)));
  };

  const clampPatches = (): void => {
    const parsed = parseInt(totalPatches, 10);
    if (!Number.isNaN(parsed) && parsed < autoCount) {
      setTotalPatches(String(autoCount));
    }
  };

  useEffect(() => {
    let frameId: number | undefined;
    let renderer: THREE.WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let scene: THREE.Scene | undefined;
    let camera: THREE.PerspectiveCamera | undefined;

    let cancelled = false;
    const mountNode = mountRef.current;

    // This is the main routine. It sends the file and patch count to the backend. 
    // It then builds the scene with the surface meshes, control points, data points and edges.
    const generate = async (): Promise<void> => {
      if (!mountRef.current || !file) {
        return;
      }

      setError(null);
      setWarnings([]);
      setLoading(true);

      const form = new FormData();

      form.append("method", method);
      form.append("file", file);

      if (totalPatches.trim() !== "") {
        form.append("totalPatches", totalPatches.trim());
      }

      let json: SurfaceResponse;

      try {
        const res = await fetch(`${API_BASE}/surface`, {
          method: "POST",
          body: form,
        });

        json = await res.json();

        if (!res.ok) {
          throw new Error(json.error || "Surface generation failed.");
        }
      } catch (e) {
        if (!cancelled) {
          setError(
            e instanceof Error ? e.message : "No. Patches not valid"
          );

          setLoading(false);
        }

        return;
      }

      if (cancelled) {
        return;
      }

      if (json.error) {
        setError(json.error);
        setLoading(false);
        return;
      }

      // Drop any patch whose sampled surface has non-finite values, so
      // one bad patch can't blank the whole view.
      const newPatches: Patch[] = (json.patches ?? []).filter(
        (p: Patch) =>
          Array.isArray(p.evalpts) &&
          p.evalpts.length > 0 &&
          p.evalpts.every((pt) => pt.every((v) => Number.isFinite(v)))
      );

      setWarnings(Array.isArray(json.warnings) ? json.warnings : []);

      if (newPatches.length === 0) {
        setError("The server returned no drawable surface for this file.");
        setLoading(false);
        return;
      }

      patchesRef.current = newPatches;
      if (totalPatches.trim() === "") {
        setAutoCount(newPatches.length);
      }
      onPatchesChange?.(newPatches);

      patchInfosRef.current = new Array(newPatches.length).fill(null);

      setLoading(false);

      const width = mountRef.current.clientWidth || 500;
      const height = 500;

      scene = new THREE.Scene();
      scene.background = new THREE.Color(0x111111);

      // Scale everything to the model so tiny or huge clouds are visible,
      // instead of assuming a model about one unit wide.
      const sceneDiag = computeBoundingDiagonal(newPatches);
      const sceneBox = computeBoundingBox(newPatches);
      const sceneCenter = new THREE.Vector3();
      if (!sceneBox.isEmpty()) sceneBox.getCenter(sceneCenter);

      camera = new THREE.PerspectiveCamera(
        60,
        width / height,
        sceneDiag * 0.001,
        sceneDiag * 100
      );
      camera.position.copy(sceneCenter).addScalar(sceneDiag * 0.9);

      renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(width, height);

      mountRef.current.innerHTML = "";
      mountRef.current.appendChild(renderer.domElement);

      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.target.copy(sceneCenter);
      controls.update();

      scene.add(new THREE.AxesHelper(sceneDiag * 0.6));

      scene.add(new THREE.AmbientLight(0xffffff, 0.6));

      const keyLight = new THREE.DirectionalLight(0xffffff, 1.0);
      keyLight.position.set(5, 5, 5);
      scene.add(keyLight);

      const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
      fillLight.position.set(-5, -3, -5);
      scene.add(fillLight);

      layersRef.current = {
        cloud: [],
        control: [],
        model: [],
        edges: [],
      };

      const addPoints = (
        pts: number[][],
        color: number,
        size: number
      ): THREE.Points => {
        const geo = new THREE.BufferGeometry();

        geo.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(pts.flat()), 3)
        );

        const points = new THREE.Points(
          geo,
          new THREE.PointsMaterial({ color, size })
        );

        scene!.add(points);
        return points;
      };

      const addLine = (pts: number[][], color: number): THREE.Line => {
        const geo = new THREE.BufferGeometry();

        geo.setAttribute(
          "position",
          new THREE.BufferAttribute(new Float32Array(pts.flat()), 3)
        );

        const line = new THREE.Line(
          geo,
          new THREE.LineBasicMaterial({ color })
        );

        scene!.add(line);
        return line;
      };

      const patchColors = [
        0xff0000,
        0x00ff00,
        0x0088ff,
        0xffff00,
        0xff00ff,
        0x00ffff,
        0xff8800,
        0x8800ff,
      ];

      newPatches.forEach((p, index) => {
        const colour = patchColors[index % patchColors.length];

        let sizeU = p.sample_size_u;
        let sizeV = p.sample_size_v;

        if (!sizeU || !sizeV) {
          const grid = findGridSize(p.evalpts.length);
          if (grid) [sizeU, sizeV] = grid;
        }

        if (sizeU && sizeV && sizeU * sizeV === p.evalpts.length) {
          const geometry = buildSurfaceGeometry(p.evalpts, sizeU, sizeV);

          const material = new THREE.MeshStandardMaterial({
            color: colour,
            side: THREE.DoubleSide,
            metalness: 0.1,
            roughness: 0.6,
          });

          const mesh = new THREE.Mesh(geometry, material);

          scene!.add(mesh);

          layersRef.current.model.push(mesh);

          patchInfosRef.current[index] = {
            sizeU,
            sizeV,
            evalpts: p.evalpts,
          };
        } else {
          // Fallback: couldn't determine a grid, show points instead
          layersRef.current.model.push(
            addPoints(p.evalpts, colour, sceneDiag * 0.008)
          );
        }

        layersRef.current.control.push(
          addPoints(p.ctrlpts, 0xffffff, sceneDiag * 0.016)
        );

        if (p.datapts) {
          layersRef.current.cloud.push(
            addPoints(p.datapts, 0x00ffaa, sceneDiag * 0.016)
          );
        }

        if (p.uCurvePts) {
          layersRef.current.model.push(addLine(p.uCurvePts, colour));
        }

        if (p.vCurvePts) {
          layersRef.current.model.push(addLine(p.vCurvePts, colour));
        }
      });

      // Detect boundary edges that two patches share and draw a tube along them
      const diag = computeBoundingDiagonal(newPatches);
      const tolerance = diag * 0.02;
      const edgeRadius = THREE.MathUtils.clamp(
        diag * 0.006,
        diag * 0.002,
        diag * 0.02
      );

      const sides: Side[] = ["uStart", "uEnd", "vStart", "vEnd"];
      const usedSides = new Set<string>();

      for (let a = 0; a < newPatches.length; a++) {
        const infoA = patchInfosRef.current[a];
        if (!infoA) continue;

        for (let b = a + 1; b < newPatches.length; b++) {
          const infoB = patchInfosRef.current[b];
          if (!infoB) continue;

          for (const sideA of sides) {
            const keyA = `${a}:${sideA}`;
            if (usedSides.has(keyA)) continue;

            const idxA = boundaryIndices(infoA.sizeU, infoA.sizeV, sideA);
            const ptsA0 = toVec3(infoA.evalpts, idxA[0]);
            const ptsA1 = toVec3(infoA.evalpts, idxA[idxA.length - 1]);

            for (const sideB of sides) {
              const keyB = `${b}:${sideB}`;
              if (usedSides.has(keyB)) continue;

              const idxB = boundaryIndices(infoB.sizeU, infoB.sizeV, sideB);
              const ptsB0 = toVec3(infoB.evalpts, idxB[0]);
              const ptsB1 = toVec3(infoB.evalpts, idxB[idxB.length - 1]);

              const forward =
                ptsA0.distanceTo(ptsB0) + ptsA1.distanceTo(ptsB1);
              const reversed =
                ptsA0.distanceTo(ptsB1) + ptsA1.distanceTo(ptsB0);

              const dist = Math.min(forward, reversed) / 2;

              if (dist <= tolerance) {
                usedSides.add(keyA);
                usedSides.add(keyB);

                const tubePoints = idxA.map((idx) =>
                  toVec3(infoA.evalpts, idx)
                );

                const tube = buildEdgeTube(tubePoints, edgeRadius, EDGE_COLOR);

                scene!.add(tube);
                layersRef.current.edges.push(tube);

                break;
              }
            }
          }
        }
      }

      layersRef.current.cloud.forEach((o) => (o.visible = showCloud));
      layersRef.current.control.forEach((o) => (o.visible = showControl));
      layersRef.current.model.forEach((o) => (o.visible = showModel));
      layersRef.current.edges.forEach((o) => (o.visible = showEdges));

      const animate = (): void => {
        frameId = requestAnimationFrame(animate);
        controls!.update();
        renderer!.render(scene!, camera!);
      };

      animate();

    };
    generate();

    return () => {
      cancelled = true;

      if (frameId !== undefined) {
        cancelAnimationFrame(frameId);
      }

      controls?.dispose();
      renderer?.dispose();
      scene?.clear();

      if (mountNode) {
        mountNode.innerHTML = "";
      }

      layersRef.current = {
        cloud: [],
        control: [],
        model: [],
        edges: [],
      };

    };
    // Visibility toggles and onPatchesChange are intentionally left out
  }, [method, file, totalPatches]);

  // A new file has its own auto count, so start again from auto
  useEffect(() => {
    setTotalPatches("");
    setAutoCount(0);
  }, [file]);

  useEffect(() => {
    layersRef.current.cloud.forEach((o) => (o.visible = showCloud));
  }, [showCloud]);

  useEffect(() => {
    layersRef.current.control.forEach((o) => (o.visible = showControl));
  }, [showControl]);

  useEffect(() => {
    layersRef.current.model.forEach((o) => (o.visible = showModel));
  }, [showModel]);

  useEffect(() => {
    layersRef.current.edges.forEach((o) => (o.visible = showEdges));
  }, [showEdges]);

  return (
    <div>
      <div
        className="clouds-tools"
      >
        <Typography
          variant="h6"
          sx={{
            color: "black",
            marginLeft: "6px",
          }}
        >
          Number of patches:
        </Typography>

        <button
          type="button"
          onClick={() => stepPatches(-1)}
          disabled={
            autoCount === 0 ||
            (totalPatches !== "" && parseInt(totalPatches, 10) <= autoCount)
          }
        >
          −
        </button>

        <input
          type="number"
          min={autoCount || 1}
          placeholder={autoCount > 0 ? `auto (${autoCount})` : "auto"}
          value={totalPatches}
          onChange={(e) => setTotalPatches(e.target.value)}
          onBlur={clampPatches}
          className="patch-input"
        />

        <button
          type="button"
          onClick={() => stepPatches(1)}
          disabled={autoCount === 0}
        >
          +
        </button>

        <FormControlLabel
          control={
            <Checkbox
              checked={showCloud}
              onChange={(e) => setShowCloud(e.target.checked)}
            />
          }
          label="Cloud points"
        />

        <FormControlLabel
          control={
            <Checkbox
              checked={showControl}
              onChange={(e) => setShowControl(e.target.checked)}
            />
          }
          label="Control points"
        />

        <FormControlLabel
          control={
            <Checkbox
              checked={showModel}
              onChange={(e) => setShowModel(e.target.checked)}
            />
          }
          label="Model"
        />

        <FormControlLabel
          control={
            <Checkbox
              checked={showEdges}
              onChange={(e) => setShowEdges(e.target.checked)}
            />
          }
          label="Show edges"
        />
        {loading && <span>Generating surface…</span>}
      </div>

      <Typography
        variant="body2"
        sx={{
          color: "#666",
          marginLeft: "6px",
          marginBottom: "8px",
        }}
      >
        Orange edges mark where two patches join.
      </Typography>

      {warnings.length > 0 && (
        <div
          className="clouds-warnings"
        >
          {warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}

      {error && (
        <div
          className="clouds-error"
        >
          {error}
        </div>
      )}

      <div
        ref={mountRef}
        style={{
          width: "100%",
          height: 500,
        }}
      />
    </div>
  );
}