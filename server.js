require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');

// ═══════════════════════════════════════════════════════════════
//  CLOUD STORAGE (MongoDB)
// ═══════════════════════════════════════════════════════════════
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Connected to MongoDB Cloud'))
  .catch(err => console.error('❌ MongoDB Connection Error:', err));

const recordSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  date: String,
  agent: String,
  leadId: String,
  customer: String,
  callType: String,
  duration: String,
  datetime: String,
  evaluator: String,
  moveType: String,
  moveValueAmount: String,
  moveValueCategory: String,
  conversionProbability: String,
  leadStatus: String,
  cueCardUsage: String,
  monitoringCategory: String,
  recordingLink: String,
  metCount: Number,
  nmCount: Number,
  niCount: Number,
  assessed: Number,
  pct: Number,
  breakdown: Array,
  aiAnalyzed: Boolean,
  tskSummary: Object,
  // Feedback fields
  callSummary: String,
  feedbackPositive: String,
  feedbackNeedsImprovement: String,
  feedbackGiven: String,
  feedbackGivenDate: String,
  createdAt: { type: Date, default: Date.now }
});

const CallRecord = mongoose.model('CallRecord', recordSchema);

const dashboardCommentSchema = new mongoose.Schema({
  date: { type: String, required: true, unique: true },
  comment: { type: String, default: '' },
  updatedBy: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
});
const DashboardComment = mongoose.model('DashboardComment', dashboardCommentSchema);

const configSchema = new mongoose.Schema({
  id: { type: String, default: 'main', unique: true },
  agentNames: { type: [String], default: ["Myles", "Dustin", "Thomas", "Anthony", "Daniel", "Noah", "Jessica", "Alex", "Arthur", "William", "Solomon", "Fabian", "Brian", "Ethan"] },
  callTypes: { type: [String], default: ["Inbound quote request", "Inbound follow up", "Outbound - Initial call", "Outbound - follow up", "Pre Move Confirmation call", "Escalations & dispute", "Short calls less than 3 Mins"] },
  evaluatorNames: { type: [String], default: ["Aarti - AI", "Aarti - Verified", "Sachin", "Solomon", "Daniel", "Saravana J"] },
  moveTypes: { type: [String], default: ["Local Move", "Long Distance Move"] },
  moveValueCategories: { type: [String], default: ["Low Value", "Mid Value", "High Value"] },
  leadStatuses: { type: [String], default: ["Open", "Closed", "Booked", "Lost", "Refund request (cancellation)"] },
  checklistSections: { type: Array, default: [] },
  preMoveChecklistSections: { type: Array, default: [] },
  escalationsChecklistSections: { type: Array, default: [] },
  monitoringCategories: { type: [String], default: ["Booked", "Complaint/Escalation Call", "High Value", "Follow-up call", "Close to booking but lost", "Prospects", "Mid Value", "Move on Hold - Crew initiated", "Move on Hold - Customer Initiated", "Move Cancelled - Customer initiated", "Move Cancelled - Ops Initiated", "Move Cancelled - Crew Initiated", "Move Cancelled - Crew Unassigned"] },
  emailRecipients: { type: [String], default: [] },
  activeRecipients: { type: [String], default: [] },
  archivedTskFiles: { type: [String], default: [] }
});
const Config = mongoose.model('Config', configSchema);

const app = express();

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
//  SHARED RECORDS API
//  GET    /api/records        → load all records
//  POST   /api/records        → save new call
//  PUT    /api/records/:id    → update a call
//  DELETE /api/records/:id    → delete a call
// ═══════════════════════════════════════════════════════════════

app.get('/api/records', async (req, res) => {
  try {
    const records = await CallRecord.find({}).sort({ createdAt: -1 });
    console.log(`[CLOUD] 📋 GET /api/records → ${records.length} records returned`);
    res.json(records);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load records', details: e.message });
  }
});

app.post('/api/records', async (req, res) => {
  const recordData = req.body;
  if (!recordData || !recordData.agent) {
    return res.status(400).json({ error: 'Invalid record — agent is required' });
  }
  try {
    const recordId = String(recordData.id);
    const result = await CallRecord.findOneAndUpdate(
      { id: recordId },
      { $set: recordData },
      { upsert: true, new: true }
    );
    const total = await CallRecord.countDocuments();
    console.log(`[CLOUD] ✅ Record SAVED/UPDATED! | Agent: ${recordData.agent} | Lead: ${recordData.leadId} | Total: ${total}`);
    res.json({ success: true, total, id: recordId });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save record', details: e.message });
  }
});

app.put('/api/records/:id', async (req, res) => {
  try {
    const updated = await CallRecord.findOneAndUpdate(
      { id: String(req.params.id) },
      { $set: req.body },
      { upsert: true, new: true }
    );
    console.log(`[CLOUD] ✅ Record UPDATED! | ID: ${req.params.id}`);
    res.json({ success: true, record: updated });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update record', details: e.message });
  }
});

app.delete('/api/records/:id', async (req, res) => {
  try {
    const result = await CallRecord.deleteOne({ id: String(req.params.id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: 'Record not found' });
    const count = await CallRecord.countDocuments();
    console.log(`[CLOUD] 🗑 Record deleted: id=${req.params.id}`);
    res.json({ success: true, total: count });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete record', details: e.message });
  }
});

// ── One-time dedup endpoint ───────────────────────────────────────────────────
app.post('/api/records/dedup', async (req, res) => {
  try {
    const records = await CallRecord.find({});
    const seen = new Set();
    const toDelete = [];
    const kept = [];
    records.forEach(r => {
      const key = `${r.agent || ''}|${r.leadId || ''}|${r.date || ''}|${r.pct || ''}`;
      if (seen.has(key)) {
        toDelete.push(r._id);
      } else {
        seen.add(key);
        kept.push(r);
      }
    });
    if (toDelete.length > 0) {
      await CallRecord.deleteMany({ _id: { $in: toDelete } });
    }
    console.log(`🧹 Dedup: removed ${toDelete.length} duplicates (${kept.length} remain)`);
    res.json({ success: true, before: records.length, after: kept.length, removed: toDelete.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  GROQ AI ENGINE
// ═══════════════════════════════════════════════════════════════

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

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_MODEL_B2 = 'llama-3.1-8b-instant';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

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

// ── Pass 1: Extract call context ──────────────────────────────────────────────
async function analyzeContext(transcript) {
  const sys = 'You are a call quality analyst. Return ONLY valid JSON, no markdown, no explanation.';
  const usr = `Carefully read this call transcript and return a JSON context object.

TRANSCRIPT:
${transcript}

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
- Read the ENTIRE transcript above before answering — do not judge based only on the opening of the call. Facts like addresses, pricing details, and payment terms are often given in the middle or toward the end of the call.
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
- addressCapturedInCall=true if agent explicitly asked for and received street-level addresses ANYWHERE in the call (cities alone do not count) — check the whole transcript, not just the opening
- moveTypeExplainedInDetail=true if agent explicitly described what basic moving includes OR what full-service moving includes
- bothPricingTypesDiscussed=true if agent discussed BOTH hourly/local pricing AND weight-based/long-distance pricing in the same call
- isDisputeOrComplaintCall=true if ANY of these are true: (1) customer expresses frustration, anger, or feeling misled during the call, (2) agent is delivering unexpected bad news (extra charges, delays, policy changes), (3) customer says words like "outrageous", "shaken down", "confused", "not happy", "I was told differently", (4) call involves a dispute about pricing, charges, or service promises made earlier

IMPORTANT: Default to FALSE only when you find NO evidence anywhere in the transcript. Read the full transcript carefully before defaulting to false — a fact mentioned once, briefly, still counts as covered.`;

  const raw = await callGroq(GROQ_MODEL, sys, usr, 700);
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

// ── Build skip list from context ──────────────────────────────────────────────
function buildSkipList(ctx) {
  const skip = new Set();
  const isLD = ctx.moveType === 'longdistance';
  const isShort = ctx.callDurationCategory === 'short';

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

// ── Pass 2: Rate checklist in batches ─────────────────────────────────────────
async function rateChecklist(transcript, skipSet, allItems, ctx) {
  const toRate = allItems.filter(i => !skipSet.has(i.key));

  // Smaller batches keep each prompt focused and let the model spend more
  // attention per item, instead of forcing large batches through a truncated
  // transcript window.
  const BATCH_SIZE = 12;
  const batches = [];
  for (let i = 0; i < toRate.length; i += BATCH_SIZE) {
    batches.push(toRate.slice(i, i + BATCH_SIZE));
  }

  const sys = 'You are a meticulous call quality evaluator. Your job is to find evidence in the transcript, not to guess. Return ONLY valid JSON, no markdown.';

  const summaryMatch = transcript.match(/(?:AI SUMMARY|Summary)[\s\S]*?[\n\r]([\s\S]*?)(?=(?:FULL TRANSCRIPT|Transcript)|$)/i);
  const transcriptMatch = transcript.match(/(?:FULL TRANSCRIPT|Transcript)[\s\S]*?[\n\r]([\s\S]*)$/i);

  // Use the FULL sampled transcript (already capped by sampleTranscript at the
  // call site) instead of re-truncating it further here. Re-slicing to a fixed
  // 8000 chars was silently discarding large portions of longer calls before
  // the rating model ever saw them.
  const aiSummary = summaryMatch ? summaryMatch[1].trim() : '';
  const fullTranscript = transcriptMatch ? transcriptMatch[1].trim() : transcript;

  function buildBatchPrompt(batch) {
    const itemLines = batch.map(i => `${i.key}: ${i.label}`).join('\n');

    return `You are evaluating a sales call for a moving company. Rate each checklist item carefully using the transcript as your primary evidence.

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

${aiSummary ? `AI SUMMARY (a quick, non-authoritative pointer to what may have happened — it is often incomplete):\n${aiSummary}\n\n` : ''}FULL TRANSCRIPT (this is the authoritative source of truth — read it carefully before rating anything):
${fullTranscript}

ITEMS TO RATE:
${itemLines}

═══════════════════════════════════════════════════════
RATING SYSTEM — 3 POSSIBLE VALUES: met / notmet / ni
═══════════════════════════════════════════════════════

"met"    = Agent did it. May be brief but clear. Task was accomplished.
"notmet" = Agent did NOT do it at all. No evidence anywhere in the transcript.
"ni"     = Agent did it BUT delivery was clearly poor (robotic, heavy fillers, no benefit explanation)

═══════════════════════════════════════════════════════
STAGE 1: DID AGENT DO IT? (search the FULL TRANSCRIPT, not just the summary)
═══════════════════════════════════════════════════════

The AI Summary is a rough pointer, not the source of truth — it frequently omits things that
actually happened. Before marking anything "notmet", scan the full transcript text above for any
mention, however brief, of the topic. Only mark "notmet" if you cannot find it anywhere in the
transcript AND it is not in the summary.

- If the topic appears anywhere in the transcript OR the summary → go to Stage 2
- If the topic appears in neither → "notmet"
- EXCEPTION: For call opening items (intro, greeting), give benefit of the doubt — transcripts
  sometimes miss the first few seconds. If agent name appears anywhere in the call and the call
  flow seems normal, assume introduction happened → "met" unless you see clear evidence otherwise.

═══════════════════════════════════════════════════════
STAGE 2: HOW WELL? (quality of delivery)
═══════════════════════════════════════════════════════

RULE OF QUALITY: A topic covered clearly → "met". Only downgrade to "ni" if quality was NOTABLY poor.

Mark "ni" ONLY when you see CLEAR evidence of poor delivery:
- Agent uses heavy fillers throughout (not occasional "um" but pervasive "like", "you know", "basically")
- Agent sounds completely robotic or scripted with no natural flow
- Agent gave an answer that was so brief it clearly didn't serve the customer's understanding
- Agent explicitly shows confusion or uncertainty ("I think...", "I'm not sure but...")
- Agent missed an obvious opportunity to explain something critical
- The topic was raised and engaged with, but the outcome was left explicitly tentative,
  incomplete, or pending confirmation — e.g. an address given as "hopefully that one" or
  "I still haven't received it yet", a date that's "kind of an experiment" with no firm
  answer, or details the customer says they'll confirm later. The agent asked the right
  question and got a partial or provisional answer — that's a real gap in the outcome, not
  a "notmet" (the topic WAS covered) and not a clean "met" (the info isn't actually locked
  in). Rate these "ni".

DO NOT mark "ni" for:
- Occasional filler words (every agent uses some fillers)
- Brief but clear answers (brevity ≠ poor quality)
- Informal but friendly language
- Answers that accomplished the task even if not perfectly worded

═══════════════════════════════════════════════════════
GENERAL CALIBRATION (evidence-based, not a target to hit)
═══════════════════════════════════════════════════════

There is no fixed quota of "met"/"ni"/"notmet" ratings — the right distribution is whatever the
transcript actually shows for THIS call. A call where the agent covered everything well should
score high; a call with genuine gaps should score low. Do not adjust ratings to steer toward any
particular overall percentage — grade only what is in the transcript.

${ctx.isDisputeOrComplaintCall ? `═══════════════════════════════════════════════════════
DISPUTE / COMPLAINT CALL — STRICTER SOFT SKILLS BAR
═══════════════════════════════════════════════════════

⚠️ THIS IS A DISPUTE OR COMPLAINT CALL. When a customer is upset, frustrated, or an agent is
delivering unexpected bad news, the bar for "met" in Soft Skills is higher.

"Spoke clearly, confidently, and at an appropriate pace" → "ni" if agent sounds defensive, hesitant, or rushes through the bad news
"Used professional and customer-friendly language" → "ni" if agent sounds unprepared or repeats themselves
"Avoided vague, unsure, or filler language" → "ni"/"notmet" if agent sounds uncertain about the reason for the charge
"Did not interrupt and listened actively to the customer" → "ni" if agent jumps in before customer finishes their complaint
"Showed empathy and reassurance during customer concerns" → "ni" if empathy feels formulaic, "notmet" if genuinely absent
"Guided the conversation and kept it focused on next steps" → "ni" if agent loses control or fails to offer a resolution path
"Built rapport and trust using the customer's name and natural conversation" → "ni" if tone feels transactional or agent doesn't acknowledge frustration
"Summarized key details and encouraged commitment or next steps" → "ni" if agent doesn't confirm what was agreed
"Confidently responded to customer questions without deflection" → "ni" if agent deflects blame or can't clearly explain the charge

Still base every rating on what's actually in the transcript — apply this stricter bar only to
soft-skill items, and only if the transcript actually shows the behavior described.` : ''}

Return ONLY this JSON format:
{"ratings": {"r_0_0": "met", "r_0_1": "notmet", "r_1_2": "ni", ...}}`;
  }

  let combined = {};
  for (let b = 0; b < batches.length; b++) {
    console.log(`  Batch ${b + 1}/${batches.length}: ${batches[b].length} items (${GROQ_MODEL})...`);
    const raw = await callGroq(GROQ_MODEL, sys, buildBatchPrompt(batches[b]), 1200);
    const result = parseJSON(raw)?.ratings || parseJSON(raw) || {};
    combined = { ...combined, ...result };
    if (b < batches.length - 1) {
      await delay(3000);
    }
  }

  return combined;
}

// ── Main analysis ─────────────────────────────────────────────────────────────
async function analyzeCall(callText) {
  const allItems = flattenChecklist();
  // Groq's llama-3.3-70b-versatile has a large context window; give both the
  // context pass and the rating pass as much of the real transcript as
  // possible instead of aggressively truncating. Only very long calls get
  // sampled (start/middle/end) to stay within a safe prompt size.
  const transcript = sampleTranscript(callText, 45000);
  console.log(`  Transcript: ${callText.length} chars → sampled ${transcript.length} chars`);

  console.log('  Pass 1: context analysis...');
  const ctx = await analyzeContext(transcript);

  if (!ctx.callDurationCategory) {
    const wc = estimateWordCount(transcript);
    ctx.callDurationCategory = wc < 800 ? 'short' : wc < 1800 ? 'medium' : 'long';
  }

  const skip = buildSkipList(ctx);
  console.log(`  Context: ${ctx.moveType} | ${ctx.callDirection} | followUp=${ctx.isFollowUpCall} | dispute=${ctx.isDisputeOrComplaintCall}`);
  console.log(`  Duration: ${ctx.callDurationCategory} | Skipping ${skip.size} items → rating ${allItems.length - skip.size} items`);

  console.log('  Pass 2: rating checklist...');
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

// ═══════════════════════════════════════════════════════════════
//  FEEDBACK API
// ═══════════════════════════════════════════════════════════════
app.post('/api/feedback', async (req, res) => {
  try {
    const { agent, leadId, date, summary, positive, ni } = req.body;

    if (!agent || !leadId || !date) {
      return res.status(400).json({ error: 'Agent, Lead ID, and Date are required' });
    }

    // Find the record by agent, leadId, and date combination
    let record = await CallRecord.findOne({
      agent,
      leadId: leadId || '',
      date
    });

    if (!record) {
      // Create a new record if none exists (feedback can be saved before the main form)
      const recordId = `${agent}_${leadId}_${date}`;
      record = new CallRecord({
        id: recordId,
        agent,
        leadId: leadId || '',
        date,
        callSummary: summary || '',
        feedbackPositive: positive || '',
        feedbackNeedsImprovement: ni || '',
        metCount: 0,
        nmCount: 0,
        niCount: 0,
        assessed: 0,
        pct: 0,
        breakdown: []
      });
      console.log(`[CLOUD] 📝 Created new record for feedback | Agent: ${agent} | Lead: ${leadId} | Date: ${date}`);
    } else {
      // Update feedback fields on existing record
      record.callSummary = summary || '';
      record.feedbackPositive = positive || '';
      record.feedbackNeedsImprovement = ni || '';
    }

    await record.save();

    console.log(`[CLOUD] ✅ Feedback saved! | Agent: ${agent} | Lead: ${leadId} | Date: ${date}`);
    res.json({ success: true, message: 'Feedback saved successfully', recordCreated: !record._id });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save feedback', details: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  EMAIL REPORTING API
// ═══════════════════════════════════════════════════════════════
app.post('/api/send-report-email', async (req, res) => {
  const { pdfBase64, fileName, htmlContent, recipients } = req.body;

  if (!pdfBase64) {
    return res.status(400).json({ error: 'PDF content is required' });
  }

  // Determine recipient list
  let recipientList = [];
  if (Array.isArray(recipients) && recipients.length > 0) {
    recipientList = recipients.filter(Boolean).map(e => e.trim());
  } else {
    recipientList = (process.env.EMAIL_RECIPIENTS || process.env.EMAIL_USER || '')
      .split(',')
      .map(e => e.trim())
      .filter(Boolean);
  }

  // Guarantee aarti.s@zentiq.ca is in default list if fallback used
  if (recipientList.length === 0) {
    recipientList = ['saravanaraja@tnvl.ca', 'aarti.s@tnvl.ca', 'aarti.s@zentiq.ca'];
  }

  const subject = `TNVL Performance Reports Bundle - ${new Date().toLocaleDateString('en-CA')}`;

  // 1. Try Nodemailer / SMTP (Zoho SMTP) first if configured
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    try {
      const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST || 'smtppro.zoho.com',
        port: parseInt(process.env.EMAIL_PORT || '465'),
        secure: parseInt(process.env.EMAIL_PORT || '465') === 465,
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 15000
      });

      const mailOptions = {
        from: `"${process.env.EMAIL_FROM_NAME || 'TNVL Reports'}" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
        to: recipientList.join(', '),
        subject: subject,
        html: htmlContent || '<p>Please find the attached performance report PDF.</p>',
        attachments: [
          {
            filename: fileName || 'Performance_Report.pdf',
            content: Buffer.from(pdfBase64, 'base64')
          }
        ]
      };

      const info = await transporter.sendMail(mailOptions);
      console.log(`✅ Sent email via SMTP (${process.env.EMAIL_HOST || 'Zoho'}) to ${recipientList.join(', ')}:`, info.messageId);
      return res.json({ success: true, message: `PDF Report sent successfully to ${recipientList.length} recipients!` });
    } catch (smtpErr) {
      console.error('⚠️ SMTP Error, falling back to Brevo if available:', smtpErr.message);
      // If Brevo isn't available, return error directly
      if (!process.env.BREVO_API_KEY) {
        return res.status(500).json({ error: 'Failed to send email via SMTP', details: smtpErr.message });
      }
    }
  }

  // 2. Brevo API Fallback
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'No email service credentials found (EMAIL_USER/EMAIL_PASS or BREVO_API_KEY missing)' });
  }

  try {
    const brevoRecipients = recipientList.map(email => ({ email }));
    const sendPromises = brevoRecipients.map(recipient => 
      fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': apiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          sender: {
            name: process.env.EMAIL_FROM_NAME || 'TNVL Reports',
            email: process.env.EMAIL_FROM || process.env.EMAIL_USER || 'noreply@brevo.com'
          },
          to: [recipient],
          subject: subject,
          htmlContent: htmlContent || '<p>Please find the attached performance report PDF.</p>',
          attachment: [
            {
              content: pdfBase64,
              name: fileName || 'Performance_Report.pdf'
            }
          ]
        })
      }).then(async r => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data?.message || `Brevo error ${r.status} for ${recipient.email}`);
        return data;
      })
    );

    const results = await Promise.all(sendPromises);
    console.log(`✅ Sent ${results.length} emails via Brevo!`);
    res.json({ success: true, message: `PDF Report sent successfully to ${results.length} recipients!` });

  } catch (error) {
    console.error('❌ Brevo Error:', error.message);
    res.status(500).json({ error: 'Failed to send report', details: error.message });
  }
});

// ── Dynamic Configuration (Dropdowns) ─────────────────────────────────────────
const CONFIG_DEFAULTS = {
  agentNames: ["Myles", "Dustin", "Thomas", "Anthony", "Daniel", "Noah", "Jessica", "Alex", "Arthur", "William", "Solomon", "Fabian", "Brian", "Ethan"],
  callTypes: ["Inbound quote request", "Inbound follow up", "Outbound - Initial call", "Outbound - follow up", "Pre Move Confirmation call", "Escalations & dispute", "Short calls less than 3 Mins"],
  evaluatorNames: ["Aarti - AI", "Aarti - Verified", "Sachin", "Solomon", "Daniel", "Saravana J"],
  moveTypes: ["Local Move", "Long Distance Move"],
  moveValueCategories: ["Low Value", "Mid Value", "High Value"],
  leadStatuses: ["Open", "Closed", "Booked", "Lost", "Refund request (cancellation)"],
  monitoringCategories: ["Booked", "Complaint/Escalation Call", "High Value", "Follow-up call", "Close to booking but lost", "Prospects", "Mid Value", "Move on Hold - Crew initiated", "Move on Hold - Customer Initiated", "Move Cancelled - Customer initiated", "Move Cancelled - Ops Initiated", "Move Cancelled - Crew Initiated", "Move Cancelled - Crew Unassigned"],
  emailRecipients: ["saravanaraja@tnvl.ca", "aarti.s@tnvl.ca", "aarti.s@zentiq.ca"],
  activeRecipients: ["saravanaraja@tnvl.ca", "aarti.s@tnvl.ca", "aarti.s@zentiq.ca"],
  checklistSections: [
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
  ],
  preMoveChecklistSections: [
    {
      title: "Call Opening & Identity Verification", items: [
        "Introduced self, company, and purpose of the call clearly.",
        "Confirmed customer identity and verified contact details."
      ]
    },
    {
      title: "Move Details Reconfirmation", items: [
        "Reconfirmed move date and preferred time window",
        "Revalidated full pickup and delivery addresses.",
        "Confirmed inventory and checked for any additions, removals, or changes.",
        "Checked if packing requirements have changed.",
        "Reconfirmed dismantling and special handling needs"
      ]
    },
    {
      title: "Access & Special Items Verification", items: [
        "Verified access details (stairs, elevator, parking, long carry).",
        "Confirmed elevator booking and building move restrictions.",
        "Checked for fragile, bulky, or high-value items."
      ]
    },
    {
      title: "Crew & Pricing Reconfirmation", items: [
        "Explained expected crew size and arrival process",
        "Reconfirmed pricing structure and key cost drivers.",
        "Clarified payment process and timelines."
      ]
    },
    {
      title: "Customer Support & Reassurance", items: [
        "Addressed any customer concerns or questions",
        "Reinforced preparation tips and move-day readiness.",
        "Shared what the customer should expect on move day",
        "Provided contact details for support and escalation.",
        "Encouraged the customer to update TNVL if there are further changes",
        "Built reassurance and confidence in the move process."
      ]
    },
    {
      title: "Call Wrap-Up & System Update", items: [
        "Summarized key details and confirmed next steps",
        "Updated the tool with relevant changes to move details discussed on the call",
        "Informed the lead and crew of the details discussed on the call"
      ]
    }
  ],
  escalationsChecklistSections: [
    {
      title: "Acknowledgement & Empathy", items: [
        "Acknowledged the escalation, complaint, or cancellation request with empathy, per the C.A.R.E. framework",
        "Applied the vulnerable customer protocol where applicable"
      ]
    },
    {
      title: "Issue Understanding", items: [
        "Asked for the reason before processing the request",
        "Confirmed the reason back to the customer",
        "Attempted an objection-related save where the issue was resolvable"
      ]
    },
    {
      title: "Resolution & Policy Application", items: [
        "Explained cancellation charges accurately per policy",
        "Offered reschedule where appropriate",
        "Offered an alternative resolution where appropriate",
        "Did not pressure the customer after a final decision was made"
      ]
    },
    {
      title: "Process & Escalation Path", items: [
        "Followed the Escalation & Dispute Handling Process as per stipulated timelines",
        "Logged the escalation/cancellation accurately in the tracker with correct category",
        "Logged the escalation/cancellation with correct status",
        "Confirmed next steps clearly with the customer before ending the call",
        "Confirmed the follow-up timeline clearly with the customer"
      ]
    }
  ]
};

app.get('/api/config', async (_req, res) => {
  try {
    let config = await Config.findOne({ id: 'main' });
    if (!config) {
      config = await Config.create({ id: 'main', ...CONFIG_DEFAULTS });
    }
    // Merge in defaults for any field that is missing or empty
    // (handles old MongoDB documents created before the fields were added)
    const merged = {};
    for (const key of Object.keys(CONFIG_DEFAULTS)) {
      const val = config[key];
      merged[key] = (Array.isArray(val) && val.length > 0) ? val : CONFIG_DEFAULTS[key];
    }
    // Auto-patch the new call type and recipients for existing databases
    if (merged.callTypes && !merged.callTypes.includes("Escalations & dispute")) {
      merged.callTypes.push("Escalations & dispute");
      await Config.updateOne({ id: 'main' }, { $addToSet: { callTypes: "Escalations & dispute" } });
    }
    const requiredRecips = ["saravanaraja@tnvl.ca", "aarti.s@tnvl.ca", "aarti.s@zentiq.ca"];
    requiredRecips.forEach(rEmail => {
      if (merged.emailRecipients && !merged.emailRecipients.includes(rEmail)) merged.emailRecipients.push(rEmail);
      if (merged.activeRecipients && !merged.activeRecipients.includes(rEmail)) merged.activeRecipients.push(rEmail);
    });
    await Config.updateOne({ id: 'main' }, { 
      $addToSet: { 
        emailRecipients: { $each: requiredRecips }, 
        activeRecipients: { $each: requiredRecips } 
      } 
    });
    console.log('[CLOUD] ⚙️ Config loaded, agents:', merged.agentNames.length);
    res.json(merged);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load config', details: e.message });
  }
});

app.put('/api/config', async (req, res) => {
  try {
    const configData = req.body;
    let config = await Config.findOneAndUpdate(
      { id: 'main' },
      { $set: configData },
      { upsert: true, new: true }
    );
    console.log(`[CLOUD] ⚙️ Configuration updated`);
    res.json({ success: true, config });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update config', details: e.message });
  }
});

// ── Dashboard comments (date-wise notes) ─────────────────────────────────────
app.get('/api/dashboard-comments', async (_req, res) => {
  try {
    const comments = await DashboardComment.find({}).sort({ date: -1 });
    res.json(comments);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load comments', details: e.message });
  }
});

app.put('/api/dashboard-comments', async (req, res) => {
  const { comments } = req.body;
  if (!Array.isArray(comments)) {
    return res.status(400).json({ error: 'comments array is required' });
  }
  const valid = comments.filter(c => c && c.date);
  const dates = valid.map(c => c.date);
  if (new Set(dates).size !== dates.length) {
    return res.status(400).json({ error: 'Each comment must have a unique date' });
  }
  try {
    await DashboardComment.deleteMany({});
    if (valid.length) {
      await DashboardComment.insertMany(valid.map(c => ({
        date: c.date,
        comment: (c.comment || '').trim(),
        updatedBy: (c.updatedBy || '').trim(),
        updatedAt: new Date()
      })));
    }
    const saved = await DashboardComment.find({}).sort({ date: -1 });
    console.log(`[CLOUD] 💬 Dashboard comments saved → ${saved.length} entries`);
    res.json({ success: true, comments: saved });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save comments', details: e.message });
  }
});

// ── Health Check ──────────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => res.json({
  status: 'ok',
  engine: `Groq FREE (${GROQ_MODEL})`,
  groqKeys: `${GROQ_KEYS.length} keys loaded`,
  sharedRecords: await CallRecord.countDocuments(),
  port: process.env.PORT || 3000
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', async () => {
  const count = await CallRecord.countDocuments();
  console.log(`\n✅ TNVL Server → http://0.0.0.0:${PORT}`);
  console.log(`   Engine  : Groq FREE ✅`);
  console.log(`   Model   : ${GROQ_MODEL} (context + rating)`);
  console.log(`   Keys    : ✅ loaded ${GROQ_KEYS.length} keys`);
  console.log(`   Limits  : No daily cap — FREE forever`);
  console.log(`\n   📦 DATABASE: Cloud MongoDB Connected`);
  console.log(`   👥 Everyone on this link sees the same data now!`);
  console.log(`   📧 EMAIL: Brevo HTTP API ✅ (Render compatible)`);
  console.log(`   📊 Records: ${count} total in database\n`);

  try {
    const recordsToFix = await CallRecord.find({
      $or: [
        { monitoringCategory: { $exists: false } },
        { monitoringCategory: "" },
        { monitoringCategory: null }
      ]
    });
    if (recordsToFix.length > 0) {
      console.log(`[BACKFILL] Found ${recordsToFix.length} records without monitoringCategory. Backfilling...`);
      let updatedCount = 0;
      for (const r of recordsToFix) {
        const leadStatus = (r.leadStatus || '').toLowerCase();
        const moveVal = (r.moveValueCategory || '').toLowerCase();
        const callType = (r.callType || '').toLowerCase();

        let cat = 'Prospects';
        if (leadStatus === 'booked') cat = 'Booked';
        else if (leadStatus === 'lost') cat = 'Close to booking but lost';
        else if (callType.includes('complaint') || callType.includes('escalation')) cat = 'Complaint/Escalation Call';
        else if (callType.includes('follow-up') || callType.includes('follow up') || callType.includes('f/u')) cat = 'Follow-up call';
        else if (moveVal === 'high value') cat = 'High Value';
        else if (moveVal === 'mid value') cat = 'Mid Value';

        r.monitoringCategory = cat;
        await r.save();
        updatedCount++;
      }
      console.log(`[BACKFILL] Successfully backfilled ${updatedCount} records in MongoDB.`);
    }
  } catch (err) {
    console.error('[BACKFILL] Error during backfill:', err.message);
  }
});