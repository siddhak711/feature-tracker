export type Status = "done" | "review" | "progress" | "blocked" | "todo";
export const LABEL: Record<Status, string> = { done: "Done / verified live", review: "In review", progress: "In progress", blocked: "Blocked / waiting on Siddha", todo: "Not started" };
export const ORDER: Status[] = ["blocked", "review", "progress", "todo", "done"];
export type PR = { number: number; title: string; url: string; state: "open" | "merged" | "closed"; draft: boolean; updated: string; branch: string; reviewer?: string };
export type Feature = { title: string; status: Status; prs: PR[]; updated: string | null; source: "REQUESTS.md" | "PR"; note?: string };
export type Repo = { name: string; url: string; features: Feature[]; hasRequests: boolean; error?: string };

const OWNER = "siddhak711";
// Public repos only (private repos need a read-only token via GITHUB_TOKEN env).
export const REPOS = (process.env.TRACKER_REPOS ?? "mockbot,FPF,reps-site,MTDWizard_MissionControl,MTDWizard_VersionControl").split(",").map(s => s.trim()).filter(Boolean);

function headers(): HeadersInit {
  const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "feature-tracker" };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
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

async function loadRepo(name: string): Promise<Repo> {
  const url = `https://github.com/${OWNER}/${name}`;
  const revalidate = name === "mockbot" ? 300 : 900;
  try {
    const [prRes, reqRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${OWNER}/${name}/pulls?state=all&per_page=100&sort=updated&direction=desc`, { headers: headers(), next: { revalidate } }),
      fetch(`https://raw.githubusercontent.com/${OWNER}/${name}/HEAD/docs/REQUESTS.md`, { next: { revalidate } }),
    ]);
    if (!prRes.ok) throw new Error(`GitHub API ${prRes.status}${prRes.status === 403 ? " (rate limited)" : ""}`);
    const raw: any[] = await prRes.json();
    const prs = new Map<number, PR>();
    for (const p of raw) prs.set(p.number, { number: p.number, title: p.title, url: p.html_url, state: p.merged_at ? "merged" : p.state, draft: !!p.draft, updated: p.updated_at, branch: p.head?.ref ?? "" });
    const features: Feature[] = [];
    const used = new Set<number>();
    let hasRequests = false;
    if (reqRes.ok) {
      hasRequests = true;
      for (const { f, nums } of parseRequests(await reqRes.text(), prs)) {
        nums.forEach(n => used.add(n));
        if (!f.updated && f.prs.length) f.updated = f.prs.map(p => p.updated).sort().at(-1)!;
        features.push(f);
      }
    }
    for (const p of prs.values()) {
      if (used.has(p.number) || p.state === "closed") continue;
      features.push({ title: p.title, status: prStatus(p), prs: [p], updated: p.updated, source: "PR", note: p.state === "merged" ? "Merged; live check not recorded (no REQUESTS.md row)" : undefined });
    }
    return { name, url, features, hasRequests };
  } catch (e: any) {
    return { name, url, features: [], hasRequests: false, error: String(e?.message ?? e) };
  }
}

export async function loadAll() { return Promise.all(REPOS.map(loadRepo)); }
