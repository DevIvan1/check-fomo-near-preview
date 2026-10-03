// Dedicated worker that emits ticks. Worker timers are not subject to the
// aggressive throttling browsers apply to timers in background tabs.
let timer = null;
self.onmessage = (e) => {
  const { cmd, ms } = e.data || {};
  if (timer) clearInterval(timer);
  timer = null;
  if (cmd === 'start') timer = setInterval(() => self.postMessage('tick'), Math.max(1000, ms | 0));
};
