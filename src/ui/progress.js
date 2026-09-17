// The sticky progress bar under the top nav, plus the cancel button that feeds
// an AbortController into whatever long job is running.

let controller = null;
let lastPaint = 0;

function els() {
  return {
    bar: document.getElementById('progress'),
    fill: document.getElementById('progress-fill'),
    label: document.getElementById('progress-label'),
    cancel: document.getElementById('progress-cancel'),
  };
}

/** Begin a cancellable job. Returns the AbortSignal to pass to ESI calls. */
export function startJob(label = 'Working…') {
  cancelJob();
  controller = new AbortController();
  const { bar, fill, label: lab, cancel } = els();
  if (!bar) return controller.signal;
  bar.hidden = false;
  fill.style.width = '0%';
  lab.textContent = label;
  cancel.onclick = () => cancelJob();
  return controller.signal;
}

/** Update the bar. Throttled to ~20fps so huge scans stay smooth. */
export function setProgress(done, total, label) {
  const now = performance.now();
  const finished = total && done >= total;
  if (!finished && now - lastPaint < 50) return;
  lastPaint = now;
  const { bar, fill, label: lab } = els();
  if (!bar || bar.hidden) return;
  const ratio = total > 0 ? Math.min(1, done / total) : 0;
  fill.style.width = `${(ratio * 100).toFixed(1)}%`;
  if (label) lab.textContent = total > 0 ? `${label} · ${Math.round(ratio * 100)}%` : label;
}

/** Progress callback shaped for the ESI helpers: (done, total, label). */
export const progressSink = (prefix = '') => (done, total, label) =>
  setProgress(done, total, prefix ? `${prefix} ${label || ''}`.trim() : label);

export function endJob() {
  const { bar } = els();
  if (bar) bar.hidden = true;
  controller = null;
}

export function cancelJob() {
  if (controller) controller.abort();
  controller = null;
  const { bar } = els();
  if (bar) bar.hidden = true;
}

export function isRunning() {
  return !!controller;
}

/** True when the error is just "the user hit cancel". */
export function isAbort(err) {
  return err && (err.name === 'AbortError' || err.message === 'Aborted');
}
