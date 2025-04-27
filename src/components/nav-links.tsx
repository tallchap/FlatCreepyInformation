"use client";

import Link from "next/link";
import { Button } from "./ui/button";
import { usePathname } from "next/navigation";

const links = [
  {
    href: "/",
    label: "Search",
  },
  {
    href: "/transcribe",
    label: "Transcribe",
  },
  {
    href: "/about",
    label: "About",
  },
];

export function NavLinks() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-2">
      {links.map((link) => (
        <Button
          variant={pathname === link.href ? "secondary" : "link"}
          asChild
          key={link.href}
          className="text-md"
        >
          <Link href={link.href}>{link.label}</Link>
        </Button>
      ))}
    </div>
  );
}
