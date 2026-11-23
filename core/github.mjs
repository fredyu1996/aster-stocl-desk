// Shared paper state in a private GitHub repo. Each save is one parentless commit, force-updated on the branch,
// so the branch never grows history. A writer re-reads the ref just before updating and steps down on a conflict.

export class Conflict extends Error {}

const b64decode = s => {
  const clean = s.replace(/\n/g, '');
  if (typeof Buffer !== 'undefined') return Buffer.from(clean, 'base64').toString('utf8');
  return new TextDecoder().decode(Uint8Array.from(atob(clean), c => c.charCodeAt(0)));
};

export function store({ token, repo, branch = 'stocks-state', path = 'stock-desk-state.json', fetchImpl = globalThis.fetch }) {
  const api = async (method, url, body) => {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}${url}`, {
      method, body: body && JSON.stringify(body), signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${method} ${url.split('?')[0]} → HTTP ${res.status}`);
    return res.status === 204 ? {} : res.json();
  };
  const head = async () => (await api('GET', `/git/ref/heads/${branch}`))?.object.sha ?? null;
  return {
    head,
    async read() {
      const ref = await head();
      if (!ref) return { state: null, ref: null };
      const commit = await api('GET', `/git/commits/${ref}`);
      const tree = await api('GET', `/git/trees/${commit.tree.sha}`);
      const entry = tree.tree.find(e => e.path === path);
      if (!entry) return { state: null, ref };
      const blob = await api('GET', `/git/blobs/${entry.sha}`);
      return { state: JSON.parse(b64decode(blob.content)), ref };
    },
    async write(state, expectRef, message = 'stock desk state') {
      const blob = await api('POST', '/git/blobs', { content: JSON.stringify(state), encoding: 'utf-8' });
      const tree = await api('POST', '/git/trees', { tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }] });
      const commit = await api('POST', '/git/commits', { message, tree: tree.sha, parents: [] });
      const now = await head();
      if (now !== expectRef) throw new Conflict('Someone else saved the shared state first.');
      if (now) await api('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha, force: true });
      else await api('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: commit.sha });
      return commit.sha;
    },
  };
}

// Read → apply `mutate` → write, retrying on conflicts. `mutate` gets the fresh remote state and returns the next one.
export async function update(st, mutate, tries = 3) {
  for (let i = 0; ; i++) {
    const { state, ref } = await st.read();
    const next = await mutate(state);
    if (!next) return { state, ref, skipped: true };
    try { return { state: next, ref: await st.write(next, ref) }; }
    catch (e) { if (!(e instanceof Conflict) || i + 1 >= tries) throw e; }
  }
}
