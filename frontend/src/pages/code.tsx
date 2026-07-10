import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const API_BASE = "http://localhost:5000";

const SHAPES = ["saddle", "curved_plate", "dome", "cylinder", "sphere"];
const METHODS = ["approximate", "interpolate"];

export default function Dash() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  const [shape, setShape] = useState("sphere");
  const [method, setMethod] = useState("approximate");
  const [noise, setNoise] = useState(false);

  const [file, setFile] = useState<File | null>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] || null);
  };

  // -------------------------
  // MAIN RENDER FUNCTION
  // -------------------------
  const generate = async () => {
    let renderer: THREE.WebGLRenderer;
    let scene: THREE.Scene;
    let camera: THREE.Camera;
    let controls: OrbitControls;
    let frameId: number;

    const form = new FormData();
    form.append("shape", shape);
    form.append("method", method);
    form.append("noise", String(noise));

    if (file) {
      form.append("file", file);
    }

    const res = await fetch(`${API_BASE}/surface`, {
      method: "POST",
      body: form,
    });

    const json = await res.json();
    const patches = json.patches || [];

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

    const addPoints = (pts: number[][], color: number, size: number) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(pts.flat()), 3)
      );

      scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color, size })));
    };

    const addLine = (pts: number[][], color: number) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(pts.flat()), 3)
      );

      scene.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color })));
    };

    const colors = [0xff3b30, 0x34c759, 0x007aff, 0xffcc00];

    patches.forEach((p: any, i: number) => {
      addPoints(p.evalpts, colors[i % colors.length], 0.03);
      addPoints(p.datapts, 0xffffff, 0.02);
      addPoints(p.ctrlpts, 0xff9500, 0.04);

      if (p.uCurvePts) addLine(p.uCurvePts, 0x00ffff);
      if (p.vCurvePts) addLine(p.vCurvePts, 0xff00ff);
    });

    const animate = () => {
      frameId = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };

    animate();

    return () => {
      cancelAnimationFrame(frameId);
      controls?.dispose();
      renderer?.dispose();
    };
  };

  return (
    <div style={{ color: "white" }}>
      {/* ---------------- CONTROLS ---------------- */}
      <div style={{ marginBottom: 10 }}>
        <label>Shape: </label>
        <select value={shape} onChange={(e) => setShape(e.target.value)}>
          {SHAPES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>

        <label style={{ marginLeft: 10 }}>Method: </label>
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {METHODS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>

        <label style={{ marginLeft: 10 }}>Noise: </label>
        <select
          value={noise ? "on" : "off"}
          onChange={(e) => setNoise(e.target.value === "on")}
        >
          <option value="off">No Noise</option>
          <option value="on">With Noise</option>
        </select>
      </div>

      {/* ---------------- FILE INPUT ---------------- */}
      <div style={{ marginBottom: 10 }}>
        <input type="file" accept=".txt" onChange={handleFile} />
        {file && <span style={{ marginLeft: 10 }}>📄 {file.name}</span>}
      </div>

      {/* ---------------- BUTTON (IMPORTANT FIX) ---------------- */}
      <button
        onClick={generate}
        style={{
          padding: "8px 16px",
          marginBottom: 10,
          cursor: "pointer",
        }}
      >
        Generate Surface
      </button>

      {/* ---------------- RENDER ---------------- */}
      <div ref={mountRef} style={{ width: "100%", height: 600 }} />
    </div>
  );
}