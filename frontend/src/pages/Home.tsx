// import { useRef, useState } from "react";
import { Box, Typography, Button } from '@mui/material';
// const API_BASE = "http://localhost:5000";
import "./Home.css";
// import logo1 from "../assets/logo1.svg";
import logo from "../assets/logo.svg";

export default function Home() {
  return (
    <Box className="page">
        <Box className="logo-page-half">
            <img src={logo} alt="Logo"/>
        </Box>
        <Box className="content-page-half">
            <Typography variant="h3" sx={{marginLeft: "10%"}}>
                CloudStudio
            </Typography>
            <Box sx={{marginLeft: "25%", marginTop: "10%"}}>
                <div className="login">
                    Login
                </div>
            </Box>
            <Box sx={{marginLeft: "25%", marginTop: "7%"}}>
                <div className="sign-up">
                    Sign Up
                </div>
            </Box>
        </Box>
    </Box>
  );
}