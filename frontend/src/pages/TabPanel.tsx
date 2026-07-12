import * as React from "react";
import { useState } from "react";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import Box from "@mui/material/Box";
import Clouds from "./Clouds";

interface TabPanelProps {
  file:File|null;
  exportFunction:any;
}

function CustomTabPanel({
  children,
  value,
  index
}:{
  children?:React.ReactNode;
  value:number;
  index:number;
}) {

  return (
    <div
      role="tabpanel"
      hidden={value !== index}
    >
      {
        value === index &&
        <Box sx={{p:1}}>
          {children}
        </Box>
      }
    </div>
  );
}

function a11yProps(index:number){
  return {
    id:`simple-tab-${index}`,
    "aria-controls":
      `simple-tabpanel-${index}`
  };
}

export default function TabPanel({
  file,
  exportFunction
}:TabPanelProps){
  const [value,setValue] =
    useState(0);
  const [method,setMethod] =
    useState("approximate");
  const handleChange = (
    _:React.SyntheticEvent,
    newValue:number
  )=>{
    setValue(newValue);
    setMethod(
      newValue === 0
      ? "approximate"
      : "interpolate"
    );
  };

  return (
    <Box sx={{width:"100%"}}>
      <Tabs
        value={value}
        onChange={handleChange}
      >
        <Tab
          label="Approximation"
          {...a11yProps(0)}
        />
        <Tab
          label="Interpolation"
          {...a11yProps(1)}
        />
      </Tabs>
      <CustomTabPanel
        value={value}
        index={0}
      >
        <Clouds
          method={method}
          file={file}
          exportFunction={exportFunction}
        />
      </CustomTabPanel>
      <CustomTabPanel
        value={value}
        index={1}
      >
        <Clouds
          method={method}
          file={file}
          exportFunction={exportFunction}
        />
      </CustomTabPanel>
    </Box>
  );
}