import { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function AdminLogLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
