// app/icons/[file]/route.tsx
// Serves /icons/icon-192.png and /icons/icon-512.png (the paths manifest.json points to),
// generated on request — no binary files to commit. Amber crescent on the app's dark ink.
// Artwork stays inside the centre 60% so it survives "maskable" cropping.

import { ImageResponse } from "next/og";

export const runtime = "edge";

export async function GET(
  _req: Request,
  { params }: { params: { file: string } }
) {
  const m = /^icon-(192|512)\.png$/.exec(params.file);
  if (!m) return new Response("Not found", { status: 404 });

  const size = Number(m[1]);
  const px = (f: number) => Math.round(size * f);

  return new ImageResponse(
    (
      <div
        style={{
          width: size,
          height: size,
          display: "flex",
          position: "relative",
          background: "#0a0b0f",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: px(0.25),
            top: px(0.25),
            width: px(0.5),
            height: px(0.5),
            borderRadius: "50%",
            background: "#f5a623",
            display: "flex",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: px(0.36),
            top: px(0.2),
            width: px(0.46),
            height: px(0.46),
            borderRadius: "50%",
            background: "#0a0b0f",
            display: "flex",
          }}
        />
      </div>
    ),
    { width: size, height: size }
  );
}
