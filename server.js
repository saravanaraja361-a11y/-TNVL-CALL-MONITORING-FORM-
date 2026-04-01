require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const GROQ_API_KEY  = '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';
const GROQ_MODEL    = 'llama-3.3-70b-versatile';
const GROQ_MODEL_B2 = 'llama-3.1-8b-instant';
const GROQ_URL      = 'https://api.groq.com/openai/v1/chat/completions';

const delay = ms => new Promise(r => setTimeout(r, ms));

async function callGroq(model, systemPrompt, userPrompt, maxTokens = 700) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      temperature: 0.1,
      max_tokens: maxTokens
    })
  });
  if (res.status === 401) throw new Error('Invalid Groq API key. Get a free key at console.groq.com/keys');
  if (res.status === 429) throw new Error('RATE_LIMIT: Groq quota hit. Wait 30 seconds and try again.');
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`Groq ${res.status}: ${e?.error?.message || 'unknown error'}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('Groq returned empty response. Please try again.');
  return text;
}

function parseJSON(raw) {
  const c = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(c); } catch (_) {}
  const m = c.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch (_) {}
  return null;
}

// Bias toward end of call (booking/payment/pre-move happen at the end)
function sampleTranscript(text, maxChars = 8500) {
  if (text.length <= maxChars) return text;
  const s = Math.floor(maxChars * 0.38);
  const e = Math.floor(maxChars * 0.52);
  const m = maxChars - s - e;
  const mid = Math.floor(text.length / 2) - Math.floor(m / 2);
  return (
    text.substring(0, s) +
    '\n\n[...middle section...]\n\n' +
    text.substring(mid, mid + m) +
    '\n\n[...end of call...]\n\n' +
    text.substring(text.length - e)
  );
}

const SECTIONS = [
  { title: "Call Opening & Contact Verification", items: [
    "Introduced self with agent name and company name",
    "Used professional greeting and asked for customer by name",
    "Verified if speaking with correct customer",
    "If wrong person, requested best callback time politely",
    "Confirmed correct contact number when applicable",
    "Scheduled callback when customer was unavailable",
    "If wrong number, politely closed call and advised number removal",
    "Logged wrong number and informed team lead/vendor (as applicable)"
  ]},
  { title: "Introduction & Reason for Call", items: [
    "Clearly stated reason for the call (quote request / move discussion)",
    "Explained intent to prepare accurate estimate"
  ]},
  { title: "Permission & Call Agenda Setting", items: [
    "Explained what will be covered during the call (move details + inventory)",
    "Set expectation of call duration (approx. time required)",
    "Asked for permission to proceed",
    "If not a good time, accepted politely and did not push",
    "Confirmed callback timing clearly",
    "Scheduled callback at customer-preferred time"
  ]},
  { title: "Move Type Identification (Basic vs End-to-End Support)", items: [
    "Checks whether customer wants basic moving or end-to-end support",
    "Clearly explained what basic moving includes (loading, transport, unloading) if needed",
    "Clearly explained what end-to-end support includes (packing, dismantling, full handling) if needed",
    "Acknowledged customer's stated preference clearly"
  ]},
  { title: "Address & Move Date Capture", items: [
    "Confirmed full pickup address",
    "Confirmed full delivery address",
    "Confirmed move date clearly",
    "Checked flexibility on dates"
  ]},
  { title: "Inventory Capture (Room-to-Room)", items: [
    "Explained why inventory details are needed for accurate estimate",
    "Followed structured room-to-room approach",
    "Covered all major rooms (living, bedrooms, kitchen)",
    "Asked about storage, garage, balcony, and outdoor items",
    "Asked about bulky, fragile or special items (piano, treadmill, large cabinets, safes, artworks etc)",
    "Confirmed bed sizes and major furniture dimensions where relevant",
    "Confirmed appliances to be moved",
    "Verified if any items were missed",
    "Set clear follow-up if inventory was incomplete"
  ]},
  { title: "Access & Constraints (Time & Cost Impact)", items: [
    "Asked about stairs or elevator at pickup",
    "Asked about stairs or elevator at delivery",
    "Asked about parking availability at both locations",
    "Probed walking distance from truck to entrance",
    "Flagged long carry if distance exceeds standard limits",
    "Advised elevator booking if required",
    "Advised to include buffer time for elevator booking",
    "Explained how access impacts move time and cost",
    "Did not skip access questions even if customer seemed confident"
  ]},
  { title: "Packing & Add-On Services", items: [
    "Asked whether customer will self-pack or needs packing assistance",
    "Acknowledged customer's packing preference clearly",
    "If self-packing, offered packing materials (boxes, wrapping, wardrobe boxes)",
    "If packing service requested, confirmed full or partial packing requirement",
    "Explained that packing time is included in total crew hours (for local moves)",
    "Asked about dismantling and reassembly needs (beds, wardrobes, large furniture)",
    "Noted specific items requiring dismantling and reassembly",
    "Explained that dismantling/assembly affects time and estimate",
    "Offered packing tips or guidance for fragile items when relevant",
    "Documented packing and add-on requirements accurately in system"
  ]},
  { title: "Estimate Logic & Pricing - Local Moves", items: [
    "Explained pricing is based on hourly rate and crew size",
    "Explained billing start and end points clearly",
    "Linked estimate to inventory and access factors",
    "Provided time range, not guaranteed duration"
  ]},
  { title: "Estimate Logic & Pricing - Long Distance Moves", items: [
    "Explained pricing is based on shipment weight and distance",
    "Explained certified weigh station process",
    "Clarified labor vs transportation charges",
    "Explained delivery window vs fixed date"
  ]},
  { title: "TNVL Trust Builders & Transparency", items: [
    "Explained when billing starts (at loading, not during drive to pickup)",
    "Explained how travel time is calculated (using Google Maps)",
    "Explained that crews follow proper wrapping and protection procedures (As applicable)",
    "Reinforced that there are no hidden charges and pricing drivers are explained upfront",
    "Explained how crew work time is tracked and communicated",
    "Clarified that break time is not charged and timer is paused during breaks",
    "Reinforced transparency of billing and work process",
    "Positioned trust and visibility as part of TNVL service approach",
    "Delivered trust statements confidently and naturally (not scripted)"
  ]},
  { title: "Objection Handling - Trust & Credibility", items: [
    "Addressed 'no / few reviews' concern by explaining recent rebranding",
    "Clarified that crew and coordinators are experienced, not new to industry",
    "Reinforced planning and written confirmation of move details",
    "Avoided defensive or dismissive tone",
    "Redirected conversation back to service process and next steps"
  ]},
  { title: "Objection Handling - Price & Value", items: [
    "Clarified that estimates are based on inventory and access details",
    "Explained that planning helps avoid later price increases",
    "Did not criticize competitor pricing practices directly",
    "Positioned service quality and planning as value drivers",
    "Offered basic vs full service options where relevant",
    "Avoided negotiating price without reviewing service scope"
  ]},
  { title: "Objection Handling - Safety & Damage", items: [
    "Reassured customer using planning and crew sizing as main protection",
    "Explained use of proper padding, wrapping, and loading methods",
    "Encouraged disclosure of fragile or special items",
    "Confirmed special handling items are noted in move plan",
    "Clarified that issues are handled through office process, not just crew"
  ]},
  { title: "Objection Handling - Storage & Delivery Timing", items: [
    "Explained difference between storage vs direct delivery clearly",
    "Clarified why storage is charged from day one (handling and facilities)",
    "Did not claim competitor offers are misleading or wrong",
    "Explained delivery windows for long-distance moves",
    "Did not guarantee fixed delivery dates for standard service",
    "Offered alternatives (storage or dedicated truck) when firm dates required"
  ]},
  { title: "Objection Handling - Last-Minute / Short-Notice Moves", items: [
    "Acknowledged urgency without over-promising",
    "Explained limited availability of crews and trucks",
    "Confirmed that options will be checked before commitment",
    "Did not guarantee service without verifying availability",
    "Maintained calm and realistic expectations"
  ]},
  { title: "Objection Handling - Decision Delay / Comparison", items: [
    "Respected customer need to consult family or partner",
    "Offered to send estimate and move details for review",
    "Set clear follow-up timeline and next contact point",
    "Offered to hold date when appropriate",
    "Did not disengage or end call without next steps"
  ]},
  { title: "Objection Handling - Charges, Valuation & Policies", items: [
    "Reassured that known cost factors are included upfront",
    "Explained that changes are discussed before move day",
    "Did not promise no changes regardless of circumstances",
    "Explained valuation as weight-based industry standard",
    "Avoided overselling additional insurance",
    "Reinforced prevention through planning and handling"
  ]},
  { title: "Sale Technique - Booking & Payment Process", items: [
    "Attempted to close after sharing estimate",
    "Asked clearly if customer would like to proceed with booking",
    "Offered tentative slot if customer hesitated",
    "Explained deposit amount and purpose clearly",
    "Explained cancellation window linked to deposit",
    "Explained 50% payment before loading at place of Origin",
    "Explained balance payment timing correctly (before unloading)",
    "Did not give unclear or conflicting payment information"
  ]},
  { title: "Pre-Move Confirmation Process", items: [
    "Informed customer about pre-move confirmation call",
    "Informed that the pre-move confirmation call will be 3 days prior to actual move date",
    "Explained purpose of confirmation call",
    "Confirmed best contact number",
    "Confirmed preferred time for confirmation call",
    "Explained importance of confirmation for crew dispatch",
    "Reinforced updating inventory if changes occur"
  ]},
  { title: "Cancellation & Reschedule Management", items: [
    "Acknowledged cancellation request with empathy",
    "Asked reason before processing cancellation",
    "Attempted save if issue was objection-related",
    "Offered reschedule where appropriate",
    "Explained cancellation charges as per policy",
    "Did not pressure after final decision",
    "Confirmed cancellation process and next steps"
  ]},
  { title: "Soft Skills & Customer Experience", items: [
    "Did not interrupt customer while they were speaking",
    "Responded directly to customer questions without deflection",
    "Gave clear and direct answers without hesitation",
    "Explained pricing and policies with confidence",
    "Avoided uncertain or vague language (e.g., 'maybe', 'I guess')",
    "Limited use of filler words (okay, um, uh, alright, like)",
    "Used professional, varied language (not robotic or scripted)",
    "Asked effective questions including probing questions to understand Customer's requirements",
    "Asked permission before placing customer on hold",
    "Explained reason for hold",
    "Avoided long or unexplained silence on the call",
    "Used empathetic language at all appropriate stages of call where customer expressed concern",
    "Maintained calm and respectful tone at all times",
    "Did not sound dismissive, rushed, or irritated",
    "Guided conversation back to topic when customer digressed",
    "Transitioned clearly between call sections",
    "Summarized key points when needed to avoid confusion"
  ]}
];

function flattenChecklist() {
  const items = [];
  SECTIONS.forEach((sec, si) => sec.items.forEach((label, ii) => {
    items.push({ key: `r_${si}_${ii}`, section: sec.title, si, ii, label });
  }));
  return items;
}

// ── Pass 1: Extract call context ─────────────────────────────────────────────
async function analyzeContext(transcript) {
  const sys = 'You are a call quality analyst. Return ONLY valid JSON, no markdown, no explanation.';
  const usr = `Carefully read this call transcript and return a JSON context object.

TRANSCRIPT:
${transcript.substring(0, 5000)}

Return ONLY this JSON with true/false values:
{
  "moveType": "local" or "longdistance",
  "callDirection": "inbound" or "outbound",
  "customerAvailable": true or false,
  "wasWrongNumber": true or false,
  "cancellationRequested": true or false,
  "customerAskedToDelay": true or false,
  "customerRaisedPriceObjection": true or false,
  "customerRaisedTrustObjection": true or false,
  "customerRaisedSafetyObjection": true or false,
  "customerRaisedStorageObjection": true or false,
  "customerRaisedUrgencyObjection": true or false,
  "customerRaisedChargesObjection": true or false,
  "agentPlacedOnHold": true or false,
  "agentGaveEstimate": true or false,
  "agentDiscussedPayment": true or false,
  "agentDiscussedPreMoveConf": true or false,
  "inventoryWasDiscussed": true or false,
  "packingWasDiscussed": true or false,
  "accessWasDiscussed": true or false,
  "trustBuildingWasDiscussed": true or false
}

DEFINITIONS:
- agentGaveEstimate: agent provided a price, time estimate, or quote
- agentDiscussedPayment: agent mentioned deposit, payment terms, or booking process  
- agentDiscussedPreMoveConf: agent explicitly mentioned a confirmation call before move day
- inventoryWasDiscussed: agent asked about furniture or items to be moved
- packingWasDiscussed: agent asked about packing needs, boxes, or packing services
- accessWasDiscussed: agent asked about stairs, elevator, parking, or access
- trustBuildingWasDiscussed: agent explained billing, timing, transparency, or how things work`;

  const raw = await callGroq(GROQ_MODEL, sys, usr, 500);
  const parsed = parseJSON(raw);
  return parsed || {
    moveType: 'local', callDirection: 'outbound',
    customerAvailable: true, wasWrongNumber: false,
    cancellationRequested: false, customerAskedToDelay: false,
    customerRaisedPriceObjection: false, customerRaisedTrustObjection: false,
    customerRaisedSafetyObjection: false, customerRaisedStorageObjection: false,
    customerRaisedUrgencyObjection: false, customerRaisedChargesObjection: false,
    agentPlacedOnHold: false, agentGaveEstimate: false,
    agentDiscussedPayment: false, agentDiscussedPreMoveConf: false,
    inventoryWasDiscussed: false, packingWasDiscussed: false,
    accessWasDiscussed: false, trustBuildingWasDiscussed: false
  };
}

// ── Build skip list from context ─────────────────────────────────────────────
function buildSkipList(ctx) {
  const skip = new Set();
  const isLD = ctx.moveType === 'longdistance';

  SECTIONS.forEach((sec, si) => {
    sec.items.forEach((_, ii) => {
      const key = `r_${si}_${ii}`;

      // s0: wrong-number items
      if (si === 0 && [3, 6, 7].includes(ii) && !ctx.wasWrongNumber) skip.add(key);
      // s0: callback item
      if (si === 0 && ii === 5 && ctx.customerAvailable) skip.add(key);

      // s2 Permission: callback items
      if (si === 2 && [4, 5].includes(ii) && ctx.customerAvailable) skip.add(key);

      // s5 Inventory: skip whole section if inventory never discussed
      if (si === 5 && !ctx.inventoryWasDiscussed) skip.add(key);

      // s6 Access: skip whole section if access never discussed
      if (si === 6 && !ctx.accessWasDiscussed) skip.add(key);

      // s7 Packing: skip detail items if packing was not discussed
      if (si === 7 && !ctx.packingWasDiscussed && ii >= 2) skip.add(key);

      // s8 Local pricing: skip for LD
      if (si === 8 && isLD) skip.add(key);
      // s9 LD pricing: skip for local
      if (si === 9 && !isLD) skip.add(key);

      // s10 Trust: skip whole section if trust building not discussed
      if (si === 10 && !ctx.trustBuildingWasDiscussed) skip.add(key);

      // s11-s17 Objection sections: skip unless objection raised
      if (si === 11 && !ctx.customerRaisedTrustObjection) skip.add(key);
      if (si === 12 && !ctx.customerRaisedPriceObjection) skip.add(key);
      if (si === 13 && !ctx.customerRaisedSafetyObjection) skip.add(key);
      if (si === 14 && !ctx.customerRaisedStorageObjection) skip.add(key);
      if (si === 15 && !ctx.customerRaisedUrgencyObjection) skip.add(key);
      if (si === 16 && !ctx.customerAskedToDelay) skip.add(key);
      if (si === 17 && !ctx.customerRaisedChargesObjection) skip.add(key);

      // s18 Booking: skip if agent never got to payment/booking discussion
      if (si === 18 && !ctx.agentDiscussedPayment) skip.add(key);

      // s19 Pre-Move Confirmation: skip if never discussed
      if (si === 19 && !ctx.agentDiscussedPreMoveConf) skip.add(key);

      // s20 Cancellation: skip unless customer requested
      if (si === 20 && !ctx.cancellationRequested) skip.add(key);

      // s21 Soft Skills: hold items only if hold was used
      if (si === 21 && [8, 9].includes(ii) && !ctx.agentPlacedOnHold) skip.add(key);
    });
  });
  return skip;
}

// ── Pass 2: Rate checklist in 2 batches ──────────────────────────────────────
async function rateChecklist(transcript, skipSet, allItems, ctx) {
  const toRate = allItems.filter(i => !skipSet.has(i.key));
  const half   = Math.ceil(toRate.length / 2);
  const batch1 = toRate.slice(0, half);
  const batch2 = toRate.slice(half);

  const sys = 'You are a call quality evaluator. Return ONLY valid JSON, no markdown.';

  function buildBatchPrompt(batch) {
    const itemLines = batch.map(i => `${i.key}: ${i.label}`).join('\n');
    return `You are evaluating a sales call for a moving company. Rate each checklist item.

CALL CONTEXT:
- Move type: ${ctx.moveType} | Call direction: ${ctx.callDirection || 'outbound'}
- Inventory discussed: ${ctx.inventoryWasDiscussed} | Packing discussed: ${ctx.packingWasDiscussed}
- Access discussed: ${ctx.accessWasDiscussed} | Trust building: ${ctx.trustBuildingWasDiscussed}
- Estimate given: ${ctx.agentGaveEstimate} | Payment discussed: ${ctx.agentDiscussedPayment}
- Pre-move confirmation discussed: ${ctx.agentDiscussedPreMoveConf}

TRANSCRIPT:
${transcript}

ITEMS TO RATE:
${itemLines}

RATING DECISION RULES — FOLLOW THESE EXACTLY:

"met" → Agent clearly did this. There is DIRECT EVIDENCE in the transcript.

"notmet" → Use ONLY when ALL THREE conditions are true:
  1. The topic was CLEARLY relevant to this call
  2. The agent CLEARLY should have done this given the call context  
  3. There is CLEAR EVIDENCE the agent did NOT do it
  
"ni" → Agent attempted this but execution was noticeably poor or incomplete.
  Use sparingly — only when the attempt is visible but clearly insufficient.

"skip" → Use when:
  - The topic did not come up in this call
  - There is not enough evidence to make a fair judgment
  - The item is conditional on something that did not occur
  - You are UNSURE whether the agent did or didn't do this

IMPORTANT: When in doubt, always use "skip" — never penalize an agent unfairly.
Only use "notmet" when the failure is OBVIOUS and CLEAR in the transcript.

Return JSON: {"r_X_X": "met", ...}
Include ALL ${batch.length} keys. Return ONLY the JSON object.`;
  }

  console.log(`  Batch 1: ${batch1.length} items (${GROQ_MODEL})...`);
  const raw1    = await callGroq(GROQ_MODEL, sys, buildBatchPrompt(batch1), 800);
  const result1 = parseJSON(raw1) || {};

  console.log(`  Waiting 5s between batches...`);
  await delay(5000);

  console.log(`  Batch 2: ${batch2.length} items (${GROQ_MODEL_B2})...`);
  const raw2    = await callGroq(GROQ_MODEL_B2, sys, buildBatchPrompt(batch2), 800);
  const result2 = parseJSON(raw2) || {};

  return { ...result1, ...result2 };
}

// ── Main analysis ─────────────────────────────────────────────────────────────
async function analyzeCall(callText) {
  const allItems   = flattenChecklist();
  const transcript = sampleTranscript(callText, 8500);
  console.log(`  Transcript: ${callText.length} chars → sampled ${transcript.length} chars`);

  console.log('  Pass 1: context analysis...');
  const ctx  = await analyzeContext(transcript);
  const skip = buildSkipList(ctx);
  console.log(`  Context: ${ctx.moveType} | ${ctx.callDirection} | inv=${ctx.inventoryWasDiscussed} pack=${ctx.packingWasDiscussed} access=${ctx.accessWasDiscussed} trust=${ctx.trustBuildingWasDiscussed}`);
  console.log(`  Booking: est=${ctx.agentGaveEstimate} pay=${ctx.agentDiscussedPayment} premove=${ctx.agentDiscussedPreMoveConf}`);
  console.log(`  Skipping ${skip.size} items → rating ${allItems.length - skip.size} items`);

  console.log('  Pass 2: rating checklist (2 batches)...');
  const batchRatings = await rateChecklist(transcript, skip, allItems, ctx);

  const ratings = {};
  allItems.forEach(({ key }) => {
    if (skip.has(key)) {
      ratings[key] = 'skip';
    } else {
      const r = batchRatings[key];
      // Missing/unrecognised keys → skip (not notmet)
      ratings[key] = ['met', 'notmet', 'ni'].includes(r) ? r : 'skip';
    }
  });

  const m  = Object.values(ratings).filter(r => r === 'met').length;
  const n  = Object.values(ratings).filter(r => r === 'notmet').length;
  const ni = Object.values(ratings).filter(r => r === 'ni').length;
  const sk = Object.values(ratings).filter(r => r === 'skip').length;
  console.log(`  ✅ met=${m} notmet=${n} ni=${ni} skip=${sk} | ${Math.round(m/(m+n+ni||1)*100)}%`);

  return { ratings, ctx };
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/api/analyze-text', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });
  try {
    const start = Date.now();
    console.log(`\n▶ /api/analyze-text (${text.length} chars) → Groq`);
    const { ratings, ctx } = await analyzeCall(text);
    console.log(`  ⏱ Done in ${((Date.now()-start)/1000).toFixed(1)}s`);
    return res.json({ ratings, context: ctx });
  } catch (err) {
    console.error('❌', err.message);
    if (err.message.startsWith('RATE_LIMIT:')) {
      return res.status(429).json({ error: err.message, isRateLimit: true });
    }
    return res.status(502).json({ error: err.message });
  }
});

app.get('/api/transkriptor/files', async (req, res) => {
  const apiKey = req.headers['x-transkriptor-key'];
  if (!apiKey) return res.status(400).json({ error: 'Missing x-transkriptor-key header' });
  try {
    const r = await fetch('https://api.tor.app/developer/files', {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' }
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Transkriptor error', details: await r.text() });
    const data  = await r.json();
    const files = (data.data || data.files || data || []).map(f => ({
      order_id: f.order_id || f.id || f.file_id || f.uuid,
      name: f.name || f.file_name || f.title || f.filename || 'Unnamed',
      created_at: f.created_at || f.date || ''
    }));
    return res.json({ data: files });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get('/api/transkriptor/summary/:orderId', async (req, res) => {
  const apiKey = req.headers['x-transkriptor-key'];
  if (!apiKey) return res.status(400).json({ error: 'Missing x-transkriptor-key header' });
  const hdrs = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  try {
    const cr = await fetch(`https://api.tor.app/developer/files/${req.params.orderId}/content`, { method: 'GET', headers: hdrs });
    if (!cr.ok) return res.status(cr.status).json({ error: 'Transkriptor error', details: await cr.text() });
    const cd = await cr.json();
    let tx = '', ai = '';
    if (cd.content && Array.isArray(cd.content))
      tx = cd.content.map(s => `${s.Speaker || s.speaker || 'Agent'}: ${s.text || s.Text || ''}`).join('\n');
    if (cd.summary_link) {
      try {
        const sr = await fetch(cd.summary_link);
        if (sr.ok) ai = (await sr.text())
          .replace(/<\/p>/gi,'\n').replace(/<\/li>/gi,'\n').replace(/<br\s*\/?>/gi,'\n')
          .replace(/<strong>(.*?)<\/strong>/gi,'$1').replace(/<li>/gi,'  • ')
          .replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<')
          .replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/\n{3,}/g,'\n\n').trim();
      } catch (_) {}
    }
    let combined = '';
    if (ai) combined += `📝 AI SUMMARY\n${'─'.repeat(40)}\n${ai}\n\n`;
    if (tx) combined += `🎙️ FULL TRANSCRIPT\n${'─'.repeat(40)}\n${tx}`;
    if (!combined) combined = '⚠️ No content found.';
    return res.json({ summary: combined });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

app.get('/api/health', (_req, res) => res.json({
  status: 'ok',
  engine: `Groq FREE (${GROQ_MODEL} + ${GROQ_MODEL_B2})`,
  groqKey: GROQ_API_KEY ? `set (${GROQ_API_KEY.substring(0,8)}...)` : 'MISSING',
  port: process.env.PORT || 3000
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ TNVL Server → http://localhost:${PORT}`);
  console.log(`   Engine : Groq FREE ✅`);
  console.log(`   Model  : ${GROQ_MODEL} (context + batch 1)`);
  console.log(`   Model2 : ${GROQ_MODEL_B2} (batch 2)`);
  console.log(`   Key    : ✅ set (${GROQ_API_KEY.substring(0,8)}...)`);
  console.log(`   Speed  : ~20-30s per analysis`);
  console.log(`   Limits : No daily cap — FREE forever`);
  console.log(`\n   Accuracy v2 — what changed:`);
  console.log(`   • NEW context fields: inventory/packing/access/trust/payment/premove`);
  console.log(`   • Smart skip: s5 inventory skipped if inventory never discussed`);
  console.log(`   • Smart skip: s6 access skipped if access never discussed`);
  console.log(`   • Smart skip: s10 trust skipped if trust never discussed`);
  console.log(`   • Smart skip: s18 booking skipped if payment never discussed`);
  console.log(`   • Smart skip: s19 pre-move skipped if never mentioned`);
  console.log(`   • Rating: "skip" when unsure — never penalize unfairly`);
  console.log(`   • Larger transcript: 8500 chars, end-biased (captures booking/payment)\n`);
});