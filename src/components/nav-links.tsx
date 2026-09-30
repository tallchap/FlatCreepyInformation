"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/chat", label: "Chat" },
  { href: "/search", label: "Search" },
  { href: "/browse", label: "Browse" },
  { href: "/transcribe", label: "Transcribe" },
  // Served by a rewrite to the Snippy Daily Worker, so it must be a full navigation, not a client-side Link.
  { href: "/daily", label: "Daily", external: true },
];

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="site-links" aria-label="Main navigation">
      {links.map((link) => {
        const active =
          pathname === link.href || (link.href === "/chat" && pathname === "/");
        const className = active ? "site-link active" : "site-link";
        return link.external ? (
          <a
            key={link.href}
            href={link.href}
            className={className}
            aria-current={active ? "page" : undefined}
          >
            {link.label}
          </a>
        ) : (
          <Link
            key={link.href}
            href={link.href}
            className={className}
            aria-current={active ? "page" : undefined}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
