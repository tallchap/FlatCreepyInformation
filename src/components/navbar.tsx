import Image from "next/image";
import Link from "next/link";
import { NavLinks } from "./nav-links";
export function Navbar() {
  return (
    <header className="site-header">
      <Link href="/" className="site-brand" aria-label="Snippysaurus home">
        <Image
          src="/snippysaurus-logo.png"
          alt=""
          width={47}
          height={53}
          priority
        />
        <span>
          snippysaurus<span className="brand-dot">.</span>
        </span>
      </Link>
      <NavLinks />
    </header>
  );
}
