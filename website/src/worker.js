import { generate } from './generator/index.mjs';

self.onmessage = async ({ data: { buffer, name, fallbackIcon } }) => {
  try {
    const result = await generate(buffer, name, { fallbackIcon, progress: event => self.postMessage({ type: 'progress', event }) });
    self.postMessage({ type: 'result', result }, result.download ? [result.download.data.buffer] : []);
  } catch (error) { self.postMessage({ type: 'error', message: error.message || '处理失败，请换一个完整的资源包重试' }); }
};
