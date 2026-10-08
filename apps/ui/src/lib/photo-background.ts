export type PhotoBackdrop = {
  axis: "sides" | "top-bottom" | "none";
  gap: number;
};

export function photoBackdropLayout(
  width: number,
  height: number,
  boxWidth: number,
  boxHeight: number,
): PhotoBackdrop {
  if ([width, height, boxWidth, boxHeight].some((value) => !Number.isFinite(value) || value <= 0))
    return { axis: "none", gap: 0 };
  const ratio = width / height;
  const boxRatio = boxWidth / boxHeight;
  if (Math.abs(ratio - boxRatio) < 0.001) return { axis: "none", gap: 0 };
  const axis = ratio < boxRatio ? "sides" : "top-bottom";
  const gap =
    axis === "sides" ? (boxWidth - boxHeight * ratio) / 2 : (boxHeight - boxWidth / ratio) / 2;
  // Borders and fractional layout can leave an imperceptible subpixel band.
  return gap < 1 ? { axis: "none", gap: 0 } : { axis, gap };
}
