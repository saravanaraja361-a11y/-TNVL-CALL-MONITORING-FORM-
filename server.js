require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');

const app = express();

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

const GROQ_KEYS = [
  process.env.GROQ_API_KEY_1 || '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',
  process.env.GROQ_API_KEY_2 || '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',
  process.env.GROQ_API_KEY_3 || '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',
  process.env.GROQ_API_KEY_4 || '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',
  process.env.GROQ_API_KEY_5 || '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'
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
  "trustBuildingWasDiscussed": true or false
}

DEFINITIONS:
- isFollowUpCall: true if this is a dispatch, confirmation, pre-move, or follow-up call (customer already booked; agent is calling to confirm documents, inform about charges, schedule crew, or check on existing booking). false if this is an initial sales/quote call where agent is asking inventory, pricing, and selling the service.
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
    moveType: 'local', callDirection: 'outbound', isFollowUpCall: false,
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

  // ── Follow-up / Dispatch Call: skip all sales/discovery sections ──────────
  // Only Call Opening (si=0), Permission item 0 (si=1,ii=0), and Soft Skills are rated
  if (ctx.isFollowUpCall) {
    SECTIONS.forEach((sec, si) => {
      if (sec.manualOnly) return;
      sec.items.forEach((_, ii) => {
        const key = `r_${si}_${ii}`;
        // Keep: si=0 (Call Opening), si=1 ii=0 (clearly stated purpose), si=20 (Soft Skills)
        const keepCallOpening = (si === 0);
        const keepPurpose = (si === 1 && ii === 0);
        const keepSoftSkills = (si === 20);
        if (!keepCallOpening && !keepPurpose && !keepSoftSkills) skip.add(key);
      });
    });
    return skip;
  }

  SECTIONS.forEach((sec, si) => {
    sec.items.forEach((_, ii) => {
      const key = `r_${si}_${ii}`;

      // s0: wrong-number items
      if (si === 0 && [3, 6, 7].includes(ii) && !ctx.wasWrongNumber) skip.add(key);
      // s0: callback item
      if (si === 0 && ii === 5 && ctx.customerAvailable) skip.add(key);

      // s1 Permission: skip callback/timing items when customer was available
      if (si === 1 && [4, 5, 6].includes(ii) && ctx.customerAvailable) skip.add(key);

      // s4 Inventory: skip whole section if inventory never discussed
      if (si === 4 && !ctx.inventoryWasDiscussed) skip.add(key);

      // s5 Access: skip whole section if access never discussed
      if (si === 5 && !ctx.accessWasDiscussed) skip.add(key);

      // s7 Packing: skip detail items if packing was not discussed
      if (si === 6 && !ctx.packingWasDiscussed && ii >= 2) skip.add(key);

      // s8 Local pricing: skip for LD
      if (si === 7 && isLD) skip.add(key);
      // s9 LD pricing: skip for local
      if (si === 8 && !isLD) skip.add(key);

      // s10 Trust: skip whole section if trust building not discussed
      if (si === 9 && !ctx.trustBuildingWasDiscussed) skip.add(key);

      // s11-s17 Objection sections: skip unless objection raised
      if (si === 10 && !ctx.customerRaisedTrustObjection) skip.add(key);
      if (si === 11 && !ctx.customerRaisedPriceObjection) skip.add(key);
      if (si === 12 && !ctx.customerRaisedSafetyObjection) skip.add(key);
      if (si === 13 && !ctx.customerRaisedStorageObjection) skip.add(key);
      if (si === 14 && !ctx.customerRaisedUrgencyObjection) skip.add(key);
      if (si === 15 && !ctx.customerAskedToDelay) skip.add(key);
      if (si === 16 && !ctx.customerRaisedChargesObjection) skip.add(key);

      // s18 Booking: only skip very specific payment sub-items if the call never reached booking at all
      // Do NOT skip the whole section — agents MUST be rated on whether they attempted to close
      // Only skip payment-detail sub-items (deposit, cancellation, 50%, balance) if no booking was discussed at all
      if (si === 17 && !ctx.agentDiscussedPayment && ii >= 3) skip.add(key);

      // s19 Pre-Move Confirmation: skip if never discussed
      if (si === 18 && !ctx.agentDiscussedPreMoveConf) skip.add(key);

      // s20 Cancellation: skip unless customer requested
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
    // Split combined text into summary and transcript parts
    // Robust splitter for AI Summary and Transcript
    const summaryMatch = transcript.match(/(?:AI SUMMARY|Summary)[\s\S]*?[\n\r]([\s\S]*?)(?=(?:FULL TRANSCRIPT|Transcript)|$)/i);
    const transcriptMatch = transcript.match(/(?:FULL TRANSCRIPT|Transcript)[\s\S]*?[\n\r]([\s\S]*)$/i);
    
    // Fallback if split fails
    const aiSummary = summaryMatch ? summaryMatch[1].trim() : transcript.substring(0, 5000);
    const fullTranscript = transcriptMatch ? transcriptMatch[1].trim().substring(0, 8000) : transcript.substring(Math.max(0, transcript.length - 8000));

    return `You are evaluating a sales call for a moving company. Rate each checklist item.

CALL CONTEXT:
- Move type: ${ctx.moveType} | Call direction: ${ctx.callDirection || 'outbound'}
- Inventory discussed: ${ctx.inventoryWasDiscussed} | Packing discussed: ${ctx.packingWasDiscussed}
- Access discussed: ${ctx.accessWasDiscussed} | Trust building: ${ctx.trustBuildingWasDiscussed}
- Estimate given: ${ctx.agentGaveEstimate} | Payment discussed: ${ctx.agentDiscussedPayment}
- Pre-move confirmation discussed: ${ctx.agentDiscussedPreMoveConf}

AI SUMMARY (PRIMARY SOURCE — use this to determine IF a topic was covered):
${aiSummary}

FULL TRANSCRIPT (use this ONLY to judge HOW WELL the agent spoke — tone, quality, fillers):
${fullTranscript}

ITEMS TO RATE:
${itemLines}

TWO-STAGE RATING PROCESS — FOLLOW IN ORDER:

⚠️ CRITICAL SKIP RULE — READ FIRST:
Items that should be skipped due to call type or context have ALREADY been removed from your list.
Do NOT return "skip" for items in your list UNLESS the item is about:
  - Hold explanation when agent never placed a hold
  - Elevator booking when there is no elevator
  - Wrong-number/callback items when the right person answered and call proceeded
For ALL other items — return "met", "ni", or "notmet". NEVER return "skip" as a way to avoid rating.

══════════════════════════════════════════════════
STAGE 1: DID THE AGENT DO IT? (Use AI Summary)
══════════════════════════════════════════════════
Read the AI SUMMARY first. It is the authoritative record of what happened in the call.

IF the topic IS confirmed in the AI Summary → proceed to Stage 2 to judge quality
IF the topic is NOT in the AI Summary:
  → "notmet" — if it is a standard expected part of this type of call
  → "skip"   — if the item is conditional and the condition did not apply

CALIBRATION — HOW TO MATCH SUMMARY CONTENT TO CHECKLIST ITEMS:

Address Items:
  → "Captured complete pickup address" = "met" if ANY origin location is mentioned (city, region, province)
    For long-distance moves, city/province IS a complete address. Street number is NOT required.
    EXAMPLE: "Montreal" is a complete pickup address. "Saskatchewan" is a complete pickup address.
  → "Captured complete delivery address" = "met" if ANY destination location is mentioned.
    EXAMPLE: "Moncton, New Brunswick" is complete. "Mississauga, Ontario" is complete.

Permission Items (VERY IMPORTANT — READ CAREFULLY):
  → "Asked for permission to proceed" = "met" if agent asked "Is this a good time?" or "Is now a good time to talk?"
    This phrasing in the transcript counts as asking permission.
  → "If not a good time, accepted politely and did not push" = "skip" whenever the customer WAS available and the call proceeded normally.
    Only "notmet" if agent pushed back when customer said it was NOT a good time.
  → Callback items ("Confirmed callback timing", "Scheduled callback") = "skip" if customer was available and call went ahead.
    Only assess callback items if the call was actually rescheduled.

Packing Items — SELF-PACKING CUSTOMER GUIDANCE:
  IF the AI Summary shows the customer is doing their own packing (pre-packed, self-packing, loading/unloading only requested):
    → "Checked if customer prefers self-packing" = met (confirmed customer preference)
    → "Acknowledged customer's packing preference" = met (preference clearly recorded)
    → "Offered packing materials for self-pack customers" = met ONLY if agent offered boxes or bubble wrap
      If agent did NOT offer packing materials = notmet
    → "If packing service requested, confirmed full or partial" = notmet (this is an expected upsell even for self-pack)
    → "Explained packing time inclusion in crew hours" = notmet (agent should explain this regardless)
    → "Asked about dismantling and reassembly" = met ONLY if explicitly discussed in transcript
      If not discussed at all = notmet
    → "Documented dismantling requirements" = met if agent noted requirements; notmet if no dismantling discussed
    → "Offered packing tips or guidance for fragile items" = notmet unless agent explicitly gave tips
    → "Recorded add-ons accurately" = met if agent recorded all items discussed (even just loading/unloading)

Inventory — ROOM-BY-ROOM DEFINITION (VERY IMPORTANT):
  → "Followed structured room-to-room approach" = met ONLY if agent explicitly named and navigated through rooms
    ("In the living room, what do you have?", "Moving to the bedroom now...")
    Simply asking "What items do you need to move?" or "Give me a list" = notmet
    Partially going room-by-room (one or two rooms named) = ni
  → "Covered all major rooms" = met ONLY if living room, bedroom(s), AND kitchen were all explicitly visited
    If only one room was discussed = notmet
  → "Asked about storage, garage, balcony, and outdoor items" = met ONLY if agent specifically asked about any of these areas
    If agent only discussed main furniture without probing outdoor/storage = notmet
  → "Confirmed appliances to be moved" = met if appliances were asked about (even if customer said none or just microwave)
  → "Checked if any items were missed" = met ONLY if agent explicitly asked "Did I miss anything?" or "Anything else?"
  → "Set clear follow-up if inventory was incomplete" = met if agent said customer can update or confirm the list later

Trust Builders — MET vs NI THRESHOLD:
  → "met" for trust items: Agent stated the policy CLEARLY AND customers can understand it without extra research.
    If the summary confirms the topic was covered, and the transcript shows the agent delivered it more than one sentence → met
    The agent does NOT need to give a full lecture with "why" for trust items to be met.
  → "ni" for trust items: Agent was very brief (one sentence only), or used heavy fillers, or sounded confused
    EXAMPLE of met: Agent explained billing start time clearly with all details
    EXAMPLE of ni: "We don't charge for breaks." (single brief statement, no context)
  → Do NOT apply NI to all trust items by default. If the summary confirms trust items were covered → met is the expected rating unless transcript shows quality issues

Move Date:
  → "Confirmed move date clearly" = "met" if ANY target date or timeframe is mentioned (e.g., "May 1st", "last week of April")
  → "Checked flexibility on dates" = "met" if there was any discussion about timing flexibility or urgency around the date

══════════════════════════════════════════════════
STAGE 2: HOW WELL? (Use Full Transcript for quality)
══════════════════════════════════════════════════
Only apply Stage 2 when the topic IS confirmed in the AI Summary.

"met" → Topic confirmed AND transcript shows quality delivery:
  ✔ Agent explained WHY it matters — not just stating the bare fact
  ✔ Natural, confident language — not scripted or robotic
  ✔ No heavy fillers (um, uh, okay okay, alright alright)
  ✔ Connected the point to the customer's specific situation
  EXAMPLE met: "We pause the timer during breaks so you're never charged for downtime."
  EXAMPLE ni:  "We don't charge for breaks." (fact only, no WHY)

"ni" (Needs Improvement) → Confirmed in Summary BUT transcript shows poor execution:
  ✗ Agent stated facts without explaining WHY
  ✗ Brief, mechanical, or scripted delivery
  ✗ Heavy fillers or repeated phrases
  → Use NI freely — it is the EXPECTED rating for items done but done poorly

══════════════════════════════════════════════════
SOFT SKILLS — CALIBRATED RULES
══════════════════════════════════════════════════
"met"    → Skill CONSISTENTLY demonstrated throughout the entire call with natural, varied, error-free language
"ni"     → Skill attempted but inconsistent, mechanical, OR any quality issue listed below — USE FREELY
"notmet" → Skill completely absent throughout the entire call
"skip"   → Only for hold-related items when no hold was placed

NI TRIGGER — Any of these in the transcript pushes a soft skill item to "ni":
  ✗ Repeated phrases in the same turn ("I can, I can, I can", "okay okay", "alright alright")
  ✗ Word errors or malapropisms ("hazel free" instead of "hassle-free", wrong terminology)
  ✗ Scripted / formulaic empathy ("I completely understand" with no personalised follow-up)
  ✗ Vague commitments ("I'll try my best", "hopefully", "we'll see")
  ✗ Deflecting or dismissive phrases ("just trust me", "don't worry about it")
  ✗ Filler words used frequently ("you know", "um", "uh", "like")
  ✗ Sounded defensive or apologetic rather than confident and solution-focused
  ✗ Failed to use the customer's name more than once or twice in the entire call
  ✗ Guided call but missed natural opportunities to build trust or rapport

EXPECTED RANGE: Most calls have 5-8 NI items in Soft Skills.
If you find fewer than 5 NI → re-read the transcript carefully for the quality issues above.
If you are unsure between "met" and "ni" for any soft skill item → give "ni".

══════════════════════════════════════════════════
PRE-MOVE CONFIRMATION — RULES
══════════════════════════════════════════════════
"met"  → Agent stated it clearly AND explained WHY it matters
"ni"   → Agent mentioned it but just stated facts — USE FREELY
"skip" → Pre-move confirmation was never discussed

Return JSON: {"r_X_X": "met", ...}
Include ALL ${batch.length} keys. Return ONLY the JSON object.`;
  }

  console.log(`  Batch 1: ${batch1.length} items (${GROQ_MODEL})...`);
  const raw1 = await callGroq(GROQ_MODEL, sys, buildBatchPrompt(batch1), 800);
  const result1 = parseJSON(raw1) || {};

  console.log(`  Waiting 5s between batches...`);
  await delay(5000);

  console.log(`  Batch 2: ${batch2.length} items (${GROQ_MODEL_B2})...`);
  const raw2 = await callGroq(GROQ_MODEL_B2, sys, buildBatchPrompt(batch2), 800);
  const result2 = parseJSON(raw2) || {};

  return { ...result1, ...result2 };
}

// ── Main analysis ─────────────────────────────────────────────────────────────
async function analyzeCall(callText) {
  const allItems = flattenChecklist();
  const transcript = sampleTranscript(callText, 25000);
  console.log(`  Transcript: ${callText.length} chars → sampled ${transcript.length} chars`);

  console.log('  Pass 1: context analysis...');
  const ctx = await analyzeContext(transcript);
  const skip = buildSkipList(ctx);
  console.log(`  Context: ${ctx.moveType} | ${ctx.callDirection} | followUp=${ctx.isFollowUpCall} | inv=${ctx.inventoryWasDiscussed} pack=${ctx.packingWasDiscussed} access=${ctx.accessWasDiscussed} trust=${ctx.trustBuildingWasDiscussed}`);
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

app.post('/api/send-report-email', async (req, res) => {
  const { csvContent, fileName, htmlContent } = req.body;

  if (!csvContent) {
    return res.status(400).json({ error: 'CSV content is required' });
  }

  const recipients = process.env.EMAIL_RECIPIENTS || process.env.EMAIL_USER;

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.error('❌ Email failed: Missing EMAIL_USER or EMAIL_PASS in .env');
    return res.status(500).json({ error: 'Email configuration missing in server .env' });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT,
      secure: process.env.EMAIL_PORT == 465,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const subject = `TNVL Performance Reports Bundle — ${new Date().toLocaleDateString('en-CA')}`;

    await transporter.sendMail({
      from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      to: recipients,
      subject,
      text: `Please find the attached TNVL Call Quality Report Bundle.`,
      html: htmlContent || `<p>Please find the attached report.</p>`,
      attachments: [{ filename: fileName || 'AgentSummary.csv', content: csvContent }],
    });

    console.log(`✅ Report emailed to: ${recipients}`);
    res.json({ success: true, message: 'Email sent successfully' });
  } catch (error) {
    console.error('❌ Email Error:', error);
    res.status(500).json({ error: 'Failed to send email', details: error.message });
  }
});

app.get('/api/health', (_req, res) => res.json({
  status: 'ok',
  engine: `Groq FREE (${GROQ_MODEL} + ${GROQ_MODEL_B2})`,
  groqKeys: `${GROQ_KEYS.length} keys loaded`,
  port: process.env.PORT || 3000
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ TNVL Server → http://0.0.0.0:${PORT}`);
  console.log(`   Engine : Groq FREE ✅`);
  console.log(`   Model  : ${GROQ_MODEL} (context + batch 1)`);
  console.log(`   Model2 : ${GROQ_MODEL_B2} (batch 2)`);
  console.log(`   Keys   : ✅ loaded ${GROQ_KEYS.length} keys`);
  console.log(`   Speed  : ~20-30s per analysis`);
  console.log(`   Limits : No daily cap — FREE forever`);
  console.log(`\n   Accuracy v3 — what changed:`);
  console.log(`   • RULE OF SILENCE: no transcript evidence = skip or notmet, never met`);
  console.log(`   • RULE OF QUALITY: present but robotic/brief/no-why = ni, not met`);
  console.log(`   • BENEFIT STATEMENT TEST: must explain WHY, not just state the fact`);
  console.log(`   • NI enforced: brief/filler-heavy/scripted delivery = ni not met\n`);
});