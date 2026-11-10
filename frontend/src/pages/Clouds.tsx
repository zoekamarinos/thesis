import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  Typography,
  FormControlLabel,
  Checkbox,
  Button,
} from "@mui/material";

const API_BASE = "http://localhost:5000";

const SHARP_EDGE_COLOR = 0xff6600;
const SMOOTH_EDGE_COLOR = 0x00eaff;

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
  mesh: THREE.Mesh;
  sizeU: number;
  sizeV: number;
  evalpts: number[][];
  originalNormals: Float32Array;
}

interface SharedEdge {
  tube: THREE.Mesh;
  smooth: boolean;
  a: { patchIndex: number; side: Side; indices: number[] };
  b: { patchIndex: number; side: Side; indices: number[] };
}

/*
 * Fallback grid-size finder, mirrors the backend's find_grid_size,
 * used only if sample_size_u/v weren't sent (e.g. stale server).
 */
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

function dist3(a: number[], b: number[]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/*
 * Decides whether a patch's v direction wraps all the way around
 * (e.g. a full revolution in azimuth, like a sphere, cylinder, or any
 * other "generalized cylinder" surface) rather than being a
 * genuinely open edge (e.g. a flat rectangular patch). Compares the
 * gap between the last and first column against the typical gap
 * between any other two adjacent columns -- a true wraparound closes
 * with roughly the same step size as every other seam, while a
 * genuinely open edge is normally many times wider than that.
 */
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

/*
 * Plain smooth-shaded surface mesh from a row-major (u then v) point
 * grid — one vertex per grid point, standard averaged normals.
 * Vertex index for grid point (i, j) is always i*sizeV + j, which is
 * relied on elsewhere to map boundary rows/columns straight onto the
 * normal buffer without any extra lookup table.
 */
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

  // Close the seam between the last column and the first, for
  // surfaces that wrap all the way around (e.g. a full revolution in
  // azimuth). Without this, the loop above only ever connects column
  // j to column j+1 and never wraps back to column 0 -- every such
  // surface rendered with exactly one missing strip, which is why it
  // showed up on every object (sphere, cylinder, bone) regardless of
  // shape: it was never about the geometry, it was this one seam
  // never being drawn.
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

/*
 * Vertex indices (into evalpts / the normal buffer) along one of a
 * patch's 4 outer boundaries, in a consistent walking order.
 */
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

function toVec3(evalpts: number[][], index: number): THREE.Vector3 {
  const p = evalpts[index];
  return new THREE.Vector3(p[0], p[1], p[2]);
}

/*
 * Combined bounding-box diagonal across every patch's sampled points,
 * used to scale both the edge-tube radius and the boundary-matching
 * tolerance to the model's real-world size.
 */
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

function computeBoundingDiagonal(patches: Patch[]): number {
  const box = computeBoundingBox(patches);

  if (box.isEmpty()) {
    return 1;
  }

  const size = new THREE.Vector3();
  box.getSize(size);

  // Guard against degenerate (zero-size) clouds
  return size.length() || 1;
}

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
  const sharedEdgesRef = useRef<SharedEdge[]>([]);

  const [totalPatches, setTotalPatches] = useState<string>("");

  const [showCloud, setShowCloud] = useState<boolean>(true);
  const [showControl, setShowControl] = useState<boolean>(true);
  const [showModel, setShowModel] = useState<boolean>(true);
  const [showEdges, setShowEdges] = useState<boolean>(true);

  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState<boolean>(false);

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

  // Set one shared edge's normal state, writing directly into both
  // patches' live normal buffers. Applies immediately/synchronously.
  const applyEdgeState = (edge: SharedEdge, smooth: boolean): void => {
    const infoA = patchInfosRef.current[edge.a.patchIndex];
    const infoB = patchInfosRef.current[edge.b.patchIndex];

    if (!infoA || !infoB) return;

    const normalAttrA = infoA.mesh.geometry.attributes
      .normal as THREE.BufferAttribute;
    const normalAttrB = infoB.mesh.geometry.attributes
      .normal as THREE.BufferAttribute;

    if (!smooth) {
      // Restore each patch's own originally-computed normals.
      edge.a.indices.forEach((idx) => {
        normalAttrA.setXYZ(
          idx,
          infoA.originalNormals[idx * 3],
          infoA.originalNormals[idx * 3 + 1],
          infoA.originalNormals[idx * 3 + 2]
        );
      });

      edge.b.indices.forEach((idx) => {
        normalAttrB.setXYZ(
          idx,
          infoB.originalNormals[idx * 3],
          infoB.originalNormals[idx * 3 + 1],
          infoB.originalNormals[idx * 3 + 2]
        );
      });
    } else {
      // Average matched point pairs across the two patches so the
      // shading is continuous across the seam.
      const ptsA = edge.a.indices.map((idx) => toVec3(infoA.evalpts, idx));
      const ptsB = edge.b.indices.map((idx) => toVec3(infoB.evalpts, idx));

      const nearestB = (p: THREE.Vector3): number => {
        let best = 0;
        let bestDist = Infinity;
        ptsB.forEach((q, k) => {
          const d = p.distanceTo(q);
          if (d < bestDist) {
            bestDist = d;
            best = k;
          }
        });
        return best;
      };

      const nearestA = (p: THREE.Vector3): number => {
        let best = 0;
        let bestDist = Infinity;
        ptsA.forEach((q, k) => {
          const d = p.distanceTo(q);
          if (d < bestDist) {
            bestDist = d;
            best = k;
          }
        });
        return best;
      };

      edge.a.indices.forEach((idxA, kA) => {
        const kB = nearestB(ptsA[kA]);
        const idxB = edge.b.indices[kB];

        const nA = new THREE.Vector3(
          infoA.originalNormals[idxA * 3],
          infoA.originalNormals[idxA * 3 + 1],
          infoA.originalNormals[idxA * 3 + 2]
        );
        const nB = new THREE.Vector3(
          infoB.originalNormals[idxB * 3],
          infoB.originalNormals[idxB * 3 + 1],
          infoB.originalNormals[idxB * 3 + 2]
        );

        const avg = nA.add(nB).normalize();

        normalAttrA.setXYZ(idxA, avg.x, avg.y, avg.z);
        normalAttrB.setXYZ(idxB, avg.x, avg.y, avg.z);
      });

      edge.b.indices.forEach((idxB, kB) => {
        const kA = nearestA(ptsB[kB]);
        const idxA = edge.a.indices[kA];

        const nA = new THREE.Vector3(
          infoA.originalNormals[idxA * 3],
          infoA.originalNormals[idxA * 3 + 1],
          infoA.originalNormals[idxA * 3 + 2]
        );
        const nB = new THREE.Vector3(
          infoB.originalNormals[idxB * 3],
          infoB.originalNormals[idxB * 3 + 1],
          infoB.originalNormals[idxB * 3 + 2]
        );

        const avg = nA.add(nB).normalize();

        normalAttrA.setXYZ(idxA, avg.x, avg.y, avg.z);
        normalAttrB.setXYZ(idxB, avg.x, avg.y, avg.z);
      });
    }

    normalAttrA.needsUpdate = true;
    normalAttrB.needsUpdate = true;

    edge.smooth = smooth;

    (edge.tube.material as THREE.MeshBasicMaterial).color.setHex(
      smooth ? SMOOTH_EDGE_COLOR : SHARP_EDGE_COLOR
    );
  };

  const resetAllEdges = (): void => {
    sharedEdgesRef.current.forEach((edge) => applyEdgeState(edge, false));
  };

  useEffect(() => {
    let frameId: number | undefined;
    let renderer: THREE.WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let scene: THREE.Scene | undefined;
    let camera: THREE.PerspectiveCamera | undefined;

    let cancelled = false;
    const mountNode = mountRef.current;

    const generate = async (): Promise<(() => void) | void> => {
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
      onPatchesChange?.(newPatches);

      patchInfosRef.current = new Array(newPatches.length).fill(null);
      sharedEdgesRef.current = [];

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

          const normalAttr = geometry.attributes
            .normal as THREE.BufferAttribute;

          patchInfosRef.current[index] = {
            mesh,
            sizeU,
            sizeV,
            evalpts: p.evalpts,
            originalNormals: new Float32Array(normalAttr.array),
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

      // --- Detect boundaries shared between patches, draw one tube per join ---

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

                const tube = buildEdgeTube(
                  tubePoints,
                  edgeRadius,
                  SHARP_EDGE_COLOR
                );

                scene!.add(tube);
                layersRef.current.edges.push(tube);

                sharedEdgesRef.current.push({
                  tube,
                  smooth: false,
                  a: { patchIndex: a, side: sideA, indices: idxA },
                  b: { patchIndex: b, side: sideB, indices: idxB },
                });

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

      // --- Click-to-toggle-edge handling ---

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let downPos: { x: number; y: number } | null = null;

      const handleEdgeClick = (event: PointerEvent): void => {
        if (!renderer || !camera) return;

        const rect = renderer.domElement.getBoundingClientRect();

        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(pointer, camera);

        const visibleEdges = sharedEdgesRef.current.filter(
          (edge) => edge.tube.visible
        );

        const hits = raycaster.intersectObjects(
          visibleEdges.map((e) => e.tube),
          false
        );

        if (hits.length === 0) return;

        const hitMesh = hits[0].object as THREE.Mesh;
        const edge = sharedEdgesRef.current.find((e) => e.tube === hitMesh);

        if (!edge) return;

        applyEdgeState(edge, !edge.smooth);
      };

      const onPointerDown = (e: PointerEvent): void => {
        downPos = { x: e.clientX, y: e.clientY };
      };

      const onPointerUp = (e: PointerEvent): void => {
        if (!downPos) return;

        const dx = e.clientX - downPos.x;
        const dy = e.clientY - downPos.y;
        const moved = Math.sqrt(dx * dx + dy * dy);

        downPos = null;

        if (moved > 5) return;

        handleEdgeClick(e);
      };

      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      renderer.domElement.addEventListener("pointerup", onPointerUp);

      const animate = (): void => {
        frameId = requestAnimationFrame(animate);
        controls!.update();
        renderer!.render(scene!, camera!);
      };

      animate();

      return () => {
        renderer?.domElement.removeEventListener(
          "pointerdown",
          onPointerDown
        );
        renderer?.domElement.removeEventListener("pointerup", onPointerUp);
      };
    };

    let removeListeners: (() => void) | void;

    generate().then((cleanup) => {
      removeListeners = cleanup;
    });

    return () => {
      cancelled = true;

      if (removeListeners) {
        removeListeners();
      }

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

      sharedEdgesRef.current = [];
    };
    // Visibility toggles and onPatchesChange are intentionally left out:
    // changing them must not rebuild the whole scene.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, file, totalPatches]);

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
        style={{
          display: "flex",
          gap: "16px",
          alignItems: "center",
          marginBottom: "8px",
          flexWrap: "wrap",
        }}
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

        <input
          type="number"
          min={1}
          placeholder="auto"
          value={totalPatches}
          onChange={(e) => setTotalPatches(e.target.value)}
          style={{
            marginLeft: "6px",
            width: "70px",
          }}
        />

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

        <Button size="small" variant="outlined" onClick={resetAllEdges}>
          Reset edges
        </Button>

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
        Orange edges join two patches with a sharp seam — click one to
        smooth it. Cyan edges are smoothed — click to make sharp again.
      </Typography>

      {warnings.length > 0 && (
        <div
          style={{
            color: "#b36b00",
            marginBottom: "8px",
            marginLeft: "6px",
            fontSize: 13,
          }}
        >
          {warnings.map((w, i) => (
            <div key={i}>⚠ {w}</div>
          ))}
        </div>
      )}

      {error && (
        <div
          style={{
            color: "#ff6b6b",
            marginBottom: "8px",
          }}
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