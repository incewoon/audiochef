// Guards against Android Chrome popping a history entry when the user
// dismisses the system file picker with the Back gesture. Without this, backing
// out of the picker on /tag-editor navigates the router back to /.
//
// Strategy: push a sentinel history entry before opening the picker. If a
// popstate arrives while the guard is active it only consumes the sentinel, so
// the current route stays mounted. When the picker resolves normally we remove
// the sentinel again so ordinary back navigation keeps working.

const SENTINEL = "__audiofly_picker__";

let active = 0;
let sentinelPushed = false;
let onPop: ((e: PopStateEvent) => void) | null = null;

function pushSentinel() {
  if (sentinelPushed || typeof window === "undefined") return;
  try {
    window.history.pushState({ [SENTINEL]: true }, "", window.location.href);
    sentinelPushed = true;
  } catch {
    /* ignore */
  }
}

function popSentinel() {
  if (!sentinelPushed || typeof window === "undefined") return;
  sentinelPushed = false;
  try {
    if ((window.history.state as Record<string, unknown> | null)?.[SENTINEL]) {
      window.history.back();
    }
  } catch {
    /* ignore */
  }
}

/**
 * Call right before opening a file picker. Returns a release function that must
 * be invoked once the picker resolves or is dismissed.
 */
export function beginPickerGuard(): () => void {
  if (typeof window === "undefined") return () => {};

  active++;
  if (active === 1) {
    pushSentinel();
    onPop = () => {
      // The sentinel entry was consumed by the picker dismissal — stay put.
      sentinelPushed = false;
      pushSentinel();
    };
    window.addEventListener("popstate", onPop);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    active = Math.max(0, active - 1);
    if (active === 0) {
      if (onPop) window.removeEventListener("popstate", onPop);
      onPop = null;
      popSentinel();
    }
  };
}

/**
 * Opens a hidden <input type="file"> with the history guard active. The guard is
 * released on `change`, on `cancel` (Chrome 113+), or on the next window focus.
 */
export function clickFileInputGuarded(input: HTMLInputElement | null) {
  if (!input) return;
  const release = beginPickerGuard();

  const cleanup = () => {
    input.removeEventListener("change", cleanup);
    input.removeEventListener("cancel", cleanup);
    window.removeEventListener("focus", onFocus);
    // Give the browser a tick to settle its own history bookkeeping.
    window.setTimeout(release, 300);
  };
  const onFocus = () => window.setTimeout(cleanup, 150);

  input.addEventListener("change", cleanup, { once: true });
  input.addEventListener("cancel", cleanup, { once: true });
  window.addEventListener("focus", onFocus, { once: true });

  input.click();
}
