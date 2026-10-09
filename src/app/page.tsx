import { listProjects } from '@/modules/discovery';
import { PROJECT_CATEGORIES } from '@/modules/projects';

export const dynamic = 'force-dynamic';

const STATUS_LABEL: Record<string, string> = {
  in_delivery: 'In delivery',
  completed: 'Completed',
};
const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string; category?: string }>;
}) {
  const sp = await searchParams;
  const sort = sp.sort === 'trending' ? 'trending' : 'support';
  const q = sp.q?.trim() || undefined;
  const category =
    sp.category && (PROJECT_CATEGORIES as readonly string[]).includes(sp.category)
      ? sp.category
      : undefined;

  const projects = await listProjects({ q, category, sort, limit: 50 });
  const metric = (p: (typeof projects)[number]) =>
    sort === 'trending' ? p.momentumScore : p.supportScore;
  const maxScore = Math.max(1, ...projects.map(metric));
  const maxSupport = Math.max(1, ...projects.map((p) => p.supportScore));
  const featured = projects.length
    ? [...projects].sort((a, b) => b.supportScore - a.supportScore)[0]
    : null;

  const sortHref = (s: string) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (category) params.set('category', category);
    if (s !== 'support') params.set('sort', s);
    const qs = params.toString();
    return qs ? `/?${qs}` : '/';
  };
  const catHref = (c: string | null) => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (sort !== 'support') params.set('sort', sort);
    if (c) params.set('category', c);
    const qs = params.toString();
    return qs ? `/?${qs}` : '/';
  };

  return (
    <>
      <section className="hero">
        <div className="wrap">
          <div className="hero-copy">
            <span className="eyebrow">Hold the door — sworn to good work</span>
            <h1>
              Support decides what gets <u>built</u>.
            </h1>
            <p>
              Charities post the help they need. The public backs it. Companies deliver it with
              their people&rsquo;s donated time — and the most-backed work rises first.
            </p>
            <div className="hero-stats">
              <div className="hero-stat">
                <div className="n">{projects.length}</div>
                <div className="l">projects seeking help</div>
              </div>
              <div className="hero-stat">
                <div className="n">{Math.max(0, ...projects.map((p) => p.supportScore))}</div>
                <div className="l">top support score</div>
              </div>
            </div>
          </div>

          {featured && (
            <a className="hero-feature" href={`/projects/${featured.id}`}>
              <span className="feature-eyebrow">Leading right now</span>
              <div className="feature-title">{featured.title}</div>
              <div className="feature-by">{featured.charityName ?? 'A charity'} · verified</div>
              <div className="meter">
                <span className="meter-cap" style={{ color: '#9a9db0' }}>
                  support
                </span>
                <div className="meter-track">
                  <div
                    className="meter-fill"
                    style={{
                      width: `${Math.max(6, Math.round((featured.supportScore / maxSupport) * 100))}%`,
                    }}
                  />
                </div>
                <span className="meter-val">{featured.supportScore}</span>
              </div>
              <span className="feature-open">Open project &rarr;</span>
            </a>
          )}
        </div>
      </section>

      <section className="board">
        <div className="wrap">
          <div className="toolbar">
            <h2>
              {q ? `Results for “${q}”` : 'Projects seeking help'}
              <small>
                {projects.length} {projects.length === 1 ? 'project' : 'projects'}
              </small>
            </h2>
            <div className="controls">
              <form className="search" action="/" method="get">
                {sort === 'trending' && <input type="hidden" name="sort" value="trending" />}
                <input
                  name="q"
                  placeholder="Search projects"
                  defaultValue={q}
                  aria-label="Search projects"
                />
                <button type="submit">Search</button>
              </form>
              <div className="sort" role="group" aria-label="Sort">
                <a href={sortHref('support')} aria-current={sort === 'support'}>
                  Most supported
                </a>
                <a href={sortHref('trending')} aria-current={sort === 'trending'}>
                  Trending
                </a>
              </div>
            </div>
          </div>

          <div className="cats" role="group" aria-label="Filter by category">
            <a className="cat" href={catHref(null)} aria-current={!category}>
              All
            </a>
            {PROJECT_CATEGORIES.map((c) => (
              <a className="cat" key={c} href={catHref(c)} aria-current={category === c}>
                {titleCase(c)}
              </a>
            ))}
          </div>

          {projects.length === 0 ? (
            <p className="empty">No projects match yet. Try a different filter or search.</p>
          ) : (
            <div className="rows">
              {projects.map((p, i) => {
                const val = metric(p);
                const width = Math.max(6, Math.round((val / maxScore) * 100));
                return (
                  <a className="row" href={`/projects/${p.id}`} key={p.id}>
                    <div className="rank">{String(i + 1).padStart(2, '0')}</div>
                    <div className="row-main">
                      <div className="row-title">{p.title}</div>
                      <div className="row-by">
                        {p.charityName ?? 'A charity'}
                        <span className="verified">✓ verified</span>
                        {p.category && <span className="tag">{titleCase(p.category)}</span>}
                        {STATUS_LABEL[p.status] && (
                          <span className="tag">{STATUS_LABEL[p.status]}</span>
                        )}
                      </div>
                      {p.description && <p className="row-desc">{p.description}</p>}
                      <div className="meter">
                        <span className="meter-cap">
                          {sort === 'trending' ? 'momentum' : 'support'}
                        </span>
                        <div className="meter-track">
                          <div className="meter-fill" style={{ width: `${width}%` }} />
                        </div>
                        <span className="meter-val">{val}</span>
                      </div>
                    </div>
                    <div className="row-side">
                      <span className="open">Open &rarr;</span>
                    </div>
                  </a>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </>
  );
}
