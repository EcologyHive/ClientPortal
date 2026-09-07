// Deliberately trimmed, viewer-safe mirror of SurveyReview's own models.js - see the architecture
// plan (Clara, 2026-09-08: "does our client output expose our internal workings?" / "propose the
// architecture/build process before implementing"). This file hand-duplicates a small set of
// stable, generic functions (label/detector lookups, descriptive pass/bout statistics over
// already-recorded data) rather than sharing SurveyReview's file directly or splitting that file to
// support this - an accepted, explicit, temporary trade-off (Clara: "I am willing to accept
// temporary duplication of small/stable generic functions if that materially reduces risk to the
// live analyst application"). Mirrors SurveyReview/models.js as of commit 701ca41 (2026-09-08):
// findSoundDetector, allLabels, findLabel, matchedRecordingFor, soundProgress, soundSummary, plus
// the BUILTIN_LABELS/BOUT_GAP_MINUTES/NON_SPECIES_FINAL_VALUES constants they depend on. Every
// authoring, mutation, migration, and file-matching-workflow function in the source file is
// deliberately excluded - see the plan's own audit for the full list and reasoning.
window.SR = window.SR || {};

(function (ns) {
  const BUILTIN_LABELS = [
    { id: 'BAT_EMERGE', name: 'Bat emergence', requiresMapPin: true },
    { id: 'BAT_FLYING', name: 'Bat flying', requiresMapPin: false },
    { id: 'INSECT', name: 'Insect', requiresMapPin: false },
    { id: 'BIRD', name: 'Bird', requiresMapPin: false },
    { id: 'ARTEFACT', name: 'Artefact (human/car/mammal)', requiresMapPin: false },
  ];

  function allLabels(site) {
    return [...BUILTIN_LABELS, ...(site.customLabels || [])];
  }

  function findLabel(site, labelId) {
    return allLabels(site).find((l) => l.id === labelId) || null;
  }

  function findSoundDetector(survey, detectorId) {
    return (survey.soundDetectors || []).find((d) => d.id === detectorId) || null;
  }

  // Resolves an ImageRecord's matched SoundRecording (if any) via its already-stored
  // matchedDetectorId/matchedRecordingId pointer - the workflow that SETS that pointer (the Match
  // sound tool) stays SurveyReview-only; this only ever reads an existing link to display it.
  function matchedRecordingFor(survey, image) {
    if (!image.matchedDetectorId || !image.matchedRecordingId) return null;
    const detector = findSoundDetector(survey, image.matchedDetectorId);
    if (!detector) return null;
    const recording = (detector.recordings || []).find((r) => r.id === image.matchedRecordingId);
    if (!recording) return null;
    return { detector, recording };
  }

  function soundProgress(detector) {
    const recordings = detector.recordings || [];
    const total = recordings.length;
    const analysed = recordings.filter((r) => r.analysis && (r.analysis.finalSpecies || (r.analysis.additionalTaxa || []).length > 0)).length;
    return { total, analysed, pct: total === 0 ? 0 : Math.round((analysed / total) * 100) };
  }

  // Consecutive recordings of the SAME species less than this apart count as one continuous bout
  // rather than separate passes - a fixed, documented grouping rule, not a tunable model.
  const BOUT_GAP_MINUTES = 5;

  // Sentinel finalSpecies values that mean "reviewed, deliberately not a species" - excluded from
  // bout/species counting so they never masquerade as a real detection.
  const NON_SPECIES_FINAL_VALUES = ['Noise / No ID', 'Unreadable file'];

  function soundSummary(detector) {
    const recordings = detector.recordings || [];
    const identified = recordings.filter((r) => r.analysis && r.analysis.finalSpecies && !NON_SPECIES_FINAL_VALUES.includes(r.analysis.finalSpecies) && r.dateTimeIso);
    const sorted = [...identified].sort((a, b) => new Date(a.dateTimeIso) - new Date(b.dateTimeIso));

    const bouts = [];
    sorted.forEach((r) => {
      const t = new Date(r.dateTimeIso).getTime();
      const species = r.analysis.finalSpecies;
      const last = bouts[bouts.length - 1];
      if (last && last.species === species && (t - last.endMs) <= BOUT_GAP_MINUTES * 60000) {
        last.endMs = t;
        last.recordingCount++;
      } else {
        bouts.push({ species, startMs: t, endMs: t, recordingCount: 1 });
      }
    });

    const boutCounts = {};
    bouts.forEach((b) => { boutCounts[b.species] = (boutCounts[b.species] || 0) + 1; });
    const passCounts = {};
    identified.forEach((r) => { passCounts[r.analysis.finalSpecies] = (passCounts[r.analysis.finalSpecies] || 0) + 1; });
    const speciesList = Object.keys({ ...boutCounts, ...passCounts })
      .map((species) => ({ species, boutCount: boutCounts[species] || 0, passCount: passCounts[species] || 0 }))
      .sort((a, b) => b.passCount - a.passCount);

    const timed = recordings.filter((r) => r.dateTimeIso).map((r) => new Date(r.dateTimeIso).getTime());
    const spanHours = timed.length >= 2 ? (Math.max(...timed) - Math.min(...timed)) / 3600000 : null;
    const boutsPerHourOverall = spanHours && spanHours > 0 ? bouts.length / spanHours : null;
    const passesPerHourOverall = spanHours && spanHours > 0 ? identified.length / spanHours : null;

    return {
      speciesList,
      totalBouts: bouts.length,
      totalPasses: identified.length,
      totalIdentifiedRecordings: identified.length,
      spanHours,
      boutsPerHourOverall,
      passesPerHourOverall,
      boutGapMinutes: BOUT_GAP_MINUTES,
    };
  }

  ns.Models = {
    allLabels,
    findLabel,
    findSoundDetector,
    matchedRecordingFor,
    soundProgress,
    soundSummary,
  };
})(window.SR);
