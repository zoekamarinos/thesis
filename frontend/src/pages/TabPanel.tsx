import * as React from "react";
import { useMemo, useState } from "react";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Clouds from "./Clouds";
import Chatbot from "./Chatbot";

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

interface TabPanelProps {
  file: File | null;
  exportFunction: React.RefObject<(() => void) | null>;
}

interface FitError {
  comparedPoints: number;
  meanError: number;
  rmse: number;
  maxError: number;
  controlPoints: number;
}

interface ErrorAnalysis {
  approximate: FitError;
  interpolate: FitError;
  comparedSurfacePoints: number;
  surfaceMeanError: number;
  surfaceRmse: number;
  surfaceMaxError: number;
}

function CustomTabPanel({
  children,
  value,
  index,
}: {
  children?: React.ReactNode;
  value: number;
  index: number;
}) {
  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`simple-tabpanel-${index}`}
      aria-labelledby={`simple-tab-${index}`}
    >
      {value === index && <Box sx={{ p: 1 }}>{children}</Box>}
    </div>
  );
}

function a11yProps(index: number) {
  return {
    id: `simple-tab-${index}`,
    "aria-controls": `simple-tabpanel-${index}`,
  };
}

// Returns the straight-line distance between two 3D points. 
// It is used to compare the two surfaces point by point.
function pointDistance(a: number[], b: number[]): number {
  if (a.length < 3 || b.length < 3) {
    return 0;
  }

  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];

  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Finds the distance from one point to the closest point in a list. 
// It checks every point in the list and keeps the smallest squared distance.
function nearestDistance(point: number[], targets: number[][]): number {
  let best = Infinity;

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const dx = point[0] - t[0];
    const dy = point[1] - t[1];
    const dz = point[2] - t[2];
    const d = dx * dx + dy * dy + dz * dz;

    if (d < best) best = d;
  }

  return Math.sqrt(best);
}

// Measures how well fitted surface matches original data. 
// For every data point it finds the nearest point on the surface
function fitError(patches: Patch[]): FitError {
  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let max = 0;
  let controlPoints = 0;

  patches.forEach((patch) => {
    controlPoints += patch.ctrlpts.length;

    patch.datapts.forEach((pt) => {
      const d = nearestDistance(pt, patch.evalpts);

      count++;
      sum += d;
      sumSq += d * d;
      if (d > max) max = d;
    });
  });

  const rmse = count > 0 ? Math.sqrt(sumSq / count) : 0;

  return {
    comparedPoints: count,
    meanError: count > 0 ? sum / count : 0,
    rmse,
    maxError: max,
    controlPoints,
  };
}

// Builds the full set of results for the error panel. 
// fitError is run on approximation and interpolation and compares the two surfaces point by point giving their mean, RMSE and maximum difference.
function calculateErrorAnalysis(
  approximate: Patch[],
  interpolate: Patch[]
): ErrorAnalysis {
  const patchCount = Math.min(approximate.length, interpolate.length);

  let count = 0;
  let sum = 0;
  let sumSq = 0;
  let max = 0;

  for (let p = 0; p < patchCount; p++) {
    const a = approximate[p].evalpts;
    const b = interpolate[p].evalpts;
    const n = Math.min(a.length, b.length);

    for (let i = 0; i < n; i++) {
      const d = pointDistance(a[i], b[i]);

      count++;
      sum += d;
      sumSq += d * d;
      if (d > max) max = d;
    }
  }

  const surfaceRmse = count > 0 ? Math.sqrt(sumSq / count) : 0;

  return {
    approximate: fitError(approximate),
    interpolate: fitError(interpolate),
    comparedSurfacePoints: count,
    surfaceMeanError: count > 0 ? sum / count : 0,
    surfaceRmse,
    surfaceMaxError: max,
  };
}

/*
 * One labelled value in the analysis grid.
 */
function StatCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Box
      sx={{
        p: 2,
        backgroundColor: "#FFFFFF",
        border: "1px solid #DCE3FF",
        borderRadius: 1,
      }}
    >
      <Typography variant="body2" sx={{ color: "#666" }}>
        {label}
      </Typography>

      <Typography variant="h6" sx={{ color: "black" }}>
        {value}
      </Typography>
    </Box>
  );
}

const statGridSx = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  gap: 2,
};

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return value.toExponential(4);
}

export default function TabPanel({ file, exportFunction }: TabPanelProps) {
  const [value, setValue] = useState<number>(0);

  const [approximatePatches, setApproximatePatches] = useState<Patch[]>([]);

  const [interpolatePatches, setInterpolatePatches] = useState<Patch[]>([]);

  const handleChange = (_: React.SyntheticEvent, newValue: number) => {
    setValue(newValue);
  };

  const hasApprox = approximatePatches.length > 0;

  const hasInterp = interpolatePatches.length > 0;

  const bothAvailable = hasApprox && hasInterp;

  const errorAnalysis = useMemo(
    () =>
      approximatePatches.length > 0 && interpolatePatches.length > 0
        ? calculateErrorAnalysis(approximatePatches, interpolatePatches)
        : null,
    [approximatePatches, interpolatePatches]
  );

  return (
    <Box sx={{ width: "100%" }}>
      {/* ALGORITHM TABS */}
      <Tabs
        value={value}
        onChange={handleChange}
        sx={{
          px: 2,
          "& .MuiTabs-indicator": {
            backgroundColor: "#0088FF",
          },
          "& .MuiTab-root.Mui-selected": {
            color: "#0088FF",
          },
        }}
      >
        <Tab label="Approximation" {...a11yProps(0)} />

        <Tab label="Interpolation" {...a11yProps(1)} />
      </Tabs>

      {/* APPROXIMATION */}
      <CustomTabPanel value={value} index={0}>
        <Clouds
          method="approximate"
          file={file}
          exportFunction={exportFunction}
          onPatchesChange={setApproximatePatches}
        />
      </CustomTabPanel>

      {/* INTERPOLATION */}
      <CustomTabPanel value={value} index={1}>
        <Clouds
          method="interpolate"
          file={file}
          exportFunction={exportFunction}
          onPatchesChange={setInterpolatePatches}
        />
      </CustomTabPanel>
      <Box
        className="analysis-card"
        sx={{
          mx: 2,
        }}
      >
        <Typography
          variant="h5"
          sx={{
            color: "black",
            mb: 1,
          }}
        >
          Manual Error Analysis
        </Typography>

        <Typography
          variant="body2"
          sx={{
            color: "#555",
            mb: 3,
          }}
        >
          Mathematical comparison of the fitted surfaces against the original
          data points, and against each other.
        </Typography>

        {!bothAvailable && (
          <Box
            sx={{
              backgroundColor: "#FFFFFF",
              border: "1px solid #DCE3FF",
              borderRadius: 1,
              p: 2,
            }}
          >
            <Typography
              sx={{
                color: "#555",
              }}
            >
              Generate both an approximation and interpolation surface to
              calculate the error analysis.
            </Typography>
          </Box>
        )}

        {bothAvailable && errorAnalysis && (
          <Box>
            {/* FIT TO ORIGINAL DATA */}
            <Typography variant="h6" sx={{ color: "black", mb: 0.5 }}>
              Fit to Original Data
            </Typography>

            <Typography variant="body2" sx={{ color: "#555", mb: 2 }}>
              Distance from each original data point to the nearest point on the
              fitted surface.
            </Typography>

            {(
              [
                ["Approximation", errorAnalysis.approximate],
                ["Interpolation", errorAnalysis.interpolate],
              ] as [string, FitError][]
            ).map(([name, fit]) => (
              <Box key={name} sx={{ mb: 3 }}>
                <Typography variant="subtitle1" sx={{ color: "black", mb: 1 }}>
                  {name}
                </Typography>

                <Box sx={statGridSx}>
                  <StatCard
                    label="Data Points Compared"
                    value={fit.comparedPoints}
                  />
                  <StatCard
                    label="Control Points Used"
                    value={fit.controlPoints}
                  />
                  <StatCard
                    label="Mean Error"
                    value={formatNumber(fit.meanError)}
                  />
                  <StatCard label="RMSE" value={formatNumber(fit.rmse)} />
                  <StatCard
                    label="Maximum Error"
                    value={formatNumber(fit.maxError)}
                  />
                </Box>
              </Box>
            ))}

            {/* SURFACE VS SURFACE */}
            <Typography variant="h6" sx={{ color: "black", mt: 4, mb: 0.5 }}>
              Approximation vs Interpolation
            </Typography>

            <Typography variant="body2" sx={{ color: "#555", mb: 2 }}>
              Distance between the two evaluated surfaces at matching surface
              positions.
            </Typography>

            <Box sx={statGridSx}>
              <StatCard
                label="Compared Surface Points"
                value={errorAnalysis.comparedSurfacePoints}
              />
              <StatCard
                label="Mean Difference"
                value={formatNumber(errorAnalysis.surfaceMeanError)}
              />
              <StatCard
                label="RMSE"
                value={formatNumber(errorAnalysis.surfaceRmse)}
              />
              <StatCard
                label="Maximum Difference"
                value={formatNumber(errorAnalysis.surfaceMaxError)}
              />
            </Box>
          </Box>
        )}
      </Box>
      <Box
        className="analysis-card"
        sx={{
          mx: 2,
          mb: 2,
        }}
      >
        <Chatbot
          approximatePatches={approximatePatches}
          interpolatePatches={interpolatePatches}
        />
      </Box>
    </Box>
  );
}
