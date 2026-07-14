import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Moss Interview Coach",
  description: "Real-time system design interview coach powered by voice AI and Moss retrieval",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
