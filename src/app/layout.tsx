import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "汇站 Atlas · Bauhaus 工作台",
  description:
    "以清晰结构管理 AI 站点、余额与查询记录。独立部署、私有记录、手动同步。",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
