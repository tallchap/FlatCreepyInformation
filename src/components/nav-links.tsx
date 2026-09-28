"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/chat", label: "Chat" },
  { href: "/", label: "Search" },
  { href: "/browse", label: "Browse" },
  { href: "/transcribe", label: "Transcribe" },
  // Served by a rewrite to the Snippy Daily Worker, so it must be a full navigation, not a client-side Link.
  { href: "/daily", label: "Daily", external: true },
];

export function NavLinks() {
  const pathname = usePathname();

  return (
    <div className="flex items-center justify-center gap-2">
      {links.map((link) => {
        const className = `inline-flex items-center justify-center rounded-md font-medium text-xl px-4 py-2 transition-all underline-offset-4 hover:underline text-primary ${
          pathname === link.href ? "underline" : ""
        }`;
        return link.external ? (
          <a key={link.href} href={link.href} className={className}>
            {link.label}
          </a>
        ) : (
          <Link key={link.href} href={link.href} className={className}>
            {link.label}
          </Link>
        );
      })}
    </div>
  );
}
