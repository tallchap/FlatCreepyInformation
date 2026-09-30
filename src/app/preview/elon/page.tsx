import {
  ELON_PORTRAITS,
  elonPortraitStyle,
} from "@/components/clip-chat/elon-portraits";
import styles from "./portraits.module.css";
export default function ElonPhotos() {
  return (
    <main className={styles.page}>
      <header>
        <p>ELON · ROUND TWO</p>
        <h1>Ten clearer faces.</h1>
        <span>
          No hands over his face. No side profiles. Pick one to try with the
          spring.
        </span>
        <a href="/preview/drag">Back to the spring preview</a>
      </header>
      <div className={styles.grid}>
        {ELON_PORTRAITS.map((photo, index) => (
          <article key={photo.id}>
            <a
              className={styles.tryPhoto}
              href={`/preview/drag?portrait=${photo.id}`}
              aria-label={`Try Elon option ${index + 1}: ${photo.label}`}
            >
              <div className={styles.photo}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/speakers/preview/elon-${photo.id}.jpg`}
                  alt={`Elon Musk — ${photo.label}`}
                  style={elonPortraitStyle(photo.id)}
                />
              </div>
              <h2>
                <b>{String(index + 1).padStart(2, "0")}</b>
                {photo.label}
              </h2>
              <span>Try with spring</span>
            </a>
            <a
              className={styles.source}
              href={photo.source}
              target="_blank"
              rel="noreferrer"
            >
              Photo source
            </a>
          </article>
        ))}
      </div>
      <footer>
        Local photo comparison. Reuse permissions have not been verified.
      </footer>
    </main>
  );
}
