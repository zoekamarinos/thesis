import { Box, Typography } from '@mui/material';
import "./Home.css";
import logo from "../assets/logo.svg";
import { useNavigate } from 'react-router-dom';

export default function Home() {
    const navigate = useNavigate();
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
                <div className="login" onClick={() => navigate('/dash')}>
                    Login
                </div>
            </Box>
            <Box sx={{marginLeft: "25%", marginTop: "7%"}}>
                <div className="sign-up" onClick={() => navigate('/')}>
                    Sign Up
                </div>
            </Box>
        </Box>
    </Box>
  );
}