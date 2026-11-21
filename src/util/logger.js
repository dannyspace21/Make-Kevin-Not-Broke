// =============================================================================
// logger.js  -  minimal console logger that hides secrets.
// -----------------------------------------------------------------------------
// If an error message ever contains an API key (some libraries echo request
// headers), `redact` replaces it with "***" before it is printed.
// =============================================================================
import { config } from '../config.js';

// Collect every secret we know about (skip empty ones).
const secrets = [
  config.alpaca.keyId, config.alpaca.secretKey, config.ai.anthropicKey, config.ai.openaiKey,
  config.ransom.ransomDbKey, config.ransom.darkwebIqKey, config.appPassword,
].filter((s) => s && s.length >= 6);

/** Replace any known secret inside a string with ***. */
export function redact(value) {
  let text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  for (const s of secrets) text = text.split(s).join('***');
  return text;
}

const stamp = () => new Date().toISOString();

// log.info('alpaca', 'connected') -> 2026-01-01T00:00:00Z [INFO ] [alpaca] connected
export const log = {
  info: (tag, ...msg) => console.log(`${stamp()} [INFO ] [${tag}]`, ...msg.map(redact)),
  warn: (tag, ...msg) => console.warn(`${stamp()} [WARN ] [${tag}]`, ...msg.map(redact)),
  error: (tag, ...msg) => console.error(`${stamp()} [ERROR] [${tag}]`, ...msg.map(redact)),
};
