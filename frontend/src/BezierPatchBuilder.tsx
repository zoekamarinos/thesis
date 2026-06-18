// BezierPatchBuilder.tsx
//
// Replaces the matplotlib interactive_ui() picker with a React + three.js UI:
//   - Fetches fitted B-spline control points from the Flask backend
//   - Renders them as clickable points (click to select/deselect, turns red)
//   - du/dv steppers (+/-) like the original buttons
//   - "Build Bezier" button posts the selected points + du/dv to /bezier
//     and renders the resulting patch
//
// npm install three

import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const API_BASE = "http://localhost:5000";

type Point = [number, number, number];

export default function BezierPatchBuilder() {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const pointsMeshRef = useRef<THREE.InstancedMesh | null>(null);
  const patchGroupRef = useRef<THREE.Group | null>(null);
  const raycasterRef = useRef(new THREE.Raycaster());
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);

  const [controlPoints, setControlPoints] = useState<Point[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set()); // indices, insertion order matters
  const [selectionOrder, setSelectionOrder] = useState<number[]>([]); // preserves click order
  const [degreeU, setDegreeU] = useState(3);
  const [degreeV, setDegreeV] = useState(3);
  const [status, setStatus] = useState("Loading control points…");
  const [error, setError] = useState<string | null>(null);

  const expectedCount = (degreeU + 1) * (degreeV + 1);

  // ---- Fetch control points once ----
  useEffect(() => {
    fetch(`${API_BASE}/control-points`)
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json();
      })
      .then(({ controlPoints }) => {
        setControlPoints(controlPoints);
        setStatus(`du=${degreeU}, dv=${degreeV} | Selected 0/${expectedCount}`);
      })
      .catch((err: Error) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Set up three.js scene once control points are loaded ----
  useEffect(() => {
    if (controlPoints.length === 0 || !mountRef.current) return;
    const mountEl = mountRef.current;

    const width = mountEl.clientWidth || 600;
    const height = 600;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111111);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
    camera.position.set(4, 4, 4);
    camera.lookAt(0, 0, 0);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(width, height);
    mountEl.innerHTML = "";
    mountEl.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.AxesHelper(2));

    // Control points as individually-colored point sprites via InstancedMesh
    const geo = new THREE.SphereGeometry(0.04, 12, 12);
    const mat = new THREE.MeshBasicMaterial({ color: 0x3399ff });
    const mesh = new THREE.InstancedMesh(geo, mat, controlPoints.length);
    const dummy = new THREE.Object3D();
    controlPoints.forEach((p, i) => {
      dummy.position.set(p[0], p[1], p[2]);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(controlPoints.length * 3),
      3
    ) as unknown as THREE.InstancedBufferAttribute;
    for (let i = 0; i < controlPoints.length; i++) {
      mesh.setColorAt(i, new THREE.Color(0x3399ff));
    }
    scene.add(mesh);
    pointsMeshRef.current = mesh;

    const patchGroup = new THREE.Group();
    scene.add(patchGroup);
    patchGroupRef.current = patchGroup;

    // Click-to-select via raycasting against the instanced mesh
    const handleClick = (event: MouseEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1
      );
      raycasterRef.current.setFromCamera(mouse, camera);
      const hits = raycasterRef.current.intersectObject(mesh);
      if (hits.length > 0 && hits[0].instanceId !== undefined) {
        toggleSelect(hits[0].instanceId);
      }
    };
    renderer.domElement.addEventListener("click", handleClick);

    let frameId: number;
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frameId);
      renderer.domElement.removeEventListener("click", handleClick);
      controls.dispose();
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controlPoints]);

  // ---- Recolor instanced mesh whenever selection changes ----
  useEffect(() => {
    const mesh = pointsMeshRef.current;
    if (!mesh) return;
    for (let i = 0; i < controlPoints.length; i++) {
      mesh.setColorAt(i, new THREE.Color(selected.has(i) ? 0xff3b30 : 0x3399ff));
    }
    mesh.instanceColor.needsUpdate = true;
    setStatus(`du=${degreeU}, dv=${degreeV} | Selected ${selected.size}/${expectedCount}`);
  }, [selected, controlPoints, degreeU, degreeV, expectedCount]);

  const toggleSelect = useCallback((i: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) {
        next.delete(i);
        setSelectionOrder((order) => order.filter((x) => x !== i));
      } else {
        next.add(i);
        setSelectionOrder((order) => [...order, i]);
      }
      return next;
    });
  }, []);

  const clearSelection = () => {
    setSelected(new Set());
    setSelectionOrder([]);
  };

  const buildBezier = async () => {
    if (selectionOrder.length !== expectedCount) {
      setStatus(
        `Need exactly ${expectedCount} points selected (have ${selectionOrder.length})`
      );
      return;
    }
    setError(null);
    setStatus("Building Bézier patch…");

    const pts = selectionOrder.map((i) => controlPoints[i]);

    try {
      const res = await fetch(`${API_BASE}/bezier`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: pts, degreeU, degreeV }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Build failed");

      // Clear previous patch render
      const patchGroup = patchGroupRef.current;
      if (!patchGroup) return;
      patchGroup.clear();

      const geo = new THREE.BufferGeometry();
      const flat = new Float32Array(data.evalpts.flat());
      geo.setAttribute("position", new THREE.BufferAttribute(flat, 3));
      const mat = new THREE.PointsMaterial({ color: 0x33ff99, size: 0.05 });
      patchGroup.add(new THREE.Points(geo, mat));

      setStatus(`Bézier patch built (${data.evalpts.length} points)`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus("Build failed");
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 8, display: "flex", gap: 12, alignItems: "center" }}>
        <span>du: {degreeU}</span>
        <button onClick={() => setDegreeU((d) => d + 1)}>du +</button>
        <button onClick={() => setDegreeU((d) => Math.max(1, d - 1))}>du -</button>
        <span>dv: {degreeV}</span>
        <button onClick={() => setDegreeV((d) => d + 1)}>dv +</button>
        <button onClick={() => setDegreeV((d) => Math.max(1, d - 1))}>dv -</button>
        <button onClick={buildBezier}>Build Bézier</button>
        <button onClick={clearSelection}>Clear selection</button>
      </div>

      <div>{status}</div>
      {error && <div style={{ color: "red" }}>Error: {error}</div>}

      <div ref={mountRef} style={{ width: "100%", height: 600, marginTop: 8 }} />
    </div>
  );
}
