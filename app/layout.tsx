import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LinkRoom — Meet someone new",
  description: "Free one-to-one video and text chat. Meet someone at random or share a private room link.",
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
