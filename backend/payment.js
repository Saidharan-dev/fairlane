/**
 * Payment adapter - wraps Razorpay test-mode order creation.
 *
 * If RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are set in .env, this
 * creates a real Razorpay TEST MODE order (no real money moves,
 * test mode never touches real funds). If keys are absent, it falls
 * back to a local mock so the demo still runs end-to-end without
 * requiring you to have Razorpay credentials in front of you.
 *
 * FAILURE INJECTION: set FORCE_FAIL_AGENT=<agentId> (or pass
 * forceFailAgentId at runtime via the /api/demo/force-fail endpoint)
 * to deterministically fail one specific agent's payment during a
 * live demo, so you can reliably show the reallocation flow on stage
 * instead of hoping a random failure happens.
 */

let Razorpay = null;
try {
  Razorpay = require('razorpay');
} catch (e) {
  // razorpay package not installed / not needed in mock mode
}

function buildPaymentAdapter({ getForceFailAgentId, clearForceFailAgentId }) {
  const hasKeys = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
  const client = hasKeys && Razorpay
    ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
    : null;

  return async function paymentAdapter(winner) {
    const forcedFailId = getForceFailAgentId();
    if (forcedFailId && forcedFailId === winner.agentId) {
      clearForceFailAgentId(); // one-shot, so subsequent runs behave normally
      return { success: false, reason: 'Card declined by issuing bank (simulated for demo)' };
    }

    if (!client) {
      // Mock mode: succeed deterministically (used when no Razorpay test keys configured)
      await sleep(300);
      return { success: true, orderId: `mock_order_${Date.now()}_${winner.agentId}` };
    }

    try {
      const order = await client.orders.create({
        amount: Math.round(winner.bidAmount * 100), // paise
        currency: 'INR',
        receipt: `fairlane_${winner.itemId}_${winner.agentId}_${Date.now()}`,
        notes: { agentId: winner.agentId, itemId: winner.itemId },
      });
      // NOTE: order.create succeeding means the order was created in
      // Razorpay test mode - actual payment capture would require a
      // client-side checkout step. For this PoC we treat order
      // creation as the "payment attempt succeeded" signal, which is
      // sufficient to demonstrate the allocation + audit trail flow.
      return { success: true, orderId: order.id };
    } catch (err) {
      return { success: false, reason: err?.error?.description || err.message || 'Unknown payment error' };
    }
  };
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

module.exports = { buildPaymentAdapter };
