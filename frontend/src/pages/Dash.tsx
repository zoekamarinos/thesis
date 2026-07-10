import { useState } from "react";
import { Box, Typography } from '@mui/material';
// const API_BASE = "http://localhost:5000";
import "./Dash.css";
// import logo1 from "../assets/logo1.svg";
import logo from "../assets/small-logo1.svg";
import TabPanel from './TabPanel';

const SHAPES = [
  "saddle",
  "curved_plate",
  "dome",
  "cylinder",
  "sphere",
];

export default function Dash() {
  const [shape, setShape] = useState("sphere");
  const [noise, setNoise] = useState(false);
  const [file, setFile] = useState<File | null>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] ?? null);
  };

  return (
    <Box className="page">
        <Box className="side-bar">
          <img src={logo} alt="Logo-small" style={{ paddingTop: "15px" }}/>
          <Box sx={{paddingTop: "20px" }}>
            <div className="home">Home</div>
          </Box>
          <Typography sx={{ color: "white", paddingTop: "25px", cursor: "pointer" }}>History</Typography>
          {/* <Box sx={{paddingTop: "20px" }}>
            <div className="history">History</div>
          </Box> */}
          <Typography sx={{ color: "white", paddingTop: "25px", cursor: "pointer" }}>Log out</Typography>
          <Box sx={{ marginTop: "auto", paddingBottom: "15px"}}>
            <div className="user">User</div>
          </Box>
        </Box>
        <Box className="content">
          <Box className="header">
            <Typography variant="h4" sx={{ color: "black", paddingLeft: "75px" }}>Cloud Studio</Typography>
            <Box className="header-btns">
              <label>Shape: </label>
              <select
                value={shape}
                onChange={(e) =>
                  setShape(e.target.value)
                }
              >
                {SHAPES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>

              <label style={{ marginLeft: 10 }}>
                Noise:
              </label>

              <select
                value={noise ? "on" : "off"}
                onChange={(e) =>
                  setNoise(e.target.value === "on")
                }
              >
                <option value="off">
                  No Noise
                </option>

                <option value="on">
                  With Noise
                </option>
              </select>
              <div style={{ marginBottom: 10 }}>
                <input
                  type="file"
                  accept=".txt"
                  onChange={handleFile}
                />

                {file && (
                  <span style={{ marginLeft: 10 }}>
                    📄 {file.name}
                  </span>
                )}
              </div>
              <div className="import">Import</div>
              <div className="export" style={{ marginLeft: "15px" }}>Export</div>
            </Box>
          </Box>
          <Box className="clouds">
            <TabPanel shape={shape} noise={noise} file={file}/>
          </Box>
        </Box>
    </Box>
  );
}