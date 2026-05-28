// Fetches and parses JSON off the main thread to avoid UI freezes on large index files
self.onmessage = async (e: MessageEvent<{ url: string }>) => {
  try {
    const r = await fetch(e.data.url);
    if (!r.ok) { self.postMessage({ error: 'HTTP ' + r.status }); return; }
    const text = await r.text();
    const data = JSON.parse(text);
    self.postMessage({ data });
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};
