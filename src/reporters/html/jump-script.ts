/** The report's only executable script. Run data travels in the two passive JSON blocks. */
export const jumpScript: string = String.raw`(() => {
  'use strict';
  const block = document.getElementById('retest-recording-clocks');
  if (!block) return;
  const data = JSON.parse(block.textContent);
  if (data.version !== 1 || !Array.isArray(data.tests)) return;
  const microseconds = value => Number.isSafeInteger(value) && value >= 0;
  const complete = clock => {
    if (!clock || clock.capture !== 'run_us' || !microseconds(clock.videoZeroUs) ||
        !microseconds(clock.durationUs) || clock.durationUs === 0 ||
        !Array.isArray(clock.shortened) || clock.shortenedCount !== clock.shortened.length) return false;
    let previous = clock.videoZeroUs;
    for (const gap of clock.shortened) {
      if (!gap || !microseconds(gap.captureUs) || !microseconds(gap.shortenedByUs) ||
          gap.captureUs <= previous || gap.shortenedByUs > gap.captureUs - previous) return false;
      previous = gap.captureUs;
    }
    return true;
  };
  for (const test of data.tests) {
    const root = document.getElementById(test.elementId);
    if (!root || !Array.isArray(test.recordings)) continue;
    for (const section of root.querySelectorAll('[data-recording-id]')) {
      const matches = test.recordings.filter(recording => recording.recordingId === section.dataset.recordingId);
      const recording = matches.length === 1 ? matches[0] : undefined;
      const video = section.querySelector('video');
      const note = section.querySelector('[data-jump-note]');
      if (!note) continue;
      if (!recording || !complete(recording.clock)) {
        note.textContent = 'Cannot jump to a step: the recording clock mapping is incomplete.';
        continue;
      }
      if (!video) {
        note.textContent = 'Cannot jump to a step: no playable recording is retained.';
        continue;
      }
      let pending;
      const seek = () => {
        if (pending === undefined) return;
        if (!Number.isFinite(video.duration) || video.duration <= 0) {
          note.textContent = 'Cannot jump to a step: the video interval is unavailable.';
          return;
        }
        const end = Math.min(recording.clock.durationUs / 1000000, video.duration);
        video.currentTime = Math.max(0, Math.min(pending, end));
        pending = undefined;
        note.textContent = '';
      };
      video.addEventListener('loadedmetadata', seek);
      for (const button of root.querySelectorAll('[data-jump-step]')) {
        button.addEventListener('click', () => {
          if (button.dataset.jumpApp !== undefined && button.dataset.jumpApp !== recording.app) return;
          const captureUs = Number(button.dataset.elapsedMs) * 1000;
          if (!Number.isFinite(captureUs) || captureUs < 0) {
            note.textContent = 'Cannot jump to a step: its run-clock time is unavailable.';
            return;
          }
          let videoUs = captureUs - recording.clock.videoZeroUs;
          for (const gap of recording.clock.shortened) {
            if (gap.captureUs <= captureUs) videoUs -= gap.shortenedByUs;
          }
          pending = videoUs / 1000000;
          if (video.readyState > 0) seek();
          else note.textContent = 'Waiting for the recording video interval.';
        });
      }
    }
  }
})();`

/** Pinned SHA-256 of the exact UTF-8 bytes above, used by the page's CSP. */
export const jumpScriptHash: string = 'sha256-U7D3WVo/N0aKSN74mGWTy2vKCdyC74A8klat6F+HW+o='
