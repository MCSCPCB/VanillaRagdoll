import { generate } from './generator/index.mjs';
import { errorMessage } from './generator/messages.mjs';

self.onmessage = async ({ data: { buffer, name, fallbackIcon } }) => {
  try {
    const result = await generate(buffer, name, { fallbackIcon, progress: event => self.postMessage({ type: 'progress', event }) });
    self.postMessage({ type: 'result', result }, result.download ? [result.download.data.buffer] : []);
  } catch (error) { self.postMessage({ type: 'error', message: errorMessage(error) }); }
};
