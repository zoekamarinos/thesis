import * as React from "react";
import { useState } from "react";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import Box from "@mui/material/Box";
import Clouds from "./code";

interface TabPanelProps {
  children?: React.ReactNode;
  index: number;
  value: number;
}

function CustomTabPanel(props: TabPanelProps) {
  const { children, value, index, ...other } = props;

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`simple-tabpanel-${index}`}
      aria-labelledby={`simple-tab-${index}`}
      {...other}
    >
      {value === index && <Box sx={{ p: 3 }}>{children}</Box>}
    </div>
  );
}

function a11yProps(index: number) {
  return {
    id: `simple-tab-${index}`,
    "aria-controls": `simple-tabpanel-${index}`,
  };
}

export default function TabPanel({ shape, noise, file }) {
  const [value, setValue] = useState(0);
  const [method, setMethod] = useState("approximate");

  const handleChange = (
    _: React.SyntheticEvent,
    newValue: number
  ) => {
    setValue(newValue);

    if (newValue === 0) {
      setMethod("approximate");
    } else {
      setMethod("interpolate");
    }
  };

  return (
    <Box sx={{ width: "100%" }}>
      <Box sx={{ borderBottom: 1, borderColor: "divider" }}>
        <Tabs
          value={value}
          onChange={handleChange}
          aria-label="basic tabs"
        >
          <Tab
            label="Approximation"
            sx={{ fontFamily: "sans-serif", color: "black" }}
            {...a11yProps(0)}
          />

          <Tab
            label="Interpolation"
            sx={{ fontFamily: "sans-serif", color: "black" }}
            {...a11yProps(1)}
          />
        </Tabs>
      </Box>

      <CustomTabPanel value={value} index={0}>
        <Clouds method={method} shape={shape} noise={noise} file={file}/>
      </CustomTabPanel>

      <CustomTabPanel value={value} index={1}>
        <Clouds method={method} shape={shape} noise={noise} file={file}/>
      </CustomTabPanel>
    </Box>
  );
}