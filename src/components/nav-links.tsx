import Link from "next/link";
import { Button } from "./ui/button";

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
  return (
    <div className="flex items-center justify-center gap-2">
      {links.map((link) => (
        <Button variant="link" asChild key={link.href} className="text-xl">
          <Link href={link.href}>{link.label}</Link>
        </Button>
      ))}
    </div>
  );
}
