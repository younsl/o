import styles from './ScrollNav.module.css'

export default function ScrollNav() {
  return (
    <div className={styles.nav}>
      <button
        className={styles.btn}
        title="Scroll to Top"
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      >
        <i className="fa-solid fa-chevron-up" />
      </button>
      <button
        className={styles.btn}
        title="Scroll to Bottom"
        onClick={() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })}
      >
        <i className="fa-solid fa-chevron-down" />
      </button>
    </div>
  )
}
