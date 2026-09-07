// Deliberately trimmed, viewer-safe mirror of SurveyReview's own files.js - see the architecture
// plan and data-model.js's own header comment for the reasoning. Mirrors SurveyReview/files.js as
// of commit 701ca41 (2026-09-08): supportsFolderPicker, getFileBlobUrl, imageDateTimeIso (+ its
// parseVideoStartDateTime dependency). Every file-matching/auto-link/BatLogger/Bat-Assist-import
// workflow function in the source file is deliberately excluded - the viewer already has its own
// simple indexHandoverFolder (portal.js) and never used any of that machinery.
window.SR = window.SR || {};

(function (ns) {
  const supportsFolderPicker = typeof window.showDirectoryPicker === 'function';

  async function getFileBlobUrl(fileHandle) {
    const file = await fileHandle.getFile();
    return URL.createObjectURL(file);
  }

  // Recovers a video's own real-world start time from its filename - both known naming
  // conventions embed a YYYYMMDD + HHMMSS pair. Local time, not UTC.
  const VIDEO_START_RE = /(\d{4})(\d{2})(\d{2})_?(\d{2})(\d{2})(\d{2})/;

  function parseVideoStartDateTime(videoBaseName) {
    if (!videoBaseName) return null;
    const m = VIDEO_START_RE.exec(videoBaseName);
    if (!m) return null;
    const [, yyyy, mo, dd, HH, MM, SS] = m;
    const d = new Date(Number(yyyy), Number(mo) - 1, Number(dd), Number(HH), Number(MM), Number(SS));
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  // An ImageRecord's own real-world timestamp (video start + its already-parsed offset into that
  // video) - videoBaseName/offsetSeconds are already-stored fields set by SurveyReview at import
  // time, so this never needs to parse a raw filename itself.
  function imageDateTimeIso(image) {
    const videoStart = parseVideoStartDateTime(image.videoBaseName);
    if (!videoStart || image.offsetSeconds == null) return null;
    const d = new Date(videoStart);
    d.setSeconds(d.getSeconds() + image.offsetSeconds);
    return d.toISOString();
  }

  ns.Files = { supportsFolderPicker, getFileBlobUrl, imageDateTimeIso };
})(window.SR);
