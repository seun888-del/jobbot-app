const { llmAvailable, llmChat } = require('../../src/services/llm');

// Finds where the next ALL-CAPS section heading starts (marks end of current section)
const SECTION_RE = /\n([A-Z][A-Z\s&]{3,})\n/;

// Work experience — covers all common heading variants
const WORK_RE = /\b(WORK EXPERIENCE|PROFESSIONAL EXPERIENCE|EMPLOYMENT HISTORY|EMPLOYMENT EXPERIENCE)\b/i;

// Skills — covers all common heading variants
const SKILLS_RE = /\b(TECHNICAL SKILLS|KEY SKILLS|CORE SKILLS|CORE COMPETENCIES|PROFESSIONAL SKILLS|IT SKILLS|SKILLS)\b/i;

const SPACED_HEADING_MAP = {
  'PROFESSIONALPROFILE':          'PROFESSIONAL PROFILE',
  'PERSONALPROFILE':              'PERSONAL PROFILE',
  'CAREERPROFILE':                'CAREER PROFILE',
  'WORKEXPERIENCE':               'WORK EXPERIENCE',
  'PROFESSIONALEXPERIENCE':       'PROFESSIONAL EXPERIENCE',
  'EMPLOYMENTHISTORY':            'EMPLOYMENT HISTORY',
  'KEYPROJECTS':                  'KEY PROJECTS',
  'TECHNICALSKILLS':              'TECHNICAL SKILLS',
  'KEYSKILLS':                    'KEY SKILLS',
  'CORESKILLS':                   'CORE SKILLS',
  'CORECOMPETENCIES':             'CORE COMPETENCIES',
  'EDUCATIONANDCERTIFICATIONS':   'EDUCATION AND CERTIFICATIONS',
  'EDUCATIONCERTIFICATIONS':      'EDUCATION & CERTIFICATIONS',
  'EDUCATION':                    'EDUCATION',
  'CERTIFICATIONS':               'CERTIFICATIONS',
  'ACHIEVEMENTS':                 'ACHIEVEMENTS',
  'PROFESSIONALSUMMARY':          'PROFESSIONAL SUMMARY',
  'CAREERSUMMARY':                'CAREER SUMMARY',
};

function normalizeSpacedLetters(text) {
  const lineArr = text.split('\n');
  // First non-empty line is the name — don't collapse it (we'd lose the space in "FEMI MERIT")
  let nameLineIdx = -1;
  for (let i = 0; i < lineArr.length; i++) {
    if (lineArr[i].trim()) { nameLineIdx = i; break; }
  }
  return lineArr.map((line, idx) => {
    const t = line.trim();
    // Fix jammed headings that are a single all-caps token (e.g. "WORKEXPERIENCE")
    if (SPACED_HEADING_MAP[t]) return SPACED_HEADING_MAP[t];
    // Fix letter-spaced headings (e.g. "W O R K  E X P E R I E N C E") — but NOT the name line
    if (idx !== nameLineIdx) {
      const parts = t.split(/\s+/);
      if (parts.length >= 4 && parts.every(p => /^[A-Z]$/.test(p))) {
        const collapsed = parts.join('');
        return SPACED_HEADING_MAP[collapsed] || collapsed;
      }
    }
    return line;
  }).join('\n');
}

function extractParts(cvText) {
  const lines = cvText.split('\n');
  const nonEmpty = lines.map((l, i) => ({ text: l.trim(), idx: i })).filter(l => l.text);
  const subtitle = nonEmpty[1] ? nonEmpty[1].text : '';

  const profileHeadingRe = /\b(PROFESSIONAL PROFILE|PERSONAL PROFILE|CAREER PROFILE|EXECUTIVE PROFILE|PROFESSIONAL SUMMARY|CAREER SUMMARY|EXECUTIVE SUMMARY|PERSONAL SUMMARY|PERSONAL STATEMENT|OBJECTIVE|ABOUT ME|SUMMARY|PROFILE)\b/i;
  const headingMatch = profileHeadingRe.exec(cvText);
  if (headingMatch) {
    console.log(`  [Tailor] Profile heading: "${headingMatch[0]}"`);
  } else {
    console.log('  [Tailor] No profile section found — skipping Step 1');
    return { subtitle, profile: '', profileStart: -1, profileEnd: -1 };
  }

  const afterHeading = cvText.slice(headingMatch.index + headingMatch[0].length);
  const nextSection  = SECTION_RE.exec(afterHeading);
  const sectionBound = nextSection ? nextSection.index : Infinity;
  // Stop at blank line
  const blankLine    = afterHeading.search(/\n\s*\n/);
  const blankBound   = blankLine > 20 ? blankLine : Infinity;
  // Scan every newline to find where a comma-separated keyword list starts
  // (covers CVs where skills run directly after profile prose with only single \n separators)
  let keywordBound = Infinity;
  const KEYWORD_LIST_RE = /^[A-Z][A-Za-z \/()&-]+(?:,\s*[A-Z][A-Za-z \/()&-]+){2,}/;
  const nlSearchLimit = Math.min(sectionBound, blankBound, 1400);
  let nlSearch = 0;
  while (nlSearch < nlSearchLimit) {
    const nlIdx = afterHeading.indexOf('\n', nlSearch);
    if (nlIdx === -1 || nlIdx >= nlSearchLimit) break;
    if (nlIdx > 80) {
      const afterNL = afterHeading.slice(nlIdx + 1).trimStart();
      if (KEYWORD_LIST_RE.test(afterNL)) { keywordBound = nlIdx; break; }
    }
    nlSearch = nlIdx + 1;
  }
  const profileEnd   = Math.min(sectionBound, blankBound, keywordBound, 1200);
  const profile      = afterHeading.slice(0, profileEnd).trim();
  const absoluteStart = headingMatch.index + headingMatch[0].length;
  const absoluteEnd   = absoluteStart + profileEnd;
  // When keywordBound hit, there is a dangling skills block between profileEnd and sectionBound.
  // Expose its end so the caller can strip it after splicing in the new profile.
  const skillsBlockEnd = (keywordBound < Math.min(sectionBound, blankBound, 1200) && sectionBound < Infinity)
    ? absoluteStart + sectionBound
    : absoluteEnd;

  return { subtitle, profile, absoluteStart, absoluteEnd, skillsBlockEnd };
}

function extractSection(cvText, headingPattern) {
  const match = headingPattern.exec(cvText);
  if (!match) return null;
  const afterHeading = cvText.slice(match.index + match[0].length);
  const nextSection  = SECTION_RE.exec(afterHeading);
  const sectionEnd   = nextSection ? nextSection.index : afterHeading.length;
  return {
    absoluteStart: match.index + match[0].length,
    absoluteEnd:   match.index + match[0].length + sectionEnd,
    text:          afterHeading.slice(0, sectionEnd).trim(),
  };
}

// ── Step 1: Subtitle + Professional Profile ──────────────────────────────────

async function _tailorProfile(cvText, jobTitle, jdExcerpt) {
  const { subtitle, profile, absoluteStart, absoluteEnd } = extractParts(cvText);
  if (!profile) return cvText;

  const prompt = `Make minimal edits to a CV subtitle and professional profile to better match a specific job — keyword injection, not a full rewrite.

JOB TITLE: ${jobTitle}
JOB DESCRIPTION:
${jdExcerpt}

CURRENT CV SUBTITLE (role title shown under the person's name):
${subtitle}

CURRENT PROFESSIONAL PROFILE:
${profile}

Update ONLY the subtitle to closely match this JD job title. Do not touch the profile prose at all.

Respond in EXACTLY this format with no other text:

SUBTITLE: [updated role title — mirror the JD's exact job title wording]
PROFILE: [copy the CURRENT PROFESSIONAL PROFILE here exactly, word for word, unchanged]

Rules:
- SUBTITLE must closely mirror the exact job title from the JD
- PROFILE must be copied verbatim — do not change a single word
- NEVER use Markdown formatting — no asterisks, no bold markers
- No commentary, no preamble — return only the two lines above`;

  try {
    const profileText   = await llmChat(prompt);
    const subtitleMatch = profileText.match(/^SUBTITLE:\s*(.+)/m);
    const profileMatch  = profileText.match(/^PROFILE:\s*([\s\S]+)/m);

    if (subtitleMatch && profileMatch) {
      let newSubtitle = subtitleMatch[1].trim();
      let newProfile  = profileMatch[1].trim();
      newProfile = newProfile.replace(/[.,]?\s*Conversational German\.?/gi, '').trim();
      newProfile = newProfile.replace(/,?\s*German\s*\(conversational\)\.?/gi, '').trim();
      // If AI added a skills dump, the profile grows significantly beyond the source length.
      // Truncate at the last sentence-ending period within 130% of the source profile length.
      if (newProfile.length > profile.length * 1.4) {
        const maxLen = Math.ceil(profile.length * 1.3);
        const cutPoint = newProfile.lastIndexOf('.', maxLen);
        if (cutPoint > 100) newProfile = newProfile.slice(0, cutPoint + 1).trim();
      }

      let tailored = cvText.replace(subtitle, newSubtitle);
      const updated = extractParts(tailored);
      if (updated.absoluteStart != null && updated.absoluteStart >= 0) {
        // Replace the profile prose with newProfile; if there's a dangling skills block
        // between absoluteEnd and skillsBlockEnd, remove that too.
        const afterProfile = updated.skillsBlockEnd > updated.absoluteEnd
          ? tailored.slice(updated.skillsBlockEnd)   // skip dangling skills block
          : tailored.slice(updated.absoluteEnd);
        tailored = tailored.slice(0, updated.absoluteStart) + '\n' + newProfile + '\n' + afterProfile;
        console.log(`  [Tailor] ✓ Profile → "${newSubtitle.substring(0, 55)}"`);
        return tailored;
      }
    } else {
      console.log('  [Tailor] Unexpected profile format — keeping original');
    }
  } catch (err) {
    console.log(`  [Tailor] Profile error: ${err.message}`);
  }
  return cvText;
}

// ── Step 2: Work Experience Bullets ─────────────────────────────────────────

async function _tailorBullets(cvText, jobTitle, jdExcerpt) {
  const workSection = extractSection(cvText, WORK_RE);
  if (!workSection || !workSection.text) {
    console.log('  [Tailor] No work experience section — skipping Step 2');
    return cvText;
  }

  const prompt = `You are making minimal, surgical edits to CV bullet points to match a specific job — like keyword injection, not a rewrite.

JOB TITLE: ${jobTitle}
JOB DESCRIPTION:
${jdExcerpt}

CURRENT WORK EXPERIENCE:
${workSection.text.substring(0, 8000)}

Rewrite the work experience section to be leaner and more relevant to this job.

The section contains multiple roles. Each role has a HEADER LINE in the format "Job Title | Company  Date" followed by bullet lines starting with •.

Rules:
- KEEP EVERY ROLE HEADER LINE UNCHANGED — the "Job Title | Company  Date" lines must appear exactly as-is, in the same order, with no alterations
- For each role, SELECT the 3 most relevant bullets to this JD and DROP the rest (3 bullets max per role)
- Shorten each kept bullet to 1 line — cut filler words, cut redundant clauses
- Lead each bullet with a strong action verb
- Swap in JD-exact terminology where it fits naturally (e.g. "supported users" → "provided IT support")
- NEVER invent facts, numbers, activities, locations, qualifications, or tools not already present in the original bullet
- NEVER add driving licence, travel, or commuting references unless already in the original
- Each JD keyword should appear at most TWICE across the entire work experience section — do NOT repeat the same term in every bullet
- KEEP the bullet character (•) at the start of every bullet line
- Return ONLY the work experience section text, no commentary, no preamble`;

  try {
    const result = await llmChat(prompt);
    if (!result) return cvText;
    const REFUSAL_RE = /cannot|ethically|I (need to|must|should)|what I can|please clarify|not (possible|appropriate)/i;
    if (REFUSAL_RE.test(result.slice(0, 300))) {
      console.log('  [Tailor] Bullets: AI returned refusal — keeping original');
      return cvText;
    }
    const pos = extractSection(cvText, WORK_RE);
    if (!pos) return cvText;
    // Reject if result is suspiciously short — AI likely truncated or returned nothing
    // Threshold is loose (25%) because we now ask for max 3 bullets per role
    if (result.trim().length < workSection.text.length * 0.25 && workSection.text.length > 1500) {
      console.log(`  [Tailor] Bullets result too short (${result.length} vs ${workSection.text.length}) — keeping original`);
      return cvText;
    }
    const tailored = cvText.slice(0, pos.absoluteStart) + '\n' + result.trim() + '\n' + cvText.slice(pos.absoluteEnd);
    console.log(`  [Tailor] ✓ Bullets tailored (${result.length} chars)`);
    return tailored;
  } catch (err) {
    console.log(`  [Tailor] Bullets error: ${err.message}`);
    return cvText;
  }
}

// ── Step 3: Skills Section Rebuild ──────────────────────────────────────────

async function _tailorSkills(cvText, jobTitle, jdExcerpt) {
  const skillsSection = extractSection(cvText, SKILLS_RE);
  if (!skillsSection || skillsSection.text.trim().length < 5) {
    console.log('  [Tailor] No skills section — skipping Step 3');
    return cvText;
  }

  const workSection   = extractSection(cvText, WORK_RE);
  const workContext   = workSection ? workSection.text.substring(0, 700) : '';

  const prompt = `You are reorganising and relabelling an existing CV Skills section to better reflect the terminology used in a job advert. You are NOT inventing new skills — only reordering and renaming existing ones using the job's wording.

JOB TITLE: ${jobTitle}
JOB DESCRIPTION:
${jdExcerpt}

WORK EXPERIENCE (context for what the candidate has done):
${workContext}

CURRENT SKILLS SECTION:
${skillsSection.text}

Instructions:
1. Reorder categories so the most relevant ones appear first
2. Rename categories and skills to match the exact wording the JD uses where the meaning is the same
3. Remove skills that have no connection to this job
4. Only group skills under a category label if that label appears in or is directly implied by the JD
5. Preserve the same formatting (Category: skill, skill, skill)
6. Each skill must appear in ONE category only — no duplicates across categories
7. Do NOT invent new skills or tools not already in the original skills section

Return ONLY the reorganised skills content — no section heading, no commentary, no explanations.`;

  try {
    const result = await llmChat(prompt);
    if (!result || result.trim().length < 5) return cvText;
    // Reject if the AI returned a refusal or commentary instead of skills content
    const REFUSAL_RE = /cannot|ethically|I (need to|must|should)|what I can|please clarify|not (possible|appropriate)/i;
    if (REFUSAL_RE.test(result.slice(0, 300))) {
      console.log('  [Tailor] Skills: AI returned refusal — keeping original');
      return cvText;
    }
    const pos = extractSection(cvText, SKILLS_RE);
    if (!pos) return cvText;
    const tailored = cvText.slice(0, pos.absoluteStart) + '\n' + result.trim() + '\n' + cvText.slice(pos.absoluteEnd);
    console.log('  [Tailor] ✓ Skills section rebuilt with JD-exact terminology');
    return tailored;
  } catch (err) {
    console.log(`  [Tailor] Skills error: ${err.message}`);
    return cvText;
  }
}

// ── Step 4: Quantify Achievements ───────────────────────────────────────────

async function _quantifyBullets(cvText, jobTitle) {
  const workSection = extractSection(cvText, WORK_RE);
  if (!workSection || workSection.text.trim().length < 20) return cvText;

  const workExcerpt = workSection.text.substring(0, 8000);

  const prompt = `Add specific numbers and metrics to unquantified bullet points in this CV Work Experience section.

ROLE BEING APPLIED FOR: ${jobTitle}

WORK EXPERIENCE:
${workExcerpt}

For each bullet WITHOUT a specific number or metric, add a realistic, conservative figure.

Examples of good quantification:
- "Provided IT support to users" → "Provided IT support to 150+ users across 2 sites"
- "Resolved help desk tickets" → "Resolved 40+ help desk tickets weekly, maintaining 95% SLA compliance"
- "Managed a team" → "Led a team of 5 technicians"
- "Configured workstations" → "Configured and deployed 80+ Windows workstations"
- "Reduced downtime" → "Reduced system downtime by 30% through proactive monitoring"
- "Trained staff" → "Trained 20+ staff members on new systems and procedures"
- "Managed projects" → "Delivered 8 infrastructure projects on time and within budget"

Rules:
- Only add a number or metric to a bullet that describes a measurable activity — do NOT change the activity itself
- Numbers must be plausible and conservative for the role seniority shown
- Do NOT add revenue amounts, contract values, or sales figures
- Do NOT change bullets that already have specific numbers or percentages
- Do NOT change job titles, company names, or dates
- Do NOT add new activities, tools, locations, or qualifications not already in the bullet — ONLY add a number to what is already there
- Do NOT add driving licence, travel, commuting, or transport references
- Keep the same writing style and tense
- KEEP the bullet character (•) at the start of every bullet line — do not remove or replace it
- Return ONLY the rewritten work experience content — no heading, no commentary`;

  try {
    const result = await llmChat(prompt);
    if (!result || result.trim().length < workExcerpt.length * 0.25) return cvText;
    const REFUSAL_RE = /cannot|ethically|I (need to|must|should)|what I can|please clarify|not (possible|appropriate)/i;
    if (REFUSAL_RE.test(result.slice(0, 300))) {
      console.log('  [Tailor] Quantify: AI returned refusal — keeping original');
      return cvText;
    }
    const pos = extractSection(cvText, WORK_RE);
    if (!pos) return cvText;
    // Only use AI result if it covers enough of what we sent — reject if truncated
    if (result.trim().length < workSection.text.length * 0.25 && workSection.text.length > 1500) {
      console.log(`  [Tailor] Quantification result too short — keeping original`);
      return cvText;
    }
    const tailored = cvText.slice(0, pos.absoluteStart) + '\n' + result.trim() + '\n' + cvText.slice(pos.absoluteEnd);
    console.log('  [Tailor] ✓ Achievements quantified with metrics');
    return tailored;
  } catch (err) {
    console.log(`  [Tailor] Quantification error: ${err.message}`);
    return cvText;
  }
}

// ── Main tailorCV (2 steps — subtitle + skills only) ─────────────────────────
// Work experience bullets and profile prose are left exactly as the user wrote them.
// Only the subtitle (job title) and skills section get adjusted to match the JD.

async function tailorCV(cvText, jobTitle, jobDescription) {
  cvText = normalizeSpacedLetters(cvText);

  if (!await llmAvailable()) {
    console.log('  [Tailor] AI unavailable — skipping all tailoring');
    return cvText;
  }

  const jdExcerpt = jobDescription.substring(0, 3500);

  let tailored = cvText;

  console.log('  [Tailor] Step 1: Subtitle update...');
  tailored = await _tailorProfile(tailored, jobTitle, jdExcerpt);

  console.log('  [Tailor] Step 2: Skills section rebuild...');
  tailored = await _tailorSkills(tailored, jobTitle, jdExcerpt);

  return tailored;
}

// ── Inline keyword weaving (called by bot_scorer after initial scoring) ───────
// Weaves missing JD keywords naturally into bullets and skills — no crude addendum.

async function weaveKeywords(cvText, missingKeywords, jdText) {
  if (!missingKeywords || !missingKeywords.length || !await llmAvailable()) return cvText;

  const meaningful = missingKeywords
    .filter(k => typeof k === 'string' && k.trim().length >= 2 && k.trim().length <= 60 && !k.includes('?') && !k.includes('|'))
    .slice(0, 12);

  if (!meaningful.length) return cvText;

  const prompt = `Add missing keywords to the KEY SKILLS section of this CV only.

KEYWORDS TO ADD:
${meaningful.join(', ')}

CURRENT CV:
${cvText.substring(0, 12000)}

Instructions:
- ONLY modify the KEY SKILLS (or SKILLS) section — do not touch any other section
- Add each keyword into the most relevant existing skill category line
- Do NOT touch the profile, work experience bullets, education, or any other section
- Do NOT change job titles, company names, dates, or section headings
- Do NOT invent new skill categories — only add to existing ones
- Do NOT add a new section
- Return the COMPLETE CV with ALL sections intact
- NEVER use Markdown formatting — no asterisks (**), no bold markers
- No commentary or preamble — return only the CV text`;

  try {
    const result = await llmChat(prompt);
    // Reject if result is significantly shorter than source — AI likely truncated
    if (result && result.length > cvText.length * 0.85) {
      console.log(`  [Tailor] ✓ ${meaningful.length} missing keywords woven inline`);
      return result.trim();
    }
    if (result) {
      console.log(`  [Tailor] Keyword weave rejected — result too short (${result.length} vs ${cvText.length}), keeping original`);
    }
  } catch (err) {
    console.log(`  [Tailor] Keyword weave error: ${err.message}`);
  }
  return cvText;
}

module.exports = { tailorCV, weaveKeywords };
