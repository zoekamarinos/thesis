import { useRef, useState } from "react";
import { Box, Typography } from "@mui/material";
import "./Dash.css";
import logo from "../../assets/small-logo1.svg";
import TabPanel from "../TabPanel/TabPanel";
import { useNavigate } from "react-router-dom";

export default function Dash() {
  const navigate = useNavigate();

  const [file, setFile] =
    useState<File | null>(null);

  const exportFunction =
    useRef<(() => void) | null>(null);

  const handleFile = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    setFile(
      e.target.files?.[0] ?? null
    );
  };

  return (
    <Box
      className="page"
    >
      {/* SIDEBAR */}
      <Box
        className="side-bar"
      >
        <img
          src={logo}
          alt="Logo-small"
          style={{
            paddingTop: "15px",
          }}
        />

        <Box
          sx={{
            paddingTop: "20px",
          }}
        >
          <div className="home">
            Home
          </div>
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
          onClick={() =>
            navigate("/")
          }
          sx={{
            color: "white",
            paddingTop: "25px",
            cursor: "pointer",
          }}
        >
          Log out
        </Typography>

        {/* Push user section to bottom */}
        <Box
          sx={{
            marginTop: "auto",
            paddingBottom: "15px",
          }}
        >
          <div className="user">
            User
          </div>
        </Box>
      </Box>

      {/* MAIN CONTENT */}
      <Box
        className="content"
      >
        {/* HEADER */}
        <Box className="header">
          <Typography
            variant="h4"
            sx={{
              color: "black",
              paddingLeft: "75px",
            }}
          >
            CloudStudio
          </Typography>

          <Box className="header-btns">
            <div
              className="import"
              onClick={() =>
                document
                  .getElementById(
                    "fileInput"
                  )
                  ?.click()
              }
            >
              Import
            </div>

            <input
              id="fileInput"
              type="file"
              accept=".txt"
              hidden
              onChange={handleFile}
            />

            <div
              className="export"
              style={{
                marginLeft: "15px",
              }}
              onClick={() =>
                exportFunction.current?.()
              }
            >
              Export
            </div>
          </Box>
        </Box>

        {/* NURBS + ANALYSIS */}
        <Box
          className="clouds"
          sx={{
            paddingBottom: "40px",
          }}
        >
          <TabPanel
            file={file}
            exportFunction={
              exportFunction
            }
          />
        </Box>
      </Box>
    </Box>
  );
}