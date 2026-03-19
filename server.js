require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

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

if (!GROQ_KEYS.length) {
  console.error('\n❌ No Groq API keys found! Add at least GROQ_API_KEY_1 to your .env file.');
  console.error('   Get free keys at: https://console.groq.com/keys\n');
}

let currentKeyIndex = 0;

function getCurrentKey() { return GROQ_KEYS[currentKeyIndex]; }
function rotateKey() {
  const prev = currentKeyIndex;
  currentKeyIndex = (currentKeyIndex + 1) % GROQ_KEYS.length;
  console.log(`  🔄 Rotated from key #${prev + 1} → key #${currentKeyIndex + 1}`);
  return GROQ_KEYS[currentKeyIndex];
}

// ── FROM SERVER V1: Two models — smart for context, fast for batch rating ─────
const GROQ_MODEL = 'llama-3.3-70b-versatile'; // context analysis + batch 1
const GROQ_MODEL_B2 = 'llama-3.1-8b-instant';    // batch 2
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── callGroq with auto-rotation (from Server V1) ─────────────────────────────
async function callGroq(model, systemPrompt, userPrompt, maxTokens = 700) {
  if (!GROQ_KEYS.length) throw new Error('No Groq API keys configured. Add GROQ_API_KEY_1 to .env');

  let attempts = 0;
  const maxAttempts = GROQ_KEYS.length; // try each key once

  while (attempts < maxAttempts) {
    const apiKey = getCurrentKey();
    attempts++;

    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: maxTokens
      })
    });

    if (res.status === 429) {
      console.log(`  ⚠️  Key #${currentKeyIndex + 1} hit rate limit.`);
      if (GROQ_KEYS.length === 1) {
        throw new Error('RATE_LIMIT: Groq quota hit. Wait 30 seconds and try again. (Add more keys to .env to avoid this)');
      }
      if (attempts < maxAttempts) {
        rotateKey();
        await delay(500);
        continue;
      } else {
        throw new Error('RATE_LIMIT: All Groq API keys are rate-limited. Wait 1 minute and try again.');
      }
    }

    if (res.status === 401) throw new Error(`Key #${currentKeyIndex + 1} is invalid. Check GROQ_API_KEY_${currentKeyIndex + 1} in .env`);

    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(`Groq ${res.status}: ${e?.error?.message || 'unknown error'}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('Groq returned empty response. Please try again.');

    console.log(`  ✅ Response from key #${currentKeyIndex + 1}`);
    return text;
  }

  throw new Error('RATE_LIMIT: All Groq API keys exhausted. Wait a minute and try again.');
}

function parseJSON(raw) {
  const c = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(c); } catch (_) { }
  const m = c.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch (_) { }
  return null;
}

// ── FROM SERVER V1: Trim transcript to fit token budget ──────────────────────
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

// ── FROM SERVER V2: Parse AI Summary + Transcript from combined Transkriptor text
function parseCombinedText(rawText) {
  const lineBreak = /─{10,}/g;
  let aiSummary = '', transcript = '';

  const transcriptMarkers = ['🎙️ FULL TRANSCRIPT', 'FULL TRANSCRIPT', '🎙 FULL TRANSCRIPT'];
  const summaryMarkers = ['📝 AI SUMMARY', 'AI SUMMARY', '📝 SUMMARY'];

  let splitDone = false;
  for (const tMark of transcriptMarkers) {
    if (rawText.includes(tMark)) {
      const parts = rawText.split(tMark);
      let summaryPart = parts[0];
      for (const sMark of summaryMarkers) summaryPart = summaryPart.replace(sMark, '');
      aiSummary = summaryPart.replace(lineBreak, '').trim();
      transcript = parts[1] ? parts[1].replace(lineBreak, '').trim() : '';
      splitDone = true;
      break;
    }
  }

  if (!splitDone) {
    const firstSpkMatch = rawText.match(/\n(SPK\d+:|Agent:|Customer:)/);
    if (firstSpkMatch && firstSpkMatch.index > 200) {
      const idx = firstSpkMatch.index;
      let summaryPart = rawText.substring(0, idx);
      for (const sMark of summaryMarkers) summaryPart = summaryPart.replace(sMark, '');
      aiSummary = summaryPart.replace(lineBreak, '').trim();
      transcript = rawText.substring(idx).replace(lineBreak, '').trim();
      splitDone = true;
    }
  }

  if (!splitDone) transcript = rawText;

  const spkLines = (transcript.match(/^SPK\d+:/gm) || []).length;
  console.log(`  Summary: ${aiSummary.length} chars | Transcript: ${transcript.length} chars | SPK lines: ${spkLines}`);
  if (!aiSummary) console.log(`  ⚠️  No AI Summary found — transcript-only mode`);

  return { aiSummary, transcript };
}

// ════════════════════════════════════════════════════════════════════════════════
//  SECTIONS — kept from Server V2 (matches frontend exactly)
// ════════════════════════════════════════════════════════════════════════════════
const SECTIONS = [
  {
    title: "Call Opening & Contact Verification", items: [
      "Introduced self with agent name and company name",
      "Used a professional greeting, addressed the customer by name, and confirmed identity.",
      "If wrong person, requested best callback time politely",
      "Confirmed correct contact number when applicable",
      "Scheduled callback when customer was unavailable",
      "If wrong number, politely closed the call",
      "Logged wrong number and informed team lead/vendor (as applicable)"
    ]
  },
  {
    title: "Permission & Call Agenda Setting", items: [
      "Clearly stated purpose of call (quote request / move discussion)",
      "Explained what will be covered during the call (move details + inventory)",
      "Set expectation of call duration (approx. time required)",
      "Asked for permission to proceed",
      "If not a good time, accepted politely and did not push",
      "Confirmed callback timing clearly",
      "Scheduled callback at customer-preferred time"
    ]
  },
  {
    title: "Move Type Identification (Basic vs End-to-End Support)", items: [
      "Identified whether customer needs basic or full-service moving.",
      "Explained inclusions of basic moving as required (Loading, Transport, Unloading)",
      "Explained inclusions of full-service moving as required (Packing, Dismantling/Assembling, Loading, Transport and Unloading)",
      "Acknowledged and confirmed customer preference"
    ]
  },
  {
    title: "Address & Move Date Capture", items: [
      "Captured complete pickup address",
      "Captured complete delivery address",
      "Confirmed move date clearly",
      "Checked flexibility on dates"
    ]
  },
  {
    title: "Inventory Capture (Room-to-Room)", items: [
      "Explained the importance of inventory for accurate pricing",
      "Followed structured room-to-room approach",
      "Covered all major rooms (living, bedrooms, kitchen)",
      "Asked about storage, garage, balcony, and outdoor items",
      "Probed for bulky, fragile, or special items",
      "Confirmed bed sizes and major furniture dimensions where relevant",
      "Confirmed appliances to be moved",
      "Checked if any items were missed",
      "Set clear follow-up if inventory was incomplete"
    ]
  },
  {
    title: "Access & Constraints (Time & Cost Impact)", items: [
      "Asked about stairs or elevator at pickup",
      "Asked about stairs or elevator at delivery",
      "Checked parking availability at both locations",
      "Assessed walking distance from truck to entrance",
      "Flagged long carry if distance exceeds standard limits",
      "Advised elevator booking if required",
      "Advised to include buffer time for elevator booking",
      "Explained impact of access on time and cost"
    ]
  },
  {
    title: "Packing & Add-On Services", items: [
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
    ]
  },
  {
    title: "Pricing & Estimate – Local Moves", items: [
      "Explained pricing is based on hourly rate and crew size",
      "Explained billing start and end points clearly",
      "Linked estimate to inventory and access factors",
      "Provided time range, not guaranteed duration"
    ]
  },
  {
    title: "Pricing & Estimate – Long Distance", items: [
      "Explained pricing is based on shipment weight and distance",
      "Explained certified weigh station process",
      "Clarified labor vs transportation charges",
      "Explained delivery window vs fixed date"
    ]
  },
  {
    title: "TNVL Trust Builders & Transparency", items: [
      "Explained when billing starts (at loading, not during drive to pickup)",
      "Explained travel time calculation (using Google Maps)",
      "Explained that crews follow proper wrapping and protection procedures (As applicable)",
      "Reinforced that there are no hidden charges and pricing drivers are explained upfront",
      "Explained how crew work time is tracked and communicated",
      "Clarified that break time is not charged and timer is paused during breaks",
      "Positioned trust and visibility as part of TNVL service approach",
      "Delivered trust statements confidently and naturally (not scripted)"
    ]
  },
  {
    title: "Objection Handling - Trust & Credibility Objections", items: [
      "Addressed \"no / few reviews\" concern by explaining recent rebranding",
      "Clarified that crew and coordinators are experienced, not new to industry",
      "Highlighted structured planning and documentation",
      "Redirected conversation back to service process and next steps"
    ]
  },
  {
    title: "Objection Handling - Price & Value Objections", items: [
      "Clarified that estimates are based on inventory and access details",
      "Explained that planning helps avoid later price increases",
      "Did not criticize competitor pricing practices directly",
      "Positioned service quality and planning as value drivers",
      "Offered basic vs full service options where relevant",
      "Avoided negotiating price without reviewing service scope"
    ]
  },
  {
    title: "Objection Handling - Safety & Damage Concerns", items: [
      "Reassured with planning and correct crew sizing",
      "Explained use of proper padding, wrapping, and loading methods",
      "Encouraged disclosure of fragile or special items",
      "Confirmed special handling items are noted in move plan",
      "Clarified that issues are handled through office process, not just crew"
    ]
  },
  {
    title: "Objection Handling - Storage & Delivery Timing", items: [
      "Explained storage vs direct delivery",
      "Clarified why storage is charged from day one (handling and facilities)",
      "Did not claim competitor offers are misleading or wrong",
      "Explained delivery windows for long-distance moves",
      "Did not guarantee fixed delivery dates for standard service",
      "Offered alternatives (storage or dedicated truck) when firm dates required"
    ]
  },
  {
    title: "Objection Handling - Last-Minute / Short-Notice Moves", items: [
      "Acknowledged urgency without over-promising",
      "Explained limited availability of crews and trucks",
      "Did not guarantee service without verifying availability"
    ]
  },
  {
    title: "Objection Handling - Decision Delay / Comparison", items: [
      "Respected customer need to consult family or partner",
      "Offered to send estimate and move details for review",
      "Set clear follow-up timeline and next contact point",
      "Offered tentative date hold",
      "Did not disengage or end call without next steps"
    ]
  },
  {
    title: "Objection Handling - Charges, Valuation & Policies", items: [
      "Reassured that known cost factors are included upfront",
      "Explained that changes are discussed before move day",
      "Avoided unrealistic commitments",
      "Explained valuation as weight-based industry standard",
      "Avoided overselling additional insurance",
      "Reinforced prevention through planning and handling"
    ]
  },
  {
    title: "Sale Technique - Booking & Payment Process", items: [
      "Attempted to close after sharing estimate",
      "Asked clearly if customer would like to proceed with booking",
      "Offered tentative slot if customer hesitated",
      "Explained deposit amount and purpose clearly",
      "Explained cancellation window linked to deposit",
      "Explained 50% payment before loading at place of Origin",
      "Explained balance payment timing correctly (before unloading)",
      "Did not give unclear or conflicting payment information"
    ]
  },
  {
    title: "Pre-Move Confirmation Process", items: [
      "Informed customer about pre-move confirmation call",
      "Informed that the pre-move confirmation call will be 3 days prior to actual move date",
      "Explained purpose of confirmation call",
      "Confirmed best contact number",
      "Confirmed preferred time for confirmation call",
      "Explained importance of confirmation for crew dispatch",
      "Reinforced updating inventory if changes occur"
    ]
  },
  {
    title: "Cancellation & Reschedule Management", items: [
      "Acknowledged cancellation request with empathy",
      "Asked reason before processing cancellation",
      "Attempted save if issue was objection-related",
      "Offered reschedule where appropriate",
      "Explained cancellation charges as per policy",
      "Did not pressure after final decision",
      "Confirmed cancellation process and next steps"
    ]
  },
  {
    title: "Soft Skills & Customer Experience", items: [
      "Spoke clearly, confidently, and at an appropriate pace",
      "Used professional and customer-friendly language",
      "Avoided vague, unsure, or filler language",
      "Did not interrupt and listened actively to the customer",
      "Asked relevant probing questions to understand needs",
      "Showed empathy and reassurance during customer concerns",
      "Maintained a calm, respectful, and positive tone throughout the call",
      "Guided the conversation and kept it focused on next steps.",
      "Built rapport and trust using the customer's name and natural conversation",
      "Summarized key details and encouraged commitment or next steps",
      "Confidently responded to customer questions without deflection",
      "Did not sound dismissive, rushed, or irritated"
    ]
  },
  {
    title: "Tools Usage", items: [
      "Correct customer details verified and updated",
      "Move Section updated with all relevant details (Move Date, Address, Add on Services, Inventory List, Access details)",
      "Follow-up tasks created with correct timeline",
      "Call outcome updated correctly",
      "Estimate shared with the Customer (during the call/immediately after call)",
      "Clear notes updated on call discussion"
    ]
  }
];

function flattenChecklist() {
  const items = [];
  SECTIONS.forEach((sec, si) => sec.items.forEach((label, ii) => {
    items.push({ key: `r_${si}_${ii}`, section: sec.title, si, ii, label });
  }));
  return items;
}

// ════════════════════════════════════════════════════════════════════════════════
//  FROM SERVER V1: Context Analysis (simple, direct)
// ════════════════════════════════════════════════════════════════════════════════
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
  "trustBuildingWasDiscussed": true or false,
  "callIsSubstantive": true or false,
  "isInboundCall": true or false
}`;

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
    accessWasDiscussed: false, trustBuildingWasDiscussed: false,
    callIsSubstantive: true, isInboundCall: false
  };
}

// ════════════════════════════════════════════════════════════════════════════════
//  Skip logic — from Server V2 (matches V2 SECTIONS indices)
// ════════════════════════════════════════════════════════════════════════════════
function buildSkipList(ctx) {
  const skip = new Set();
  const isLD = ctx.moveType === 'longdistance';
  const isShort = !ctx.callIsSubstantive;

  SECTIONS.forEach((sec, si) => {
    sec.items.forEach((_, ii) => {
      const key = `r_${si}_${ii}`;

      // Section 0: Call Opening
      if (si === 0 && [2, 3, 5, 6].includes(ii) && !ctx.wasWrongNumber) skip.add(key);
      if (si === 0 && ii === 4 && ctx.customerAvailable !== false) skip.add(key);

      // Section 1: Permission & Agenda
      if (si === 1 && [4, 5, 6].includes(ii) && ctx.customerAvailable !== false) skip.add(key);

      // Section 6: Packing — CRM-only items always skip
      if (si === 6 && ii === 6) skip.add(key);
      if (si === 6 && ii === 9) skip.add(key);

      // Section 7: Local pricing → skip for long distance
      if (si === 7 && isLD) skip.add(key);

      // Section 8: Long distance pricing → skip for local
      if (si === 8 && !isLD) skip.add(key);

      // Section 9: Trust builders → skip for non-substantive calls
      if (si === 9 && isShort) skip.add(key);

      // Sections 10–16: Objection handling
      if (si === 10 && !ctx.customerRaisedTrustObjection) skip.add(key);
      if (si === 11 && !ctx.customerRaisedPriceObjection) skip.add(key);
      if (si === 12 && !ctx.customerRaisedSafetyObjection) skip.add(key);
      if (si === 13 && !ctx.customerRaisedStorageObjection) skip.add(key);
      if (si === 14 && !ctx.customerRaisedUrgencyObjection) skip.add(key);
      if (si === 15 && !ctx.customerAskedToDelay) skip.add(key);
      if (si === 16 && !ctx.customerRaisedChargesObjection) skip.add(key);

      // Section 17: Sale / Payment
      if (si === 17 && isShort) skip.add(key);
      if (si === 17 && [5, 6].includes(ii) && !ctx.agentDiscussedPayment) skip.add(key);

      // Section 18: Pre-Move Confirmation
      if (si === 18 && !ctx.agentDiscussedPreMoveConf) skip.add(key);

      // Section 19: Cancellation
      if (si === 19 && !ctx.cancellationRequested) skip.add(key);

      // Section 21: Tools Usage — ALWAYS skip for AI (Manual Rating Only)
      if (si === 21) skip.add(key);
    });
  });
  return skip;
}

// ════════════════════════════════════════════════════════════════════════════════
//  FROM SERVER V1: Rate checklist in 2 batches with simple prompts
// ════════════════════════════════════════════════════════════════════════════════
async function rateChecklist(transcript, skipSet, allItems, ctx) {
  const toRate = allItems.filter(i => !skipSet.has(i.key));
  const half = Math.ceil(toRate.length / 2);
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

RATING RULES:
"met"    → Agent clearly did this (direct evidence in transcript)
"notmet" → Topic was relevant AND agent clearly failed to do it
"ni"     → Agent attempted but execution was poor/incomplete
"skip"   → Topic didn't come up, not enough evidence, or you're unsure

When in doubt → use "skip". Never penalize unfairly.

Return JSON: {"r_X_X": "met", ...}
Include ALL ${batch.length} keys. Return ONLY the JSON object.`;
  }

  console.log(`  Batch 1: ${batch1.length} items...`);
  const raw1 = await callGroq(GROQ_MODEL, sys, buildBatchPrompt(batch1), 800);
  const result1 = parseJSON(raw1) || {};

  console.log(`  Waiting 3s between batches...`);
  await delay(3000);

  console.log(`  Batch 2: ${batch2.length} items...`);
  const raw2 = await callGroq(GROQ_MODEL_B2, sys, buildBatchPrompt(batch2), 800);
  const result2 = parseJSON(raw2) || {};

  return { ...result1, ...result2 };
}

// ════════════════════════════════════════════════════════════════════════════════
//  FROM SERVER V1: Main orchestrator — 3 API calls total (1 context + 2 batches)
//  Combined with Server V2's parseCombinedText to handle AI Summary + Transcript
// ════════════════════════════════════════════════════════════════════════════════
async function analyzeCall(callText) {
  const allItems = flattenChecklist();

  // Step 1: Parse AI Summary + Transcript from combined Transkriptor text (V2 feature)
  console.log('  Step 1: Parsing summary + transcript...');
  const { aiSummary, transcript } = parseCombinedText(callText);

  // Build combined text and sample it (V1 approach)
  const combined = aiSummary
    ? `AI SUMMARY:\n${aiSummary}\n\nFULL TRANSCRIPT:\n${transcript}`
    : transcript;
  const sampledText = sampleTranscript(combined, 8500);
  console.log(`  Input: ${callText.length} chars → sampled ${sampledText.length} chars`);

  // Step 2: Context analysis (V1 — simple, direct)
  console.log('  Pass 1: context analysis...');
  const ctx = await analyzeContext(sampledText);
  const skip = buildSkipList(ctx);
  console.log(`  Context: ${ctx.moveType} | ${ctx.callDirection}`);
  console.log(`  Skipping ${skip.size} items → rating ${allItems.length - skip.size} items`);

  // Step 3: Rate checklist in 2 batches (V1 — simple prompts)
  console.log('  Pass 2: rating checklist (2 batches)...');
  const batchRatings = await rateChecklist(sampledText, skip, allItems, ctx);

  // Merge ratings
  const ratings = {};
  allItems.forEach(({ key }) => {
    if (skip.has(key)) {
      ratings[key] = 'skip';
    } else {
      const r = batchRatings[key];
      ratings[key] = ['met', 'notmet', 'ni'].includes(r) ? r : 'skip';
    }
  });

  const m = Object.values(ratings).filter(r => r === 'met').length;
  const n = Object.values(ratings).filter(r => r === 'notmet').length;
  const ni = Object.values(ratings).filter(r => r === 'ni').length;
  const sk = Object.values(ratings).filter(r => r === 'skip').length;
  console.log(`  ✅ met=${m} notmet=${n} ni=${ni} skip=${sk} | ${Math.round(m / (m + n + ni || 1) * 100)}%`);

  return { ratings, ctx };
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.post('/api/analyze-text', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });
  try {
    const start = Date.now();
    console.log(`\n▶ /api/analyze-text (${text.length} chars) | active key: #${currentKeyIndex + 1}`);
    const { ratings, ctx } = await analyzeCall(text);
    console.log(`  ⏱ Done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
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
          .replace(/<\/p>/gi, '\n').replace(/<\/li>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
          .replace(/<strong>(.*?)<\/strong>/gi, '$1').replace(/<li>/gi, '  • ')
          .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      } catch (_) { }
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
  version: 'v12-merged',
  engine: `Groq — ${GROQ_KEYS.length} key(s) loaded`,
  ratingLogic: 'Server V1 (2-batch, simple prompts)',
  activeKey: `#${currentKeyIndex + 1}`,
  totalApiCallsPerAnalysis: 3,
  keys: GROQ_KEYS.map((k, i) => `Key #${i + 1}: ${k.substring(0, 8)}...`),
  port: process.env.PORT || 3000
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const total = SECTIONS.reduce((s, sec) => s + sec.items.length, 0);
  console.log(`\n✅ TNVL Server v12-merged → http://localhost:${PORT}`);
  console.log(`   Structure  : Server V2 (static files, routes, SECTIONS)`);
  console.log(`   Rating     : Server V1 (2 batches, simple prompts, direct transcript)`);
  console.log(`   Context    : ${GROQ_MODEL} (smart model)`);
  console.log(`   Batch 1    : ${GROQ_MODEL} (smart model)`);
  console.log(`   Batch 2    : ${GROQ_MODEL_B2} (fast model)`);
  console.log(`   Keys loaded: ${GROQ_KEYS.length}`);
  GROQ_KEYS.forEach((k, i) => console.log(`     Key #${i + 1}: ${k.substring(0, 8)}...`));
  console.log(`   📋 Checklist: ${SECTIONS.length} sections, ${total} items`);
  console.log(`   🔢 API calls per analysis: 3 (1 context + 2 rating batches)\n`);
});

// ── Email Sending Endpoint ───────────────────────────────────────────────────
app.post('/api/send-report-email', async (req, res) => {
  const { email, csvContent, fileName, htmlContent } = req.body;

  if (!email || !csvContent) {
    return res.status(400).json({ error: 'Email and CSV content are required' });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT,
      secure: process.env.EMAIL_PORT == 465, // true for 465, false for others
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const mailOptions = {
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: email,
      subject: `Report: ${fileName || 'Agent Summary'}`,
      text: `Please find the attached report: ${fileName || 'Agent Summary'}`,
      html: htmlContent || `<p>Please find the attached report: ${fileName || 'Agent Summary'}</p>`,
      attachments: [
        {
          filename: fileName || 'AgentSummary.csv',
          content: csvContent,
        },
      ],
    };

    await transporter.sendMail(mailOptions);
    res.json({ success: true, message: 'Email sent successfully' });
  } catch (error) {
    console.error('❌ Email Error:', error);
    res.status(500).json({ error: 'Failed to send email', details: error.message });
  }
});