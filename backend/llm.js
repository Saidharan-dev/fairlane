/**
 * LLM integration for FairLane.
 *
 * Two jobs:
 *  1. AGENT BID DECISIONS - each simulated AI buyer agent is given a
 *     persona + situational context and actually asked (via an LLM
 *     call) to decide its own bid amount, urgency, and a short stated
 *     reason - this is what makes them "agents" rather than hardcoded
 *     numbers pretending to be agents.
 *  2. ALLOCATION EXPLANATIONS - instead of a canned template string,
 *     the audit trail's win/loss explanations are generated per-agent
 *     by an LLM given the actual scoreboard, so the explanation is
 *     genuinely tailored, not boilerplate.
 *
 * PROVIDER PRIORITY: GROQ_API_KEY first - free tier, no credit card
 * (https://console.groq.com), and its free-tier rate limits comfortably
 * handle this demo's burst pattern (up to 12 LLM calls in a few seconds
 * per batch: 6 concurrent bid decisions + up to 6 sequential explanations).
 * GEMINI_API_KEY is supported as an alternative, but Google's free tier
 * for gemini-3.6-flash caps out at 5 requests/minute and 20/day, which
 * this demo's burst pattern exceeds on a single run - kept here for
 * completeness and lower-volume use, not as the recommended default.
 * ANTHROPIC_API_KEY works if you have Anthropic credits (no free tier).
 * If none are set, both functions fall back to clearly labeled
 * rule-based logic rather than fabricating an "AI-generated" claim.
 * Every call site records which path was used (llmUsed: true/false,
 * provider: 'groq'|'gemini'|'anthropic'|'rule-based') so nothing
 * overclaims what happened.
 */

const fetch = require('node-fetch');

function activeProvider() {
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

function hasApiKey() {
  return activeProvider() !== null;
}

async function callGroq(systemPrompt, userPrompt, maxTokens, jsonMode = false) {
  const body = {
    model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b', // override via GROQ_MODEL in .env if this becomes unavailable
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  };
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callGemini(systemPrompt, userPrompt, maxTokens, jsonMode = false) {
  const model = process.env.GEMINI_MODEL || 'gemini-3.6-flash'; // Google's free tier for this model is capped at 5 req/min, 20/day - see note above
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      ...(jsonMode ? { responseMimeType: 'application/json' } : {}),
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts;
  return parts?.map((p) => p.text).join('') || '';
}

async function callClaude(systemPrompt, userPrompt, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }
  const data = await res.json();
  const textBlock = data.content?.find((b) => b.type === 'text');
  return textBlock?.text || '';
}

/** Routes to whichever provider has a key configured. Throws if none does - callers must check hasApiKey() first. */
async function callLLM(systemPrompt, userPrompt, maxTokens = 300, jsonMode = false) {
  const provider = activeProvider();
  if (provider === 'groq') return callGroq(systemPrompt, userPrompt, maxTokens, jsonMode);
  if (provider === 'gemini') return callGemini(systemPrompt, userPrompt, maxTokens, jsonMode);
  if (provider === 'anthropic') return callClaude(systemPrompt, userPrompt, maxTokens);
  throw new Error('No LLM provider configured');
}

function extractJson(raw) {
  // Models sometimes wrap JSON in prose or code fences despite instructions - salvage it.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in LLM response');
  return JSON.parse(match[0]);
}

function isRateLimitError(err) {
  return /429|rate_limit/i.test(err.message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Retries once on a rate-limit error (Groq's free tier resets in well under a second), then gives up. */
async function withRateLimitRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    if (isRateLimitError(err)) {
      await sleep(1200);
      return fn(); // second and final attempt - if this also fails, let it throw up to the caller's fallback
    }
    throw err;
  }
}

/**
 * Ask an LLM to make the bidding decision for one simulated buyer agent persona.
 * Falls back to the persona's own baseline numbers (clearly flagged) if no key
 * is configured or the call fails, so the demo never breaks.
 */
async function decideAgentBid(persona, context) {
  const provider = activeProvider();
  if (!provider) {
    return {
      bidAmount: persona.baseline.bidAmount,
      urgency: persona.baseline.urgency,
      reasoning: '(rule-based fallback: no GROQ_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY configured)',
      llmUsed: false,
      provider: 'rule-based',
    };
  }

  const systemPrompt = `You are simulating one autonomous AI shopping agent acting on behalf of a real buyer in an agentic-commerce protocol (like AP2/ACP). You must decide a bid for a scarce item on the buyer's behalf, within their stated constraints. Respond with ONLY a JSON object, no prose, no code fences: {"bidAmount": number, "urgency": number between 0 and 1, "reasoning": "one short sentence explaining the decision"}`;

  const userPrompt = `Your persona: ${persona.description}
Hard budget ceiling you must never exceed: ₹${persona.maxBudget}
Item: ${context.itemName}, list price ₹${context.listPrice}, only ${context.stock} unit(s) left, other agents are bidding concurrently.
Decide your bid now.`;

  try {
    const raw = await withRateLimitRetry(() => callLLM(systemPrompt, userPrompt, 500, true));
    const parsed = extractJson(raw);
    const bidAmount = Math.min(Number(parsed.bidAmount), persona.maxBudget); // hard safety clamp
    const urgency = Math.max(0, Math.min(1, Number(parsed.urgency)));
    return {
      bidAmount,
      urgency,
      reasoning: String(parsed.reasoning || '').slice(0, 300),
      llmUsed: true,
      provider,
    };
  } catch (err) {
    return {
      bidAmount: persona.baseline.bidAmount,
      urgency: persona.baseline.urgency,
      reasoning: `(rule-based fallback: LLM call failed - ${err.message})`,
      llmUsed: false,
      provider: 'rule-based',
    };
  }
}

/**
 * Ask an LLM to write a tailored explanation of why a specific agent
 * won or lost, given the real scoreboard. Falls back to a templated
 * sentence (clearly flagged) if no key or on error.
 */
async function explainOutcome({ agentId, won, myBid, myScore, breakdown, cutoffScore, itemName }) {
  const templated = won
    ? `Won allocation: score ${myScore.toFixed(3)} cleared the cutoff of ${cutoffScore.toFixed(3)}.`
    : `Did not win: score ${myScore.toFixed(3)} ranked below the cutoff of ${cutoffScore.toFixed(3)}.`;

  const provider = activeProvider();
  if (!provider) {
    return { text: `${templated} (rule-based: no GROQ_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY configured)`, llmUsed: false, provider: 'rule-based' };
  }

  const systemPrompt = `You write short, honest, one-sentence explanations of an allocation decision for an AI buyer agent that just bid on a merchant's scarce item. Be specific about the numbers given. No preamble, no markdown, just the sentence.`;
  const userPrompt = `Item: ${itemName}
Agent ${agentId} ${won ? 'WON' : 'DID NOT WIN'} the allocation.
Their bid: ₹${myBid}. Their computed score: ${myScore.toFixed(3)} (bid component ${breakdown.bidComponent}, urgency component ${breakdown.urgencyComponent}, loyalty component ${breakdown.loyaltyComponent}).
Cutoff score to win this batch: ${cutoffScore.toFixed(3)}.
Write one sentence explaining the outcome to this agent, referencing which factor mattered most.`;

  try {
    const text = await withRateLimitRetry(() => callLLM(systemPrompt, userPrompt, 350));
    return { text: text.trim() || templated, llmUsed: true, provider };
  } catch (err) {
    return { text: `${templated} (rule-based fallback: LLM call failed - ${err.message})`, llmUsed: false, provider: 'rule-based' };
  }
}

module.exports = { hasApiKey, activeProvider, decideAgentBid, explainOutcome };
