import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LinkRoom — Simple private video calls",
  description: "Create a private room, share one link, and talk face to face.",
  authors: [{ name: "Jayant Adhikary" }],
  creator: "Jayant Adhikary",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
