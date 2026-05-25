import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Content Automation",
  description: "Multi-business content automation",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
