import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const API_BASE = "http://localhost:5000";

interface Patch {
  evalpts:number[][];
  datapts:number[][];
  ctrlpts:number[][];
  degree_u:number;
  degree_v:number;
  size_u:number;
  size_v:number;
  knot_u:number[];
  knot_v:number[];
  uCurvePts?:number[][];
  vCurvePts?:number[][];
}

interface CloudsProps {
  method:string;
  file:File|null;
  exportFunction:React.MutableRefObject<(() => void)|null>;
}

export default function Clouds({
  method,
  file,
  exportFunction
}:CloudsProps){

  const mountRef = useRef<HTMLDivElement|null>(null);
  const patchesRef = useRef<Patch[]>([]);

  const exportSurface = () => {
    if(patchesRef.current.length === 0) return;

    let output = "";

    patchesRef.current.forEach((p,index)=>{

      output += `# NURBS PATCH ${index}\n`;
      output += `degree_u=${p.degree_u}\n`;
      output += `degree_v=${p.degree_v}\n`;
      output += `size_u=${p.size_u}\n`;
      output += `size_v=${p.size_v}\n\n`;

      output += "ctrlpts\n";

      p.ctrlpts.forEach(pt=>{
        output += `${pt[0]},${pt[1]},${pt[2]}\n`;
      });

      output += "\nknotvector_u\n";
      output += p.knot_u.join(",") + "\n";

      output += "\nknotvector_v\n";
      output += p.knot_v.join(",") + "\n\n";
    });

    const blob = new Blob(
      [output],
      {type:"text/plain"}
    );

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = "surface_export.txt";
    link.click();

    URL.revokeObjectURL(url);
  };

  exportFunction.current = exportSurface;

  useEffect(()=>{

    let frameId:number;
    let renderer:THREE.WebGLRenderer;
    let controls:OrbitControls;
    let scene:THREE.Scene;

    const generate = async()=>{

      if(!mountRef.current || !file) return;

      const form = new FormData();

      form.append("method",method);
      form.append("file",file);

      const res = await fetch(
        `${API_BASE}/surface`,
        {
          method:"POST",
          body:form
        }
      );

      const json = await res.json();

      const patches:Patch[] =
        json.patches ?? [];

      patchesRef.current = patches;

      const width =
        mountRef.current.clientWidth || 500;

      const height = 400;

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
          antialias:true
        });

      renderer.setSize(
        width,
        height
      );

      mountRef.current.innerHTML="";

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
        pts:number[][],
        color:number,
        size:number
      )=>{

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

        scene.add(
          new THREE.Points(
            geo,
            new THREE.PointsMaterial({
              color,
              size
            })
          )
        );
      };

      const addLine = (
        pts:number[][],
        color:number
      )=>{

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

        scene.add(
          new THREE.Line(
            geo,
            new THREE.LineBasicMaterial({
              color
            })
          )
        );
      };

      const patchColors = [
        0xff0000,
        0x00ff00,
        0x0088ff,
        0xffff00,
        0xff00ff,
        0x00ffff,
        0xff8800,
        0x8800ff
      ];


      patches.forEach((p,index)=>{

        const colour =
          patchColors[
            index % patchColors.length
          ];


        addPoints(
          p.evalpts,
          colour,
          0.03
        );


        addPoints(
          p.ctrlpts,
          0xffffff,
          0.06
        );


        if(p.uCurvePts){

          addLine(
            p.uCurvePts,
            colour
          );

        }

        if(p.vCurvePts){
          addLine(
            p.vCurvePts,
            colour
          );
        }
      });

      const animate = ()=>{
        frameId =
          requestAnimationFrame(
            animate
          );
        controls.update();
        renderer.render(
          scene,
          camera
        );
      };
      animate();
    };

    generate();

    return ()=>{
      cancelAnimationFrame(frameId);
      controls?.dispose();
      renderer?.dispose();
      scene?.clear();
      if(mountRef.current)
        mountRef.current.innerHTML="";
    };
  },[
    method,
    file
  ]);

  return (
    <div
      ref={mountRef}
      style={{
        width:"100%",
        height:400
      }}
    />
  );
}