import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const API_BASE = "http://localhost:5000";

const SHAPE_OPTIONS = [
  { value: "saddle", label: "Saddle" },
  { value: "curved_plate", label: "Curved Plate" },
  { value: "dome", label: "Dome" },
  { value: "cylinder", label: "Cylinder" },
  { value: "sphere", label: "Sphere" },
];

const METHOD_OPTIONS = [
  { value: "approximate", label: "Approximation" },
  { value: "interpolate", label: "Interpolation" },
];

export default function NurbsSurface() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  const [shape, setShape] = useState("sphere");
  const [method, setMethod] = useState("approximate");
  const [noise, setNoise] = useState(false);

  useEffect(() => {
    let renderer: THREE.WebGLRenderer;
    let scene: THREE.Scene;
    let camera: THREE.Camera;
    let controls: OrbitControls;
    let frameId: number;

    fetch(
      `${API_BASE}/surface?shape=${shape}&method=${method}&noise=${noise}`
    )
      .then((res) => res.json())
      .then(({ patches }) => {
        const width = mountRef.current?.clientWidth || 600;
        const height = 600;

        // ---------------- SCENE ----------------
        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x111111);

        camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
        camera.position.set(3, 3, 3);

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);

        if (mountRef.current) {
          mountRef.current.innerHTML = "";
          mountRef.current.appendChild(renderer.domElement);
        }

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;

        scene.add(new THREE.AxesHelper(2));

        // ---------------- HELPERS ----------------
        const addPoints = (pts: number[][], color: number, size: number) => {
          const geo = new THREE.BufferGeometry();
          const flat = new Float32Array(pts.flat());
          geo.setAttribute("position", new THREE.BufferAttribute(flat, 3));

          const mat = new THREE.PointsMaterial({
            color,
            size,
            sizeAttenuation: true,
          });

          scene.add(new THREE.Points(geo, mat));
        };

        const addControlPoints = (
          pts: number[][],
          color: number,
          size: number
        ) => {
          const geo = new THREE.BufferGeometry();
          const flat = new Float32Array(pts.flat());
          geo.setAttribute("position", new THREE.BufferAttribute(flat, 3));

          const mat = new THREE.PointsMaterial({
            color,
            size,
            sizeAttenuation: true,
          });

          scene.add(new THREE.Points(geo, mat));
        };

        const addLine = (pts: number[][], color: number) => {
          const geo = new THREE.BufferGeometry();
          const flat = new Float32Array(pts.flat());
          geo.setAttribute("position", new THREE.BufferAttribute(flat, 3));

          const mat = new THREE.LineBasicMaterial({ color });

          scene.add(new THREE.Line(geo, mat));
        };

        const colors = [
          0xff3b30,
          0x34c759,
          0x007aff,
          0xffcc00,
          0xaf52de,
          0xff9500,
        ];

        // ---------------- RENDER PATCHES ----------------
        patches.forEach((p: any, i: number) => {
          // surface
          addPoints(p.evalpts, colors[i % colors.length], 0.03);

          // data points (white)
          addPoints(p.datapts, 0xffffff, 0.02);

          // control points (orange)
          addControlPoints(p.ctrlpts, 0xff9500, 0.05);

          // curves
          if (p.uCurvePts) addLine(p.uCurvePts, 0x00ffff);
          if (p.vCurvePts) addLine(p.vCurvePts, 0xff00ff);
        });

        // ---------------- ANIMATION ----------------
        const animate = () => {
          frameId = requestAnimationFrame(animate);
          controls.update();
          renderer.render(scene, camera);
        };

        animate();
      });

    // ---------------- CLEANUP ----------------
    return () => {
      cancelAnimationFrame(frameId);
      if (controls) controls.dispose();
      if (renderer) renderer.dispose();
    };
  }, [shape, method, noise]);

  return (
    <div>
      {/* ---------------- UI CONTROLS ---------------- */}
      <div style={{ marginBottom: 10, color: "white" }}>
        {/* Shape */}
        <label>Shape: </label>
        <select value={shape} onChange={(e) => setShape(e.target.value)}>
          {SHAPE_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        {/* Method */}
        <label style={{ marginLeft: 16 }}>Method: </label>
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {METHOD_OPTIONS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

        {/* Noise */}
        <label style={{ marginLeft: 16 }}>Noise: </label>
        <select
          value={noise ? "on" : "off"}
          onChange={(e) => setNoise(e.target.value === "on")}
        >
          <option value="off">No Noise</option>
          <option value="on">With Noise</option>
        </select>
      </div>

      {/* ---------------- RENDER AREA ---------------- */}
      <div ref={mountRef} style={{ width: "100%", height: 600 }} />
    </div>
  );
}