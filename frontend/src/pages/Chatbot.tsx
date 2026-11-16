import React, { useState } from "react";
import {
  Box,
  Button,
  TextField,
  Typography,
} from "@mui/material";

const API_BASE = "http://localhost:5001";

interface Patch {
  evalpts: number[][];
  datapts: number[][];
  ctrlpts: number[][];
  degree_u: number;
  degree_v: number;
  size_u: number;
  size_v: number;
  knot_u: number[];
  knot_v: number[];
  uCurvePts?: number[][];
  vCurvePts?: number[][];
}

interface ChatMessage {
  sender: "User" | "Chatbot";
  text: string;
}

interface ChatbotProps {
  approximatePatches: Patch[];
  interpolatePatches: Patch[];
}

function Chatbot({
  approximatePatches,
  interpolatePatches,
}: ChatbotProps) {

  const [prompt, setPrompt] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  const hasApprox = approximatePatches.length > 0;
  const hasInterp = interpolatePatches.length > 0;
  const bothAvailable = hasApprox && hasInterp;

  const handleChatSubmit = async (): Promise<void> => {
    if (!prompt.trim()) {
      alert("Please enter a question.");
      return;
    }

    if (!hasApprox && !hasInterp) {
      alert("No NURBS surfaces have been generated yet.");
      return;
    }

    const userPrompt = prompt.trim();

    setChatMessages((previous) => [
      ...previous,
      {
        sender: "User",
        text: userPrompt,
      },
    ]);

    setPrompt("");
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/analyze-control-points`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: userPrompt,
          approximatePatches: approximatePatches,
          interpolatePatches: interpolatePatches,
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.error || "Server error");
      }

      setChatMessages((previous) => [
        ...previous,
        {
          sender: "Chatbot",
          text: result.response || "No response was returned.",
        },
      ]);

    } catch (error) {
      console.error("Error:", error);
      const errorText = error instanceof Error ? error.message : "Error analysing the control points.";
      setChatMessages((previous) => [
        ...previous,
        {
          sender: "Chatbot",
          text: errorText,
        },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Box>
      <Typography
        variant="h5"
        sx={{
          color: "black",
          mb: 1,
        }}
      >
        AI Error Analysis
      </Typography>

      <Typography
        variant="body2"
        sx={{
          color: "#555",
          mb: 2,
        }}
      >
        Use the AI assistant to interpret the mathematical results and compare the approximation and interpolation algorithms.
      </Typography>

      <Box
        sx={{
          backgroundColor: "#FFFFFF",
          border: "1px solid #DCE3FF",
          borderRadius: 1,
          p: 2,
          mb: 3,
        }}
      >
        <Typography variant="body2" sx={{ color: "#555" }}>
          {bothAvailable
            ? "Both approximation and interpolation results are available for comparison."
            : hasApprox
            ? "Only approximation results are currently available. Generate interpolation results for a complete comparison."
            : hasInterp
            ? "Only interpolation results are currently available. Generate approximation results for a complete comparison."
            : "Generate both surfaces before performing an AI comparison."}
        </Typography>
      </Box>

      {/* CHAT HISTORY CONTAINER */}
      <Box
        sx={{
          height: 400,
          overflowY: "auto",
          mb: 2,
          p: 2,
          bgcolor: "#F8FAFC",
          border: "1px solid #E2E8F0",
          borderRadius: 2,
          display: "flex",
          flexDirection: "column",
          gap: 1.5
        }}
      >
        {chatMessages.map((msg, index) => {
          const isUser = msg.sender === "User";
          return (
            <Box
              key={index}
              sx={{
                display: "flex",
                justifyContent: isUser ? "flex-end" : "flex-start",
                width: "100%"
              }}
            >
              <Box
                sx={{
                  maxWidth: "80%",
                  borderRadius: 2,
                  p: 2,
                  bgcolor: isUser ? "#0088FF" : "#FFFFFF",
                  color: isUser ? "#FFFFFF" : "#0F172A",
                  boxShadow: "0px 1px 3px rgba(0, 0, 0, 0.05)",
                  border: isUser ? "none" : "1px solid #E2E8F0",
                }}
              >
                <Typography
                  variant="caption"
                  sx={{
                    display: "block",
                    fontWeight: 700,
                    color: isUser ? "rgba(255, 255, 255, 0.8)" : "#64748B",
                    mb: 0.5
                  }}
                >
                  {msg.sender.toUpperCase()}
                </Typography>
                <Typography sx={{ whiteSpace: "pre-wrap", fontSize: "0.925rem", lineHeight: 1.5 }}>
                  {msg.text}
                </Typography>
              </Box>
            </Box>
          );
        })}

        {/* LOADING STATE BUBBLE */}
        {loading && (
          <Box sx={{ display: "flex", justifyContent: "flex-start", width: "100%" }}>
            <Box
              sx={{
                maxWidth: "80%",
                borderRadius: 2,
                p: 2,
                bgcolor: "#FFFFFF",
                color: "#64748B",
                boxShadow: "0px 1px 3px rgba(0, 0, 0, 0.05)",
                border: "1px solid #E2E8F0",
              }}
            >
              <Typography variant="caption" sx={{ display: "block", fontWeight: 700, color: "#0088FF", mb: 0.5 }}>
                AI SYSTEM
              </Typography>
              <Typography sx={{ fontStyle: "italic", fontSize: "0.925rem", lineHeight: 1.5 }}>
                Analysing the approximation and interpolation geometric arrays...
              </Typography>
            </Box>
          </Box>
        )}
      </Box>

      {/* QUESTION INPUT FRAME */}
      <Box sx={{ display: "flex", gap: 2 }}>
        <TextField
          fullWidth
          variant="outlined"
          label="Ask the AI about your results..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleChatSubmit();
            }
          }}
          disabled={loading}
          sx={{
            input: { color: "#000000" },
            "& .MuiInputBase-root": { color: "#000000" },
            "& .MuiInputLabel-root": { color: "#555" },
            "& .MuiOutlinedInput-root": {
              "& fieldset": { borderColor: "#DCE3FF" },
              "&:hover fieldset": { borderColor: "#0088FF" },
              "&.Mui-focused fieldset": { borderColor: "#0088FF" },
            },
          }}
        />

        <Button
          variant="contained"
          onClick={handleChatSubmit}
          disabled={loading}
          sx={{
            backgroundColor: "#0088FF",
            minWidth: "120px",
            fontWeight: 600,
            "&:hover": { backgroundColor: "#0B0084" },
          }}
        >
          {loading ? "Analysing..." : "Analyse"}
        </Button>
      </Box>
    </Box>
  );
}

export default Chatbot;
