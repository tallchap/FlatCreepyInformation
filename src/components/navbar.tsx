import Image from "next/image";
import Link from "next/link";
import { NavLinks } from "./nav-links";

export function Navbar() {
  return (
    <nav className="w-full py-4 px-6 bg-[#99cc66]">
      <div className="container mx-auto max-w-6xl flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2">
            <Image
              src="/snippysaurus-logo.png"
              alt="Snippysaurus Logo"
              width={70}
              height={70}
              className="object-contain"
            />
            <Image
              src="/snippysaurus-name.png"
              alt="Snippysaurus"
              width={300}
              height={70}
              className="object-contain"
            />
          </Link>
        </div>
        <NavLinks />
      </div>
    </nav>
  );
}
