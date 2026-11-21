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

// Chart colours for each STYLE (pro / cyber) and MODE (dark / light).
// Must match style.css (cyber) and theme-pro.css (pro).
const PRO_FONT = "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";
const CYBER_FONT = "'Share Tech Mono', monospace";
export const THEMES = {
  'pro-dark': {
    up: '#089981', down: '#f23645', grid: 'rgba(42, 46, 57, 0.6)', text: '#b2b5be', bg: '#131722',
    border: '#2a2e39', separator: '#2a2e39', font: PRO_FONT,
    volUp: 'rgba(8,153,129,0.45)', volDown: 'rgba(242,54,69,0.45)', level: 'rgba(120,123,134,0.6)',
  },
  'pro-light': {
    up: '#089981', down: '#f23645', grid: 'rgba(42, 46, 57, 0.06)', text: '#131722', bg: '#ffffff',
    border: '#e0e3eb', separator: '#e0e3eb', font: PRO_FONT,
    volUp: 'rgba(8,153,129,0.35)', volDown: 'rgba(242,54,69,0.35)', level: 'rgba(120,123,134,0.6)',
  },
  'cyber-dark': {
    font: CYBER_FONT,
    up: '#05ffa1', down: '#ff2a6d', grid: 'rgba(0, 240, 255, 0.06)', text: '#9ad8e8', bg: '#07060f',
    border: 'rgba(0, 240, 255, 0.25)', separator: 'rgba(255, 42, 109, 0.35)',
    volUp: 'rgba(5,255,161,0.25)', volDown: 'rgba(255,42,109,0.25)', level: 'rgba(255,255,255,0.25)',
  },
  'cyber-light': {
    font: CYBER_FONT,
    up: '#00a86b', down: '#e0245e', grid: 'rgba(20, 18, 37, 0.06)', text: '#3b4660', bg: '#ffffff',
    border: 'rgba(0, 127, 153, 0.3)', separator: 'rgba(209, 0, 75, 0.25)',
    volUp: 'rgba(0,168,107,0.25)', volDown: 'rgba(224,36,94,0.25)', level: 'rgba(20,18,37,0.3)',
  },
};

export class ChartManager {
  /**
   * @param {HTMLElement} container the <div> the chart lives in
   * @param {'pro'|'cyber'} style
   * @param {'dark'|'light'} mode
   */
  constructor(container, style = 'pro', mode = 'dark') {
    this.chart = createChart(container, {
      autoSize: true, // follows the container's size automatically
      layout: { panes: { enableResize: true } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 6 },
      localization: { priceFormatter: (p) => (Math.abs(p) >= 1e6 ? `${(p / 1e6).toFixed(2)}M` : p.toFixed(2)) },
    });

    // Price candles (pane 0) - colours are set in applyTheme()
    this.candles = this.chart.addSeries(CandlestickSeries, {});
    // Volume bars on a hidden price scale squeezed into the bottom 20% of pane 0
    this.volume = this.chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    this.indicatorSeries = new Map(); // indicator uid -> { series: [], levels: [] }
    this.bars = [];
    this.applyTheme(style, mode);
  }

  /** Switch style (pro/cyber) and mode (dark/light) without reloading data. */
  applyTheme(style, mode) {
    const t = THEMES[`${style}-${mode}`] ?? THEMES['pro-dark'];
    this.t = t;
    this.chart.applyOptions({
      layout: { background: { color: t.bg }, textColor: t.text, fontFamily: t.font, panes: { separatorColor: t.separator, separatorHoverColor: t.border } },
      grid: { vertLines: { color: t.grid }, horzLines: { color: t.grid } },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    });
    this.candles.applyOptions({
      upColor: t.up, downColor: t.down, borderUpColor: t.up, borderDownColor: t.down, wickUpColor: t.up, wickDownColor: t.down,
    });
    if (this.bars.length) this.volume.setData(this.bars.map((b) => this.volPoint(b))); // re-colour volume bars
  }

  /** One volume bar, green when the candle closed up, pink when down. */
  volPoint(b) {
    return { time: b.time, value: b.volume, color: b.close >= b.open ? this.t.volUp : this.t.volDown };
  }

  /** Replace all candles (used when ticker/timeframe changes). */
  setBars(bars) {
    this.candles.setData(bars.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    this.bars = bars;
    this.volume.setData(bars.map((b) => this.volPoint(b)));
    this.chart.timeScale().fitContent();
  }

  /** Update (or append) the newest candle - used for live ticks. */
  updateBar(bar) {
    this.candles.update({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    this.volume.update(this.volPoint(bar));
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
        for (const price of item.levels) series[0].createPriceLine({ price, color: this.t.level, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
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
