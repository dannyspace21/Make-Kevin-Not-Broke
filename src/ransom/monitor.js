// =============================================================================
// ransom/monitor.js  -  the RANSOMWARE vs. SEC 8-K WATCHDOG.
// -----------------------------------------------------------------------------
// Every RANSOM_POLL_MINUTES this runs one "cycle":
//
//  1. CLAIMS   - download recent victims from leak-site trackers
//                (Ransomware.live + optional Ransom-DB / WatchGuard feeds)
//  2. MATCH    - keep only victims that match a U.S.-listed company (SEC list)
//  3. VERIFY   - cross-check names against HIBP / Comparitech / Darkweb IQ
//  4. FILINGS  - ask SEC EDGAR whether an 8-K cyber disclosure was filed
//  5. EVALUATE - compute business days elapsed + status (see evaluate.js)
//  6. ALERT    - when a case changes into an alert-worthy status, push it to
//                every open browser (WebSocket) and an optional webhook
//
// It is an EventEmitter:  monitor.on('alert', fn)  /  monitor.on('update', fn)
// =============================================================================
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../util/logger.js';
import { JsonStore } from '../util/store.js';
import { fetchJson } from '../util/http.js';
import { ymd } from '../util/businessDays.js';
import { normalizeName, domainRoot } from './normalize.js';
import { loadTickerIndex, matchCompany, findCyberFilings } from './sec.js';
import { evaluateCase, ALERT_STATUSES } from './evaluate.js';
import { fetchRansomwareLive } from './sources/ransomwareLive.js';
import { fetchGenericFeed } from './sources/genericFeed.js';
import { fetchHibpBreaches } from './sources/hibp.js';
import { demoCases } from './sources/demo.js';

const DAY = 86400000;
const MAX_ALERTS = 300;

/** Turn any date-ish value into "YYYY-MM-DD" or null. */
function toDay(value) {
  const t = Date.parse(value);
  return Number.isFinite(t) ? ymd(t) : null;
}

class RansomMonitor extends EventEmitter {
  constructor() {
    super();
    this.store = new JsonStore(config.demoMode ? 'ransom-monitor-demo.json' : 'ransom-monitor.json', { cases: {}, alerts: [], lastRun: null, sourceStatus: {} });
    this.running = false;
    this.timer = null;
    this.verifyCache = { at: 0, entries: [] }; // verification lists, refreshed every 12h
  }

  /** Load saved state and start the polling loop. */
  async start() {
    await this.store.load();
    if (!config.ransom.enabled) { log.info('ransom', 'monitor disabled (RANSOM_MONITOR_ENABLED=false)'); return; }
    // First run shortly after boot, then on the configured interval.
    setTimeout(() => this.runCycle(), 3000).unref();
    this.timer = setInterval(() => this.runCycle(), config.ransom.pollMinutes * 60000);
    this.timer.unref();
  }

  /** Public snapshot for the UI (sorted: most urgent first). */
  snapshot() {
    const order = ['OVERDUE', 'DEADLINE_SOON', 'CLOCK_RUNNING', 'POSSIBLE_DISCLOSURE', 'DISCLOSED_LATE', 'DISCLOSED_ON_TIME'];
    const cases = Object.values(this.store.data.cases)
      .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.claimDate.localeCompare(a.claimDate));
    return {
      mode: config.demoMode ? 'demo' : 'live',
      lastRun: this.store.data.lastRun,
      sourceStatus: this.store.data.sourceStatus,
      cases,
      alerts: this.store.data.alerts.slice(0, 100),
    };
  }

  /** One full monitoring cycle. Guarded so two cycles never overlap. */
  async runCycle() {
    if (this.running) return;
    this.running = true;
    try {
      const work = config.demoMode ? await this.collectDemo() : await this.collectLive();
      const today = ymd(Date.now());
      for (const w of work) this.upsertCase(w, today);
      this.prune(today);
      this.store.data.lastRun = new Date().toISOString();
      await this.store.save();
      this.emit('update', this.snapshot());
    } catch (err) {
      log.error('ransom', `cycle failed: ${err.message}`);
    } finally {
      this.running = false;
    }
  }

  /** DEMO: fictional cases, no network. */
  async collectDemo() {
    this.store.data.sourceStatus = { 'DEMO feed': 'ok (fictional data)' };
    return demoCases();
  }

  /** LIVE: claims -> SEC match -> verification -> filings. */
  async collectLive() {
    const status = {};
    const r = config.ransom;

    // ---- 1. CLAIMS (each source is optional; one failing doesn't stop others)
    const claimSources = [
      ['Ransomware.live', () => fetchRansomwareLive()],
      ['Ransom-DB', () => fetchGenericFeed({ label: 'Ransom-DB', url: r.ransomDbUrl, apiKey: r.ransomDbKey })],
      ['WatchGuard', () => fetchGenericFeed({ label: 'WatchGuard', url: r.watchguardUrl })],
    ];
    const claims = [];
    for (const [label, fn] of claimSources) {
      if (label !== 'Ransomware.live' && !(label === 'Ransom-DB' ? r.ransomDbUrl : r.watchguardUrl)) {
        status[label] = 'not configured'; continue;
      }
      try {
        const rows = await fn();
        claims.push(...rows);
        status[label] = `ok (${rows.length})`;
      } catch (err) {
        status[label] = `error: ${err.message}`;
        log.warn('ransom', `${label}: ${err.message}`);
      }
    }

    // ---- 2. MATCH to SEC-listed companies
    let index;
    try {
      index = await loadTickerIndex();
      status['SEC EDGAR'] = 'ok';
    } catch (err) {
      status['SEC EDGAR'] = `error: ${err.message}`;
      this.store.data.sourceStatus = status;
      throw err; // without SEC data we can't evaluate anything
    }
    const cutoff = ymd(Date.now() - r.lookbackDays * DAY);
    const merged = new Map(); // cik -> earliest claim
    for (const c of claims) {
      const day = toDay(c.discovered);
      if (!day || day < cutoff) continue;
      const match = matchCompany(index, c);
      if (!match) continue;
      const prev = merged.get(match.cik);
      if (!prev || day < prev.claim.discovered) {
        merged.set(match.cik, { claim: { ...c, discovered: day }, match, sources: new Set([...(prev?.sources ?? []), c.source]) });
      } else {
        prev.sources.add(c.source);
      }
    }

    // ---- 3. VERIFY
    const verifyList = await this.loadVerification(status);

    // ---- 4. FILINGS for every matched (new or still-open) case
    const work = [];
    for (const { claim, match, sources } of merged.values()) {
      const existing = this.store.data.cases[String(match.cik)];
      if (existing && existing.status.startsWith('DISCLOSED') && Date.now() - Date.parse(existing.updatedAt) < DAY) {
        continue; // already finished and fresh - skip extra SEC calls
      }
      try {
        const since = ymd(Date.parse(claim.discovered) - 30 * DAY); // disclosed BEFORE the leak also counts
        const { domesticFiler, filings } = await findCyberFilings(match.cik, since);
        if (!domesticFiler) continue; // foreign filers use 6-K, the 8-K rule doesn't apply
        work.push({ claim: { ...claim, source: [...sources].join(', ') }, match, filings, verifiedBy: this.verify(verifyList, claim) });
      } catch (err) {
        log.warn('ransom', `SEC lookup failed for ${match.ticker}: ${err.message}`);
      }
    }
    status.matched = `${work.length} U.S.-listed of ${claims.length} claims`;
    this.store.data.sourceStatus = status;
    return work;
  }

  /** Download verification lists (HIBP + optional feeds), cached 12 hours. */
  async loadVerification(status) {
    if (Date.now() - this.verifyCache.at < 12 * 3600000) return this.verifyCache.entries;
    const r = config.ransom;
    const entries = [];
    const tasks = [
      ['Have I Been Pwned', r.hibpEnabled, () => fetchHibpBreaches()],
      ['Comparitech', Boolean(r.comparitechUrl), () => fetchGenericFeed({ label: 'Comparitech', url: r.comparitechUrl })],
      ['Darkweb IQ', Boolean(r.darkwebIqUrl), () => fetchGenericFeed({ label: 'Darkweb IQ', url: r.darkwebIqUrl, apiKey: r.darkwebIqKey })],
    ];
    for (const [label, enabled, fn] of tasks) {
      if (!enabled) { status[label] = 'not configured'; continue; }
      try {
        const rows = await fn();
        for (const row of rows) entries.push({ key: normalizeName(row.name), root: domainRoot(row.domain), source: label });
        status[label] = `ok (${rows.length})`;
      } catch (err) {
        status[label] = `error: ${err.message}`;
      }
    }
    this.verifyCache = { at: Date.now(), entries };
    return entries;
  }

  /** Which verification sources also mention this victim? */
  verify(list, claim) {
    const key = normalizeName(claim.name);
    const root = domainRoot(claim.domain);
    const hits = new Set();
    for (const e of list) {
      if ((key && e.key === key) || (root.length >= 4 && e.root === root)) hits.add(e.source);
    }
    return [...hits];
  }

  /** Insert/update one case and raise an alert if its status changed. */
  upsertCase({ claim, match, filings, verifiedBy }, today) {
    const id = String(match.cik || match.ticker);
    const prev = this.store.data.cases[id];
    const claimDate = prev && prev.claimDate < claim.discovered ? prev.claimDate : claim.discovered;
    const result = evaluateCase({ claimDate, today, filings });
    const next = {
      id,
      company: match.title,
      victimName: claim.name,
      ticker: match.ticker,
      cik: match.cik,
      matchType: match.matchType,
      group: claim.group,
      sources: claim.source,
      claimDate,
      verifiedBy,
      ...result,
      firstSeen: prev?.firstSeen ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.store.data.cases[id] = next;

    // New case -> informational alert. Status change into an alert status -> alert.
    if (!prev) {
      this.raise(next, 'NEW_CASE');
      if (ALERT_STATUSES.has(next.status)) this.raise(next, next.status);
    } else if (prev.status !== next.status && ALERT_STATUSES.has(next.status)) {
      this.raise(next, next.status);
    }
  }

  /** Create an alert, push it to listeners and the optional webhook. */
  raise(c, kind) {
    const alert = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      kind,
      ticker: c.ticker,
      company: c.company,
      status: c.status,
      businessDaysElapsed: c.businessDaysElapsed,
      deadline: c.deadline,
      disclosedInTime: c.disclosedInTime,
      message: `${c.ticker} - ${c.company}: ${kind.replace(/_/g, ' ')} (day ${c.businessDaysElapsed} of 4, deadline ${c.deadline}). ${c.signal}`,
    };
    this.store.data.alerts.unshift(alert);
    this.store.data.alerts.length = Math.min(this.store.data.alerts.length, MAX_ALERTS);
    this.emit('alert', alert);
    this.sendWebhook(alert);
  }

  /** Discord ("content") and Slack ("text") compatible webhook. Fire-and-forget. */
  sendWebhook(alert) {
    const url = config.ransom.alertWebhookUrl;
    if (!url || alert.kind === 'NEW_CASE') return;
    const text = `🚨 Make Kevin Not Broke - ${alert.message}`;
    fetchJson(url, {
      method: 'POST', timeoutMs: 10000,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text, text }),
    }).catch((err) => {
      // Many webhooks reply 204/empty body -> "invalid JSON" is still a success.
      if (!/invalid JSON/.test(err.message)) log.warn('ransom', `webhook failed: ${err.message}`);
    });
  }

  /** Forget cases older than lookback + 90 days so the file doesn't grow forever. */
  prune(today) {
    const limit = ymd(Date.parse(today) - (config.ransom.lookbackDays + 90) * DAY);
    for (const [id, c] of Object.entries(this.store.data.cases)) {
      if (c.claimDate < limit) delete this.store.data.cases[id];
    }
  }
}

export const ransomMonitor = new RansomMonitor();
