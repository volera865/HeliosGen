/** Resolves after `ms` or immediately when the tab becomes visible. */
export function waitOrVisible(ms: number): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      document.removeEventListener("visibilitychange", onVisible);
      resolve();
    };
    const onVisible = () => { if (!document.hidden) finish(); };
    const t = setTimeout(finish, ms);
    document.addEventListener("visibilitychange", onVisible);
  });
}
