import { Source_Serif_4 } from "next/font/google";
import styles from "@/components/browse/browse.module.css";

const display = Source_Serif_4({ subsets: ["latin"], variable: "--browse-display", display: "swap" });

export default function BrowseLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${display.variable} ${styles.surface}`}>{children}</div>;
}
