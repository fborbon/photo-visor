import { useState, useMemo, useRef } from 'react';
import { useIndex }   from '../hooks/useIndex';
import { useLang }    from '../context/LangContext';
import { usePrivacy } from '../context/PrivacyContext';
import { Summary, PhotoEntry } from '../types';
import PhotoGrid from './PhotoGrid';

interface MonthGroup {
  month:  number;
  photos: PhotoEntry[];
}

export default function TimelineView() {
  const { tr }                       = useLang();
  const { isOwner, isPhotoPrivate }  = usePrivacy();
  const { data: summary }            = useIndex<Summary>('index/summary.json');
  const years = useMemo(
    () => (summary ? [...summary.years].sort((a, b) => b - a) : []),
    [summary],
  );

  const [selectedYear, setSelectedYear] = useState<number | null>(null);

  const yearKey = selectedYear ? 'index/time/' + selectedYear + '.json' : null;
  const { data: yearPhotos, loading }   = useIndex<PhotoEntry[]>(yearKey);

  const monthGroups: MonthGroup[] = useMemo(() => {
    if (!yearPhotos) return [];
    const map = new Map<number, PhotoEntry[]>();
    for (const p of yearPhotos) {
      if (!isOwner && isPhotoPrivate(p.hash)) continue;
      const m = p.month ?? 0;
      const arr = map.get(m) ?? [];
      arr.push(p);
      map.set(m, arr);
    }
    return Array.from(map.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([month, photos]) => ({ month, photos }));
  }, [yearPhotos, isOwner, isPhotoPrivate]);

  // Refs for each month section – used for scroll-to navigation
  const sectionRefs = useRef<Record<number, HTMLDivElement | null>>({});

  const scrollToMonth = (month: number) => {
    const el = sectionRefs.current[month];
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="timeline-layout">

      {/* ── Year rail ──────────────────────────────────────── */}
      <aside className="year-rail">
        <h3 className="rail-heading">{tr.yearsHeading}</h3>
        {years.map(y => (
          <button
            key={y}
            className={'year-btn' + (selectedYear === y ? ' active' : '')}
            onClick={() => setSelectedYear(y)}
          >
            {y}
          </button>
        ))}
      </aside>

      {/* ── Main content ───────────────────────────────────── */}
      <div className="timeline-main">

        {!selectedYear && (
          <div className="timeline-hint">{tr.selectYearHint}</div>
        )}

        {selectedYear && (
          <>
            {/* Month navigation strip */}
            {monthGroups.length > 0 && (
              <div className="month-strip">
                {monthGroups.map(g => (
                  <button
                    key={g.month}
                    className="month-btn"
                    onClick={() => scrollToMonth(g.month)}
                  >
                    {g.month ? tr.monthsShort[g.month] : '?'}
                    <span className="month-count">{g.photos.length}</span>
                  </button>
                ))}
              </div>
            )}

            {loading && <p className="panel-loading">{tr.loading}</p>}

            {/* One section per month */}
            {!loading && monthGroups.map(g => (
              <div
                key={g.month}
                className="month-section"
                ref={el => { sectionRefs.current[g.month] = el; }}
              >
                <div className="month-section-header">
                  <span className="month-section-name">
                    {g.month ? tr.months[g.month] : '?'}
                  </span>
                  <span className="month-section-count">
                    {g.photos.length} {tr.photos}
                  </span>
                </div>
                <PhotoGrid photos={g.photos} />
              </div>
            ))}

            {!loading && yearPhotos && monthGroups.length === 0 && (
              <p className="panel-loading">{tr.noPhotos}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
