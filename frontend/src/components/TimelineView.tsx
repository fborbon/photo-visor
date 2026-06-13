import { useState, useMemo, useEffect, useRef } from 'react';
import { useIndex }   from '../hooks/useIndex';
import { useLang }    from '../context/LangContext';
import { usePrivacy } from '../context/PrivacyContext';
import { useNav, scrollToHash } from '../context/NavContext';
import { Summary, PhotoEntry } from '../types';
import PhotoGrid from './PhotoGrid';

interface MonthGroup {
  month:  number;
  photos: PhotoEntry[];
}

interface Props { initialYear?: number; initialMonth?: number; }

export default function TimelineView({ initialYear, initialMonth }: Props) {
  const { tr }                       = useLang();
  const { isOwner, isPhotoPrivate }  = usePrivacy();
  const { pendingNav, clearNav }     = useNav();
  const { data: summary }            = useIndex<Summary>('index/summary.json');
  const years = useMemo(
    () => (summary ? [...summary.years].sort((a, b) => b - a) : []),
    [summary],
  );

  const mainRef        = useRef<HTMLDivElement>(null);
  const mountedRef     = useRef(false);
  // Prevent year-change effect from clearing the month when navigating to a specific month.
  const skipMonthReset = useRef(false);
  // True when the year was auto-selected on open so we also auto-pick the latest month.
  const autoSelectMonth = useRef(false);

  const [selectedYear,  setSelectedYear]  = useState<number | null>(initialYear  ?? null);
  const [selectedMonth, setSelectedMonth] = useState<number | null>(initialMonth ?? null);

  // Auto-select latest year on first load when no year is already set.
  useEffect(() => {
    if (years.length === 0) return;
    if (selectedYear !== null) return;
    if (pendingNav?.year) return;
    skipMonthReset.current = true;
    autoSelectMonth.current = true;
    setSelectedYear(years[0]);
  }, [years]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset month when year changes — skip when a cross-tab nav has already set it.
  useEffect(() => {
    if (!mountedRef.current) { mountedRef.current = true; return; }
    if (skipMonthReset.current) { skipMonthReset.current = false; return; }
    setSelectedMonth(null);
  }, [selectedYear]);

  // Apply incoming nav: set year+month, flag to prevent year-change from clearing month.
  useEffect(() => {
    if (!pendingNav?.year) return;
    if (pendingNav.month) skipMonthReset.current = true;
    setSelectedYear(pendingNav.year);
    if (pendingNav.month) setSelectedMonth(pendingNav.month);
  }, [pendingNav]);

  const yearKey = selectedYear ? 'index/time/' + selectedYear + '.json' : null;
  const { data: yearPhotos, loading } = useIndex<PhotoEntry[]>(yearKey);

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

  const activeGroup = selectedMonth !== null
    ? monthGroups.find(g => g.month === selectedMonth) ?? null
    : null;

  // Auto-select the latest month after auto year selection.
  useEffect(() => {
    if (!autoSelectMonth.current) return;
    if (monthGroups.length === 0) return;
    autoSelectMonth.current = false;
    setSelectedMonth(monthGroups[monthGroups.length - 1].month);
  }, [monthGroups]);

  // Scroll to the pending photo hash once the month's photos are rendered.
  useEffect(() => {
    if (!pendingNav?.hash || !activeGroup) return;
    scrollToHash(pendingNav.hash, undefined, clearNav);
  }, [activeGroup, pendingNav, clearNav]);

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
      <div className="timeline-main" ref={mainRef}>

        {!selectedYear && (
          <div className="timeline-hint">{tr.selectYearHint}</div>
        )}

        {selectedYear && (
          <>
            {loading && <p className="panel-loading">{tr.loading}</p>}

            {/* Month selector strip */}
            {!loading && monthGroups.length > 0 && (
              <div className="month-strip">
                {monthGroups.map(g => (
                  <button
                    key={g.month}
                    className={'month-btn' + (selectedMonth === g.month ? ' active' : '')}
                    onClick={() => setSelectedMonth(g.month)}
                  >
                    {g.month ? tr.monthsShort[g.month] : '?'}
                    <span className="month-count">{g.photos.length}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Photo grid for selected month — sort handled by PhotoGrid */}
            {activeGroup && (
              <>
                <div className="month-section">
                  <div className="month-section-header">
                    <span className="month-section-name">
                      {activeGroup.month ? tr.months[activeGroup.month] : '?'}
                    </span>
                    <span className="month-section-count">
                      {activeGroup.photos.length} {tr.photos}
                    </span>
                  </div>
                  <PhotoGrid photos={activeGroup.photos} navMode="timeline" defaultSort="newest" />
                  <div className="back-to-top-wrap">
                    <button
                      className="back-to-top-btn"
                      onClick={() => mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })}
                    >↑ {tr.backToTop ?? 'Back to top'}</button>
                  </div>
                </div>
              </>
            )}

            {!loading && !selectedMonth && monthGroups.length > 0 && (
              <div className="timeline-hint">↑ {tr.selectMonthHint ?? 'Select a month'}</div>
            )}

            {!loading && yearPhotos && monthGroups.length === 0 && (
              <p className="panel-loading">{tr.noPhotos}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
