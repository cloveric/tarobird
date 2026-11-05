import { useMemo, useRef, useState, useLayoutEffect, useEffect, useContext } from "react";
import { ArrowLeftRight, Check, ChevronLeft, ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import { reportMetric, type ReportData, type ReportRow } from "../../src/client-protocol/report.js";
import { t, useLocale } from "./i18n.js";
import { useBackAction } from "./back-navigation.js";
import { useMessageReader } from "./message-overlay.js";
import { RuntimeHostActiveContext } from "./RuntimeHost.js";
import "./report.css";
import { reportChartDomain } from "./report-chart-domain.js";

// Series identity uses the original chart order, never the filtered visible order.
const seriesDashes = [undefined, "7 3", "2 3", "8 3 2 3"] as const;
function SeriesSwatch({ index, kind, color }: { index: number; kind: "line" | "bar"; color: string }) {
  return <svg className="report-series-swatch" viewBox="0 0 28 12" aria-hidden="true" focusable="false" style={{ color }}>
    {kind === "line" ? <path d="M1 6H27" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={seriesDashes[index]}/>
      : <rect x="5" y="1" width="18" height="10" rx="2" fill="currentColor"/>}
  </svg>;
}

// A report may contain 2,400 cells. Reuse the browser-locale formatter instead
// of constructing one for every numeric cell on each filter/selection render.
const numberFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const number = (value: number) => numberFormatter.format(value);
const display = (value: string | number | null | undefined) => value == null ? "—" : typeof value === "number" ? number(value) : value;

export function Report({ title, summary, report, compact = false, showHeader = true }: { title: string; summary: string; report: ReportData; compact?: boolean; showHeader?: boolean }) {
  useLocale();
  const dataset = useMemo(() => JSON.stringify([report.columns, report.rows, report.chart]), [report]);
  const [filter, setFilter] = useState<{ dataset: string; value: string }>();
  const query = filter?.dataset === dataset ? filter.value : "";
  const setQuery = (value: string) => setFilter({ dataset, value });
  const [view, setView] = useState<"overview" | "table">("overview");
  const [selection, setSelection] = useState<{ dataset: string; query: string; index: number }>();
  const selected = selection?.dataset === dataset && selection.query === query ? selection.index : undefined;
  const setSelected = (index?: number) => setSelection(index === undefined ? undefined : { dataset, query, index });
  const [seriesSelection, setSeriesSelection] = useState<{ dataset: string; hidden: number[] }>();
  const hiddenSeries = seriesSelection?.dataset === dataset ? seriesSelection.hidden : [];
  const changeSeries = (hidden: number[]) => setSeriesSelection({ dataset, hidden });
  const [expanded, setExpanded] = useState(false);
  const container = useRef<HTMLElement>(null);
  const [inlineHeight, setInlineHeight] = useState<number>();
  const dialog = useRef<HTMLDialogElement>(null), expand = useRef<HTMLButtonElement>(null);
  const rows = useMemo(() => report.rows.filter(row => !query || row.some(value => String(value ?? "").toLocaleLowerCase().includes(query.toLocaleLowerCase()))), [report, query]);
  const active = useContext(RuntimeHostActiveContext);
  const close = () => { setExpanded(false); expand.current?.focus({ preventScroll: true }); };
  useEffect(() => { if (!active) setExpanded(false); }, [active]);
  useLayoutEffect(() => { const panel = dialog.current!; panel.close(); if (expanded) panel.showModal(); else panel.setAttribute("open", ""); }, [expanded]);
  useBackAction(dialog, () => { if (!expanded) return false; close(); return true; }, 210);
  useMessageReader(active && expanded);
  const contents = <>
    {showHeader && <header className="report-header"><strong>{title}</strong><button ref={expand} aria-label={expanded ? t("收起交互组件") : t("放大交互组件")} onClick={() => { if (expanded) close(); else { setInlineHeight(container.current?.getBoundingClientRect().height); setExpanded(true); } }}>{expanded ? <Minimize2 size={16}/> : <Maximize2 size={16}/>}<span>{expanded ? t("收起") : t("放大")}</span></button></header>}
    <div className="report-body">
      <p className="report-conclusion">{summary}</p>
      <div className="report-controls">
        {(report.chart || report.timeline) && <div className="report-views" role="group" aria-label={t("报告视图")}><button aria-pressed={view === "overview"} onClick={() => setView("overview")}>{t("概览")}</button><button aria-pressed={view === "table"} onClick={() => setView("table")}>{t("明细")}</button></div>}
        {report.rows.length > 8 && <input type="search" aria-label={t("筛选报告")} placeholder={t("筛选报告")} value={query} onChange={event => { setQuery(event.target.value); setSelected(undefined); }}/>}<small>{t("{0} 条记录", rows.length)}</small>
      </div>
      {!!report.metrics?.length && <dl className="report-metrics">{report.metrics.map((metric, index) => <div key={index}><dt>{metric.label}</dt><dd>{display(reportMetric(rows, metric))}{metric.unit && <small> {metric.unit}</small>}</dd></div>)}</dl>}
      {!rows.length ? <p className="report-empty">{t("没有匹配的记录")}</p> : view === "overview" && report.chart ? <ReportChart rows={rows} report={report} selected={selected} select={setSelected} hidden={hiddenSeries} changeHidden={changeSeries} compact={compact && !expanded}/> : view === "overview" && report.timeline ? <ol className="report-timeline">{rows.map((row, index) => <li key={index}><span>{display(row[report.timeline!.date])}</span><strong>{display(row[report.timeline!.title])}</strong>{report.timeline!.detail !== undefined && <p>{display(row[report.timeline!.detail])}</p>}</li>)}</ol> : <ReportTable columns={report.columns} rows={rows}/>}
      {report.source && <p className="report-source">{report.source}</p>}
      {report.note && <details><summary>{t("说明")}</summary><p className="report-note">{report.note}</p></details>}
    </div>
  </>;
  // One persistent DOM tree preserves selection and scroll when expanding.
  return <section ref={container} style={{ minHeight: expanded ? inlineHeight : undefined }} className={`inline-report${expanded ? " report-expanded" : ""}${compact && !expanded ? " report-compact" : ""}`} aria-label={title}>
    <dialog ref={dialog} aria-label={title} className="report-panel" onCancel={event => { event.preventDefault(); close(); }}>{contents}</dialog>
  </section>;
}

function ReportTable({ columns, rows }: { columns: string[]; rows: ReportRow[] }) {
  const port = useRef<HTMLDivElement>(null), table = useRef<HTMLTableElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const viewport = port.current!, content = table.current!;
    const measure = () => setWide(content.scrollWidth > viewport.clientWidth + 1);
    measure(); const observer = new ResizeObserver(measure);
    observer.observe(viewport); observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return <>
    {wide && <p className="report-table-hint"><ArrowLeftRight size={14} aria-hidden="true"/>{t("左右滑动查看")}</p>}
    <div ref={port} className="report-table" tabIndex={0} role="region" aria-label={t("报告明细")} onKeyDown={event => {
      if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !wide) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault(); event.stopPropagation();
      event.currentTarget.scrollLeft += event.key === "ArrowRight" ? 80 : -80;
    }}><table ref={table}><thead><tr>{columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell}>{display(value)}</td>)}</tr>)}</tbody></table></div>
  </>;
}

function ReportChart({ rows, report, selected, select, hidden, changeHidden, compact }: {
  rows: ReportRow[]; report: ReportData; selected?: number; select: (index: number) => void;
  hidden: number[]; changeHidden: (columns: number[]) => void; compact?: boolean;
}) {
  const chart = report.chart!;
  const container = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(600);
  const [hover, setHover] = useState<{ rows: ReportRow[]; index: number }>();
  // Both hover and durable selection belong to the dataset being inspected.
  const hovered = hover?.rows === rows ? hover.index : undefined;
  const setHovered = (index?: number) => setHover(previous => index === undefined ? undefined
    : previous?.rows === rows && previous.index === index ? previous : { rows, index });
  useLayoutEffect(() => {
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (width) setCanvasWidth(Math.max(160, Math.min(850, Math.floor(width))));
    });
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const visible = chart.values.filter(column => !hidden.includes(column));
  const values = rows.flatMap(row => visible.map(column => row[column]).filter((value): value is number => typeof value === "number"));
  const domain = reportChartDomain(values, chart.kind);
  const top = 12, bottom = compact ? 118 : canvasWidth < 420 ? 150 : 200;
  const left = Math.max(54, Math.max(0, ...domain.labels.map(label => label.length)) * 7 + 12), width = Math.max(1, canvasWidth - left - 12);
  const y = (value: number) => bottom - domain.position(value) * (bottom - top);
  const step = width / Math.max(1, rows.length), x = (index: number) => left + step * (index + .5);
  const color = (column: number) => `var(--chart-series-${chart.values.indexOf(column) + 1})`;
  const current = hovered !== undefined && rows[hovered] ? hovered : selected !== undefined && rows[selected] ? selected : 0;
  const labelText = (row: ReportRow) => [...String(row[chart.category] ?? "—")].slice(0, 10).join("");
  const labelWidth = Math.max(...rows.map(row => [...labelText(row)].reduce((sum, char) => sum + (/^[\d\s\-./:]$/.test(char) ? 8 : 12), 0)));
  // Edge labels point inward instead of hanging out of the chart. Their full
  // width plus half the next label must fit between ticks, including CJK text.
  const count = Math.min(rows.length, Math.max(1, Math.floor(width / Math.max(90, labelWidth * 1.5 + 12)) + 1));
  const labels = new Set(Array.from({ length: count }, (_, index) => count === 1 ? 0 : Math.round(index * (rows.length - 1) / (count - 1))));
  const pointAt = (event: { currentTarget: SVGSVGElement; clientX: number; clientY: number }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return undefined;
    const localX = (event.clientX - rect.left) / rect.width * canvasWidth;
    const localY = (event.clientY - rect.top) / rect.height * (bottom + 36);
    if (localX < left || localX > left + width || localY < top || localY > bottom) return undefined;
    return Math.max(0, Math.min(rows.length - 1, Math.floor((localX - left) / step)));
  };
  const touch = useRef<{ id: number; x: number; y: number; moved: boolean; index?: number; rows: ReportRow[] } | undefined>(undefined);
  const touchClick = useRef(false);
  return <div ref={container} className="report-chart">
    <div className="report-legend" onFocusCapture={() => setHovered(undefined)} role="group" aria-label={t("显示的数据系列")}>
      {chart.values.map(column => <button key={column} type="button" aria-pressed={!hidden.includes(column)} onClick={() => changeHidden(hidden.includes(column) ? hidden.filter(value => value !== column) : [...hidden, column])}>
        <i className="report-series-toggle" aria-hidden="true"><Check size={9}/></i><SeriesSwatch index={chart.values.indexOf(column)} kind={chart.kind} color={color(column)}/><span>{report.columns[column]}</span>
      </button>)}
      {chart.unit && <small className="report-unit">{chart.unit}</small>}
    </div>
    {chart.kind === "line" && visible.length > 0 && !domain.empty && <p className="report-scale-note">{t("纵轴按可见数据缩放")}</p>}
    {!visible.length ? <div className="report-chart-empty" role="status"><p>{t("所有数据系列已隐藏")}</p><button type="button" onClick={() => changeHidden([])}>{t("显示全部系列")}</button></div> : <>
      {domain.empty ? <div className="report-chart-empty" role="status"><p>{t("暂无可绘制的数值")}</p></div> : <svg viewBox={`0 0 ${canvasWidth} ${bottom + 36}`} role="img" aria-label={t("图表；下方可选择记录查看数值")}
        onPointerDown={event => {
          touchClick.current = event.pointerType !== "mouse";
          if (touchClick.current) touch.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, index: pointAt(event), rows };
        }}
        onPointerMove={event => {
          if (event.pointerType === "mouse") setHovered(pointAt(event));
          else if (touch.current?.id === event.pointerId && Math.hypot(event.clientX - touch.current.x, event.clientY - touch.current.y) > 8) touch.current.moved = true;
        }}
        onPointerUp={event => {
          const start = touch.current; touch.current = undefined;
          if (!start || start.rows !== rows || start.id !== event.pointerId || start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
          if (start.index !== undefined) select(start.index);
        }}
        onPointerCancel={() => { touch.current = undefined; }} onPointerLeave={() => setHovered(undefined)}
        onClick={event => {
          // A mobile compatibility click can arrive after entry motion ends and
          // rounds coordinates. Keep the record hit on pointerdown instead.
          if (touchClick.current) { touchClick.current = false; return; }
          const index = pointAt(event); if (index !== undefined) select(index);
        }}>
        {domain.ticks.map((value, index) => <g key={value}><line x1={left} x2={left + width} y1={y(value)} y2={y(value)} stroke="var(--border)" strokeWidth={value === 0 ? 1.5 : 1}/><text className="report-y-label" data-value={value} x={left - 8} y={y(value) + 4} textAnchor="end">{domain.labels[index]}</text></g>)}
        {chart.kind === "line" && <line className="report-cursor" x1={x(current)} x2={x(current)} y1={top} y2={bottom} stroke="var(--muted)" strokeDasharray="3 4" opacity=".5"/>}
        {chart.kind === "line" ? visible.map(column => <g key={column} data-series={column} fill="none" stroke={color(column)} strokeWidth="2" strokeDasharray={seriesDashes[chart.values.indexOf(column)]}>
          {/* One path preserves dash cadence across dense samples; M starts a new span after a missing value. */}
          <path strokeLinejoin="round" d={rows.map((row, index) => typeof row[column] === "number"
            ? `${index > 0 && typeof rows[index - 1][column] === "number" ? "L" : "M"}${x(index)} ${y(row[column] as number)}` : "").join(" ")}/>
          {rows.map((row, index) => typeof row[column] === "number" && (rows.length <= 12 || index === current || typeof rows[index - 1]?.[column] !== "number" && typeof rows[index + 1]?.[column] !== "number") ? <circle key={index} cx={x(index)} cy={y(row[column] as number)} r={current === index ? 4 : 2.5} fill={color(column)} strokeDasharray="none"/> : null)}
        </g>) : visible.map((column, series) => <g key={column} data-series={column}>{rows.map((row, index) => typeof row[column] === "number" ? <rect key={index} x={left + index * step + step * .12 + series * step * .76 / visible.length} y={Math.min(y(0), y(row[column] as number))} width={Math.max(.5, step * .76 / visible.length - 2)} height={Math.max(0, Math.abs(y(row[column] as number) - y(0)))} fill={color(column)}/> : null)}</g>)}
        {/* A separate group frame stays visible even when a bar matches --text. */}
        {chart.kind === "bar" && <rect className="report-bar-selection" x={left + current * step} y={top} width={step} height={bottom - top} fill="none" stroke="var(--text)" strokeWidth="1" strokeDasharray="3 3" pointerEvents="none"/>}
        {rows.map((row, index) => labels.has(index) ? <text className="report-x-label" key={index} x={x(index)} y={bottom + 24} textAnchor={index === 0 ? "start" : index === rows.length - 1 ? "end" : "middle"}>{labelText(row)}</text> : null)}
      </svg>}
      <div className="report-inspector">
        <div className="report-record-picker" onFocusCapture={() => setHovered(undefined)}>
          <button type="button" aria-label={t("上一条记录")} disabled={current === 0} onClick={() => select(current - 1)}><ChevronLeft size={16}/></button>
          <select aria-label={t("选择记录查看数值")} value={current} onChange={event => select(Number(event.target.value))}>{rows.map((row, index) => <option key={index} value={index}>{display(row[chart.category])}</option>)}</select>
          <button type="button" aria-label={t("下一条记录")} disabled={current === rows.length - 1} onClick={() => select(current + 1)}><ChevronRight size={16}/></button>
          <small>{current + 1} / {rows.length}</small>
        </div>
        <dl className="report-selection" aria-live={hovered === undefined ? "polite" : "off"}>
          <div className="report-selection-category"><dt>{report.columns[chart.category]}</dt><dd>{display(rows[current]?.[chart.category])}</dd></div>
          {visible.map(column => <div key={column}><dt><SeriesSwatch index={chart.values.indexOf(column)} kind={chart.kind} color={color(column)}/>{report.columns[column]}</dt><dd>{display(rows[current]?.[column])}</dd></div>)}
        </dl>
      </div>
    </>}
  </div>;
}
