import { useState } from "react";
import { Box, Typography } from "@mui/material";
import "./Dash.css";
import logo from "../assets/small-logo1.svg";
import TabPanel from "./TabPanel";

export default function Dash() {
  const [file, setFile] = useState<File | null>(null);

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFile(e.target.files?.[0] ?? null);
  };

  return (
    <Box className="page">
      <Box className="side-bar">
        <img
          src={logo}
          alt="Logo-small"
          style={{ paddingTop: "15px" }}
        />

        <Box sx={{ paddingTop: "20px" }}>
          <div className="home">Home</div>
        </Box>

        <Typography
          sx={{
            color: "white",
            paddingTop: "25px",
            cursor: "pointer",
          }}
        >
          History
        </Typography>

        <Typography
          sx={{
            color: "white",
            paddingTop: "25px",
            cursor: "pointer",
          }}
        >
          Log out
        </Typography>

        <Box
          sx={{
            marginTop: "auto",
            paddingBottom: "15px",
          }}
        >
          <div className="user">User</div>
        </Box>
      </Box>

      <Box className="content">
        <Box className="header">
          <Typography
            variant="h4"
            sx={{
              color: "black",
              paddingLeft: "75px",
            }}
          >
            Cloud Studio
          </Typography>

          <Box className="header-btns">
            {/* Hidden file input */}
            <input
              id="file-upload"
              type="file"
              accept=".txt"
              onChange={handleFile}
              style={{ display: "none" }}
            />

            {/* Custom Import Button */}
            <Box
              component="label"
              htmlFor="file-upload"
              className="import"
              sx={{ cursor: "pointer" }}
            >
              Import
            </Box>

            <div
              className="export"
              style={{ marginLeft: "15px" }}
            >
              Export
            </div>
          </Box>
        </Box>

        {/* Selected file name */}
        {file && (
          <Typography
            sx={{
              ml: "75px",
              mt: 1,
              color: "#555",
              fontSize: "0.9rem",
            }}
          >
            📄 {file.name}
          </Typography>
        )}

        <Box className="clouds">
          <TabPanel
            file={file}
          />
        </Box>
      </Box>
    </Box>
  );
}