import { loadAll, LABEL, ORDER, Status } from "./data";
export const dynamic = "force-dynamic";

function ago(s: string | null) {
  if (!s) return "—";
  const d = new Date(s); if (isNaN(+d)) return s;
  const m = Math.round((Date.now() - +d) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
}

export default async function Page({ searchParams }: { searchParams: Promise<{ status?: string; repo?: string }> }) {
  const sp = await searchParams;
  const filter = (ORDER as string[]).includes(sp.status ?? "") ? (sp.status as Status) : null;
  const { repos, status } = await loadAll();
  const total: Record<string, number> = {};
  repos.forEach(r => r.features.forEach(f => (total[f.status] = (total[f.status] ?? 0) + 1)));
  const q = (s: string | null) => (s ? `?status=${s}` : "/");
  return (
    <main className="wrap">
      <h1>Feature Tracker</h1>
      <div className="muted">siddhak711 · live from GitHub (PRs + docs/REQUESTS.md) · rendered per request (GitHub cached ≤60s) · notes from data/status.json{status.updated ? ` (updated ${ago(status.updated)})` : ""} · {new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET</div>
      <div className="filters">
        <a className={`chip ${!filter ? "on" : ""}`} href="/">All ({Object.values(total).reduce((a, b) => a + b, 0)})</a>
        {ORDER.map(s => <a key={s} className={`chip ${filter === s ? "on" : ""}`} href={q(s)}>{LABEL[s]} ({total[s] ?? 0})</a>)}
      </div>
      {repos.map(r => {
        const c: Record<string, number> = {};
        r.features.forEach(f => (c[f.status] = (c[f.status] ?? 0) + 1));
        const rows = r.features.filter(f => !filter || f.status === filter).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || (b.updated ?? "").localeCompare(a.updated ?? ""));
        return (
          <section className="repo" key={r.name}>
            <header>
              <div><h2><a href={r.url}>{r.name}</a></h2><span className="src">{r.hasRequests ? "docs/REQUESTS.md + PRs" : "PRs only (no docs/REQUESTS.md yet)"}</span></div>
              <div className="counts">{ORDER.filter(s => c[s]).map(s => <span key={s} className={`b ${s}`}>{c[s]} {LABEL[s]}</span>)}</div>
            </header>
            {r.status && (["alerts", "blockers", "handoffs"] as const).map(k => (r.status![k]?.length ? (
              <div key={k} className={`notes ${k}`}><strong>{k === "alerts" ? "⚠ Alerts" : k === "blockers" ? "Blockers" : "Handoffs"}</strong>
                <ul>{r.status![k]!.map((n, i) => <li key={i}><b>{n.title}</b>{n.note ? ` — ${n.note}` : ""}</li>)}</ul></div>) : null))}
            {r.error ? <div className="err">Couldn’t load: {r.error}</div> : rows.length === 0 ? <div className="err muted">No features{filter ? " with this status" : ""}.</div> : (
              <table><thead><tr><th>Feature / request</th><th>Status</th><th>PR(s)</th><th>Updated</th></tr></thead><tbody>
                {rows.map((f, i) => (
                  <tr key={i}>
                    <td>{f.title}{f.note ? <div className="src">{f.note}</div> : null}<div className="src">{f.source}</div></td>
                    <td><span className={`b ${f.status}`}>{LABEL[f.status]}</span></td>
                    <td>{f.prs.length ? f.prs.map(p => <a key={p.number} className="pr" href={p.url}>#{p.number} · {p.draft && p.state === "open" ? "draft" : p.state}{p.checks ? ` · ${p.checks}` : ""}</a>) : <span className="muted">—</span>}</td>
                    <td className="muted">{ago(f.updated)}</td>
                  </tr>))}
              </tbody></table>)}
          </section>);
      })}
    </main>);
}
