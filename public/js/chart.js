// =============================================================================
// chart.js  -  draws candles, volume and every indicator using TradingView's
//              open-source "Lightweight Charts" library (v5, supports panes).
// -----------------------------------------------------------------------------
// Main ideas:
//   * pane 0       = price candles + volume + "overlay" indicators (SMA, BB...)
//   * pane 1, 2... = one pane per "separate" indicator (RSI, MACD...)
//   * setIndicatorPlots() rebuilds indicator series when the LIST changes;
//     updateIndicatorPlots() just refreshes data (fast path for live ticks).
// =============================================================================
const LWC = window.LightweightCharts; // loaded by <script> in index.html
const { createChart, CandlestickSeries, HistogramSeries, LineSeries, CrosshairMode, LineStyle } = LWC;

// Cyberpunk colour palette shared with style.css
export const NEON = { up: '#05ffa1', down: '#ff2a6d', grid: 'rgba(0, 240, 255, 0.06)', text: '#9ad8e8', bg: '#07060f' };

export class ChartManager {
  /** @param {HTMLElement} container the <div> the chart lives in */
  constructor(container) {
    this.chart = createChart(container, {
      autoSize: true, // follows the container's size automatically
      layout: {
        background: { color: NEON.bg },
        textColor: NEON.text,
        fontFamily: "'Share Tech Mono', monospace",
        panes: { separatorColor: 'rgba(255, 42, 109, 0.35)', separatorHoverColor: 'rgba(0, 240, 255, 0.25)', enableResize: true },
      },
      grid: { vertLines: { color: NEON.grid }, horzLines: { color: NEON.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: 'rgba(0, 240, 255, 0.25)' },
      timeScale: { borderColor: 'rgba(0, 240, 255, 0.25)', timeVisible: true, secondsVisible: false, rightOffset: 6 },
      localization: { priceFormatter: (p) => (Math.abs(p) >= 1e6 ? `${(p / 1e6).toFixed(2)}M` : p.toFixed(2)) },
    });

    // Price candles (pane 0)
    this.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: NEON.up, downColor: NEON.down, borderUpColor: NEON.up, borderDownColor: NEON.down,
      wickUpColor: NEON.up, wickDownColor: NEON.down,
    });
    // Volume bars on a hidden price scale squeezed into the bottom 20% of pane 0
    this.volume = this.chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    this.indicatorSeries = new Map(); // indicator uid -> { series: [], levels: [] }
  }

  /** Replace all candles (used when ticker/timeframe changes). */
  setBars(bars) {
    this.candles.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    this.volume.setData(bars.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? 'rgba(5,255,161,0.25)' : 'rgba(255,42,109,0.25)' })));
    this.chart.timeScale().fitContent();
  }

  /** Update (or append) the newest candle - used for live ticks. */
  updateBar(bar) {
    this.candles.update({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    this.volume.update({ time: bar.time, value: bar.volume, color: bar.close >= bar.open ? 'rgba(5,255,161,0.25)' : 'rgba(255,42,109,0.25)' });
  }

  /** Convert our [values] array into chart points, skipping nulls. */
  static toPoints(bars, values) {
    const pts = [];
    for (let i = 0; i < bars.length; i++) {
      const v = values[i];
      if (v !== null && v !== undefined && Number.isFinite(v)) pts.push({ time: bars[i].time, value: v });
    }
    return pts;
  }

  /**
   * Full rebuild of indicator series.
   * @param {Array<{uid, pane, plots, levels}>} items  computed indicators in display order
   * @param {Array} bars
   */
  setIndicatorPlots(items, bars) {
    // 1. remove every existing indicator series (empty panes disappear on their own)
    for (const { series } of this.indicatorSeries.values()) for (const s of series) this.chart.removeSeries(s);
    this.indicatorSeries.clear();

    // 2. add series again. "separate" indicators each get the next pane index.
    let nextPane = 1;
    for (const item of items) {
      const paneIndex = item.pane === 'separate' ? nextPane++ : 0;
      const series = item.plots.map((plot) => {
        const common = { color: plot.color || '#00f0ff', priceLineVisible: false, lastValueVisible: true, title: plot.name };
        const s = plot.style === 'histogram'
          ? this.chart.addSeries(HistogramSeries, { ...common, base: 0 }, paneIndex)
          : this.chart.addSeries(LineSeries, { ...common, lineWidth: 2, crosshairMarkerVisible: false }, paneIndex);
        s.setData(ChartManager.toPoints(bars, plot.values));
        return s;
      });
      // Dashed horizontal guide lines (e.g. RSI 30/70) on the first series
      if (series[0] && item.levels) {
        for (const price of item.levels) series[0].createPriceLine({ price, color: 'rgba(255,255,255,0.25)', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
      }
      this.indicatorSeries.set(item.uid, { series, plots: item.plots });
    }

    // 3. give the price pane most of the height
    const panes = this.chart.panes();
    panes[0]?.setStretchFactor(Math.max(2, panes.length));
    for (let i = 1; i < panes.length; i++) panes[i].setStretchFactor(1);
  }

  /** Fast path: same indicator list, only the numbers changed (live tick). */
  updateIndicatorPlots(items, bars) {
    for (const item of items) {
      const entry = this.indicatorSeries.get(item.uid);
      if (!entry || entry.series.length !== item.plots.length) return false; // shape changed -> caller rebuilds
      item.plots.forEach((plot, i) => {
        // Only the last 2 points can change on a tick - update() is much cheaper than setData().
        for (let k = Math.max(0, bars.length - 2); k < bars.length; k++) {
          const v = plot.values[k];
          // historicalUpdate=true lets us also correct the previous point
          if (v !== null && Number.isFinite(v)) entry.series[i].update({ time: bars[k].time, value: v }, k < bars.length - 1);
        }
      });
    }
    return true;
  }
}
