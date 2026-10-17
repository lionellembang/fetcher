/**
 * The settings cut and transcribe run with: this hub's, whether the work runs
 * here (COMPUTE=local) or on the compute node (remote.js sends them along).
 * Each stage stores its key; when a setting changes, so does the key, and the
 * stage is redone.
 */
const config = require('./config');

/** Options for shared/cut.js cutRecording (with downloadDir). */
const cut = () => ({ edit: config.cutEdit, margin: config.cutMargin, extraArgs: config.cutExtraArgs });
const cutKey = () => [config.cutEdit, config.cutMargin, ...config.cutExtraArgs].join('|');

function useLoudnorm(probeMeta) {
  if (config.transcribeLoudnorm === 'always') return true;
  if (config.transcribeLoudnorm === 'never') return false;
  return !!(probeMeta && probeMeta.quiet);
}

/** Options for shared/transcribe.js transcribeFile (with key and label). */
const transcribe = (probeMeta) => ({
  language: config.transcribeLang,
  model: config.transcribeModel,
  gateDb: config.transcribeGateDb,
  loudnorm: useLoudnorm(probeMeta),
  duration: (probeMeta && probeMeta.duration) || 3600,
});
const transcribeKey = () =>
  [config.transcribeModel, config.transcribeLang, `gate${config.transcribeGateDb}`, `loudnorm:${config.transcribeLoudnorm}`].join('|');

module.exports = { cut, cutKey, transcribe, transcribeKey, useLoudnorm };
