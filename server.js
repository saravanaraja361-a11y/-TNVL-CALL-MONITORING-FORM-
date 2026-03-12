require('dotenv').config();
const express = require('express');
const fetch   = require('node-fetch');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const path = require('path');

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname)));

// Root route - serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Multi-Key Groq Pool ───────────────────────────────────────────────────────
const GROQ_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
].filter(Boolean);

if (!GROQ_KEYS.length) console.error('\n❌ No Groq API keys found!');

let currentKeyIndex = 0;
function getCurrentKey() { return GROQ_KEYS[currentKeyIndex]; }
function rotateKey() {
  const prev = currentKeyIndex;
  currentKeyIndex = (currentKeyIndex + 1) % GROQ_KEYS.length;
  console.log(`  🔄 Rotated key #${prev + 1} → #${currentKeyIndex + 1}`);
}

const GROQ_MODEL_FAST = 'llama-3.1-8b-instant';   // for 3 batch rating calls
const GROQ_MODEL_SMART = 'llama-3.3-70b-versatile'; // for context analysis only
const GROQ_MODEL = GROQ_MODEL_SMART; // default (overridden per call)
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── callGroq: rotate keys on 429, wait if ALL are exhausted ──────────────────
async function callGroq(systemPrompt, userPrompt, maxTokens = 1200, model = GROQ_MODEL_SMART) {
  if (!GROQ_KEYS.length) throw new Error('No Groq API keys configured.');

  const MAX_ROUNDS  = 4;   // how many full key-rotation cycles to attempt
  const WAIT_MS     = 35000; // 35s wait when ALL keys are rate-limited

  let totalAttempts = 0;
  let keysTriedThisRound = 0;

  while (totalAttempts < MAX_ROUNDS * GROQ_KEYS.length) {
    const apiKey = getCurrentKey();
    totalAttempts++;
    keysTriedThisRound++;

    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   }
        ],
        temperature: 0.1,
        max_tokens: maxTokens
      })
    });

    if (res.status === 429) {
      console.log(`  ⚠️  Key #${currentKeyIndex + 1} rate limited.`);
      rotateKey();

      if (keysTriedThisRound >= GROQ_KEYS.length) {
        // Tried every key — all rate-limited, must wait
        // IMPORTANT: Ignore Groq's retry-after header (it can be 4800s on free tier)
        // Always use our own fixed wait time of 30s
        console.log(`  ⏳ All keys exhausted. Waiting 30s before retry...`);
        await delay(30000);
        keysTriedThisRound = 0; // reset for next round
      } else {
        await delay(1000); // small pause between key switches
      }
      continue;
    }

    if (res.status === 401) throw new Error(`Key #${currentKeyIndex + 1} is invalid.`);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(`Groq ${res.status}: ${e?.error?.message || 'unknown'}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('Groq returned empty response.');
    console.log(`  ✅ Key #${currentKeyIndex + 1} responded`);
    return text;
  }

  throw new Error('RATE_LIMIT: Could not get a response after multiple retries. Please wait 1 minute and try again.');
}

function parseJSON(raw) {
  const c = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(c); } catch (_) {}
  const m = c.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch (_) {}
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  STEP 1 (NO API CALL): Parse AI Summary + Transcript from raw Transkriptor text
// ══════════════════════════════════════════════════════════════════════════════
function parseCombinedText(rawText) {
  const lineBreak = /─{10,}/g;
  let aiSummary = '', transcript = '';

  // Try multiple marker formats Transkriptor may use
  const transcriptMarkers = [
    '🎙️ FULL TRANSCRIPT',
    'FULL TRANSCRIPT',
    '🎙 FULL TRANSCRIPT',
  ];
  const summaryMarkers = [
    '📝 AI SUMMARY',
    'AI SUMMARY',
    '📝 SUMMARY',
  ];

  let splitDone = false;
  for (const tMark of transcriptMarkers) {
    if (rawText.includes(tMark)) {
      const parts = rawText.split(tMark);
      let summaryPart = parts[0];
      for (const sMark of summaryMarkers) {
        summaryPart = summaryPart.replace(sMark, '');
      }
      aiSummary  = summaryPart.replace(lineBreak, '').trim();
      transcript = parts[1] ? parts[1].replace(lineBreak, '').trim() : '';
      splitDone = true;
      break;
    }
  }

  // Fallback: look for SPK1:/SPK2: lines — if found, everything before first SPK line is summary
  if (!splitDone) {
    const firstSpkMatch = rawText.match(/\n(SPK\d+:|Agent:|Customer:)/);
    if (firstSpkMatch && firstSpkMatch.index > 200) {
      const idx = firstSpkMatch.index;
      let summaryPart = rawText.substring(0, idx);
      for (const sMark of summaryMarkers) {
        summaryPart = summaryPart.replace(sMark, '');
      }
      aiSummary  = summaryPart.replace(lineBreak, '').trim();
      transcript = rawText.substring(idx).replace(lineBreak, '').trim();
      splitDone  = true;
      console.log(`  ℹ️  Used SPK-line heuristic to split summary/transcript`);
    }
  }

  // Last resort: whole text is transcript
  if (!splitDone) {
    transcript = rawText;
  }

  // Count actual transcript lines (SPK lines)
  const spkLines = (transcript.match(/^SPK\d+:/gm) || []).length;
  console.log(`  Summary: ${aiSummary.length} chars | Transcript: ${transcript.length} chars | SPK lines: ${spkLines}`);
  if (!aiSummary) {
    console.log(`  ⚠️  No AI Summary found — transcript-only mode (rating may be less accurate)`);
  }

  return { aiSummary, transcript };
}

// ══════════════════════════════════════════════════════════════════════════════
//  STEP 2 (API CALL 1/4): Context analysis — uses AI Summary as primary source
// ══════════════════════════════════════════════════════════════════════════════
async function analyzeContext(aiSummary, transcript) {
  const sys = 'You are a call quality analyst. Return ONLY valid JSON, no markdown.';

  // Summary is primary — keep input compact to save tokens
  const summaryInput = aiSummary ? aiSummary.substring(0, 2500) : '';
  const transcriptInput = transcript.substring(0, 1500); // small sample only

  const usr = `Analyze this TNVL (True North Van Lines) moving company call.
The AI Summary is your PRIMARY source. The transcript is all SPK1 — unreliable for speaker identity.

AI SUMMARY:
${summaryInput || '(none)'}

TRANSCRIPT SAMPLE (first 1500 chars):
${transcriptInput}

Return ONLY this JSON:
{"moveType":"local","callDirection":"outbound","customerAvailable":true,"wasWrongNumber":false,"cancellationRequested":false,"customerAskedToDelay":false,"customerRaisedPriceObjection":false,"customerRaisedTrustObjection":false,"customerRaisedSafetyObjection":false,"customerRaisedStorageObjection":false,"customerRaisedUrgencyObjection":false,"customerRaisedChargesObjection":false,"agentGaveEstimate":false,"agentDiscussedPayment":false,"agentDiscussedPreMoveConf":false,"agentPlacedOnHold":false,"inventoryWasDiscussed":true,"packingWasDiscussed":false,"accessWasDiscussed":true,"callIsSubstantive":true,"isInboundCall":false,"trustDetail":{"billingStartExplicit":false,"travelTimeGoogleMaps":false,"wrappingExplicit":false,"noHiddenCharges":false,"crewTimeTracking":false,"breakTimeNotCharged":false},"paymentDetail":{"depositExplained":false,"cancellationWindow":false,"fiftyPercentBeforeLoading":false,"balanceBeforeUnloading":false},"callQuality":"good","summaryHighlights":""}

RULES:
- moveType = "longdistance" if move crosses provinces/states (Alberta→Manitoba, QC→ON, BC cross-island = longdistance)
- callIsSubstantive = true if real moving discussion happened (not just greeting/wrong number)
- isInboundCall = true if customer called in (summary says "inbound" or customer initiated)
- agentDiscussedPreMoveConf = true ONLY if summary says "pre-move confirmation call" or "3 days before"
- customerRaisedTrustObjection = true ONLY if customer questioned company credibility or reviews
- customerAskedToDelay = true if summary says customer wants to compare, think, consult, or call back
- customerRaisedPriceObjection = true if customer pushed back on cost or asked to lower price
- inventoryWasDiscussed = true if summary mentions ANY furniture, rooms, appliances, or items
- packingWasDiscussed = true if summary mentions packing preference, boxes, dismantling, or materials
- accessWasDiscussed = true if summary mentions stairs, elevator, parking, steps, or building access
- agentGaveEstimate = true if summary says agent gave a time range or dollar estimate
- agentDiscussedPayment = true if summary mentions deposit, payment steps, or booking
- agentPlacedOnHold = true if summary or transcript mentions agent asked customer to hold/wait
- trustDetail: set each to true ONLY if summary EXPLICITLY mentions that specific point:
  billingStartExplicit = billing starts at loading/pickup (not during travel to job)
  travelTimeGoogleMaps = Google Maps used for travel time calculation (must be explicit)
  wrappingExplicit = padding, blankets, wrapping, protection procedures explicitly mentioned
  noHiddenCharges = upfront/transparent pricing or no hidden fees mentioned
  crewTimeTracking = timer, app, clock, or crew work time tracking explicitly mentioned
  breakTimeNotCharged = breaks not charged or timer paused during breaks explicitly mentioned
- paymentDetail: set each to true ONLY if summary explicitly mentions that payment step:
  depositExplained = deposit amount and purpose explained
  cancellationWindow = cancellation policy/window linked to deposit explained
  fiftyPercentBeforeLoading = 50% or half payment before loading explicitly stated
  balanceBeforeUnloading = balance/remaining payment before unloading explicitly stated
- callQuality = "good" if professional structured call; "issues" if filler words/interruptions/hesitation/scripted tone noted in summary
- summaryHighlights = 2-3 key facts: agent name, customer name, move route, date, key topics covered`;

  const raw = await callGroq(sys, usr, 700);
  const parsed = parseJSON(raw);
  return parsed || {
    moveType: 'local', callDirection: 'outbound',
    customerAvailable: true, wasWrongNumber: false,
    cancellationRequested: false, customerAskedToDelay: false,
    customerRaisedPriceObjection: false, customerRaisedTrustObjection: false,
    customerRaisedSafetyObjection: false, customerRaisedStorageObjection: false,
    customerRaisedUrgencyObjection: false, customerRaisedChargesObjection: false,
    agentGaveEstimate: false, agentDiscussedPayment: false,
    agentDiscussedPreMoveConf: false, agentPlacedOnHold: false,
    inventoryWasDiscussed: true, packingWasDiscussed: false,
    accessWasDiscussed: true, callIsSubstantive: true,
    isInboundCall: false, callQuality: 'good',
    trustDetail: { billingStartExplicit: false, travelTimeGoogleMaps: false, wrappingExplicit: false, noHiddenCharges: false, crewTimeTracking: false, breakTimeNotCharged: false },
    paymentDetail: { depositExplained: false, cancellationWindow: false, fiftyPercentBeforeLoading: false, balanceBeforeUnloading: false },
    summaryHighlights: ''
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  SECTIONS — 22 sections, matches frontend exactly
// ══════════════════════════════════════════════════════════════════════════════
const SECTIONS = [
  { title: "Call Opening & Contact Verification", items: [
    "Introduced self with agent name and company name",
    "Used a professional greeting, addressed the customer by name, and confirmed identity.",
    "If wrong person, requested best callback time politely",
    "Confirmed correct contact number when applicable",
    "Scheduled callback when customer was unavailable",
    "If wrong number, politely closed the call",
    "Logged wrong number and informed team lead/vendor (as applicable)"
  ]},
  { title: "Permission & Call Agenda Setting", items: [
    "Clearly stated purpose of call (quote request / move discussion)",
    "Explained what will be covered during the call (move details + inventory)",
    "Set expectation of call duration (approx. time required)",
    "Asked for permission to proceed",
    "If not a good time, accepted politely and did not push",
    "Confirmed callback timing clearly",
    "Scheduled callback at customer-preferred time"
  ]},
  { title: "Move Type Identification (Basic vs End-to-End Support)", items: [
    "Identified whether customer needs basic or full-service moving.",
    "Explained inclusions of basic moving as required (Loading, Transport, Unloading)",
    "Explained inclusions of full-service moving as required (Packing, Dismantling/Assembling, Loading, Transport and Unloading)",
    "Acknowledged and confirmed customer preference"
  ]},
  { title: "Address & Move Date Capture", items: [
    "Captured complete pickup address",
    "Captured complete delivery address",
    "Confirmed move date clearly",
    "Checked flexibility on dates"
  ]},
  { title: "Inventory Capture (Room-to-Room)", items: [
    "Explained the importance of inventory for accurate pricing",
    "Followed structured room-to-room approach",
    "Covered all major rooms (living, bedrooms, kitchen)",
    "Asked about storage, garage, balcony, and outdoor items",
    "Probed for bulky, fragile, or special items",
    "Confirmed bed sizes and major furniture dimensions where relevant",
    "Confirmed appliances to be moved",
    "Checked if any items were missed",
    "Set clear follow-up if inventory was incomplete"
  ]},
  { title: "Access & Constraints (Time & Cost Impact)", items: [
    "Asked about stairs or elevator at pickup",
    "Asked about stairs or elevator at delivery",
    "Checked parking availability at both locations",
    "Assessed walking distance from truck to entrance",
    "Flagged long carry if distance exceeds standard limits",
    "Advised elevator booking if required",
    "Advised to include buffer time for elevator booking",
    "Explained impact of access on time and cost"
  ]},
  { title: "Packing & Add-On Services", items: [
    "Checked if customer prefers self-packing or company packing",
    "Acknowledged customer's packing preference clearly",
    "Offered packing materials for self-pack customers.",
    "If packing service requested, confirmed full or partial packing requirement",
    "Explained packing time inclusion in crew hours.",
    "Asked about dismantling and reassembly (beds, wardrobes, large furniture)",
    "Documented dismantling requirements",
    "Explained that dismantling/assembly affects time and estimate",
    "Offered packing tips or guidance for fragile items when relevant",
    "Recorded add-ons accurately in the system"
  ]},
  { title: "Pricing & Estimate \u2013 Local Moves", items: [
    "Explained pricing is based on hourly rate and crew size",
    "Explained billing start and end points clearly",
    "Linked estimate to inventory and access factors",
    "Provided time range, not guaranteed duration"
  ]},
  { title: "Pricing & Estimate \u2013 Long Distance", items: [
    "Explained pricing is based on shipment weight and distance",
    "Explained certified weigh station process",
    "Clarified labor vs transportation charges",
    "Explained delivery window vs fixed date"
  ]},
  { title: "TNVL Trust Builders & Transparency", items: [
    "Explained when billing starts (at loading, not during drive to pickup)",
    "Explained travel time calculation (using Google Maps)",
    "Explained that crews follow proper wrapping and protection procedures (As applicable)",
    "Reinforced that there are no hidden charges and pricing drivers are explained upfront",
    "Explained how crew work time is tracked and communicated",
    "Clarified that break time is not charged and timer is paused during breaks",
    "Positioned trust and visibility as part of TNVL service approach",
    "Delivered trust statements confidently and naturally (not scripted)"
  ]},
  { title: "Objection Handling - Trust & Credibility Objections", items: [
    "Addressed \"no / few reviews\" concern by explaining recent rebranding",
    "Clarified that crew and coordinators are experienced, not new to industry",
    "Highlighted structured planning and documentation",
    "Redirected conversation back to service process and next steps"
  ]},
  { title: "Objection Handling - Price & Value Objections", items: [
    "Clarified that estimates are based on inventory and access details",
    "Explained that planning helps avoid later price increases",
    "Did not criticize competitor pricing practices directly",
    "Positioned service quality and planning as value drivers",
    "Offered basic vs full service options where relevant",
    "Avoided negotiating price without reviewing service scope"
  ]},
  { title: "Objection Handling - Safety & Damage Concerns", items: [
    "Reassured with planning and correct crew sizing",
    "Explained use of proper padding, wrapping, and loading methods",
    "Encouraged disclosure of fragile or special items",
    "Confirmed special handling items are noted in move plan",
    "Clarified that issues are handled through office process, not just crew"
  ]},
  { title: "Objection Handling - Storage & Delivery Timing", items: [
    "Explained storage vs direct delivery",
    "Clarified why storage is charged from day one (handling and facilities)",
    "Did not claim competitor offers are misleading or wrong",
    "Explained delivery windows for long-distance moves",
    "Did not guarantee fixed delivery dates for standard service",
    "Offered alternatives (storage or dedicated truck) when firm dates required"
  ]},
  { title: "Objection Handling - Last-Minute / Short-Notice Moves", items: [
    "Acknowledged urgency without over-promising",
    "Explained limited availability of crews and trucks",
    "Did not guarantee service without verifying availability"
  ]},
  { title: "Objection Handling - Decision Delay / Comparison", items: [
    "Respected customer need to consult family or partner",
    "Offered to send estimate and move details for review",
    "Set clear follow-up timeline and next contact point",
    "Offered tentative date hold",
    "Did not disengage or end call without next steps"
  ]},
  { title: "Objection Handling - Charges, Valuation & Policies", items: [
    "Reassured that known cost factors are included upfront",
    "Explained that changes are discussed before move day",
    "Avoided unrealistic commitments",
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
    "Spoke clearly, confidently, and at an appropriate pace",
    "Used professional and customer-friendly language",
    "Avoided vague, unsure, or filler language",
    "Did not interrupt and listened actively to the customer",
    "Asked relevant probing questions to understand needs",
    "Showed empathy and reassurance during customer concerns",
    "Maintained a calm, respectful, and positive tone throughout the call",
    "Guided the conversation and kept it focused on next steps.",
    "Built rapport and trust using the customer\u2019s name and natural conversation",
    "Summarized key details and encouraged commitment or next steps",
    "Confidently responded to customer questions without deflection",
    "Did not sound dismissive, rushed, or irritated"
  ]},
  { title: "Tools Usage", items: [
    "Correct customer details verified and updated",
    "Move Section updated with all relevant details (Move Date, Address, Add on Services, Inventory List, Access details)",
    "Follow-up tasks created with correct timeline",
    "Call outcome updated correctly",
    "Estimate shared with the Customer (during the call/immediately after call)",
    "Clear notes updated on call discussion"
  ]}
];

function flattenChecklist() {
  const items = [];
  SECTIONS.forEach((sec, si) => sec.items.forEach((label, ii) => {
    items.push({ key: `r_${si}_${ii}`, section: sec.title, si, ii, label });
  }));
  return items;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Skip logic
// ══════════════════════════════════════════════════════════════════════════════
function buildSkipList(ctx) {
  const skip = new Set();
  const isLD       = ctx.moveType === 'longdistance';
  const isInbound  = ctx.isInboundCall === true;
  const isShort    = !ctx.callIsSubstantive;

  SECTIONS.forEach((sec, si) => {
    sec.items.forEach((_, ii) => {
      const key = `r_${si}_${ii}`;

      // ── Section 0: Call Opening ──────────────────────────────────────────
      // Wrong-number items (ii 2,5,6) → skip unless actually wrong number
      // Scheduled-callback item (ii 4) → skip if customer was available
      // Confirmed contact number (ii 3) → skip if no wrong number
      if (si === 0 && [2,3,5,6].includes(ii) && !ctx.wasWrongNumber) skip.add(key);
      if (si === 0 && ii === 4 && ctx.customerAvailable !== false)    skip.add(key);

      // ── Section 1: Permission & Agenda ──────────────────────────────────
      // "Not a good time" items (ii 4,5,6) → skip if customer engaged
      // For inbound calls: customer already called in, full agenda-setting not required
      if (si === 1 && [4,5,6].includes(ii) && ctx.customerAvailable !== false) skip.add(key);

      // ── Section 6: Packing ───────────────────────────────────────────────
      // Item 6 (Documented in system) → always skip (CRM action, not audible)
      // Item 9 (Recorded add-ons) → always skip (CRM action, not audible)
      if (si === 6 && ii === 6) skip.add(key);
      if (si === 6 && ii === 9) skip.add(key);

      // ── Section 7: Local Pricing → skip entirely for long distance ────────
      if (si === 7 && isLD) skip.add(key);

      // ── Section 8: Long Distance Pricing → skip entirely for local ────────
      if (si === 8 && !isLD) skip.add(key);

      // ── Section 9: Trust Builders ────────────────────────────────────────
      // Skip all for non-substantive calls only
      if (si === 9 && isShort) skip.add(key);

      // ── Sections 10-16: Objection Handling ──────────────────────────────
      // Skip the entire section ONLY if that specific objection was not raised
      if (si === 10 && !ctx.customerRaisedTrustObjection)    skip.add(key);
      if (si === 11 && !ctx.customerRaisedPriceObjection)    skip.add(key);
      if (si === 12 && !ctx.customerRaisedSafetyObjection)   skip.add(key);
      if (si === 13 && !ctx.customerRaisedStorageObjection)  skip.add(key);
      if (si === 14 && !ctx.customerRaisedUrgencyObjection)  skip.add(key);
      if (si === 15 && !ctx.customerAskedToDelay)            skip.add(key);
      if (si === 16 && !ctx.customerRaisedChargesObjection)  skip.add(key);

      // ── Section 17: Sale / Payment ───────────────────────────────────────
      // Skip entire section for non-substantive calls
      if (si === 17 && isShort) skip.add(key);
      // Items 5,6 (50% before loading, balance before unloading):
      // skip if payment was never discussed — these are specific steps
      if (si === 17 && [5,6].includes(ii) && !ctx.agentDiscussedPayment) skip.add(key);

      // ── Section 18: Pre-Move Confirmation ───────────────────────────────
      // Skip entirely unless agent explicitly discussed pre-move confirmation call
      if (si === 18 && !ctx.agentDiscussedPreMoveConf) skip.add(key);

      // ── Section 19: Cancellation ────────────────────────────────────────
      // Skip entirely unless customer actually requested cancellation
      if (si === 19 && !ctx.cancellationRequested) skip.add(key);

      // ── Section 21: Tools Usage → ALWAYS skip (CRM only, not audible) ───
      if (si === 21) skip.add(key);
    });
  });
  return skip;
}

// ══════════════════════════════════════════════════════════════════════════════
//  STEPS 3-5 (API CALLS 2/4, 3/4, 4/4): Rate checklist in 3 batches
//  Token-efficient: uses SUMMARY only (not full transcript) to stay within
//  Groq free-tier token limits per request
// ══════════════════════════════════════════════════════════════════════════════
async function rateChecklist(aiSummary, transcript, skipSet, allItems, ctx) {
  const toRate = allItems.filter(i => !skipSet.has(i.key));
  const third  = Math.ceil(toRate.length / 3);
  const batches = [
    toRate.slice(0, third),
    toRate.slice(third, third * 2),
    toRate.slice(third * 2)
  ];

  // Use summary as primary evidence (compact), add small transcript sample as backup
  // This dramatically reduces tokens per request, preventing rate-limit exhaustion
  const summaryInput = aiSummary ? aiSummary.substring(0, 2000) : '(no summary — use transcript)';
  // Only send a small transcript sample as backup context
  const txSample = transcript.substring(0, 3000);

  const sys = 'You are a call quality evaluator. Return ONLY valid JSON, no markdown.';

  function buildPrompt(batch) {
    const itemLines = batch.map(i => `"${i.key}": // [${i.section}] ${i.label}`).join('\n');
    return `You are a TNVL (True North Van Lines) call quality evaluator.
Use the AI Summary as your PRIMARY source of truth. The transcript is all SPK1 (single speaker label) — use it only for tone clues.

══ CALL CONTEXT ══
Move type       : ${ctx.moveType}
Call direction  : ${ctx.callDirection || 'outbound'}
Inventory disc. : ${ctx.inventoryWasDiscussed}
Packing disc.   : ${ctx.packingWasDiscussed}
Access disc.    : ${ctx.accessWasDiscussed}
Estimate given  : ${ctx.agentGaveEstimate}
Payment disc.   : ${ctx.agentDiscussedPayment}
On hold placed  : ${ctx.agentPlacedOnHold || false}
Call quality    : ${ctx.callQuality || 'good'}
Key facts       : ${ctx.summaryHighlights || 'see summary'}

TRUST BUILDER SIGNALS (true = explicitly confirmed in summary):
  Billing starts at loading    : ${(ctx.trustDetail || {}).billingStartExplicit || false}
  Travel time via Google Maps  : ${(ctx.trustDetail || {}).travelTimeGoogleMaps || false}
  Wrapping/protection explicit : ${(ctx.trustDetail || {}).wrappingExplicit || false}
  No hidden charges            : ${(ctx.trustDetail || {}).noHiddenCharges || false}
  Crew time tracking           : ${(ctx.trustDetail || {}).crewTimeTracking || false}
  Break time not charged       : ${(ctx.trustDetail || {}).breakTimeNotCharged || false}

PAYMENT SIGNALS (true = explicitly confirmed in summary):
  Deposit explained            : ${(ctx.paymentDetail || {}).depositExplained || false}
  Cancellation window          : ${(ctx.paymentDetail || {}).cancellationWindow || false}
  50% before loading           : ${(ctx.paymentDetail || {}).fiftyPercentBeforeLoading || false}
  Balance before unloading     : ${(ctx.paymentDetail || {}).balanceBeforeUnloading || false}

══ AI SUMMARY (read every bullet carefully) ══
${summaryInput}

══ TRANSCRIPT SAMPLE (tone/phrasing clues only) ══
${txSample}

══ THE 4 RATING VALUES — USE ALL OF THEM ══
"met"    = Summary clearly confirms agent did this. Be generous: if a topic was covered well, sub-items = "met".
"ni"     = Agent touched on it but incompletely or vaguely (partial credit).
"notmet" = Agent clearly SKIPPED or MISSED this step. Use this confidently when evidence is absent for important steps.
"skip"   = Does not apply to this call type (CRM-only items, wrong-number items, inapplicable sections).

══ THE DECISION TREE — follow in order ══

STEP A — Is this a CRM/system item? → always "skip"
  (Any label containing: "in system", "Documented in system", "Recorded in system", "updated in system")

STEP A2 — Is this section/topic simply NOT APPLICABLE to this specific call?
  Examples: Move Type sub-items when customer already knows what they want and agent just confirmed it
            Address sub-items for fields the customer didn't provide (e.g. delivery address not needed yet)
            Inventory sub-items that weren't relevant (e.g. "bed sizes" when customer has a studio flat)
            Access sub-items not relevant to this building type
  → "skip" (not "ni"). Only assess items that were realistically applicable to this call.

STEP B — Was this section/topic clearly covered in the summary?
  YES, THOROUGHLY → rate ALL sub-items "met" (do not downgrade to "ni" just because each sub-step isn't spelled out)
  PARTIALLY → rate partially-covered sub-items "ni"
  NOT AT ALL → see Step C

STEP C — Is this an IMPORTANT step that a trained agent should always do?
  YES and absent from summary → "notmet" (be decisive — important steps not mentioned = missed)
  NO, minor or optional detail → "ni"

══ SECTION-BY-SECTION RULES (derived from manual QA) ══

CALL OPENING (r_0_x):
  Summary says agent introduced themselves + greeted customer → ALL opening items = "met"
  Do NOT give "ni" just because the summary doesn't quote the exact words. If the call was professional and summary confirms opening → "met".

MOVE TYPE IDENTIFICATION (r_2_x):
  CRITICAL: Only assess the sub-items that were actually relevant to this call.
  • "Identified basic vs full-service" → "met" if agent confirmed this; "skip" if customer's preference was already clear at start of inbound call
  • "Explained basic moving inclusions" → "met" if agent explained it; "skip" if customer already knew and didn't need it explained
  • "Explained full-service inclusions" → "met" if agent explained it; "skip" if not relevant to this customer's choice
  • "Acknowledged customer preference" → "met" if agent confirmed the preference; always assess this one
  An inbound call where the customer already knows what they want = most Move Type items are "skip" except "Acknowledged preference".

PERMISSION & AGENDA (r_1_x):
  Outbound call with full agenda described in summary → "met" for all agenda items.
  "Set expectation of call duration" → "met" if summary shows agent explained what the call would cover.
  "Asked permission to proceed" → "met" if agent transitioned smoothly into the call.
  Only give "ni" if summary says the agent launched into questions WITHOUT any agenda-setting.

TRUST BUILDERS (r_9_x) — USE THE TRUST BUILDER SIGNALS ABOVE:
  CRITICAL: These signals are the definitive source of truth. Do NOT override them with your own inference from the summary.
  • Billing starts at loading → EXACTLY: "met" if billingStartExplicit = true; "notmet" if false
  • Travel time via Google Maps → EXACTLY: "met" if travelTimeGoogleMaps = true; "notmet" if false
  • Wrapping / protection procedures → EXACTLY: "met" if wrappingExplicit = true; "notmet" if false
  • No hidden charges → EXACTLY: "met" if noHiddenCharges = true; "notmet" if false
  • Crew work time tracked → EXACTLY: "met" if crewTimeTracking = true; "notmet" if false
  • Break time not charged → EXACTLY: "met" if breakTimeNotCharged = true; "notmet" if false
  • Billing transparency reinforced → "met" if any billing/pricing detail was explained (broad item — use summary)
  • Positioned TNVL confidently → "met" if agent presented company positively and professionally
  • Trust delivered naturally → "met" if callQuality = "good"; "ni" if callQuality = "issues"
  ⚠ NEVER give "ni" for the 6 signal-based items above. Only "met" or "notmet" based on the signal.

PAYMENT / BOOKING (r_17_x) — USE THE PAYMENT SIGNALS ABOVE:
  CRITICAL: When agentDiscussedPayment = true, treat all payment items as applicable (do NOT give "ni" — give "met" or "notmet").
  • Close attempt → "met" if agent tried to close/book at any point
  • Asked if customer wants to proceed → "met" if booking was discussed
  • Offered tentative slot → "met" if agent offered to hold a date/slot; "ni" if not mentioned but customer was hesitant; "skip" if customer was ready to book immediately
  • Deposit explained → EXACTLY: "met" if depositExplained = true; "notmet" if false AND payment discussed
  • Cancellation window → EXACTLY: "met" if cancellationWindow = true; "notmet" if false AND payment discussed
  • 50% payment before loading → EXACTLY: "met" if fiftyPercentBeforeLoading = true; "notmet" if false AND payment discussed
  • Balance before unloading → EXACTLY: "met" if balanceBeforeUnloading = true; "notmet" if false AND payment discussed
  • "Did not give conflicting payment info" → "met" unless summary explicitly shows confusion or contradictions
  ⚠ When payment was discussed, deposit/cancellation/50%/balance items are REQUIRED steps — absence = "notmet", not "ni".

INVENTORY (r_4_x):
  CRITICAL RULE — when a summary shows a thorough room-by-room walkthrough, rate ALL inventory sub-items as "met".
  Do NOT individually verify each sub-item against the summary if the overall inventory was clearly comprehensive.
  • Thorough room-by-room inventory in summary → ALL 9 sub-items = "met" (do NOT downgrade to "ni")
  • Summary shows partial/brief inventory → covered rooms "met", clearly missed areas "ni"
  • Sub-items like "asked about storage/garage", "confirmed appliances" → "met" if the inventory was thorough overall
  • "Checked if any items missed" and "Set follow-up if incomplete" → "met" if agent confirmed inventory and set next steps
  • "notmet" ONLY if the summary shows agent completely skipped inventory

ACCESS (r_5_x):
  CRITICAL RULE — when a summary confirms thorough access review, rate ALL assessed access sub-items "met".
  • Summary shows agent asked about access at both locations → ALL access sub-items = "met"
  • Summary mentions stairs/elevator/parking/walking distance → those specific items = "met"
  • "Flagged long carry", "Advised elevator booking", "Did not skip access" → "met" if access was covered generally
  • Do NOT give "ni" just because the summary uses general language like "discussed access" without itemizing each detail
  • "ni" only if a specific access area was clearly missed (e.g. asked about pickup but not delivery)

PACKING (r_6_x):
  Customer self-packing: "offered packing materials" = "met" if agent offered boxes/supplies; "ni" if not mentioned
  Company packing: "confirmed full/partial" = "met"; "offered materials" = "skip"
  "Packing time in crew hours" → "met" if explicitly explained; "ni" if not clearly stated
  "Packing tips for fragile items" → "met" if fragile tips given; "notmet" if fragile items discussed but no tips given; "ni" if fragile items not discussed

SOFT SKILLS (r_20_x):
  CRITICAL: callQuality signal is your guide. If callQuality = "good" → most items = "met". If "issues" → apply "ni" selectively.
  A professional, well-structured call → most items = "met"
  "ni" (NOT "notmet") for minor issues: occasional filler words, slight hesitation, once interrupted, slightly scripted
  "notmet" ONLY for clear failures: consistently rude, very confused throughout, aggressive filler words constantly
  Hold items (asked permission to hold, explained reason for hold):
    → "skip" if agentPlacedOnHold = false (agent never placed customer on hold)
    → "met" or "ni" if agentPlacedOnHold = true (rate based on how well it was done)
  "Interrupted customer" → "ni" if it happened occasionally; "met" if agent listened well throughout
  "Limited filler words", "professional varied language" → "met" if callQuality = "good"; "ni" if callQuality = "issues"
  ⚠ Do NOT give all 12 soft skill items "met" on a good call — use the hold items skip logic above. If agentPlacedOnHold = false, the 2 hold items are "skip".

══ ITEMS TO RATE (${batch.length} total) ══
${itemLines}

Return ONLY a JSON object with exactly ${batch.length} keys. No explanation, no markdown.`;
  }

  const results = [];
  for (let i = 0; i < batches.length; i++) {
    console.log(`  Batch ${i+1}: ${batches[i].length} items...`);
    const raw = await callGroq(sys, buildPrompt(batches[i]), 800, GROQ_MODEL_FAST);
    results.push(parseJSON(raw) || {});
    if (i < batches.length - 1) {
      console.log(`  ⏸  Waiting 12s before next batch...`);
      await delay(12000);
    }
  }

  return Object.assign({}, ...results);
}


// ── Fallback for any missing keys ─────────────────────────────────────────────
async function retryMissing(aiSummary, transcript, missingItems, ctx) {
  if (!missingItems.length) return {};
  console.log(`  ⚠️  ${missingItems.length} missing keys — fallback pass...`);
  const sys = 'You are a call quality evaluator. Return ONLY valid JSON, no markdown.';
  const itemLines = missingItems.map(i => `"${i.key}": // [${i.section}] ${i.label}`).join('\n');
  const prompt = `Rate these TNVL call items. AI Summary = primary truth. Return ALL ${missingItems.length} keys.

AI SUMMARY: ${aiSummary.substring(0, 2000)}
TRANSCRIPT: ${transcript.substring(0, 6000)}

ITEMS:
${itemLines}

Ratings: "met"/"ni"/"notmet"/"skip". If summary mentions a topic → "met". Return ONLY JSON.`;
  const raw = await callGroq(sys, prompt, 800, GROQ_MODEL_FAST);
  return parseJSON(raw) || {};
}

// ══════════════════════════════════════════════════════════════════════════════
//  Main orchestrator — exactly 4 API calls total (1 context + 3 batches)
// ══════════════════════════════════════════════════════════════════════════════
async function analyzeCall(rawText) {
  const allItems = flattenChecklist();

  // Step 1: Parse (NO API CALL)
  console.log('  Step 1: Parsing summary + transcript...');
  const { aiSummary, transcript } = parseCombinedText(rawText);
  console.log(`  Summary: ${aiSummary.length} chars | Transcript: ${transcript.length} chars`);

  // Step 2: Context analysis (API CALL #1)
  console.log('  Step 2: Context analysis...');
  const ctx = await analyzeContext(aiSummary, transcript);
  const skip = buildSkipList(ctx);
  const toRateItems = allItems.filter(i => !skip.has(i.key));
  console.log(`  Move: ${ctx.moveType} | Substantive: ${ctx.callIsSubstantive} | Skip: ${skip.size} | Rate: ${toRateItems.length}`);

  await delay(4000); // breathing room between calls

  // Steps 3-5: Rate in 3 batches (API CALLS #2, #3, #4)
  console.log('  Steps 3-5: Rating checklist (3 batches)...');
  const batchRatings = await rateChecklist(aiSummary, transcript, skip, allItems, ctx);

  // Fallback for missing keys (only if needed)
  const missingItems = toRateItems.filter(i => {
    const r = batchRatings[i.key];
    return !r || !['met','notmet','ni','skip'].includes(r);
  });
  let fallback = {};
  if (missingItems.length > 0) {
    await delay(4000);
    fallback = await retryMissing(aiSummary, transcript, missingItems, ctx);
  }

  // Merge ratings
  const ratings = {};
  allItems.forEach(({ key }) => {
    if (skip.has(key)) { ratings[key] = 'skip'; return; }
    const r = batchRatings[key] || fallback[key];
    ratings[key] = ['met','notmet','ni'].includes(r) ? r : 'skip';
  });

  const m  = Object.values(ratings).filter(r => r === 'met').length;
  const n  = Object.values(ratings).filter(r => r === 'notmet').length;
  const ni = Object.values(ratings).filter(r => r === 'ni').length;
  const sk = Object.values(ratings).filter(r => r === 'skip').length;
  console.log(`  ✅ met=${m} notmet=${n} ni=${ni} skip=${sk} | score=${Math.round(m/(m+n+ni||1)*100)}%`);
  return { ratings, ctx };
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/api/analyze-text', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });
  try {
    const start = Date.now();
    console.log(`\n▶ /api/analyze-text (${text.length} chars) | key: #${currentKeyIndex + 1}`);
    const { ratings, ctx } = await analyzeCall(text);
    console.log(`  ⏱ Done in ${((Date.now()-start)/1000).toFixed(1)}s`);
    return res.json({ ratings, context: ctx });
  } catch (err) {
    console.error('❌', err.message);
    if (err.message.startsWith('RATE_LIMIT:'))
      return res.status(429).json({ error: err.message, isRateLimit: true });
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
    const data = await r.json();
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
      tx = cd.content.map(s => `${s.Speaker || s.speaker || 'SPK1'}: ${s.text || s.Text || ''}`).join('\n');
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
  status: 'ok', version: 'v11',
  engine: `Groq — ${GROQ_KEYS.length} key(s)`,
  activeKey: `#${currentKeyIndex + 1}`,
  totalApiCallsPerAnalysis: 4,
  keys: GROQ_KEYS.map((k, i) => `Key #${i+1}: ${k.substring(0,8)}...`),
  port: process.env.PORT || 3000
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const total = SECTIONS.reduce((s, sec) => s + sec.items.length, 0);
  console.log(`\n✅ TNVL Server v11 → http://localhost:${PORT}`);
  console.log(`   Context model : ${GROQ_MODEL_SMART}`);
  console.log(`   Batch model   : ${GROQ_MODEL_FAST} (faster, lower tokens/min usage)`);
  console.log(`   Keys  : ${GROQ_KEYS.length} loaded`);
  GROQ_KEYS.forEach((k, i) => console.log(`     Key #${i+1}: ${k.substring(0,8)}...`));
  console.log(`   📋 Checklist: ${SECTIONS.length} sections, ${total} items`);
  console.log(`   🔢 API calls per analysis: 4 (summary-only batches, token-efficient) (1 context + 3 batches)`);
  console.log(`   ⚠️  NO speaker ID pass — AI Summary is primary source of truth\n`);
});