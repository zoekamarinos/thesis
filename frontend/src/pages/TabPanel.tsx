import * as React from "react";
import { useState } from "react";
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

interface ErrorAnalysis {
  comparedControlPoints: number;
  meanEuclideanError: number;
  rmse: number;
  maxEuclideanError: number;
  maxErrorPatch: number;
  maxErrorPoint: number;
  relativeError: number;
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
      {value === index && (
        <Box sx={{ p: 1 }}>
          {children}
        </Box>
      )}
    </div>
  );
}

function a11yProps(index: number) {
  return {
    id: `simple-tab-${index}`,
    "aria-controls":
      `simple-tabpanel-${index}`,
  };
}

/*
 * Calculates the Euclidean distance between
 * two 3D points.
 */
function pointDistance(
  a: number[],
  b: number[]
): number {
  if (
    a.length < 3 ||
    b.length < 3
  ) {
    return 0;
  }

  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];

  return Math.sqrt(
    dx * dx +
      dy * dy +
      dz * dz
  );
}

/*
 * Calculates the magnitude of a 3D point.
 */
function pointMagnitude(
  point: number[]
): number {
  if (point.length < 3) {
    return 0;
  }

  return Math.sqrt(
    point[0] * point[0] +
      point[1] * point[1] +
      point[2] * point[2]
  );
}

/*
 * Compare approximation and interpolation.
 *
 * Control points are compared by matching
 * patch index and point index.
 */
function calculateErrorAnalysis(
  approximate: Patch[],
  interpolate: Patch[]
): ErrorAnalysis {

  const distances: number[] = [];

  let maxError = 0;
  let maxPatch = -1;
  let maxPoint = -1;

  let interpolationMagnitude = 0;
  let magnitudeCount = 0;

  /*
   * CONTROL POINT COMPARISON
   */
  const patchCount = Math.min(
    approximate.length,
    interpolate.length
  );

  for (
    let patchIndex = 0;
    patchIndex < patchCount;
    patchIndex++
  ) {

    const approxPoints =
      approximate[patchIndex]
        ?.ctrlpts ?? [];

    const interpPoints =
      interpolate[patchIndex]
        ?.ctrlpts ?? [];

    const pointCount =
      Math.min(
        approxPoints.length,
        interpPoints.length
      );

    for (
      let pointIndex = 0;
      pointIndex < pointCount;
      pointIndex++
    ) {

      const approx =
        approxPoints[pointIndex];

      const interp =
        interpPoints[pointIndex];

      const distance =
        pointDistance(
          approx,
          interp
        );

      distances.push(distance);

      const magnitude =
        pointMagnitude(interp);

      if (magnitude > 0) {
        interpolationMagnitude +=
          magnitude;

        magnitudeCount++;
      }

      if (
        distance > maxError
      ) {
        maxError = distance;
        maxPatch =
          patchIndex;
        maxPoint =
          pointIndex;
      }
    }
  }

  const comparedControlPoints =
    distances.length;

  const meanEuclideanError =
    comparedControlPoints > 0
      ? distances.reduce(
          (sum, value) =>
            sum + value,
          0
        ) /
        comparedControlPoints
      : 0;

  const rmse =
    comparedControlPoints > 0
      ? Math.sqrt(
          distances.reduce(
            (sum, value) =>
              sum +
              value * value,
            0
          ) /
            comparedControlPoints
        )
      : 0;

  /*
   * Relative difference.
   *
   * This is based on the magnitude of
   * the interpolation control points.
   */
  const relativeError =
    interpolationMagnitude > 0
      ? (meanEuclideanError /
          (interpolationMagnitude /
            magnitudeCount)) *
        100
      : 0;

  /*
   * SURFACE POINT COMPARISON
   */
  const surfaceDistances: number[] =
    [];

  for (
    let patchIndex = 0;
    patchIndex < patchCount;
    patchIndex++
  ) {

    const approxSurface =
      approximate[patchIndex]
        ?.evalpts ?? [];

    const interpSurface =
      interpolate[patchIndex]
        ?.evalpts ?? [];

    const pointCount =
      Math.min(
        approxSurface.length,
        interpSurface.length
      );

    for (
      let pointIndex = 0;
      pointIndex < pointCount;
      pointIndex++
    ) {

      surfaceDistances.push(
        pointDistance(
          approxSurface[pointIndex],
          interpSurface[pointIndex]
        )
      );
    }
  }

  const comparedSurfacePoints =
    surfaceDistances.length;

  const surfaceMeanError =
    comparedSurfacePoints > 0
      ? surfaceDistances.reduce(
          (sum, value) =>
            sum + value,
          0
        ) /
        comparedSurfacePoints
      : 0;

  const surfaceRmse =
    comparedSurfacePoints > 0
      ? Math.sqrt(
          surfaceDistances.reduce(
            (sum, value) =>
              sum +
              value * value,
            0
          ) /
            comparedSurfacePoints
        )
      : 0;

  const surfaceMaxError =
    comparedSurfacePoints > 0
      ? Math.max(
          ...surfaceDistances
        )
      : 0;

  return {
    comparedControlPoints,
    meanEuclideanError,
    rmse,
    maxEuclideanError: maxError,
    maxErrorPatch: maxPatch,
    maxErrorPoint: maxPoint,
    relativeError,
    comparedSurfacePoints,
    surfaceMeanError,
    surfaceRmse,
    surfaceMaxError,
  };
}

function formatNumber(
  value: number
): string {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return value.toExponential(4);
}

export default function TabPanel({
  file,
  exportFunction,
}: TabPanelProps) {

  const [value, setValue] =
    useState<number>(0);

  const [
    approximatePatches,
    setApproximatePatches,
  ] = useState<Patch[]>([]);

  const [
    interpolatePatches,
    setInterpolatePatches,
  ] = useState<Patch[]>([]);

  const handleChange = (
    _: React.SyntheticEvent,
    newValue: number
  ) => {
    setValue(newValue);
  };

  const hasApprox =
    approximatePatches.length > 0;

  const hasInterp =
    interpolatePatches.length > 0;

  const bothAvailable =
    hasApprox && hasInterp;

  const errorAnalysis =
    bothAvailable
      ? calculateErrorAnalysis(
          approximatePatches,
          interpolatePatches
        )
      : null;

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

        <Tab
          label="Approximation"
          {...a11yProps(0)}
        />

        <Tab
          label="Interpolation"
          {...a11yProps(1)}
        />

      </Tabs>

      {/* APPROXIMATION */}
      <CustomTabPanel
        value={value}
        index={0}
      >

        <Clouds
          method="approximate"
          file={file}
          exportFunction={
            exportFunction
          }
          onPatchesChange={
            setApproximatePatches
          }
        />

      </CustomTabPanel>

      {/* INTERPOLATION */}
      <CustomTabPanel
        value={value}
        index={1}
      >

        <Clouds
          method="interpolate"
          file={file}
          exportFunction={
            exportFunction
          }
          onPatchesChange={
            setInterpolatePatches
          }
        />

      </CustomTabPanel>

      {/* =====================================================
          MANUAL MATHEMATICAL ERROR ANALYSIS
          ===================================================== */}

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
          Mathematical comparison of the
          control points and evaluated
          surfaces generated by the
          approximation and interpolation
          algorithms.
        </Typography>

        {!bothAvailable && (
          <Box
            sx={{
              backgroundColor:
                "#FFFFFF",
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
              Generate both an
              approximation and
              interpolation surface
              to calculate the error
              analysis.
            </Typography>

          </Box>
        )}

        {bothAvailable &&
          errorAnalysis && (

            <Box>

              {/* CONTROL POINT ANALYSIS */}
              <Typography
                variant="h6"
                sx={{
                  color: "black",
                  mb: 2,
                }}
              >
                Control Point Comparison
              </Typography>

              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 2,
                }}
              >

                <Box
                  sx={{
                    p: 2,
                    backgroundColor:
                      "#FFFFFF",
                    border: "1px solid #DCE3FF",
                    borderRadius: 1,
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      color: "#666",
                    }}
                  >
                    Compared Control Points
                  </Typography>

                  <Typography
                    variant="h6"
                    sx={{
                      color: "black",
                    }}
                  >
                    {
                      errorAnalysis.comparedControlPoints
                    }
                  </Typography>
                </Box>

                <Box
                  sx={{
                    p: 2,
                    backgroundColor:
                      "#FFFFFF",
                    border: "1px solid #DCE3FF",
                    borderRadius: 1,
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      color: "#666",
                    }}
                  >
                    Mean Euclidean Difference
                  </Typography>

                  <Typography
                    variant="h6"
                    sx={{
                      color: "black",
                    }}
                  >
                    {formatNumber(
                      errorAnalysis.meanEuclideanError
                    )}
                  </Typography>
                </Box>

                <Box
                  sx={{
                    p: 2,
                    backgroundColor:
                      "#FFFFFF",
                    border: "1px solid #DCE3FF",
                    borderRadius: 1,
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      color: "#666",
                    }}
                  >
                    RMSE
                  </Typography>

                  <Typography
                    variant="h6"
                    sx={{
                      color: "black",
                    }}
                  >
                    {formatNumber(
                      errorAnalysis.rmse
                    )}
                  </Typography>
                </Box>

                <Box
                  sx={{
                    p: 2,
                    backgroundColor:
                      "#FFFFFF",
                    border: "1px solid #DCE3FF",
                    borderRadius: 1,
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      color: "#666",
                    }}
                  >
                    Maximum Difference
                  </Typography>

                  <Typography
                    variant="h6"
                    sx={{
                      color: "black",
                    }}
                  >
                    {formatNumber(
                      errorAnalysis.maxEuclideanError
                    )}
                  </Typography>
                </Box>

                <Box
                  sx={{
                    p: 2,
                    backgroundColor:
                      "#FFFFFF",
                    border: "1px solid #DCE3FF",
                    borderRadius: 1,
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      color: "#666",
                    }}
                  >
                    Relative Difference
                  </Typography>

                  <Typography
                    variant="h6"
                    sx={{
                      color: "black",
                    }}
                  >
                    {
                      errorAnalysis.relativeError.toFixed(
                        4
                      )
                    }
                    %
                  </Typography>
                </Box>

                <Box
                  sx={{
                    p: 2,
                    backgroundColor:
                      "#FFFFFF",
                    border: "1px solid #DCE3FF",
                    borderRadius: 1,
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      color: "#666",
                    }}
                  >
                    Largest Difference
                  </Typography>

                  <Typography
                    variant="body1"
                    sx={{
                      color: "black",
                    }}
                  >
                    Patch{" "}
                    {errorAnalysis.maxErrorPatch +
                      1}
                    , Control Point{" "}
                    {errorAnalysis.maxErrorPoint +
                      1}
                  </Typography>
                </Box>

              </Box>

              {/* SURFACE ANALYSIS */}
              <Typography
                variant="h6"
                sx={{
                  color: "black",
                  mt: 4,
                  mb: 2,
                }}
              >
                Evaluated Surface Comparison
              </Typography>

              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: 2,
                }}
              >

                <Box
                  sx={{
                    p: 2,
                    backgroundColor:
                      "#FFFFFF",
                    border: "1px solid #DCE3FF",
                    borderRadius: 1,
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      color: "#666",
                    }}
                  >
                    Compared Surface Points
                  </Typography>

                  <Typography
                    variant="h6"
                    sx={{
                      color: "black",
                    }}
                  >
                    {
                      errorAnalysis.comparedSurfacePoints
                    }
                  </Typography>
                </Box>

                <Box
                  sx={{
                    p: 2,
                    backgroundColor:
                      "#FFFFFF",
                    border: "1px solid #DCE3FF",
                    borderRadius: 1,
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      color: "#666",
                    }}
                  >
                    Mean Surface Difference
                  </Typography>

                  <Typography
                    variant="h6"
                    sx={{
                      color: "black",
                    }}
                  >
                    {formatNumber(
                      errorAnalysis.surfaceMeanError
                    )}
                  </Typography>
                </Box>

                <Box
                  sx={{
                    p: 2,
                    backgroundColor:
                      "#FFFFFF",
                    border: "1px solid #DCE3FF",
                    borderRadius: 1,
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      color: "#666",
                    }}
                  >
                    Surface RMSE
                  </Typography>

                  <Typography
                    variant="h6"
                    sx={{
                      color: "black",
                    }}
                  >
                    {formatNumber(
                      errorAnalysis.surfaceRmse
                    )}
                  </Typography>
                </Box>

                <Box
                  sx={{
                    p: 2,
                    backgroundColor:
                      "#FFFFFF",
                    border: "1px solid #DCE3FF",
                    borderRadius: 1,
                  }}
                >
                  <Typography
                    variant="body2"
                    sx={{
                      color: "#666",
                    }}
                  >
                    Maximum Surface Difference
                  </Typography>

                  <Typography
                    variant="h6"
                    sx={{
                      color: "black",
                    }}
                  >
                    {formatNumber(
                      errorAnalysis.surfaceMaxError
                    )}
                  </Typography>
                </Box>

              </Box>

              <Typography
                variant="caption"
                sx={{
                  display: "block",
                  color: "#666",
                  mt: 2,
                }}
              >
                The calculated values represent
                differences between the two
                algorithms. They do not by
                themselves establish which
                algorithm is more accurate.
              </Typography>

            </Box>
          )}

      </Box>

      {/* =====================================================
          AI ANALYSIS
          ===================================================== */}

      <Box
        className="analysis-card"
        sx={{
          mx: 2,
          mb: 2,
        }}
      >

        <Chatbot
          approximatePatches={
            approximatePatches
          }
          interpolatePatches={
            interpolatePatches
          }
        />

      </Box>

    </Box>
  );
}