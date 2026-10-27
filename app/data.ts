export type Status = "done" | "review" | "progress" | "blocked" | "todo";
export const LABEL: Record<Status, string> = { done: "Done / verified live", review: "In review", progress: "In progress", blocked: "Blocked / waiting on Siddha", todo: "Not started" };
export const ORDER: Status[] = ["blocked", "review", "progress", "todo", "done"];
export type PR = { number: number; title: string; url: string; state: "open" | "merged" | "closed"; draft: boolean; updated: string; branch: string; sha?: string; checks?: string; reviewer?: string };
export type Note = { title: string; note?: string; level?: string };
export type RepoStatus = { alerts?: Note[]; blockers?: Note[]; handoffs?: Note[]; prs?: Record<string, { status?: Status; note?: string }> };
export type Feature = { title: string; status: Status; prs: PR[]; updated: string | null; source: "REQUESTS.md" | "PR"; note?: string };
export type Repo = { name: string; url: string; features: Feature[]; hasRequests: boolean; error?: string; status?: RepoStatus };

const OWNER = "siddhak711";
// Public repos only (private repos need a read-only token via GITHUB_TOKEN env).
export const REPOS = (process.env.TRACKER_REPOS ?? "mockbot,FPF,reps-site,MTDWizard_MissionControl,MTDWizard_VersionControl").split(",").map(s => s.trim()).filter(Boolean);

function headers(): HeadersInit {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "feature-tracker" };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

// In-memory cache (~60s) so unauthenticated GitHub (60 req/h) isn't exhausted; serves stale data on errors.
const cache = new Map<string, { at: number; ok: boolean; status: number; body: string }>();
async function cached(url: string, ttl = 60_000, h?: HeadersInit) {
  const c = cache.get(url);
  if (c && Date.now() - c.at < ttl) return c;
  try {
    const r = await fetch(url, { headers: h, cache: "no-store" });
    const e = { at: Date.now(), ok: r.ok, status: r.status, body: await r.text() };
    if (e.ok || e.status === 404 || !c) cache.set(url, e);
    return e.ok || e.status === 404 || !c ? e : c;
  } catch (err) { if (c) return c; throw err; }
}

export async function loadStatus(): Promise<{ updated?: string; repos: Record<string, RepoStatus> }> {
  const r = await cached(`https://raw.githubusercontent.com/${OWNER}/feature-tracker/main/data/status.json`);
  try { return r.ok ? JSON.parse(r.body) : { repos: {} }; } catch { return { repos: {} }; }
}

async function checksFor(name: string, sha: string) {
  const r = await cached(`https://api.github.com/repos/${OWNER}/${name}/commits/${sha}/check-runs?per_page=50`, 300_000, headers());
  if (!r.ok) return undefined;
  const runs: any[] = JSON.parse(r.body).check_runs ?? [];
  if (!runs.length) return "no checks";
  if (runs.some(c => c.status !== "completed")) return "checks running";
  const bad = runs.filter(c => !["success", "neutral", "skipped"].includes(c.conclusion));
  return bad.length ? `checks failing (${bad.map(c => c.name).join(", ")})` : "checks passing";
}

export function parseStatus(s: string): Status {
  const t = s.toLowerCase();
  if (/block|waiting|siddha|needs (you|user|owner)|on hold/.test(t)) return "blocked";
  if (/done|verified|live|shipped|complete|merged/.test(t)) return "done";
  if (/review|pr open/.test(t)) return "review";
  if (/progress|wip|building|doing|started|active/.test(t)) return "progress";
  return "todo";
}

function prStatus(p: PR): Status {
  if (p.state === "merged") return "done";
  if (p.state === "closed") return "todo";
  if (p.draft || /^\s*\[?wip/i.test(p.title)) return "progress";
  return "review";
}

function splitRow(line: string) { return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()); }

export function parseRequests(md: string, prs: Map<number, PR>) {
  const lines = md.split("\n");
  const out: { f: Feature; nums: number[] }[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].trim().startsWith("|") || !/^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) continue;
    const hdr = splitRow(lines[i]).map(h => h.toLowerCase());
    const col = (re: RegExp) => hdr.findIndex(h => re.test(h));
    const ti = col(/request|feature|ask|item|title|what/), si = col(/status|state/), pi = col(/^prs?\b|pull|pr\(s\)|link/), ui = col(/updated|date|last/), ni = col(/done|criteria|note|blocker|waiting/);
    if (ti < 0 || si < 0) continue;
    for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j++) {
      const c = splitRow(lines[j]);
      const title = (c[ti] ?? "").replace(/\*\*/g, "");
      if (!title) continue;
      const prCell = pi >= 0 ? c[pi] ?? "" : c.join(" ");
      const nums = [...prCell.matchAll(/(?:#|\/pull\/)(\d+)/g)].map(m => +m[1]);
      out.push({ nums, f: { title, status: parseStatus(c[si] ?? ""), prs: nums.map(n => prs.get(n)).filter(Boolean) as PR[], updated: ui >= 0 ? c[ui] || null : null, source: "REQUESTS.md", note: ni >= 0 ? c[ni] : undefined } });
    }
    i += 1;
  }
  return out;
}

async function loadRepo(name: string, st?: RepoStatus): Promise<Repo> {
  const url = `https://github.com/${OWNER}/${name}`;
  try {
    const [prRes, reqRes] = await Promise.all([
      cached(`https://api.github.com/repos/${OWNER}/${name}/pulls?state=all&per_page=100&sort=updated&direction=desc`, 60_000, headers()),
      cached(`https://raw.githubusercontent.com/${OWNER}/${name}/HEAD/docs/REQUESTS.md`),
    ]);
    if (!prRes.ok) throw new Error(`GitHub API ${prRes.status}${prRes.status === 403 ? " (rate limited)" : ""}`);
    const raw: any[] = JSON.parse(prRes.body);
    const prs = new Map<number, PR>();
    for (const p of raw) prs.set(p.number, { number: p.number, title: p.title, url: p.html_url, state: p.merged_at ? "merged" : p.state, draft: !!p.draft, updated: p.updated_at, branch: p.head?.ref ?? "", sha: p.head?.sha });
    const features: Feature[] = [];
    const used = new Set<number>();
    let hasRequests = false;
    if (reqRes.ok) {
      hasRequests = true;
      for (const { f, nums } of parseRequests(reqRes.body, prs)) {
        nums.forEach(n => used.add(n));
        if (!f.updated && f.prs.length) f.updated = f.prs.map(p => p.updated).sort().at(-1)!;
        features.push(f);
      }
    }
    for (const p of prs.values()) {
      if (used.has(p.number) || p.state === "closed") continue;
      features.push({ title: p.title, status: prStatus(p), prs: [p], updated: p.updated, source: "PR", note: p.state === "merged" ? "Merged; live check not recorded (no REQUESTS.md row)" : undefined });
    }
    if (st?.prs) {
      const tracked = new Set(features.flatMap(f => f.prs.map(p => p.number)));
      for (const n of Object.keys(st.prs)) { const p = prs.get(+n); if (p && !tracked.has(p.number)) features.push({ title: p.title, status: prStatus(p), prs: [p], updated: p.updated, source: "PR" }); }
      for (const f of features) for (const p of f.prs) {
        const o = st.prs[String(p.number)]; if (!o) continue;
        if (o.status) f.status = o.status;
        if (o.note) f.note = o.note + (f.note && f.source === "REQUESTS.md" ? ` · ${f.note}` : "");
      }
      const open = features.flatMap(f => f.prs).filter(p => p.state === "open" && p.sha && st.prs![String(p.number)]);
      await Promise.all(open.map(async p => { p.checks = await checksFor(name, p.sha!).catch(() => undefined); }));
    }
    return { name, url, features, hasRequests, status: st };
  } catch (e: any) {
    return { name, url, features: [], hasRequests: false, error: String(e?.message ?? e) };
  }
}

export async function loadAll() {
  const status: { updated?: string; repos: Record<string, RepoStatus> } = await loadStatus().catch(() => ({ repos: {} }));
  return { status, repos: await Promise.all(REPOS.map(n => loadRepo(n, status.repos[n]))) };
}
