import type { Metadata } from "next";
import "@/app/globals.css";

export const metadata: Metadata = {
  title: "Roundup",
  description: "Your crew makes sure you actually wake up.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: "#0a0b0f" }}>{children}</body>
    </html>
  );
}
