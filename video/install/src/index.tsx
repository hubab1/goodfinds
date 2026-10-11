import React, { useMemo } from "react";
import {
  AbsoluteFill,
  Composition,
  Easing,
  Img,
  interpolate,
  registerRoot,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const ink = "#151515";
const clamp = { extrapolateLeft: "clamp" as const, extrapolateRight: "clamp" as const };
const labels = ["Open the installer.", "Install Goodfinds.", "Find something good."];
const captions = [
  "Open the .pkg file and choose Continue.",
  "Choose Install. Goodfinds opens ChatGPT.",
  "Choose Install in ChatGPT. You’re ready to go.",
];

const Logo = ({ size = 80 }: { size?: number }) => {
  const style = useMemo(
    () => ({ width: size, height: size, background: "#000", borderRadius: size * 0.22 }),
    [size],
  );
  return <Img src={staticFile("logo.png")} style={style} />;
};
const Check = () => (
  <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
    <circle cx="26" cy="26" r="25" fill={ink} />
    <path
      d="m15 26 7 7 15-15"
      stroke="white"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const Button = ({
  children,
  active = false,
  native = false,
}: {
  children: React.ReactNode;
  active?: boolean;
  native?: boolean;
}) => (
  <div
    style={{
      padding: "17px 30px",
      borderRadius: 10,
      color: "white",
      background: native ? (active ? "#2162d6" : "#3478f6") : active ? "#444" : ink,
      fontSize: 25,
      fontWeight: 600,
      display: "inline-block",
    }}
  >
    {children}
  </div>
);

function Cursor({
  frame,
  to,
  click = 99,
}: {
  frame: number;
  to: [number, number];
  click?: number;
}) {
  const t = interpolate(frame, [42, 92], [0, 1], {
    ...clamp,
    easing: Easing.bezier(0.22, 1, 0.36, 1),
  });
  const pulse = interpolate(frame, [click, click + 7, click + 20], [0, 1, 0], clamp);
  return (
    <div
      style={{
        position: "absolute",
        left: 850 + (to[0] - 850) * t,
        top: 780 + (to[1] - 780) * t,
        opacity: interpolate(frame, [36, 42], [0, 1], clamp),
      }}
    >
      <div
        style={{
          position: "absolute",
          width: 62,
          height: 62,
          border: "2px solid #555",
          borderRadius: "50%",
          left: -24,
          top: -22,
          transform: `scale(${0.5 + pulse})`,
          opacity: pulse * 0.4,
        }}
      />
      <svg
        width="30"
        height="38"
        viewBox="0 0 30 38"
        style={{ filter: "drop-shadow(0 2px 2px #0003)" }}
      >
        <path
          d="M3 2v28l7-7 6 13 6-3-6-12h11L3 2Z"
          fill={ink}
          stroke="white"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

function Window({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 90,
        top: 278,
        width: 780,
        height: 460,
        borderRadius: 22,
        background: "#fff",
        border: "1.5px solid #deded9",
        boxShadow: "0 22px 50px #1515150b",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: 56,
          borderBottom: "1px solid #ededeb",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 20,
          color: "#777",
          position: "relative",
        }}
      >
        <div style={{ position: "absolute", left: 23, display: "flex", gap: 9 }}>
          {["close", "minimize", "zoom"].map((control) => (
            <span
              key={control}
              style={{ width: 11, height: 11, borderRadius: 20, background: "#dcdcd8" }}
            />
          ))}
        </div>
        {title}
      </div>
      {children}
    </div>
  );
}

const filmStyle = {
  background: "#f3f3ef",
  fontFamily: "Arial, Helvetica, sans-serif",
  color: ink,
  overflow: "hidden",
} as const;
const installerTarget: [number, number] = [727, 655];
const continueTarget: [number, number] = [519, 620];
const installTarget: [number, number] = [728, 598];

function Film() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const scene = Math.min(2, Math.floor(frame / 210));
  const local = frame - scene * 210;
  const enter = spring({ frame: local, fps, config: { damping: 24, stiffness: 130 } });
  const opacity = interpolate(local, [0, 12, 198, 209], [0, 1, 1, 0], clamp);
  const installed = local > 117;
  return (
    <AbsoluteFill style={filmStyle}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(ellipse at 50% 58%,#fff 0%,#f3f3ef 65%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          opacity,
          transform: `translateY(${(1 - enter) * 18}px)`,
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 120,
            left: 60,
            right: 60,
            textAlign: "center",
            fontSize: 47,
            letterSpacing: -1.8,
            fontWeight: 500,
          }}
        >
          {labels[scene]}
        </div>
        {scene === 0 && (
          <>
            <Window title="Downloads">
              <div
                style={{
                  margin: "51px 38px 0",
                  padding: 29,
                  border: "1px solid #e7e7e2",
                  borderRadius: 16,
                  display: "flex",
                  alignItems: "center",
                  gap: 24,
                  background: "#fafaf8",
                }}
              >
                <Logo size={73} />
                <div>
                  <div style={{ fontSize: 28, fontWeight: 600, marginBottom: 9 }}>
                    {"Goodfinds.pkg"}
                  </div>
                  <div style={{ fontSize: 22, color: "#73736d" }}>Ready to open</div>
                </div>
                <div style={{ marginLeft: "auto", fontSize: 30 }}>↓</div>
              </div>
              <div style={{ position: "absolute", right: 39, bottom: 44 }}>
                <Button active={local > 94 && local < 104}>
                  {local > 110 ? "Opening…" : "Open installer"}
                </Button>
              </div>
            </Window>
            <Cursor frame={local} to={installerTarget} />
            {local > 122 && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  opacity: interpolate(local, [122, 138], [0, 1], clamp),
                }}
              >
                <Window title={"Install Goodfinds"}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 30,
                      height: 365,
                    }}
                  >
                    <Logo size={90} />
                    <div>
                      <div style={{ fontSize: 30, fontWeight: 600 }}>{"Welcome to Goodfinds"}</div>
                      <div style={{ fontSize: 24, color: "#74746e", marginTop: 12 }}>
                        {"Set up for your user account."}
                      </div>
                    </div>
                  </div>
                  {
                    <div style={{ position: "absolute", right: 39, bottom: 35 }}>
                      <Button native>Continue</Button>
                    </div>
                  }
                </Window>
              </div>
            )}
          </>
        )}
        {scene === 1 && (
          <>
            <Window title={"Install Goodfinds"}>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  paddingTop: 30,
                  gap: 20,
                }}
              >
                {installed ? <Check /> : <Logo size={65} />}
                <div style={{ fontSize: 29, fontWeight: 600, letterSpacing: -0.6 }}>
                  {installed ? "Installation was successful." : "Add Goodfinds to ChatGPT."}
                </div>
                <div
                  style={{ fontSize: 22, color: "#73736d", textAlign: "center", lineHeight: 1.45 }}
                >
                  {installed ? (
                    <>
                      Choose Install on the Goodfinds page.
                      <br />
                      Then tell your agent what you want.
                    </>
                  ) : (
                    <>
                      We’ll prepare Goodfinds on your Mac,
                      <br />
                      then open its plugin page in ChatGPT.
                    </>
                  )}
                </div>
                <Button native active={local > 96 && local < 110}>
                  {installed ? "Close" : "Install"}
                </Button>
              </div>
            </Window>
            <Cursor frame={local} to={continueTarget} />
          </>
        )}
        {scene === 2 && (
          <>
            <Window title="Plugins">
              <div style={{ padding: "30px 40px" }}>
                <div style={{ fontSize: 22, color: "#74746e", marginBottom: 25 }}>My plugins</div>
                <div
                  style={{
                    border: "1px solid #e7e7e2",
                    borderRadius: 17,
                    padding: 27,
                    display: "flex",
                    alignItems: "center",
                    gap: 22,
                  }}
                >
                  <Logo size={72} />
                  <div>
                    <div style={{ fontSize: 29, fontWeight: 600 }}>Goodfinds</div>
                    <div style={{ fontSize: 21, color: "#73736d", marginTop: 8 }}>
                      Your next good find, found for you.
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 24 }}>
                  <Button active={local > 99 && local < 112}>
                    {local > 124 ? "Installed ✓" : "Install"}
                  </Button>
                </div>
              </div>
            </Window>
            <Cursor frame={local} to={installTarget} click={103} />
          </>
        )}
        <div
          style={{
            position: "absolute",
            top: 785,
            left: 70,
            right: 70,
            textAlign: "center",
            fontSize: 24,
            lineHeight: 1.5,
            color: "#666660",
          }}
        >
          {captions[scene]}
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: 57,
          left: 0,
          right: 0,
          display: "flex",
          gap: 14,
          justifyContent: "center",
        }}
      >
        {labels.map((label, i) => (
          <div
            key={label}
            style={{
              width: i === scene ? 58 : 12,
              height: 6,
              borderRadius: 20,
              background: i === scene ? ink : "#d7d7d1",
            }}
          />
        ))}
      </div>
    </AbsoluteFill>
  );
}

registerRoot(() => (
  <Composition
    id="InstallGoodfinds"
    component={Film}
    durationInFrames={630}
    fps={30}
    width={960}
    height={960}
  />
));
