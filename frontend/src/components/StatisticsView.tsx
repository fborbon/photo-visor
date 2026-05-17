import { useState, useEffect, useRef } from 'react';
import { useLang }   from '../context/LangContext';
import { useIndex }  from '../hooks/useIndex';
import { StatsIndex, MonthStat } from '../types';

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function useContainerWidth(ref: React.RefObject<HTMLDivElement>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(entries => setW(entries[0].contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

const ML = 64, MR = 20, MT = 16, MB = 44;

// ── Cumulative line chart ──────────────────────────────────────────────────
function CumulativeChart({ byMonth }: { byMonth: MonthStat[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const cw  = useContainerWidth(ref);
  const H   = 280;
  const W   = cw - ML - MR;
  const IH  = H - MT - MB;

  // Compute cumulative totals
  let cum = 0;
  const data = byMonth.map(d => { cum += d.count; return { ym: d.ym, cum }; });
  const maxV = data[data.length - 1]?.cum ?? 1;
  const n    = data.length;

  const xp = (i: number) => (i / Math.max(n - 1, 1)) * W;
  const yp = (v: number) => IH - (v / maxV) * IH;

  // SVG paths
  const pts    = data.map((d, i) => `${xp(i).toFixed(1)},${yp(d.cum).toFixed(1)}`).join(' L ');
  const line   = `M ${pts}`;
  const area   = `M ${xp(0).toFixed(1)},${IH} L ${pts} L ${xp(n - 1).toFixed(1)},${IH} Z`;

  // X axis: year labels
  const yearTicks: { label: string; x: number }[] = [];
  data.forEach((d, i) => {
    if (d.ym.slice(5) === '01') yearTicks.push({ label: d.ym.slice(0, 4), x: xp(i) });
  });
  const yStep = yearTicks.length > 14 ? 5 : yearTicks.length > 7 ? 2 : 1;

  // Y axis
  const yTicks = [0, .25, .5, .75, 1].map(f => ({ v: Math.round(maxV * f), y: yp(maxV * f) }));

  return (
    <div ref={ref} style={{ width: '100%', height: H }}>
      {W > 0 && (
        <svg width={cw} height={H}>
          <defs>
            <linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#ff0084" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#ff0084" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <g transform={`translate(${ML},${MT})`}>
            {/* Grid */}
            {yTicks.map(t => (
              <line key={t.v} x1={0} y1={t.y.toFixed(1)} x2={W} y2={t.y.toFixed(1)}
                stroke="#242424" strokeWidth={1} />
            ))}
            {/* Area + line */}
            <path d={area} fill="url(#cumGrad)" />
            <path d={line} fill="none" stroke="#ff0084" strokeWidth={2.5}
              strokeLinejoin="round" strokeLinecap="round" />
            {/* X axis */}
            <line x1={0} y1={IH} x2={W} y2={IH} stroke="#2e2e2e" />
            {yearTicks.filter((_, i) => i % yStep === 0).map(t => (
              <g key={t.label} transform={`translate(${t.x.toFixed(1)},${IH})`}>
                <line y2={5} stroke="#3a3a3a" />
                <text y={18} textAnchor="middle" fill="#686868" fontSize={11}>{t.label}</text>
              </g>
            ))}
            {/* Y axis */}
            <line x1={0} y1={0} x2={0} y2={IH} stroke="#2e2e2e" />
            {yTicks.map(t => (
              <g key={t.v} transform={`translate(0,${t.y.toFixed(1)})`}>
                <line x1={-4} stroke="#3a3a3a" />
                <text x={-8} textAnchor="end" dominantBaseline="middle" fill="#686868" fontSize={11}>
                  {fmtNum(t.v)}
                </text>
              </g>
            ))}
          </g>
        </svg>
      )}
    </div>
  );
}

// ── Monthly bar chart ──────────────────────────────────────────────────────
function MonthlyBarChart({ byMonth }: { byMonth: MonthStat[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const cw  = useContainerWidth(ref);
  const H   = 260;
  const IH  = H - MT - MB;
  const IW  = Math.max(1, cw - ML - MR);

  const n    = byMonth.length;
  // Fit all bars in the available width — no horizontal scroll
  const slot = IW / n;
  const barW = Math.max(1, slot - Math.min(1, slot * 0.15));

  const maxV = Math.max(...byMonth.map(d => d.count), 1);
  const yTicks = [0, .25, .5, .75, 1].map(f => ({ v: Math.round(maxV * f), y: IH - IH * f }));

  const yearMarks: { label: string; x: number }[] = [];
  byMonth.forEach((d, i) => {
    if (d.ym.slice(5) === '01') {
      yearMarks.push({ label: d.ym.slice(0, 4), x: i * slot + slot / 2 });
    }
  });
  const yStep = yearMarks.length > 14 ? 5 : yearMarks.length > 7 ? 2 : 1;

  return (
    <div ref={ref} style={{ width: '100%' }}>
      {cw > 0 && (
        <svg width={cw} height={H} style={{ display: 'block' }}>
          <g transform={`translate(${ML},${MT})`}>
            {/* Grid */}
            {yTicks.map(t => (
              <line key={t.v} x1={0} y1={t.y.toFixed(1)} x2={IW} y2={t.y.toFixed(1)}
                stroke="#242424" strokeWidth={1} />
            ))}
            {/* Bars */}
            {byMonth.map((d, i) => {
              const bh  = Math.max(1, (d.count / maxV) * IH);
              const x   = i * slot + (slot - barW) / 2;
              const isJan = d.ym.slice(5) === '01';
              return (
                <rect key={d.ym}
                  x={x.toFixed(2)} y={(IH - bh).toFixed(1)}
                  width={barW.toFixed(2)} height={bh.toFixed(1)}
                  fill={isJan ? '#ff0084' : '#cc006a'}
                  opacity={0.85} rx={barW > 6 ? 2 : 0}
                />
              );
            })}
            {/* X axis */}
            <line x1={0} y1={IH} x2={IW} y2={IH} stroke="#2e2e2e" />
            {yearMarks.filter((_, i) => i % yStep === 0).map(t => (
              <g key={t.label} transform={`translate(${t.x.toFixed(1)},${IH})`}>
                <line y2={5} stroke="#3a3a3a" />
                <text y={18} textAnchor="middle" fill="#686868" fontSize={11}>{t.label}</text>
              </g>
            ))}
            {/* Y axis */}
            <line x1={0} y1={0} x2={0} y2={IH} stroke="#2e2e2e" />
            {yTicks.map(t => (
              <g key={t.v} transform={`translate(0,${t.y.toFixed(1)})`}>
                <line x1={-4} stroke="#3a3a3a" />
                <text x={-8} textAnchor="end" dominantBaseline="middle" fill="#686868" fontSize={11}>
                  {fmtNum(t.v)}
                </text>
              </g>
            ))}
          </g>
        </svg>
      )}
    </div>
  );
}

// ── Main view ──────────────────────────────────────────────────────────────
export default function StatisticsView() {
  const { tr } = useLang();
  const { data: stats, loading } = useIndex<StatsIndex>('index/stats.json');

  return (
    <div className="stats-layout">
      {loading && <p className="panel-loading">{tr.loading}</p>}

      {stats && (
        <>
          {/* ── Totals row ───────────────────────────────────────────── */}
          <div className="stats-totals-row">
            <div className="stats-kpi">
              <span className="stats-kpi-num">{stats.total.toLocaleString()}</span>
              <span className="stats-kpi-label">{tr.statsTotal}</span>
            </div>
            <div className="stats-kpi secondary">
              <span className="stats-kpi-num">{stats.no_date.toLocaleString()}</span>
              <span className="stats-kpi-label">{tr.statsNoDate}</span>
            </div>
            <div className="stats-kpi secondary">
              <span className="stats-kpi-num">{stats.by_month.length}</span>
              <span className="stats-kpi-label">{tr.statsMonthsWithPhotos}</span>
            </div>
          </div>

          {/* ── Cumulative chart ─────────────────────────────────────── */}
          <div className="stats-card">
            <h3 className="stats-card-title">{tr.statsCumulative}</h3>
            <CumulativeChart byMonth={stats.by_month} />
          </div>

          {/* ── Monthly bar chart ────────────────────────────────────── */}
          <div className="stats-card">
            <h3 className="stats-card-title">{tr.statsMonthly}</h3>
            <MonthlyBarChart byMonth={stats.by_month} />
          </div>
        </>
      )}
    </div>
  );
}
