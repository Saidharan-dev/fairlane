/**
 * Fires several AI buyer agent PERSONAS at the merchant CONCURRENTLY
 * for the scarce flash-drop item (sku-001, 3 units in stock).
 *
 * Each persona doesn't just submit a hardcoded bid - it calls an LLM
 * (via decideAgentBid in llm.js) to actually DECIDE its bid amount,
 * urgency, and stated reasoning, within its budget ceiling. This is
 * what makes them agents rather than fixed numbers dressed up as agents.
 *
 * If ANTHROPIC_API_KEY is not set, each agent falls back to its own
 * baseline numbers - the run still works end-to-end, but the console
 * output and audit trail will say so explicitly (llmUsed: false).
 *
 * Run the backend first (`npm start`), then in another terminal:
 *   npm run simulate
 */
const fetch = require('node-fetch');
require('dotenv').config();
const { decideAgentBid, hasApiKey, activeProvider } = require('./llm');

const BASE_URL = process.env.BASE_URL || 'http://localhost:4000';
const ITEM_ID = 'sku-001';
const ITEM_CONTEXT = { itemName: 'Limited Edition Sneakers (Flash Drop)', listPrice: 2999, stock: 3 };

// Personas replace the old hardcoded {bidAmount, urgency} pairs. Each
// persona gets a description (what the LLM reasons over), a hard
// budget ceiling (safety clamp - never exceeded regardless of what
// the LLM proposes), a merchant-assigned loyalty score (buyers can't
// self-report this - it comes from the merchant's own records, same
// as in the original design), and a baseline used only as a fallback
// if no API key is configured.
const personas = [
  {
    agentId: 'agent-alex-budget',
    description: 'A price-sensitive buyer who wants the item but is firm on not overpaying list price.',
    maxBudget: 3000,
    loyalty: 0.10,
    baseline: { bidAmount: 2999, urgency: 0.3 },
  },
  {
    agentId: 'agent-priya-vip',
    description: 'A long-time repeat customer of this merchant who genuinely wants this item but shops calmly, not impulsively.',
    maxBudget: 3200,
    loyalty: 0.95,
    baseline: { bidAmount: 3050, urgency: 0.6 },
  },
  {
    agentId: 'agent-sam-reseller',
    description: 'A reseller agent trying to acquire limited-edition stock to resell at a markup, willing to pay a premium and needs it fast.',
    maxBudget: 3600,
    loyalty: 0.05,
    baseline: { bidAmount: 3400, urgency: 0.9 },
  },
  {
    agentId: 'agent-riya-loyal',
    description: 'A loyal repeat customer with moderate urgency who has bought from this merchant many times before.',
    maxBudget: 3100,
    loyalty: 0.80,
    baseline: { bidAmount: 3000, urgency: 0.5 },
  },
  {
    agentId: 'agent-kabir-lowball',
    description: 'A casual, price-conscious buyer who would like the item but will not stretch their budget for it.',
    maxBudget: 3000,
    loyalty: 0.20,
    baseline: { bidAmount: 2999, urgency: 0.2 },
  },
  {
    agentId: 'agent-neha-urgent',
    description: 'A buyer who needs this exact item today as a gift and is under real time pressure, willing to pay noticeably above list price for certainty.',
    maxBudget: 3200,
    loyalty: 0.30,
    baseline: { bidAmount: 3100, urgency: 0.95 },
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runAgent(persona, staggerMs) {
  await sleep(staggerMs); // spread LLM calls across the batch window instead of firing all at once, to stay under free-tier per-minute token limits
  const decision = await decideAgentBid(persona, ITEM_CONTEXT);
  const label = decision.llmUsed ? '[LLM]' : '[fallback]';
  console.log(`${label} ${persona.agentId} decided: ₹${decision.bidAmount}, urgency ${decision.urgency.toFixed(2)} — "${decision.reasoning}"`);

  const res = await fetch(`${BASE_URL}/api/bid`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      itemId: ITEM_ID,
      agentId: persona.agentId,
      bidAmount: decision.bidAmount,
      urgency: decision.urgency,
      loyalty: persona.loyalty,
      reasoning: decision.reasoning,
      llmUsed: decision.llmUsed,
    }),
  });
  return res.json();
}

async function main() {
  console.log(`LLM provider: ${activeProvider() || 'none configured (using rule-based fallback)'}`);
  console.log(`Firing ${personas.length} AI buyer agents at ${ITEM_ID} (only 3 units in stock), staggered across the batch window...\n`);

  // Staggered, not simultaneous: each agent's LLM call is offset by ~350ms
  // from the last. This still lands every bid well inside the 2.5s batch
  // window (so the fairness mechanism treats them as fully concurrent -
  // arrival order within the window never decides the winner), but it
  // spreads token usage over time instead of bursting all 6 calls in the
  // same instant, which is what was tripping Groq's free-tier per-minute
  // token limit.
  const STAGGER_MS = 350;
  const results = await Promise.all(personas.map((p, i) => runAgent(p, i * STAGGER_MS)));
  results.forEach((r, i) => console.log(`  -> ${personas[i].agentId} bid accepted:`, r.accepted));

  console.log('\nAll agents decided and bid within the batch window. Check the dashboard.');
  console.log('It will auto-close in ~2.5s, or force-close it from the dashboard controls.');
}

main().catch(console.error);
