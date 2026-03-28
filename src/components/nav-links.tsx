"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/chat", label: "Chat" },
  { href: "/", label: "Search" },
  { href: "/browse", label: "Browse" },
  { href: "/transcribe", label: "Transcribe" },
  { href: "/snippy", label: "Snippy" },
];

export function NavLinks() {
  const pathname = usePathname();

  return (
    <div className="flex items-center justify-center gap-2">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={`inline-flex items-center justify-center rounded-md font-medium text-xl px-4 py-2 transition-all underline-offset-4 hover:underline text-primary ${
            pathname === link.href ? "underline" : ""
          }`}
        >
          {link.label}
        </Link>
      ))}
    </div>
  );
}
