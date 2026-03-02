/**
 * Polymarket Data Service
 *
 * Pure ES module that fetches prediction market data from the Polymarket
 * Gamma API, normalizes it, and provides polling with change detection.
 * No dependencies — runs in the browser with the native fetch API.
 */

// Proxy through our server to avoid CORS issues
const BASE_URL = '/api';

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polymarket API ${res.status}: ${res.statusText}`);
  return res.json();
}

/**
 * Fetch top markets ordered by 24-hour volume.
 */
export async function fetchTopMarkets(limit = 50) {
  const url = `${BASE_URL}/events?active=true&closed=false&order=volume24hr&ascending=false&limit=${limit}`;
  const events = await fetchJSON(url);
  return events.map(normalizeEvent);
}

/**
 * Fetch markets closest to their resolution date.
 */
export async function fetchNearResolution(limit = 20) {
  const url = `${BASE_URL}/events?active=true&closed=false&order=endDate&ascending=true&limit=${limit}`;
  const events = await fetchJSON(url);
  return events.map(normalizeEvent);
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function normalizeEvent(event) {
  const markets = Array.isArray(event.markets) ? event.markets : [];

  const outcomes = markets.flatMap((m) => {
    const names = safeJSON(m.outcomes) || [];
    const prices = safeJSON(m.outcomePrices) || [];

    // Binary Yes/No sub-market in a multi-market event:
    // use the market's own title as the outcome name with the Yes price
    const isBinary = names.length === 2
      && names[0].toLowerCase() === 'yes'
      && names[1].toLowerCase() === 'no';

    if (isBinary && markets.length > 1) {
      const label = m.groupItemTitle || m.question || m.title || names[0];
      const yesPrice = prices[0] !== undefined ? parseFloat(prices[0]) : null;
      return [{ name: label, price: yesPrice }];
    }

    return names.map((name, i) => ({
      name,
      price: prices[i] !== undefined ? parseFloat(prices[i]) : null,
    }));
  });

  // Aggregate volume across sub-markets
  const totalVolume = markets.reduce((sum, m) => sum + (parseFloat(m.volume) || 0), 0);
  const volume24hr = markets.reduce((sum, m) => sum + (parseFloat(m.volume24hr) || 0), 0);
  const liquidity = markets.reduce((sum, m) => sum + (parseFloat(m.liquidity) || 0), 0);

  // Category from tags
  const tags = Array.isArray(event.tags) ? event.tags : [];
  const category = tags.length > 0
    ? (typeof tags[0] === 'object' ? tags[0].label || tags[0].slug || '' : String(tags[0]))
    : '';

  return {
    id: event.id,
    title: event.title || '',
    slug: event.slug || '',
    category,
    volume24hr,
    totalVolume,
    liquidity,
    outcomes,
    endDate: event.endDate || null,
    startDate: event.startDate || null,
    image: event.image || null,
  };
}

function safeJSON(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Change Detection
// ---------------------------------------------------------------------------

/**
 * Compare two snapshots and return arrays of volume spikes and price swings.
 *
 * Volume spike:  volume24hr increased > 50 % between polls.
 * Price swing:   any outcome price changed by > 10 percentage points.
 */
function detectChanges(previous, current) {
  const prevMap = new Map(previous.map((e) => [e.id, e]));
  const spikes = [];
  const swings = [];

  for (const cur of current) {
    const prev = prevMap.get(cur.id);
    if (!prev) continue;

    // Volume spike detection
    if (prev.volume24hr > 0 && cur.volume24hr > prev.volume24hr * 1.5) {
      spikes.push({
        event: cur,
        previousVolume: prev.volume24hr,
        currentVolume: cur.volume24hr,
        increasePercent: ((cur.volume24hr - prev.volume24hr) / prev.volume24hr) * 100,
      });
    }

    // Price swing detection — match outcomes by name
    const prevOutcomes = new Map(prev.outcomes.map((o) => [o.name, o.price]));
    for (const outcome of cur.outcomes) {
      const prevPrice = prevOutcomes.get(outcome.name);
      if (prevPrice == null || outcome.price == null) continue;
      const delta = Math.abs(outcome.price - prevPrice);
      if (delta > 0.10) {
        swings.push({
          event: cur,
          outcome: outcome.name,
          previousPrice: prevPrice,
          currentPrice: outcome.price,
          delta,
        });
      }
    }
  }

  return { spikes, swings };
}

// ---------------------------------------------------------------------------
// Polling Manager
// ---------------------------------------------------------------------------

/**
 * PolymarketPoller
 *
 * Extends EventTarget so consumers can listen for:
 *   "update"       — fires every successful poll with { topMarkets, nearResolution }
 *   "volumeSpike"  — fires when a market's 24h volume jumps > 50 %
 *   "priceSwing"   — fires when an outcome price shifts > 10 pp
 *   "error"        — fires when a poll fails
 */
export class PolymarketPoller extends EventTarget {
  /**
   * @param {object} [options]
   * @param {number} [options.interval=120000]  Polling interval in ms (default 2 min)
   * @param {number} [options.topLimit=50]      Number of top markets to fetch
   * @param {number} [options.nearLimit=20]     Number of near-resolution markets
   */
  constructor(options = {}) {
    super();
    this.interval = options.interval ?? 120_000;
    this.topLimit = options.topLimit ?? 50;
    this.nearLimit = options.nearLimit ?? 20;

    this._timerId = null;
    this._previousTop = [];
    this._previousNear = [];

    // Latest data accessible synchronously after first poll
    this.topMarkets = [];
    this.nearResolution = [];
  }

  /** Start polling. Performs an initial fetch immediately. */
  start() {
    if (this._timerId !== null) return; // already running
    this._poll(); // first poll right away
    this._timerId = setInterval(() => this._poll(), this.interval);
  }

  /** Stop polling. */
  stop() {
    if (this._timerId !== null) {
      clearInterval(this._timerId);
      this._timerId = null;
    }
  }

  /** Whether the poller is currently running. */
  get running() {
    return this._timerId !== null;
  }

  /** Perform a single poll (public so callers can force a refresh). */
  async poll() {
    return this._poll();
  }

  // ---- internal -----------------------------------------------------------

  async _poll() {
    try {
      const [top, near] = await Promise.all([
        fetchTopMarkets(this.topLimit),
        fetchNearResolution(this.nearLimit),
      ]);

      // Detect changes against previous snapshot
      if (this._previousTop.length > 0) {
        const { spikes, swings } = detectChanges(this._previousTop, top);
        for (const spike of spikes) {
          this.dispatchEvent(new CustomEvent('volumeSpike', { detail: spike }));
        }
        for (const swing of swings) {
          this.dispatchEvent(new CustomEvent('priceSwing', { detail: swing }));
        }
      }

      if (this._previousNear.length > 0) {
        const { spikes, swings } = detectChanges(this._previousNear, near);
        for (const spike of spikes) {
          this.dispatchEvent(new CustomEvent('volumeSpike', { detail: spike }));
        }
        for (const swing of swings) {
          this.dispatchEvent(new CustomEvent('priceSwing', { detail: swing }));
        }
      }

      // Store for next comparison
      this._previousTop = top;
      this._previousNear = near;

      // Expose latest data
      this.topMarkets = top;
      this.nearResolution = near;

      this.dispatchEvent(
        new CustomEvent('update', { detail: { topMarkets: top, nearResolution: near } }),
      );
    } catch (err) {
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience singleton
// ---------------------------------------------------------------------------

let _defaultPoller = null;

/**
 * Returns a shared PolymarketPoller instance (created on first call).
 * Useful when multiple parts of the app want the same data stream.
 */
export function getPoller(options) {
  if (!_defaultPoller) {
    _defaultPoller = new PolymarketPoller(options);
  }
  return _defaultPoller;
}
