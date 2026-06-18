// NurbsSurface.jsx
//
// Fetches the fitted NURBS surface from the Flask backend (server.py)
// and renders it with three.js: cyan/magenta isocurves, surface as a
// point cloud, and the original data points in red — matching the
// original matplotlib script's visualization.
//
// npm install three

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
// import BezierPatchBuilder from './BezierPatchBuilder.tsx';

const API_URL = "http://localhost:5000/surface";

export default function NurbsSurface() {
  const mountRef = useRef(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let renderer: THREE.WebGLRenderer, scene: THREE.Scene<THREE.Object3DEventMap>, camera: THREE.Camera, frameId: number, controls: OrbitControls;

    fetch(API_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json();
      })
      .then(({ evalpts, datapts, uCurvePts, vCurvePts }) => {
        setLoading(false);

        const width = mountRef.current.clientWidth || 600;
        const height = 600;

        scene = new THREE.Scene();
        scene.background = new THREE.Color(0x111111);

        camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1000);
        camera.position.set(20, 20, 20);
        camera.lookAt(0, 0, 0);

        renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(width, height);
        mountRef.current.appendChild(renderer.domElement);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;

        scene.add(new THREE.AxesHelper(10));

        // Helper to build a colored point cloud from an array of [x, y, z]
        const addPoints = (pts: any[], color: number, size: number) => {
          const geo = new THREE.BufferGeometry();
          const flat = new Float32Array(pts.flat());
          geo.setAttribute("position", new THREE.BufferAttribute(flat, 3));
          const mat = new THREE.PointsMaterial({ color, size, sizeAttenuation: true });
          scene.add(new THREE.Points(geo, mat));
        };

        // Helper to build a colored line from an array of [x, y, z]
        const addLine = (pts: any[], color: number) => {
          const geo = new THREE.BufferGeometry();
          const flat = new Float32Array(pts.flat());
          geo.setAttribute("position", new THREE.BufferAttribute(flat, 3));
          const mat = new THREE.LineBasicMaterial({ color });
          scene.add(new THREE.Line(geo, mat));
        };

        // Fitted surface as a point cloud (cyan-ish, matches evalpts scatter)
        addPoints(evalpts, 0x00bcd4, 0.25);

        // Original input data points (red, matches the scatter in the script)
        addPoints(datapts, 0xff3b30, 0.6);

        // Optional: u/v isocurves extracted from the surface
        if (uCurvePts) addLine(uCurvePts, 0x00ffff); // cyan
        if (vCurvePts) addLine(vCurvePts, 0xff00ff); // magenta

        const animate = () => {
          frameId = requestAnimationFrame(animate);
          controls.update();
          renderer.render(scene, camera);
        };
        animate();
      })
      .catch((err) => {
        setLoading(false);
        setError(err.message);
      });

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      if (controls) controls.dispose();
      if (renderer) {
        renderer.dispose();
        if (mountRef.current && renderer.domElement.parentNode === mountRef.current) {
          mountRef.current.removeChild(renderer.domElement);
        }
      }
    };
  }, []);

  return (
    <div>
      {loading && <p>Loading surface…</p>}
      {error && <p style={{ color: "red" }}>Failed to load surface: {error}</p>}
      <div ref={mountRef} style={{ width: "100%", height: 600 }} />
      {/* <BezierPatchBuilder /> */}
    </div>
  );
}
