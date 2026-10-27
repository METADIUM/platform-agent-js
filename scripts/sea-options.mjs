/**
 * The SEA blob options the release ships with. `build-sea.mjs` and `check-sea-entropy.mjs` both
 * read them from here, so the entropy probe measures the configuration that is released.
 */
export const SEA_OPTIONS = Object.freeze({
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
});
