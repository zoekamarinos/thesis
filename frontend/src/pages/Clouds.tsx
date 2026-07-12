import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
const API_BASE = "http://localhost:5000";
interface Patch {
  evalpts: number[][];
  datapts: number[][];
  ctrlpts: number[][];
  uCurvePts?: number[][];
  vCurvePts?: number[][];
}
interface CloudsProps {
  method: string;
  file: File | null;
}

export default function Clouds({
  method,
  file
}: CloudsProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let frameId: number | undefined;
    let renderer: THREE.WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let scene: THREE.Scene | undefined;

    const generate = async () => {
      if (!mountRef.current) return;
      const form = new FormData();
      form.append("method", method);

      if (file) {
        form.append(
          "file",
          file
        );
      }

      const res = await fetch(
        `${API_BASE}/surface`,
        {
          method: "POST",
          body: form,
        }
      );

      const json = await res.json();

      const patches: Patch[] =
        json.patches ?? [];

      const width =
        mountRef.current.clientWidth || 300;

      const height = mountRef.current.clientHeight || 350;

      scene = new THREE.Scene();
      scene.background =
        new THREE.Color(0x111111);

      const camera =
        new THREE.PerspectiveCamera(
          60,
          width / height,
          0.1,
          1000
        );
      camera.position.set(
        3,
        3,
        3
      );
      renderer =
        new THREE.WebGLRenderer({
          antialias: true,
        });
      renderer.setSize(
        width,
        height
      );
      mountRef.current.innerHTML = "";
      mountRef.current.appendChild(
        renderer.domElement
      );
      controls =
        new OrbitControls(
          camera,
          renderer.domElement
        );
      controls.enableDamping = true;
      scene.add(
        new THREE.AxesHelper(2)
      );
      const addPoints = (
        pts: number[][],
        color: number,
        size: number
      ) => {

        const geo =
          new THREE.BufferGeometry();

        geo.setAttribute(
          "position",
          new THREE.BufferAttribute(
            new Float32Array(
              pts.flat()
            ),
            3
          )
        );
        scene!.add(
          new THREE.Points(
            geo,
            new THREE.PointsMaterial({
              color,
              size,
            })
          )
        );

      };

      const addLine = (
        pts: number[][],
        color: number
      ) => {

        const geo =
          new THREE.BufferGeometry();
        geo.setAttribute(
          "position",
          new THREE.BufferAttribute(
            new Float32Array(
              pts.flat()
            ),
            3
          )
        );
        scene!.add(
          new THREE.Line(
            geo,
            new THREE.LineBasicMaterial({
              color,
            })
          )
        );
      };

      const colors = [
        0xff3b30,
        0x34c759,
        0x007aff,
        0xffcc00,
      ];

      patches.forEach(
        (p, i) => {

          addPoints(
            p.evalpts,
            colors[i % colors.length],
            0.03
          );

          addPoints(
            p.datapts,
            0xffffff,
            0.02
          );

          addPoints(
            p.ctrlpts,
            0xff9500,
            0.04
          );

          if (p.uCurvePts) {
            addLine(
              p.uCurvePts,
              0x00ffff
            );
          }

          if (p.vCurvePts) {
            addLine(
              p.vCurvePts,
              0xff00ff
            );
          }

        }
      );

      const animate = () => {
        frameId =
          requestAnimationFrame(
            animate
          );

        controls!.update();
        renderer!.render(
          scene!,
          camera
        );
      };
      animate();
    };
    generate();

    return () => {
      if (frameId) {
        cancelAnimationFrame(frameId);
      }
      controls?.dispose();
      renderer?.dispose();
      scene?.clear();
      if (mountRef.current) {
        mountRef.current.innerHTML = "";
      }
    };
  }, [
    method,
    file
  ]);

  return (
    <div
      ref={mountRef}
      style={{
        width: "100%",
        height: "100%",
      }}
    />
  );
}