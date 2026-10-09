#!/usr/bin/env bun
/**
 * Rebuild the silent Goodfinds promo from the checked-in fictional demo captures.
 * Usage: bun scripts/render-promo.ts
 * Development-only dependencies: ffmpeg with drawtext/libx264, and ffprobe.
 * Optional: PROMO_FONT_REGULAR / PROMO_FONT_BOLD for other installed font paths.
 * Intermediate renders and the inspection montage live in ignored output/.
 */
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const media = join(root, "website/media");
const work = join(root, "output/promo-render");
mkdirSync(work, { recursive: true });

function font(envName: string, candidates: string[]): string {
  const path = [process.env[envName], ...candidates].find((item) => item && existsSync(item));
  if (!path) throw new Error(`Set ${envName} to an installed TrueType font.`);
  return path;
}

const regular = font("PROMO_FONT_REGULAR", [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]);
const bold = font("PROMO_FONT_BOLD", [
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]);
const quote = (value: string): string =>
  `'${value.replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "'\\''")}'`;
const textFiles = new Map<string, string>();

function text(
  value: string,
  x: number | string,
  y: number | string,
  size: number,
  options: { bold?: boolean; color?: string; alpha?: string } = {},
): string {
  let path = textFiles.get(value);
  if (!path) {
    path = join(work, `text-${textFiles.size}.txt`);
    writeFileSync(path, value);
    textFiles.set(value, path);
  }
  return [
    "drawtext",
    `fontfile=${quote(options.bold ? bold : regular)}`,
    `textfile=${quote(path)}`,
    "expansion=none",
    `fontsize=${size}`,
    `fontcolor=${options.color ?? "0x111111"}`,
    `x=${quote(String(x))}`,
    `y=${quote(String(y))}`,
    `alpha=${quote(options.alpha ?? "1")}`,
  ]
    .join(":")
    .replace("drawtext:", "drawtext=");
}

const box = (
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  thickness: string | number = "fill",
): string => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=${thickness}`;
const lift = (y: number, delay = 0): string => `${y}+14*(1-min(max((t-${delay})/0.8,0),1))^3`;
const reveal = (delay = 0) => `min(max((t-${delay})/0.55,0),1)`;

function run(args: string[]): void {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}

const scenes = [
  {
    name: "intro",
    duration: 4.5,
    filters: [
      text("Your next good find,", 80, lift(228), 80, { bold: true, alpha: reveal() }),
      text("found for you.", 80, lift(326, 0.22), 80, { bold: true, alpha: reveal(0.22) }),
      box(84, 459, 100, 4, "0x111111"),
      text("Marketplace searches, kept together.", 82, 500, 27, {
        color: "0x666666",
        alpha: reveal(0.6),
      }),
    ],
  },
  {
    name: "conversation",
    duration: 7,
    label: "Illustrated conversation",
    filters: [
      text("Start with what matters.", 80, lift(129), 50, { bold: true }),
      box(92, 229, 1096, 285, "0xf6f6f6"),
      box(92, 229, 1096, 285, "0xe3e3e3", 1),
      text("YOU", 128, 260, 16, { bold: true, color: "0x666666" }),
      text("Find a MacBook Pro under £1,250,", 128, 307, 39, { alpha: reveal(0.25) }),
      text("with at least 32 GB memory", 128, 364, 39, { alpha: reveal(0.55) }),
      text("and 1 TB storage.", 128, 421, 39, { alpha: reveal(0.85) }),
      text("A clear request. A focused search.", 96, 568, 25, {
        color: "0x666666",
        alpha: reveal(1.25),
      }),
    ],
  },
  {
    name: "requirements",
    duration: 7.5,
    label: "Actual Goodfinds interface",
    image: "requirements.jpg",
    crop: "970:338:139:354",
    imageWidth: 1096,
    imageHeight: 382,
    imageX: "92",
    imageY: lift(263),
    filters: [
      text("Your requirements, remembered.", 80, 124, 49, { bold: true }),
      text("Budget, specs and distance — in one search.", 82, 194, 25, { color: "0x666666" }),
      box(87, 258, 1106, 392, "0xebebeb"),
    ],
  },
  {
    name: "listing",
    duration: 7.5,
    label: "Actual Goodfinds interface",
    image: "listing.jpg",
    crop: "402:390:646:151",
    imageWidth: 536,
    imageHeight: 520,
    imageX: "650+12*(1-min(t/1.2,1))^3",
    imageY: "123",
    filters: [
      text("Look closer.", 80, lift(210), 54, { bold: true }),
      text("Price. Specs. Availability.", 83, 289, 26, { color: "0x666666" }),
      box(84, 367, 54, 3, "0x111111"),
      text("16-inch MacBook Pro", 83, 402, 25, { bold: true }),
      text("Example listing", 83, 442, 22, { color: "0x666666" }),
      text("Know what to ask next.", 83, 541, 24, { color: "0x666666" }),
      box(632, 106, 572, 555, "0xe4e4e4", 1),
    ],
  },
  {
    name: "message",
    duration: 8.5,
    label: "Actual Goodfinds interface",
    image: "message.jpg",
    crop: "533:372:364:38",
    imageWidth: 638,
    imageHeight: 446,
    imageX: "565",
    imageY: lift(165),
    filters: [
      text("Review", 80, lift(207), 53, { bold: true }),
      text("every word.", 80, lift(271, 0.1), 53, { bold: true }),
      text("Prepare a message.", 83, 363, 26, { color: "0x666666" }),
      text("Keep the decision yours.", 83, 403, 26, { color: "0x666666" }),
      text("Sample draft. No seller contacted.", 83, 551, 19, { color: "0x666666" }),
      box(549, 147, 671, 482, "0xe4e4e4", 1),
    ],
  },
  {
    name: "outro",
    duration: 5.5,
    centeredLogo: true,
    filters: [
      text("Goodfinds.", "(w-text_w)/2", lift(284), 72, { bold: true, alpha: reveal(0.15) }),
      text("Keep your search together.", "(w-text_w)/2", 384, 36, { alpha: reveal(0.5) }),
      text("From first thought to next step.", "(w-text_w)/2", 479, 24, {
        color: "0x666666",
        alpha: reveal(0.8),
      }),
    ],
  },
];

for (const [index, scene] of scenes.entries()) {
  process.stdout.write(`Rendering ${index + 1}/${scenes.length}: ${scene.name}\n`);
  const args = [
    "-f",
    "lavfi",
    "-i",
    `color=c=white:s=1280x720:r=30:d=${scene.duration}`,
    "-loop",
    "1",
    "-framerate",
    "30",
    "-i",
    join(media, "logo.png"),
  ];
  if (scene.image) args.push("-loop", "1", "-framerate", "30", "-i", join(media, scene.image));
  const logo = scene.centeredLogo ? { size: 80, x: 600, y: 159 } : { size: 38, x: 80, y: 40 };
  // The logo is transparent; it needs a black backing on the white video canvas.
  const filters = [...scene.filters, box(logo.x, logo.y, logo.size, logo.size, "black")];
  if (!scene.centeredLogo) filters.push(text("Goodfinds", 131, 49, 23, { bold: true }));
  if (scene.label) filters.push(text(scene.label, "w-text_w-80", 52, 19, { color: "0x666666" }));
  const graph = [
    `[0:v]${filters.join(",")}[base]`,
    `[1:v]scale=${logo.size}:${logo.size}:flags=lanczos[logo]`,
    `[base][logo]overlay=x=${logo.x}:y=${logo.y}:shortest=1[branded]`,
  ];
  if (scene.image) {
    graph.push(
      `[2:v]crop=${scene.crop},scale=${scene.imageWidth}:${scene.imageHeight}:flags=lanczos[screen]`,
    );
    graph.push(
      `[branded][screen]overlay=x='${scene.imageX}':y='${scene.imageY}':shortest=1,setsar=1,format=yuv420p[out]`,
    );
  } else {
    graph.push("[branded]setsar=1,format=yuv420p[out]");
  }
  const graphPath = join(work, `${scene.name}.ffgraph`);
  writeFileSync(graphPath, graph.join(";\n"));
  run([
    ...args,
    "-filter_complex_script",
    graphPath,
    "-map",
    "[out]",
    "-an",
    "-t",
    String(scene.duration),
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    join(work, `${scene.name}.mp4`),
  ]);
}

const graph: string[] = [];
const firstScene = scenes[0];
if (!firstScene) throw new Error("At least one scene is required.");
let offset = firstScene.duration - 0.5;
for (const [index, scene] of scenes.entries()) {
  if (index === 0) continue;
  const prior = index === 1 ? "0:v" : `mix${index - 1}`;
  graph.push(
    `[${prior}][${index}:v]xfade=transition=fade:duration=0.5:offset=${offset}[mix${index}]`,
  );
  offset += scene.duration - 0.5;
}
const duration = offset + 0.5;
// This disclosure is added after every transition, so it never fades or disappears.
graph.push(
  `[mix${scenes.length - 1}]${box(0, 666, 1280, 54, "white")},${text("Fictional demo data", "w-text_w-80", 682, 18, { color: "0x666666" })},drawbox=x=80:y=702:w=1120:h=2:color=0xebebeb:t=fill,format=yuv420p[out]`,
);
const graphPath = join(work, "final.ffgraph");
writeFileSync(graphPath, graph.join(";\n"));
const movie = join(media, "goodfinds-demo.mp4");
const inputs = scenes.flatMap((scene) => ["-i", join(work, `${scene.name}.mp4`)]);
process.stdout.write(`Encoding ${duration.toFixed(1)}-second final movie\n`);
run([
  ...inputs,
  "-filter_complex_script",
  graphPath,
  "-map",
  "[out]",
  "-an",
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "22",
  "-maxrate",
  "1400k",
  "-bufsize",
  "2800k",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  movie,
]);

run(["-ss", "1.5", "-i", movie, "-frames:v", "1", "-q:v", "2", join(media, "demo-poster.jpg")]);
run([
  "-i",
  movie,
  "-vf",
  "select='eq(n,45)+eq(n,195)+eq(n,405)+eq(n,615)+eq(n,840)+eq(n,1080)',scale=640:360,tile=2x3",
  "-frames:v",
  "1",
  "-q:v",
  "2",
  join(work, "montage.jpg"),
]);

writeFileSync(
  join(media, "demo-captions.vtt"),
  `WEBVTT

00:00.000 --> 00:04.000
Your next good find, found for you.
Marketplace searches, kept together.

00:04.000 --> 00:10.500
[Illustrated conversation]
Find a MacBook Pro under £1,250, with at least 32 GB memory and 1 TB storage.

00:10.500 --> 00:17.500
[Actual Goodfinds interface]
Your requirements, remembered. Budget, specs and distance — in one search.

00:17.500 --> 00:24.500
[Actual Goodfinds interface]
Look closer. Compare price, specs and availability for an example listing.

00:24.500 --> 00:32.500
[Actual Goodfinds interface]
Review every word. Prepare a message. Keep the decision yours.
Sample draft. No seller contacted.

00:32.500 --> 00:38.000
Goodfinds. Keep your search together.
Fictional demo data throughout.
`,
);

const bytes = statSync(movie).size;
if (bytes >= 8_000_000) throw new Error(`Movie is ${bytes} bytes, over the 8 MB budget.`);
process.stdout.write(
  execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size:stream=codec_name,pix_fmt,width,height",
      "-of",
      "json",
      movie,
    ],
    { encoding: "utf8" },
  ),
);
process.stdout.write(
  `Verified upload budget: ${bytes.toLocaleString("en-US")} bytes (< 8,000,000).\n`,
);
