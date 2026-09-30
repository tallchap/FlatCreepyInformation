import { pageNumbers } from "./utils/presentation";
import styles from "./browse.module.css";

export function BrowsePagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (page: number) => void }) {
  if (totalPages <= 1) return null;
  return <nav className={styles.pagination} aria-label="Pagination">
    <span>Page <strong>{page}</strong> of {totalPages}</span>
    <div className={styles.pages}>
      <button className={styles.outlineButton} disabled={page <= 1} onClick={() => onChange(page - 1)}>← Prev</button>
      {pageNumbers(page, totalPages).map((item) => typeof item === "string"
        ? <span className={styles.ellipsis} key={item}>…</span>
        : <button key={item} className={styles.pageNumber} aria-label={`Page ${item}`} aria-current={item === page ? "page" : undefined} onClick={() => onChange(item)}>{item}</button>)}
      <button className={styles.outlineButton} disabled={page >= totalPages} onClick={() => onChange(page + 1)}>Next →</button>
    </div>
  </nav>;
}
