import { loadFont as loadMontserrat } from "@remotion/google-fonts/Montserrat";
import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { loadFont as loadBebasNeue } from "@remotion/google-fonts/BebasNeue";
import { loadFont as loadOswald } from "@remotion/google-fonts/Oswald";
import { loadFont as loadPoppins } from "@remotion/google-fonts/Poppins";
import { loadFont as loadRoboto } from "@remotion/google-fonts/Roboto";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadPlayfairDisplay } from "@remotion/google-fonts/PlayfairDisplay";
import { loadFont as loadLobster } from "@remotion/google-fonts/Lobster";
import { loadFont as loadPacifico } from "@remotion/google-fonts/Pacifico";
import { loadFont as loadBangers } from "@remotion/google-fonts/Bangers";
import { loadFont as loadPermanentMarker } from "@remotion/google-fonts/PermanentMarker";
import { loadFont as loadArchivoBlack } from "@remotion/google-fonts/ArchivoBlack";
import { loadFont as loadAlfaSlabOne } from "@remotion/google-fonts/AlfaSlabOne";

loadMontserrat("normal", { weights: ["400", "700", "900"], subsets: ["latin"] });
loadAnton("normal", { weights: ["400"], subsets: ["latin"] });
loadBebasNeue("normal", { weights: ["400"], subsets: ["latin"] });
loadOswald("normal", { weights: ["400", "700"], subsets: ["latin"] });
loadPoppins("normal", { weights: ["400", "700", "900"], subsets: ["latin"] });
loadRoboto("normal", { weights: ["400", "700", "900"], subsets: ["latin"] });
loadInter("normal", { weights: ["400", "700", "900"], subsets: ["latin"] });
loadPlayfairDisplay("normal", { weights: ["400", "700", "900"], subsets: ["latin"] });
loadLobster("normal", { weights: ["400"], subsets: ["latin"] });
loadPacifico("normal", { weights: ["400"], subsets: ["latin"] });
loadBangers("normal", { weights: ["400"], subsets: ["latin"] });
loadPermanentMarker("normal", { weights: ["400"], subsets: ["latin"] });
loadArchivoBlack("normal", { weights: ["400"], subsets: ["latin"] });
loadAlfaSlabOne("normal", { weights: ["400"], subsets: ["latin"] });

export const SNIPPY_FONT_FAMILIES = [
  "Montserrat",
  "Anton",
  "Bebas Neue",
  "Oswald",
  "Poppins",
  "Roboto",
  "Inter",
  "Playfair Display",
  "Lobster",
  "Pacifico",
  "Bangers",
  "Permanent Marker",
  "Archivo Black",
  "Alfa Slab One",
] as const;

export const SNIPPY_GOOGLE_FONTS_CSS_URL =
  "https://fonts.googleapis.com/css2?" +
  [
    "family=Montserrat:wght@400;700;900",
    "family=Anton",
    "family=Bebas+Neue",
    "family=Oswald:wght@400;700",
    "family=Poppins:wght@400;700;900",
    "family=Roboto:wght@400;700;900",
    "family=Inter:wght@400;700;900",
    "family=Playfair+Display:wght@400;700;900",
    "family=Lobster",
    "family=Pacifico",
    "family=Bangers",
    "family=Permanent+Marker",
    "family=Archivo+Black",
    "family=Alfa+Slab+One",
  ].join("&") +
  "&display=swap";
