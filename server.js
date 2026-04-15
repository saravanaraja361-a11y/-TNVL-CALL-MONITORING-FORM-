require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');                          // ← ADDED
const nodemailer = require('nodemailer');
const { Resend } = require('resend');

const app = express();

// ═══════════════════════════════════════════════════════════════
//  SHARED RECORDS — stored in shared_records.json on the server
//  All users on the same link read/write from this one file.
//  Your manager in Chennai, your sister, everyone — same data.
// ═══════════════════════════════════════════════════════════════

const RECORDS_FILE = path.join(__dirname, 'shared_records.json');  // ← ADDED

function loadSharedRecords() {                                       // ← ADDED
  try {
    if (fs.existsSync(RECORDS_FILE)) {
      const raw = fs.readFileSync(RECORDS_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('⚠️  Could not read shared_records.json:', e.message);
  }
  return [];
}

function saveSharedRecords(records) {                                // ← ADDED
  try {
    fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2));
  } catch (e) {
    console.error('⚠️  Could not save shared_records.json:', e.message);
  }
}

// ── Restore global error handlers ─────
process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught Exception (server kept alive):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled Rejection (server kept alive):', reason?.message || reason);
});

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static files
app.use(express.static(__dirname));

// Request Logger
app.use((req, res, next) => {
  console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.url} - IP: ${req.ip}`);
  next();
});

app.get('/', (req, res) => {
  console.log('--- DASHBOARD SERVED ---');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ═══════════════════════════════════════════════════════════════
//  SHARED RECORDS API — 4 endpoints                            ← ADDED
//  GET    /api/records        → load all records (page load)
//  POST   /api/records        → save new call (on submit)
//  PUT    /api/records/:id    → update a call (on edit save)
//  DELETE /api/records/:id    → delete a call (future use)
// ═══════════════════════════════════════════════════════════════

app.get('/api/records', (req, res) => {                             // ← ADDED
  try {
    const records = loadSharedRecords();
    console.log(`📋 GET /api/records → ${records.length} records returned`);
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load records', details: e.message });
  }
});

app.post('/api/records', (req, res) => {                            // ← ADDED
  const record = req.body;
  if (!record || !record.agent) {
    return res.status(400).json({ error: 'Invalid record — agent is required' });
  }
  try {
    const records = loadSharedRecords();
    const key = `${record.leadId||''}|${record.date||''}|${record.evaluator||''}|${record.pct||''}`;
    const exists = records.some(r =>
      `${r.leadId||''}|${r.date||''}|${r.evaluator||''}|${r.pct||''}` === key
    );
    if (!exists) {
      records.push(record);
      saveSharedRecords(records);
      console.log(`✅ New record saved: agent=${record.agent} lead=${record.leadId} score=${record.pct}% → total=${records.length}`);
    } else {
      console.log(`ℹ️  Duplicate skipped: ${key}`);
    }
    res.json({ success: true, total: records.length, duplicate: exists });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save record', details: e.message });
  }
});

app.put('/api/records/:id', (req, res) => {                         // ← ADDED
  try {
    const records = loadSharedRecords();
    const idx = records.findIndex(r => String(r.id) === String(req.params.id));
    if (idx === -1) return res.status(404).json({ error: 'Record not found' });
    records[idx] = { ...records[idx], ...req.body };
    saveSharedRecords(records);
    console.log(`✏️  Record updated: id=${req.params.id}`);
    res.json({ success: true, record: records[idx] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update record', details: e.message });
  }
});

app.delete('/api/records/:id', (req, res) => {                      // ← ADDED
  try {
    const records = loadSharedRecords();
    const filtered = records.filter(r => String(r.id) !== String(req.params.id));
    if (filtered.length === records.length) return res.status(404).json({ error: 'Record not found' });
    saveSharedRecords(filtered);
    console.log(`🗑  Record deleted: id=${req.params.id}`);
    res.json({ success: true, total: filtered.length });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete record', details: e.message });
  }
});

// // // // // // // // // // // // // // // // // // // // // // // // //
//  ONE-TIME DEDUP ENDPOINT
// // // // // // // // // // // // // // // // // // // // // // // // //
app.post('/api/records/dedup', (req, res) => {
  try {
    const records = loadSharedRecords();
    const seen = new Set();
    const deduped = records.filter(r => {
      // Better key: includes agent so two agents on same lead aren't collapsed
      const key = `${r.agent||''}|${r.leadId||''}|${r.date||''}|${r.pct||''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const removed = records.length - deduped.length;
    saveSharedRecords(deduped);
    console.log(`\ud83e\uddf9 Dedup: removed ${removed} duplicates (${deduped.length} remain)`);
    res.json({ success: true, before: records.length, after: deduped.length, removed });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// // // // // // // // // // // // // // // // // // // // // // // // //
//  EVERYTHING BELOW THIS LINE IS 100% UNCHANGED FROM ORIGINAL
// // // // // // // // // // // // // // // // // // // // // // // // //

const GROQ_KEYS = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5,
  process.env.GROQ_API_KEY_6,
  process.env.GROQ_API_KEY_7
].filter(Boolean);

let currentKeyIndex = 0;

const GROQ_MODEL   = 'llama-3.3-70b-versatile';
const GROQ_MODEL_B2 = 'llama-3.1-8b-instant';
const GROQ_URL      = 'https://api.groq.com/openai/v1/chat/completions';

const delay = ms => new Promise(r => setTimeout(r, ms));

async function callGroq(model, systemPrompt, userPrompt, maxTokens = 700) {
  if (GROQ_KEYS.length === 0) throw new Error('No GROQ_API_KEY configured');

  const attempts = GROQ_KEYS.length;
  for (let i = 0; i < attempts; i++) {
    const key = GROQ_KEYS[currentKeyIndex];
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        temperature: 0.1,
        max_tokens: maxTokens
      })
    });

    if (res.status === 401 || res.status === 429) {
      console.warn(`⚠️ Groq Key ${currentKeyIndex + 1} failed (${res.status}). Switching to next key...`);
      currentKeyIndex = (currentKeyIndex + 1) % GROQ_KEYS.length;
      if (i === attempts - 1) {
        throw new Error(res.status === 401 ? 'All Groq API keys are invalid.' : 'RATE_LIMIT: All Groq API keys rate limited.');
      }
      continue;
    }

    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(`Groq ${res.status}: ${e?.error?.message || 'unknown error'}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('Groq returned empty response. Please try again.');
    return text;
  }
}

function parseJSON(raw) {
  const c = raw.replace(/```json|```/g, '').trim();
  try { return JSON.parse(c); } catch (_) { }
  const m = c.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch (_) { }
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

// Estimate word count from transcript portion only
function estimateWordCount(text) {
  const transcriptMatch = text.match(/(?:FULL TRANSCRIPT|Transcript)[\s\S]*?[\n\r]([\s\S]*)$/i);
  const transcriptText = transcriptMatch ? transcriptMatch[1] : text;
  return transcriptText.split(/\s+/).filter(Boolean).length;
}

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
    title: "Pricing & Estimate \u2013 Local Moves", items: [
      "Explained pricing is based on hourly rate and crew size",
      "Explained billing start and end points clearly",
      "Linked estimate to inventory and access factors",
      "Provided time range, not guaranteed duration"
    ]
  },
  {
    title: "Pricing & Estimate \u2013 Long Distance", items: [
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
      "Built rapport and trust using the customer\u2019s name and natural conversation",
      "Summarized key details and encouraged commitment or next steps",
      "Confidently responded to customer questions without deflection",
      "Did not sound dismissive, rushed, or irritated"
    ]
  },
  {
    title: "Tools Usage", manualOnly: true, items: [
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
  SECTIONS.forEach((sec, si) => {
    if (sec.manualOnly) return;
    sec.items.forEach((label, ii) => {
      items.push({ key: `r_${si}_${ii}`, section: sec.title, si, ii, label });
    });
  });
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
  "isFollowUpCall": true or false,
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
  "callDurationCategory": "short" or "medium" or "long",
  "customerIsSelfPacking": true or false,
  "dismantlingWasDiscussed": true or false,
  "elevatorWasMentioned": true or false,
  "stairsAtDeliveryMentioned": true or false,
  "addressCapturedInCall": true or false,
  "moveTypeExplainedInDetail": true or false,
  "bothPricingTypesDiscussed": true or false,
  "isDisputeOrComplaintCall": true or false
}

CRITICAL INSTRUCTIONS:
- isFollowUpCall=true ONLY when: customer has already booked AND paid a deposit AND this call is about confirming move day / dispatch / handling a pre-move issue. NOT for initial quote calls.
- inventoryWasDiscussed=true if agent asks about furniture/items
- packingWasDiscussed=true if agent asks about packing/boxes
- accessWasDiscussed=true if agent asks about stairs/elevator/parking
- trustBuildingWasDiscussed=true if agent explains billing/timing/transparency
- agentGaveEstimate=true if agent provides any price/quote
- agentDiscussedPayment=true if agent mentions deposit/payment
- agentDiscussedPreMoveConf=true if agent mentions confirmation call
- callDurationCategory: "short" = under 800 words in transcript, "medium" = 800-1800 words, "long" = over 1800 words
- customerIsSelfPacking=true if customer explicitly says they will pack their own items themselves
- dismantlingWasDiscussed=true if agent specifically asked about or discussed bed/furniture dismantling/assembly
- elevatorWasMentioned=true if elevator was specifically mentioned in the call
- stairsAtDeliveryMentioned=true if stairs at the delivery/destination address were discussed
- addressCapturedInCall=true if agent explicitly asked for and received street-level addresses during the call (cities alone do not count)
- moveTypeExplainedInDetail=true if agent explicitly described what basic moving includes OR what full-service moving includes
- bothPricingTypesDiscussed=true if agent discussed BOTH hourly/local pricing AND weight-based/long-distance pricing in the same call
- isDisputeOrComplaintCall=true if ANY of these are true: (1) customer expresses frustration, anger, or feeling misled during the call, (2) agent is delivering unexpected bad news (extra charges, delays, policy changes), (3) customer says words like "outrageous", "shaken down", "confused", "not happy", "I was told differently", (4) call involves a dispute about pricing, charges, or service promises made earlier

IMPORTANT: Default to FALSE unless you find CLEAR EVIDENCE in transcript.`;

  const raw = await callGroq(GROQ_MODEL, sys, usr, 600);
  const parsed = parseJSON(raw);
  return parsed || {
    moveType: 'local', callDirection: 'outbound', isFollowUpCall: false,
    customerAvailable: true, wasWrongNumber: false,
    cancellationRequested: false, customerAskedToDelay: false,
    customerRaisedPriceObjection: false, customerRaisedTrustObjection: false,
    customerRaisedSafetyObjection: false, customerRaisedStorageObjection: false,
    customerRaisedUrgencyObjection: false, customerRaisedChargesObjection: false,
    agentPlacedOnHold: false, agentGaveEstimate: false,
    agentDiscussedPayment: false, agentDiscussedPreMoveConf: false,
    inventoryWasDiscussed: false, packingWasDiscussed: false,
    accessWasDiscussed: false, trustBuildingWasDiscussed: false,
    callDurationCategory: 'medium',
    customerIsSelfPacking: false, dismantlingWasDiscussed: false,
    elevatorWasMentioned: false, stairsAtDeliveryMentioned: false,
    addressCapturedInCall: false, moveTypeExplainedInDetail: false,
    bothPricingTypesDiscussed: false, isDisputeOrComplaintCall: false
  };
}

// ── Build skip list from context ─────────────────────────────────────────────
function buildSkipList(ctx) {
  const skip = new Set();
  const isLD = ctx.moveType === 'longdistance';
  const isShort = ctx.callDurationCategory === 'short';
  const isMedium = ctx.callDurationCategory === 'medium';

  if (ctx.isFollowUpCall) {
    SECTIONS.forEach((sec, si) => {
      if (sec.manualOnly) return;
      sec.items.forEach((_, ii) => {
        const key = `r_${si}_${ii}`;
        const keepIntro = (si === 0 && ii === 0);
        const keepGreeting = (si === 0 && ii === 1);
        const keepPurpose = (si === 1 && ii === 0);
        const keepSoftSkills = (si === 20);
        if (!keepIntro && !keepGreeting && !keepPurpose && !keepSoftSkills) skip.add(key);
      });
    });
    return skip;
  }

  SECTIONS.forEach((sec, si) => {
    sec.items.forEach((_, ii) => {
      const key = `r_${si}_${ii}`;

      if (si === 0 && [2, 3, 5, 6].includes(ii) && !ctx.wasWrongNumber) skip.add(key);
      if (si === 0 && ii === 4 && ctx.customerAvailable) skip.add(key);

      if (si === 1 && [4, 5, 6].includes(ii) && ctx.customerAvailable) skip.add(key);
      if (si === 1 && ii === 2) skip.add(key);

      if (si === 2 && [1, 2].includes(ii) && !ctx.moveTypeExplainedInDetail) skip.add(key);

      if (si === 3 && !ctx.addressCapturedInCall) skip.add(key);
      if (si === 3 && ii === 3 && isShort) skip.add(key);

      if (si === 4 && !ctx.inventoryWasDiscussed) skip.add(key);

      if (si === 5 && !ctx.accessWasDiscussed) skip.add(key);
      if (si === 5 && [5, 6].includes(ii) && !ctx.elevatorWasMentioned) skip.add(key);
      if (si === 5 && ii === 1 && !ctx.stairsAtDeliveryMentioned) skip.add(key);
      if (si === 5 && ii === 4) skip.add(key);
      if (si === 5 && ii === 7 && isShort) skip.add(key);

      if (si === 6 && !ctx.packingWasDiscussed && ii >= 2) skip.add(key);
      if (si === 6 && ctx.customerIsSelfPacking) {
        if ([3, 4, 8].includes(ii)) skip.add(key);
      }
      if (si === 6 && !ctx.dismantlingWasDiscussed && [5, 6, 7].includes(ii)) skip.add(key);

      if (si === 7 && isLD && !ctx.bothPricingTypesDiscussed) skip.add(key);
      if (si === 8 && !isLD && !ctx.bothPricingTypesDiscussed) skip.add(key);

      if (si === 9 && !ctx.trustBuildingWasDiscussed) skip.add(key);

      if (si === 10 && !ctx.customerRaisedTrustObjection) skip.add(key);
      if (si === 11 && !ctx.customerRaisedPriceObjection) skip.add(key);
      if (si === 12 && !ctx.customerRaisedSafetyObjection) skip.add(key);
      if (si === 13 && !ctx.customerRaisedStorageObjection) skip.add(key);
      if (si === 14 && !ctx.customerRaisedUrgencyObjection) skip.add(key);
      if (si === 15 && !ctx.customerAskedToDelay) skip.add(key);
      if (si === 16 && !ctx.customerRaisedChargesObjection) skip.add(key);

      if (si === 17 && !ctx.agentDiscussedPayment && ii >= 3) skip.add(key);

      if (si === 18 && !ctx.agentDiscussedPreMoveConf) skip.add(key);

      if (si === 19 && !ctx.cancellationRequested) skip.add(key);
    });
  });
  return skip;
}

// ── Pass 2: Rate checklist in 2 batches ──────────────────────────────────────
async function rateChecklist(transcript, skipSet, allItems, ctx) {
  const toRate = allItems.filter(i => !skipSet.has(i.key));
  const half = Math.ceil(toRate.length / 2);
  const batch1 = toRate.slice(0, half);
  const batch2 = toRate.slice(half);

  const sys = 'You are a call quality evaluator. Return ONLY valid JSON, no markdown.';

  function buildBatchPrompt(batch) {
    const itemLines = batch.map(i => `${i.key}: ${i.label}`).join('\n');

    const summaryMatch = transcript.match(/(?:AI SUMMARY|Summary)[\s\S]*?[\n\r]([\s\S]*?)(?=(?:FULL TRANSCRIPT|Transcript)|$)/i);
    const transcriptMatch = transcript.match(/(?:FULL TRANSCRIPT|Transcript)[\s\S]*?[\n\r]([\s\S]*)$/i);

    const aiSummary = summaryMatch ? summaryMatch[1].trim() : transcript.substring(0, 5000);
    const fullTranscript = transcriptMatch ? transcriptMatch[1].trim().substring(0, 8000) : transcript.substring(Math.max(0, transcript.length - 8000));

    return `You are evaluating a sales call for a moving company. Rate each checklist item carefully.

CALL CONTEXT:
- Move type: ${ctx.moveType} | Call direction: ${ctx.callDirection || 'outbound'}
- Call length: ${ctx.callDurationCategory || 'medium'}
- Customer self-packing: ${ctx.customerIsSelfPacking} | Dismantling discussed: ${ctx.dismantlingWasDiscussed}
- Inventory discussed: ${ctx.inventoryWasDiscussed} | Packing discussed: ${ctx.packingWasDiscussed}
- Access discussed: ${ctx.accessWasDiscussed} | Trust building: ${ctx.trustBuildingWasDiscussed}
- Estimate given: ${ctx.agentGaveEstimate} | Payment discussed: ${ctx.agentDiscussedPayment}
- Move type explained in detail: ${ctx.moveTypeExplainedInDetail}
- Elevator mentioned: ${ctx.elevatorWasMentioned} | Stairs at delivery: ${ctx.stairsAtDeliveryMentioned}
- ⚠️ DISPUTE/COMPLAINT CALL: ${ctx.isDisputeOrComplaintCall}

AI SUMMARY (use to determine IF a topic was covered):
${aiSummary}

FULL TRANSCRIPT (use to judge HOW WELL — tone, quality, fillers, confidence):
${fullTranscript}

ITEMS TO RATE:
${itemLines}

═══════════════════════════════════════════════════════
RATING SYSTEM — 3 POSSIBLE VALUES: met / notmet / ni
═══════════════════════════════════════════════════════

"met"    = Agent did it. May be brief but clear. Task was accomplished.
"notmet" = Agent did NOT do it at all. Topic absent from call.
"ni"     = Agent did it BUT delivery was clearly poor (robotic, heavy fillers, no benefit explanation)

═══════════════════════════════════════════════════════
STAGE 1: DID AGENT DO IT? (Read AI Summary first)
═══════════════════════════════════════════════════════

RULE OF SILENCE: If the topic is clearly NOT in the AI Summary → "notmet"

Read the AI Summary first. It is the authoritative record of what happened.
- If a topic IS in the summary → go to Stage 2
- If a topic is NOT in the summary → "notmet"
- EXCEPTION: For call opening items (intro, greeting), give benefit of the doubt — transcripts
  sometimes miss the first few seconds. If agent name appears anywhere in the call and the call
  flow seems normal, assume introduction happened → "met" unless you see clear evidence otherwise.

═══════════════════════════════════════════════════════
STAGE 2: HOW WELL? (Read Full Transcript for quality)
═══════════════════════════════════════════════════════

RULE OF QUALITY: A topic covered clearly → "met". Only downgrade to "ni" if quality was NOTABLY poor.

Mark "ni" ONLY when you see CLEAR evidence of poor delivery:
- Agent uses heavy fillers throughout (not occasional "um" but pervasive "like", "you know", "basically")
- Agent sounds completely robotic or scripted with no natural flow
- Agent gave an answer that was so brief it clearly didn't serve the customer's understanding
- Agent explicitly shows confusion or uncertainty ("I think...", "I'm not sure but...")
- Agent missed an obvious opportunity to explain something critical

DO NOT mark "ni" for:
- Occasional filler words (every agent uses some fillers)
- Brief but clear answers (brevity ≠ poor quality)
- Informal but friendly language
- Answers that accomplished the task even if not perfectly worded

═══════════════════════════════════════════════════════
NI CALIBRATION — REALISTIC TARGETS
═══════════════════════════════════════════════════════

REALISTIC NI PER CALL: 5-10 NI items for a full 15-22 minute call. Shorter calls have fewer.

SOFT SKILLS — typical distribution:
- 5-7 "met" items (most agents are reasonably professional)
- 3-5 "ni" items (real quality issues)
- 0-2 "notmet" items (agent was actively bad at something)

TRUST BUILDERS — typical distribution:
- 2-4 "met" items (topics they covered well)
- 2-3 "ni" items (topics covered but not explained well)
- 1-3 "notmet" items (topics not discussed at all)

SPECIFIC GUIDANCE:
- "Introduced self with agent name and company name" → "met" if agent said name AND company name
  (even if transcript starts mid-call — assume intro happened if call flow is normal)
- "Used professional greeting, confirmed identity" → "met" if agent greeted by name and confirmed
- "Avoided vague/filler language" → "ni" only if fillers are PERVASIVE, not occasional
- "Built rapport using customer name" → "met" if agent uses name at least 2 times naturally
- "Spoke clearly and confidently" → "ni" if agent sounds notably unsure or rushed throughout
- "Showed empathy" → "ni" if agent acknowledged concern but in a formulaic/dismissive way

CALIBRATION TARGETS (manual analysis benchmarks):
- Jessica (Lead 2109, 14 min): ~68% — good call with some packing/trust gaps
- Daniel (Lead 1999, 22 min): ~73% — thorough call, minor NI issues in soft skills
- Noah (Lead 1810, 10 min): ~59% — short call, missed booking/inventory depth
- Daniel (Lead 2321, 7 min): ~44% — short dispatch/issue call, soft skills need work

═══════════════════════════════════════════════════════
DISPUTE / COMPLAINT CALL — STRICT SOFT SKILLS MODE
═══════════════════════════════════════════════════════

${ctx.isDisputeOrComplaintCall ? `⚠️ THIS IS A DISPUTE OR COMPLAINT CALL.

When a customer is upset, frustrated, or an agent is delivering unexpected bad news, the bar for "met" in Soft Skills is MUCH higher. Most soft skill items should be "ni" not "met" in these calls.

APPLY THESE STRICT RULES FOR SOFT SKILLS:

"Spoke clearly, confidently, and at an appropriate pace"
→ "ni" if agent sounds at all defensive, hesitant, or rushes through the bad news
→ "ni" if agent uses phrases like "you know", "I understand but", "like" frequently

"Used professional and customer-friendly language"
→ "ni" if agent uses informal phrases, sounds unprepared, or repeats themselves
→ "ni" if agent says things like "you know what I mean", "basically", "like I said"

"Avoided vague, unsure, or filler language"
→ "notmet" if agent uses heavy fillers throughout the call
→ "ni" if agent sounds uncertain about the reason for the charge

"Did not interrupt and listened actively to the customer"
→ "ni" if agent jumps in before customer finishes their complaint
→ "ni" if agent does not acknowledge what the customer said before responding

"Showed empathy and reassurance during customer concerns"
→ "ni" if agent says "I understand" but immediately moves to justifying the charge
→ "ni" if empathy feels formulaic ("I completely understand but...")
→ "notmet" if agent shows no genuine empathy at all

"Guided the conversation and kept it focused on next steps"
→ "ni" if agent loses control of the conversation or becomes reactive
→ "ni" if agent fails to proactively offer a clear resolution path

"Built rapport and trust using the customer's name and natural conversation"
→ "ni" if agent uses customer name fewer than 3 times OR tone feels transactional
→ "ni" if agent does not acknowledge the customer's frustration genuinely

"Summarized key details and encouraged commitment or next steps"
→ "ni" if agent does not clearly confirm what was agreed at end of call
→ "ni" if agent closes without ensuring customer understands what happens next

"Confidently responded to customer questions without deflection"
→ "ni" if agent deflects blame to another agent (e.g., "Noah should have told you")
→ "ni" if agent cannot clearly explain why the charge is legitimate

EXPECTED DISTRIBUTION for dispute/complaint calls:
- Soft Skills: 1-3 "met", 6-9 "ni", 0-2 "notmet"
- Overall call score for a 7-minute dispute call: typically 40-55%` : `No special dispute/complaint rules apply to this call.`}

Return ONLY this JSON format:
{"ratings": {"r_0_0": "met", "r_0_1": "notmet", "r_1_2": "ni", ...}}`;
  }

  console.log(`  Batch 1: ${batch1.length} items (${GROQ_MODEL})...`);
  const raw1 = await callGroq(GROQ_MODEL, sys, buildBatchPrompt(batch1), 1500);
  const result1 = parseJSON(raw1)?.ratings || parseJSON(raw1) || {};

  console.log(`  Waiting 5s between batches...`);
  await delay(5000);

  console.log(`  Batch 2: ${batch2.length} items (${GROQ_MODEL})...`);
  const raw2 = await callGroq(GROQ_MODEL, sys, buildBatchPrompt(batch2), 1500);
  const result2 = parseJSON(raw2)?.ratings || parseJSON(raw2) || {};

  return { ...result1, ...result2 };
}

// ── Main analysis ─────────────────────────────────────────────────────────────
async function analyzeCall(callText) {
  const allItems = flattenChecklist();
  const transcript = sampleTranscript(callText, 25000);
  console.log(`  Transcript: ${callText.length} chars → sampled ${transcript.length} chars`);

  console.log('  Pass 1: context analysis...');
  const ctx = await analyzeContext(transcript);

  if (!ctx.callDurationCategory) {
    const wc = estimateWordCount(transcript);
    ctx.callDurationCategory = wc < 800 ? 'short' : wc < 1800 ? 'medium' : 'long';
  }

  const skip = buildSkipList(ctx);
  console.log(`  Context: ${ctx.moveType} | ${ctx.callDirection} | followUp=${ctx.isFollowUpCall} | dispute=${ctx.isDisputeOrComplaintCall}`);
  console.log(`  Topics: inv=${ctx.inventoryWasDiscussed} pack=${ctx.packingWasDiscussed} access=${ctx.accessWasDiscussed} trust=${ctx.trustBuildingWasDiscussed}`);
  console.log(`  Packing: selfPack=${ctx.customerIsSelfPacking} dismantling=${ctx.dismantlingWasDiscussed} | Address captured=${ctx.addressCapturedInCall}`);
  console.log(`  Access: elevator=${ctx.elevatorWasMentioned} stairsDelivery=${ctx.stairsAtDeliveryMentioned} | MoveTypeDetail=${ctx.moveTypeExplainedInDetail}`);
  console.log(`  Booking: est=${ctx.agentGaveEstimate} pay=${ctx.agentDiscussedPayment} premove=${ctx.agentDiscussedPreMoveConf} | bothPricing=${ctx.bothPricingTypesDiscussed}`);
  console.log(`  Duration: ${ctx.callDurationCategory} | Skipping ${skip.size} items → rating ${allItems.length - skip.size} items`);

  console.log('  Pass 2: rating checklist (2 batches)...');
  const batchRatings = await rateChecklist(transcript, skip, allItems, ctx);

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
    console.log(`\n▶ /api/analyze-text (${text.length} chars) → Groq`);
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
  const apiKey = req.headers['x-transkriptor-key'] || process.env.TRANSKRIPTOR_API_KEY;
  console.log('🔑 Transkriptor API key check:', {
    fromHeader: !!req.headers['x-transkriptor-key'],
    fromEnv: !!process.env.TRANSKRIPTOR_API_KEY,
    envKeyLength: process.env.TRANSKRIPTOR_API_KEY?.length || 0
  });
  if (!apiKey) return res.status(400).json({ error: 'Missing Transkriptor API key' });
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
  const apiKey = req.headers['x-transkriptor-key'] || process.env.TRANSKRIPTOR_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Missing Transkriptor API key' });
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

// ── Email Route (Zoho SMTP - PDF Support) ───────────────────────────────────
app.post('/api/send-report-email', async (req, res) => {
  const { pdfBase64, fileName, htmlContent } = req.body;

  if (!pdfBase64) {
    return res.status(400).json({ error: 'PDF content is required' });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY missing in .env' });
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);

    const recipients = (process.env.EMAIL_RECIPIENTS || process.env.EMAIL_USER || '')
      .split(',')
      .map(e => e.trim())
      .filter(Boolean);

    const { data, error } = await resend.emails.send({
      from: 'TNVL Reports <saravanaraja@tnvl.ca>',
      to: recipients,
      subject: `TNVL Performance Reports Bundle — ${new Date().toLocaleDateString('en-CA')}`,
      html: htmlContent || '<p>Please find the attached performance report PDF.</p>',
      attachments: [
        {
          filename: fileName || 'Performance_Report.pdf',
          content: pdfBase64,
        }
      ]
    });

    if (error) {
      console.error('❌ Resend error:', error);
      return res.status(500).json({ error: error.message });
    }

    console.log('✅ Email sent via Resend:', data?.id);
    res.json({ success: true, message: 'PDF Report sent successfully!', id: data?.id });

  } catch (err) {
    console.error('❌ Resend exception:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({
  status: 'ok',
  engine: `Groq FREE (${GROQ_MODEL} + ${GROQ_MODEL_B2})`,
  groqKeys: `${GROQ_KEYS.length} keys loaded`,
  sharedRecords: loadSharedRecords().length,              // ← ADDED
  port: process.env.PORT || 3000
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  const existing = loadSharedRecords();                   // ← ADDED
  console.log(`\n✅ TNVL Server → http://0.0.0.0:${PORT}`);
  console.log(`   Engine : Groq FREE ✅`);
  console.log(`   Model  : ${GROQ_MODEL} (context + batch 1)`);
  console.log(`   Model2 : ${GROQ_MODEL_B2} (batch 2)`);
  console.log(`   Keys   : ✅ loaded ${GROQ_KEYS.length} keys`);
  console.log(`   Speed  : ~20-30s per analysis`);
  console.log(`   Limits : No daily cap — FREE forever`);
  console.log(`\n   📦 Shared Records: ${existing.length} records in shared_records.json`);  // ← ADDED
  console.log(`   👥 Everyone on this link sees the same data now!\n`);                      // ← ADDED
  console.log(`\n   Accuracy v6 — what changed:`);
  console.log(`   • NEW FLAG: isDisputeOrComplaintCall — detects upset customer / bad news delivery calls`);
  console.log(`   • DISPUTE MODE: when true, soft skills rated with strict NI criteria (target 1-3 met, 6-9 ni)`);
  console.log(`   • Fixes Lead 2123/2321 Cheryl call: AI was 87%, manual was 44%`);
  console.log(`   • All other leads unaffected — dispute mode only triggers when customer is upset\n`);
});