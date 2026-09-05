/**
 * FairLane Allocation Engine
 * -------------------------------------------------------------
 * Problem: when N AI buyer agents hit a merchant simultaneously for
 * scarce stock, naive "first request wins" checkout infra either
 * oversells (race condition) or rewards raw request speed instead
 * of who *should* win. This engine fixes both.
 *
 * How it works:
 *  1. Incoming bids for a given SKU are collected into a short
 *     BATCH WINDOW (not processed one-at-a-time). This removes the
 *     "who was 10ms faster" problem entirely - it's not a race.
 *  2. When the window closes, all bids in the batch are scored with
 *     a transparent, explainable formula (no black-box model).
 *  3. Stock is allocated to the top-N scoring bids, ATOMICALLY -
 *     stock is decremented once, inside a single synchronous pass,
 *     so overselling is structurally impossible even though bids
 *     arrived concurrently.
 *  4. Every bid (winner or not) gets a structured, human-readable
 *     explanation of the outcome.
 *  5. Winning bids attempt payment. If a payment fails, that unit
 *     of stock is immediately reallocated to the next-highest
 *     scoring bid that didn't originally win - live, without
 *     reopening the whole auction.
 *  6. Every step (bid received, batch closed, scored, allocated,
 *     payment attempted, reallocation) is written to an in-memory
 *     audit trail with a timestamp and machine+human readable reason.
 */

const { v4: uuidv4 } = require('uuid');
const { explainOutcome } = require('./llm');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- Tunable, documented scoring weights (this is what "explainable" means) ----
const WEIGHTS = {
  bid: 0.55,      // how much of the score is driven by willingness to pay
  urgency: 0.25,  // self-declared urgency (0-1), capped - can't be gamed to dominate
  loyalty: 0.20,  // merchant-known loyalty tier (0-1) - rewards repeat customers
};

const BATCH_WINDOW_MS = 2500; // how long we wait to collect concurrent bids before scoring

class AllocationEngine {
  constructor(catalog, { onAudit, onBroadcast, paymentAdapter }) {
    this.catalog = catalog; // { itemId: { name, price, stock } }
    this.onAudit = onAudit || (() => {});
    this.onBroadcast = onBroadcast || (() => {});
    this.paymentAdapter = paymentAdapter; // async (bid) => { success, reason }
    this.pendingBatches = {}; // itemId -> { bids: [], timer }
    this.auditTrail = [];
  }

  log(entry) {
    const record = { id: uuidv4(), ts: new Date().toISOString(), ...entry };
    this.auditTrail.push(record);
    this.onAudit(record);
    return record;
  }

  getItem(itemId) {
    return this.catalog[itemId];
  }

  /**
   * Called when an agent submits a bid for an item.
   * Bids are NOT processed immediately - they're queued into the
   * current batch window for that item. This is the mechanism that
   * makes this fair-under-concurrency rather than fastest-wins.
   */
  submitBid(bid) {
    const item = this.getItem(bid.itemId);
    if (!item) {
      return { accepted: false, reason: 'Unknown item' };
    }

    const enriched = {
      bidId: uuidv4(),
      agentId: bid.agentId,
      itemId: bid.itemId,
      bidAmount: Number(bid.bidAmount),
      urgency: clamp01(bid.urgency),
      loyalty: clamp01(bid.loyalty),
      reasoning: bid.reasoning || null,
      llmUsed: !!bid.llmUsed,
      receivedAt: Date.now(),
    };

    this.log({
      type: 'BID_RECEIVED',
      itemId: bid.itemId,
      agentId: bid.agentId,
      detail: `Agent ${bid.agentId} bid ₹${enriched.bidAmount} (urgency ${enriched.urgency.toFixed(2)}, loyalty ${enriched.loyalty.toFixed(2)})${enriched.reasoning ? ` — stated reason: "${enriched.reasoning}"` : ''}${enriched.llmUsed ? ' [LLM-decided]' : ' [rule-based]'}`,
    });
    this.onBroadcast({ type: 'BID_RECEIVED', bid: enriched });

    if (!this.pendingBatches[bid.itemId]) {
      this.pendingBatches[bid.itemId] = { bids: [], timer: null };
      this.log({
        type: 'BATCH_OPENED',
        itemId: bid.itemId,
        detail: `Batch window opened for ${item.name} (${BATCH_WINDOW_MS}ms) - collecting concurrent bids before deciding, so speed never decides the winner.`,
      });
      this.onBroadcast({ type: 'BATCH_OPENED', itemId: bid.itemId, windowMs: BATCH_WINDOW_MS });

      this.pendingBatches[bid.itemId].timer = setTimeout(
        () => this.closeBatch(bid.itemId),
        BATCH_WINDOW_MS
      );
    }

    this.pendingBatches[bid.itemId].bids.push(enriched);
    return { accepted: true, bidId: enriched.bidId };
  }

  /** Force-close a batch early (used by the "run allocation now" demo control). */
  forceCloseBatch(itemId) {
    const batch = this.pendingBatches[itemId];
    if (!batch) return { closed: false, reason: 'No open batch for this item' };
    clearTimeout(batch.timer);
    this.closeBatch(itemId);
    return { closed: true };
  }

  scoreBid(bid) {
    const item = this.getItem(bid.itemId);
    // normalize bid amount against the item's list price so scores are 0-1-ish
    const normalizedBid = Math.min(bid.bidAmount / (item.price * 1.5), 1);
    const score =
      WEIGHTS.bid * normalizedBid +
      WEIGHTS.urgency * bid.urgency +
      WEIGHTS.loyalty * bid.loyalty;
    return {
      score,
      breakdown: {
        normalizedBid: round(normalizedBid),
        bidComponent: round(WEIGHTS.bid * normalizedBid),
        urgencyComponent: round(WEIGHTS.urgency * bid.urgency),
        loyaltyComponent: round(WEIGHTS.loyalty * bid.loyalty),
      },
    };
  }

  async closeBatch(itemId) {
    const batch = this.pendingBatches[itemId];
    if (!batch) return;
    delete this.pendingBatches[itemId];

    const item = this.getItem(itemId);
    const bids = batch.bids;

    this.log({
      type: 'BATCH_CLOSED',
      itemId,
      detail: `Batch closed for ${item.name}: ${bids.length} bid(s) received, ${item.stock} unit(s) in stock.`,
    });
    this.onBroadcast({ type: 'BATCH_CLOSED', itemId, bidCount: bids.length, stock: item.stock });

    if (bids.length === 0) return;

    // ---- SCORE: transparent, explainable, no black box ----
    const scored = bids.map((b) => ({ ...b, ...this.scoreBid(b) }));
    scored.sort((a, b) => b.score - a.score);

    this.log({
      type: 'SCORED',
      itemId,
      detail: `Scoreboard computed. Formula: score = ${WEIGHTS.bid}×bid + ${WEIGHTS.urgency}×urgency + ${WEIGHTS.loyalty}×loyalty.`,
      scoreboard: scored.map((s) => ({
        agentId: s.agentId,
        bidAmount: s.bidAmount,
        score: round(s.score),
        breakdown: s.breakdown,
      })),
    });
    this.onBroadcast({
      type: 'SCOREBOARD',
      itemId,
      scoreboard: scored.map((s) => ({
        agentId: s.agentId,
        bidAmount: s.bidAmount,
        urgency: s.urgency,
        loyalty: s.loyalty,
        score: round(s.score),
        breakdown: s.breakdown,
      })),
    });

    // ---- ATOMIC ALLOCATION: this whole block is synchronous JS,
    // so there is no interleaving point where two bids could both
    // "see" the same free unit. This is what makes overselling
    // structurally impossible even though bids arrived concurrently. ----
    const availableStock = item.stock;
    const winners = scored.slice(0, availableStock);
    const losers = scored.slice(availableStock);
    item.stock -= winners.length; // decremented once, atomically, before any async work

    this.log({
      type: 'ALLOCATED',
      itemId,
      detail: `${winners.length} unit(s) allocated. Remaining stock: ${item.stock}.`,
      winners: winners.map((w) => w.agentId),
    });
    this.onBroadcast({
      type: 'ALLOCATED',
      itemId,
      winners: winners.map((w) => ({ agentId: w.agentId, score: round(w.score) })),
      remainingStock: item.stock,
    });

    const cutoffScore = winners[winners.length - 1]?.score ?? 1;

    for (const loser of losers) {
      await sleep(200); // small pacing gap - keeps this batch's explanation calls from bursting against the same per-minute token budget as the bid decisions that just fired
      const explanation = await explainOutcome({
        agentId: loser.agentId,
        won: false,
        myBid: loser.bidAmount,
        myScore: loser.score,
        breakdown: loser.breakdown,
        cutoffScore,
        itemName: item.name,
      });
      this.log({
        type: 'LOSS_EXPLAINED',
        itemId,
        agentId: loser.agentId,
        detail: `${explanation.text}${explanation.llmUsed ? ' [LLM-generated]' : ' [rule-based]'}`,
      });
      this.onBroadcast({
        type: 'LOSS_EXPLAINED',
        itemId,
        agentId: loser.agentId,
        reason: explanation.text,
        llmUsed: explanation.llmUsed,
        yourScore: round(loser.score),
      });
    }

    for (const winner of winners) {
      await sleep(200);
      const explanation = await explainOutcome({
        agentId: winner.agentId,
        won: true,
        myBid: winner.bidAmount,
        myScore: winner.score,
        breakdown: winner.breakdown,
        cutoffScore,
        itemName: item.name,
      });
      this.log({
        type: 'WIN_EXPLAINED',
        itemId,
        agentId: winner.agentId,
        detail: `${explanation.text}${explanation.llmUsed ? ' [LLM-generated]' : ' [rule-based]'}`,
      });
      this.onBroadcast({
        type: 'WIN_EXPLAINED',
        itemId,
        agentId: winner.agentId,
        reason: explanation.text,
        llmUsed: explanation.llmUsed,
      });
    }

    // ---- Attempt payment for winners, in score order; reallocate live on failure ----
    let waitlist = losers.slice(); // next-in-line if a winner's payment fails
    for (const winner of winners) {
      await this.attemptPaymentWithReallocation(itemId, winner, waitlist);
    }
  }

  async attemptPaymentWithReallocation(itemId, winner, waitlist) {
    const item = this.getItem(itemId);
    this.log({
      type: 'PAYMENT_ATTEMPT',
      itemId,
      agentId: winner.agentId,
      detail: `Attempting payment for agent ${winner.agentId}: ₹${winner.bidAmount}.`,
    });
    this.onBroadcast({ type: 'PAYMENT_ATTEMPT', itemId, agentId: winner.agentId, amount: winner.bidAmount });

    const result = await this.paymentAdapter(winner);

    if (result.success) {
      this.log({
        type: 'PAYMENT_SUCCESS',
        itemId,
        agentId: winner.agentId,
        detail: `Payment succeeded for agent ${winner.agentId} (order ${result.orderId}).`,
      });
      this.onBroadcast({ type: 'PAYMENT_SUCCESS', itemId, agentId: winner.agentId, orderId: result.orderId });
      return;
    }

    // ---- FAILURE HANDLING: this is the "one failure handled gracefully" moment ----
    this.log({
      type: 'PAYMENT_FAILED',
      itemId,
      agentId: winner.agentId,
      detail: `Payment failed for agent ${winner.agentId}: ${result.reason}. Unit will be reallocated live, not just marked lost.`,
    });
    this.onBroadcast({ type: 'PAYMENT_FAILED', itemId, agentId: winner.agentId, reason: result.reason });

    if (waitlist.length === 0) {
      item.stock += 1; // return the unit to stock - no buyer available
      this.log({
        type: 'STOCK_RETURNED',
        itemId,
        detail: `No waitlisted agent available. 1 unit returned to stock (now ${item.stock}).`,
      });
      this.onBroadcast({ type: 'STOCK_RETURNED', itemId, stock: item.stock });
      return;
    }

    const next = waitlist.shift();
    this.log({
      type: 'REALLOCATED',
      itemId,
      agentId: next.agentId,
      detail: `Unit reallocated live to next-highest-scoring agent ${next.agentId} (score ${round(next.score)}), without reopening the auction.`,
    });
    this.onBroadcast({ type: 'REALLOCATED', itemId, agentId: next.agentId, score: round(next.score) });

    await this.attemptPaymentWithReallocation(itemId, next, waitlist);
  }
}

function clamp01(n) {
  n = Number(n);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

module.exports = { AllocationEngine, WEIGHTS, BATCH_WINDOW_MS };
