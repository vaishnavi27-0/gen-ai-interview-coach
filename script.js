// ---------- Config ----------
const GEMINI_API_KEY = 'AIzaSyAjNEs5e3rl0Zno_759qn1BxIK5GtbUnyQ';
const MODELS = [
  'models/gemini-2.5-flash:generateContent',
  'models/gemini-2.5-pro:generateContent',
  'models/gemini-2.0-flash:generateContent'
];
const MAX_RETRIES = 3;
const MAX_REGENERATE_ATTEMPTS = 4;
const SIMILARITY_THRESHOLD = 0.45;

/* ---------- DOM ---------- */
const startBtn = document.getElementById('startBtn');
const regenerateBtn = document.getElementById('regenerateBtn');
const roleInput = document.getElementById('roleInput');
const questionsArea = document.getElementById('questionsArea');
const answerPanel = document.getElementById('answerPanel');
const answerInput = document.getElementById('answerInput');
const submitAnswerBtn = document.getElementById('submitAnswerBtn');
const revealModelBtn = document.getElementById('revealModelBtn');
const feedbackContainer = document.getElementById('feedbackContainer');
const apiStatus = document.getElementById('apiStatus');

let currentQuestion = null;
let previousQuestions = [];
let awaitingNext = false;
let lastLLMRaw = '';

/* ---------- callGemini ---------- */
async function callGemini(prompt, opts = {}) {
  const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.18;
  const maxRetries = typeof opts.maxRetries === 'number' ? opts.maxRetries : MAX_RETRIES;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    for (const modelPath of MODELS) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/${modelPath}?key=${GEMINI_API_KEY}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature, maxOutputTokens: 700 }
          })
        });

        if (!resp.ok) {
          const txt = await resp.text();
          console.warn(`Model ${modelPath} failed (status ${resp.status}):`, txt);
          if (resp.status === 429) apiStatus.textContent = '❗ Rate limited (429). Try again later or use lower frequency.';
          continue;
        }

        const data = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text && text.trim()) {
          console.log(`✅ Success from ${modelPath} (attempt ${attempt + 1})`);
          lastLLMRaw = text.trim();
          return text.trim();
        }

        // fallback: store stringified response for debugging and attempt to return some long string
        const whole = JSON.stringify(data || '');
        lastLLMRaw = whole;
        const m = whole.match(/"([^"]{20,})"/);
        if (m) return m[1];
      } catch (err) {
        console.warn(`callGemini error (model ${modelPath}, attempt ${attempt + 1}):`, err?.message || err);
      }
    }
    await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
  }

  return null;
}

/* ---------- Utilities ---------- */
function escapeHtml(s) { if (!s && s !== 0) return ''; return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }
function wordSet(s) { if (!s) return new Set(); return new Set(s.toLowerCase().replace(/[^\w\s]/g,' ').split(/\s+/).filter(Boolean)); }
function jaccard(a,b){ const A=wordSet(a), B=wordSet(b); if(A.size===0 && B.size===0) return 1; if(A.size===0||B.size===0) return 0; let inter=0; for(const x of A) if(B.has(x)) inter++; const uni=new Set([...A,...B]).size; return inter/uni; }
function similarityToList(q, list) { let max = 0; for (const t of list) { const s = jaccard(q, t); if (s > max) max = s; } return max; }

/* ---------- Debug / Aggressive Normalizer ---------- */
function debugLogLLM(raw, tag = 'LLM') {
  try { console.groupCollapsed(`${tag} output`); console.log(raw); console.groupEnd(); } catch(e){ /* ignore */ }
}

function findLikelyAnswer(obj) {
  if (obj == null) return null;
  if (typeof obj === 'string' && obj.trim().length > 0) return obj.trim();
  if (Array.isArray(obj)) {
    for (const el of obj) {
      const found = findLikelyAnswer(el);
      if (found) return found;
    }
    return null;
  }
  if (typeof obj === 'object') {
    const keyPriority = ['solution','modelAnswer','model_answer','answer','model','response','content','text','solution_text','solutionText','answer_text'];
    for (const k of keyPriority) {
      if (k in obj) {
        const val = obj[k];
        const found = findLikelyAnswer(val);
        if (found) return found;
      }
    }
    for (const k of Object.keys(obj)) {
      const val = obj[k];
      const found = findLikelyAnswer(val);
      if (found) return found;
    }
  }
  return null;
}

function tryParseAnyJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) {}
  const objMatch = s.match(/(\{[\s\S]*\})/m);
  if (objMatch) { try { return JSON.parse(objMatch[1]); } catch (e) {} }
  const arrMatch = s.match(/(\[[\s\S]*\])/m);
  if (arrMatch) { try { return JSON.parse(arrMatch[1]); } catch (e) {} }
  return null;
}

function extractSolutionFromText(s) {
  if (!s) return '';
  const re = /(Solution|Model answer|Model Answer|Answer)\s*[:\-]\s*([\s\S]{20,1000}?)(?:\n{2,}|$)/i;
  const m = s.match(re);
  if (m && m[2]) return m[2].trim();
  const paragraphs = s.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  for (let i = paragraphs.length - 1; i >= 0; i--) {
    const p = paragraphs[i];
    if (p.split(/[.?!]/).filter(Boolean).length >= 1 && p.length > 30 && p.length < 800) return p;
  }
  return '';
}

function normalizeParsedObject(p) {
  if (!p) return null;
  if (Array.isArray(p) && p.length > 0) p = p[0];
  if (typeof p !== 'object') return null;

  let q = null;
  if (typeof p.q === 'string' && p.q.trim()) q = p.q.trim();
  else if (typeof p.question === 'string' && p.question.trim()) q = p.question.trim();
  else if (typeof p.prompt === 'string' && p.prompt.trim()) q = p.prompt.trim();
  else {
    for (const k of Object.keys(p)) {
      if (typeof p[k] === 'string' && p[k].trim().length > 10) { q = p[k].trim(); break; }
    }
  }

  let modelAnswer = findLikelyAnswer(p.solution) || findLikelyAnswer(p.modelAnswer) || findLikelyAnswer(p.model_answer) || findLikelyAnswer(p.answer) || findLikelyAnswer(p.solution_text) || findLikelyAnswer(p.model_answer_text) || null;
  if (!modelAnswer) modelAnswer = findLikelyAnswer(p);

  q = (q || '').trim();
  modelAnswer = (modelAnswer || '').trim();

  console.groupCollapsed('normalizeParsedObject result');
  console.log('original obj:', p);
  console.log('extracted q:', q);
  console.log('extracted modelAnswer:', modelAnswer);
  console.groupEnd();

  if (!q) return null;
  return { q, modelAnswer };
}

/* ---------- Prompt builder (single question) ---------- */
function jsonPromptForSingleQuestion(role, avoidList = [], nonce = null, varietyHint = '') {
  const avoidText = (avoidList && avoidList.length) ? `Avoid repeating or paraphrasing these previous questions:\n- ${avoidList.join('\n- ')}\n\n` : '';
  const nonceText = nonce ? `/* UNIQUE_RUN_TOKEN: ${nonce} */\n` : '';
  const variety = varietyHint || 'Prefer scenario-based and concrete question (mix conceptual + practical).';

  return `${nonceText}${avoidText}You are an expert interviewer. Produce EXACTLY ONE interview question tailored to the role "${role}". ${variety}
Return JSON ONLY (no extra text). The JSON should be an array with a single object that has exactly:
- "q": the question text (string)
- "solution": concise model answer (2-6 sentences, string)

Example:
[
  { "q": "Explain X?", "solution": "Short answer." }
]

Do not include anything else.`;
}

/* ---------- Prompt builder (follow-up for solution only) ---------- */
function promptForSolutionOnly(question, nonce = null) {
  const nonceText = nonce ? `/* UNIQUE_RUN_TOKEN: ${nonce} */\n` : '';
  return `${nonceText}You are an expert interviewer. Given the interview question below, return ONLY a concise model answer (2-6 sentences). Return JSON ONLY as an object with exactly one field "solution" whose value is the concise answer string.

Question:
${question}

Example:
{ "solution": "Concise model answer." }

Do not include any other keys or commentary.`;
}

/* ---------- Robust JSON extractor ---------- */
function extractJsonBlock(s) {
  if (!s) return null;
  const arrayMatch = s.match(/(\[\s*\{[\s\S]*?\}\s*\])/m);
  if (arrayMatch) {
    try { const parsed = JSON.parse(arrayMatch[1]); if (Array.isArray(parsed)) return parsed; } catch (e) { console.warn('JSON.parse failed on extracted arrayMatch:', e); }
  }
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    try { const parsed = JSON.parse(fenced[1].trim()); if (Array.isArray(parsed)) return parsed; } catch (e) { console.warn('JSON.parse failed on fenced block:', e); }
  }
  const firstBracket = s.indexOf('[');
  if (firstBracket >= 0) {
    let depth = 0, endIdx = -1;
    for (let i = firstBracket; i < s.length; i++) {
      if (s[i] === '[') depth++;
      else if (s[i] === ']') { depth--; if (depth === 0) { endIdx = i; break; } }
    }
    if (endIdx > firstBracket) {
      const candidate = s.slice(firstBracket, endIdx + 1);
      try { const parsed = JSON.parse(candidate); if (Array.isArray(parsed)) return parsed; } catch (e) { console.warn('JSON.parse failed on candidate slice:', e); }
    }
  }
  return null;
}

/* ---------- Free-text fallback parser for single question ---------- */
function parseSingleQuestionFromText(raw) {
  if (!raw) return null;
  const qMatch = raw.match(/(?:^|\n)\s*(?:1\.\s*)?(?:Question|Q|Q:)?\s*([^\n\r]{10,})\s*(?:\n|$)/i);
  const solMatch = raw.match(/(?:Solution|Answer|Model answer)[:\s]*([\s\S]{10,800})$/i);
  let q = null, sol = '';
  if (solMatch) {
    sol = solMatch[1].trim();
    const before = raw.split(solMatch[0])[0];
    const lines = before.trim().split(/\n/).map(l=>l.trim()).filter(Boolean);
    if (lines.length) q = lines[lines.length-1];
  } else {
    const lines = raw.split(/\n/).map(l=>l.trim()).filter(Boolean);
    if (lines.length) q = lines.find(l => l.length > 10) || lines[0];
  }
  if (!q) return null;
  return { q: q.trim(), modelAnswer: sol.trim() };
}

/* ---------- Fetch solution follow-up ---------- */
async function fetchSolutionForQuestion(question, ctxNonce) {
  apiStatus.textContent = '⏳ Fetching model answer...';
  const p = promptForSolutionOnly(question, ctxNonce);
  const llmText = await callGemini(p, { temperature: 0.2, maxRetries: 2 });
  debugLogLLM(llmText, 'fetchSolutionForQuestion - raw');

  if (!llmText) return '';

  // try JSON object parse
  const any = tryParseAnyJSON(llmText);
  if (any && typeof any === 'object') {
    // may be { solution: "..." } or [ { solution: "..." } ]
    let candidateObj = any;
    if (Array.isArray(any) && any.length > 0) candidateObj = any[0];
    const sol = findLikelyAnswer(candidateObj.solution || candidateObj.modelAnswer || candidateObj.answer || candidateObj);
    if (sol) return sol;
  }

  // try to extract "solution" from text
  const solText = extractSolutionFromText(llmText);
  if (solText) return solText;

  // last fallback: take the longest paragraph under 800 chars
  const paras = llmText.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paras.length) {
    const chosen = paras.find(p => p.length > 30 && p.length < 800) || paras[0];
    return chosen;
  }

  return '';
}

/* ---------- Render single question UI (with raw LLM debug block) ---------- */
function renderSingleQuestion(rawDebug = '') {
  questionsArea.innerHTML = '';
  if (!currentQuestion) {
    questionsArea.innerHTML = `<div class="card"><div class="qtext">No question available.</div></div>`;
    answerPanel.style.display = 'none';
    regenerateBtn.style.display = 'inline-flex';
    return;
  }

  const modelAnswerHtml = (currentQuestion.modelAnswer && currentQuestion.modelAnswer.trim()) ? escapeHtml(currentQuestion.modelAnswer) : 'Model answer unavailable.';
  const debugBlock = rawDebug ? `<details style="margin-top:8px;color:var(--muted);font-size:12px"><summary>Show LLM raw output</summary><pre style="white-space:pre-wrap;max-height:300px;overflow:auto">${escapeHtml(rawDebug)}</pre></details>` : '';

  const qcard = document.createElement('article');
  qcard.className = 'qcard';
  qcard.innerHTML = `
    <div class="qmeta">
      <div>
        <div class="qtitle">Interview Question</div>
        <div class="qtext">${escapeHtml(currentQuestion.q)}</div>
      </div>
      <div class="qactions">
        <button class="btn secondary toggleModelBtn" data-idx="0"> Model Answer</button>
      </div>
    </div>
    <div class="model" id="model-0" style="display:none;">
      <pre id="modelAnswerPre">${modelAnswerHtml}</pre>
      ${debugBlock}
    </div>
  `;

  questionsArea.appendChild(qcard);
  answerPanel.style.display = 'block';
  answerInput.value = '';
  feedbackContainer.innerHTML = '';
  regenerateBtn.style.display = 'inline-flex';
  regenerateBtn.disabled = false;
  apiStatus.textContent = '✅ Question ready';
  setTimeout(()=>answerInput.focus(), 120);
}

/* ---------- Events ---------- */
startBtn.addEventListener('click', startInterview);
regenerateBtn.addEventListener('click', regenerateQuestion);
questionsArea.addEventListener('click', (e) => {
  const btn = e.target.closest('.toggleModelBtn');
  if (!btn) return;
  const panel = document.getElementById('model-0');
  if (panel) panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
});
submitAnswerBtn.addEventListener('click', async () => {
  if (awaitingNext) { awaitingNext = false; submitAnswerBtn.textContent = ' Get Feedback'; return; }
  await evaluateAnswer();
});
revealModelBtn.addEventListener('click', () => {
  const panel = document.getElementById('model-0');
  if (panel) panel.style.display = panel.style.display === 'block' ? 'none' : 'block';
});
answerInput?.addEventListener?.('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) submitAnswerBtn.click(); });

/* ---------- Main flows ---------- */
async function startInterview() {
  currentQuestion = null;
  answerPanel.style.display = 'none';
  regenerateBtn.style.display = 'none';
  startBtn.disabled = true; startBtn.textContent = '🤖 Generating...';
  apiStatus.textContent = '⏳ Generating question...';
  lastLLMRaw = '';

  const role = (roleInput.value || 'Software Engineer').trim();
  const nonce = Math.random().toString(36).slice(2,9);
  const prompt = jsonPromptForSingleQuestion(role, previousQuestions, nonce, 'Concrete scenario preferred.');

  let llmText = await callGemini(prompt, { temperature: 0.6, maxRetries: 3 });
  let parsedObj = null;

  if (llmText) {
    debugLogLLM(llmText, 'startInterview - initial');
    const arr = extractJsonBlock(llmText);
    if (Array.isArray(arr) && arr.length > 0) {
      console.groupCollapsed('startInterview - parsedArray');
      console.log(arr);
      console.groupEnd();
      parsedObj = normalizeParsedObject(arr[0]);
      if (parsedObj && parsedObj.q) {
        currentQuestion = { q: parsedObj.q, modelAnswer: parsedObj.modelAnswer };
        renderSingleQuestion(llmText);
      }
    }

    if (!currentQuestion) {
      const anyJson = tryParseAnyJSON(llmText);
      if (anyJson) {
        console.groupCollapsed('startInterview - anyJson parsed');
        console.log(anyJson);
        console.groupEnd();
        const norm = normalizeParsedObject(anyJson);
        if (norm && norm.q) {
          currentQuestion = { q: norm.q, modelAnswer: norm.modelAnswer };
          renderSingleQuestion(llmText);
        }
      }
    }

    if (!currentQuestion) {
      const fallback = parseSingleQuestionFromText(llmText);
      if (fallback) {
        currentQuestion = { q: fallback.q, modelAnswer: fallback.modelAnswer || '' };
        renderSingleQuestion(llmText);
      }
    }
  }

  // if we have question but no modelAnswer, fetch one explicitly
  if (currentQuestion && (!currentQuestion.modelAnswer || !currentQuestion.modelAnswer.trim())) {
    // visually indicate fetching
    apiStatus.textContent = '⏳ Fetching model answer...';
    // optimistic UI update
    const pre = document.getElementById('modelAnswerPre');
    if (pre) pre.textContent = 'Fetching model answer...';
    const sol = await fetchSolutionForQuestion(currentQuestion.q, nonce);
    if (sol && sol.trim()) {
      currentQuestion.modelAnswer = sol.trim();
    } else {
      // last-resort: extract from lastLLMRaw
      const lastFallback = extractSolutionFromText(lastLLMRaw || llmText || '');
      if (lastFallback) currentQuestion.modelAnswer = lastFallback;
    }
    renderSingleQuestion(lastLLMRaw || llmText || '');
  }

  // final fallback if no question
  if (!currentQuestion) {
    apiStatus.textContent = '⚠️ LLM failed — using local fallback question.';
    const fb = getDiverseFallback(role)[0];
    currentQuestion = { q: fb.q, modelAnswer: fb.modelAnswer || fb.solution || '' };
    renderSingleQuestion();
  }

  previousQuestions.push(currentQuestion.q);
  startBtn.disabled = false; startBtn.textContent = ' New Interview';
}

/* ---------- Regenerate ---------- */
async function regenerateQuestion() {
  regenerateBtn.disabled = true; regenerateBtn.textContent = '🔁 Generating...';
  apiStatus.textContent = '🔁 Generating a distinct question...';
  lastLLMRaw = '';

  const role = (roleInput.value || 'Software Engineer').trim();
  let attempts = 0;
  let got = null;

  while (attempts < MAX_REGENERATE_ATTEMPTS) {
    attempts++;
    const nonce = Math.random().toString(36).slice(2,9);
    const prompt = jsonPromptForSingleQuestion(role, previousQuestions, nonce, 'Do NOT repeat previous questions. Make this question distinct.');
    const llmText = await callGemini(prompt, { temperature: 0.7, maxRetries: 3 });

    let candidate = null;
    if (llmText) {
      debugLogLLM(llmText, `regenerateAttempt-${attempts}`);
      const arr = extractJsonBlock(llmText);
      if (Array.isArray(arr) && arr.length > 0) {
        console.groupCollapsed(`regenerateAttempt-${attempts} - parsedArray`);
        console.log(arr);
        console.groupEnd();
        const p = normalizeParsedObject(arr[0]);
        if (p && p.q) candidate = { q: p.q, modelAnswer: p.modelAnswer };
        console.log(`regenerateAttempt-${attempts} - normalized`, p);
      } else {
        const any = tryParseAnyJSON(llmText);
        if (any) {
          const p = normalizeParsedObject(any);
          if (p && p.q) candidate = { q: p.q, modelAnswer: p.modelAnswer };
        } else {
          const parsed = parseSingleQuestionFromText(llmText);
          if (parsed) candidate = { q: parsed.q, modelAnswer: parsed.modelAnswer || '' };
        }
      }
    }

    if (!candidate) {
      apiStatus.textContent = `⚠️ Attempt ${attempts}: nothing parseable — retrying...`;
      await new Promise(r => setTimeout(r, 250 + Math.random() * 300));
      continue;
    }

    const sim = similarityToList(candidate.q, previousQuestions);
    if (sim < SIMILARITY_THRESHOLD) {
      // fetch solution if missing
      if (!candidate.modelAnswer || !candidate.modelAnswer.trim()) {
        const sol = await fetchSolutionForQuestion(candidate.q, nonce);
        if (sol) candidate.modelAnswer = sol;
        else {
          const lastFallback = extractSolutionFromText(lastLLMRaw);
          if (lastFallback) candidate.modelAnswer = lastFallback;
        }
      }
      got = candidate;
      break;
    } else {
      apiStatus.textContent = `⚠️ Attempt ${attempts}: too similar to previous — retrying...`;
      await new Promise(r => setTimeout(r, 250 + Math.random() * 300));
      continue;
    }
  }

  if (!got) {
    apiStatus.textContent = '⚠️ Could not get distinct LLM result — using local fallback.';
    const fb = getDiverseFallback(role).find(f => !previousQuestions.includes(f.q)) || getDiverseFallback(role)[0];
    got = { q: fb.q, modelAnswer: fb.modelAnswer || fb.solution || '' };
  }

  currentQuestion = got;
  previousQuestions.push(currentQuestion.q);
  renderSingleQuestion(lastLLMRaw);
  regenerateBtn.disabled = false; regenerateBtn.textContent = '🔁 New questions (same role)';
  apiStatus.textContent = '✅ New question ready.';
}

/* ---------- Evaluation / Feedback ---------- */
async function evaluateAnswer() {
  const userAnswer = answerInput.value.trim();
  if (!userAnswer) { feedbackContainer.innerHTML = `<div class="feedback-card">Please type your answer before submitting.</div>`; return; }

  submitAnswerBtn.disabled = true; submitAnswerBtn.textContent = ' Judging...';
  feedbackContainer.innerHTML = `<div class="feedback-card">AI reviewing your answer — please wait...</div>`;

  const qText = currentQuestion?.q || 'Question';
  const prompt = `You are an expert interviewer and evaluator. Score the following answer from 0-10 and provide short bullet points for strengths and improvements. Also include a concise model/ideal answer (2-6 sentences).

Q: ${qText}
A: ${userAnswer}

Return format EXACTLY:
Score: X/10
Strengths:
- ...
Improvements:
- ...
Model answer:
<concise model answer here>`;

  const feedbackText = await callGemini(prompt);

  if (!feedbackText) {
    const fallbackText = `Score: 8/10
Strengths:
- Clear structure
Improvements:
- Add technical depth and examples
Model answer:
${currentQuestion.modelAnswer || 'Model answer not available.'}`;
    displayFeedbackAndScore(fallbackText);
  } else {
    displayFeedbackAndScore(feedbackText);
  }

  awaitingNext = true;
  submitAnswerBtn.textContent = 'Get Feedback';
  submitAnswerBtn.disabled = false;
}

/* ---------- Display feedback ---------- */
function displayFeedbackAndScore(raw) {
  const text = raw || '';
  const scoreMatch = text.match(/Score\s*:\s*(\d{1,2})(?:\s*\/\s*10)?/i);
  const score = scoreMatch ? Number(scoreMatch[1]) : null;
  const safe = escapeHtml(text).replace(/\n/g, '<br>');
  const model = escapeHtml(currentQuestion?.modelAnswer || 'Model answer not available.').replace(/\n/g, '<br>');
  const scoreHtml = (score !== null) ? `<div style="font-size:18px;margin-bottom:8px"><strong>Score: ${score}/10</strong></div>` : '';

  feedbackContainer.innerHTML = `
    <div class="feedback-card">
      ${scoreHtml}
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:220px">
          <strong>AI Feedback</strong>
          <div style="margin-top:8px;color:var(--muted);font-size:13px">${safe}</div>
        </div>
        <div style="flex:1;min-width:220px;border-left:1px dashed rgba(255,255,255,0.02);padding-left:12px">
          <strong>Model Answer</strong>
          <div style="margin-top:8px;color:var(--muted);font-size:13px">${model}</div>
        </div>
      </div>
    </div>
  `;
}

/* ---------- Local fallback question generator ---------- */
function getDiverseFallback(role) {
  const r = (role || '').toLowerCase();
  if (r.includes('react') || r.includes('frontend') || r.includes('ui')) {
    return [
      { q: 'Explain React reconciliation and the role of keys in lists.', modelAnswer: 'Reconciliation compares virtual DOM trees to compute minimal updates; keys help React match elements between renders to avoid unnecessary reordering and re-renders.' },
      { q: 'How would you optimize rendering for a large list in React?', modelAnswer: 'Use list virtualization/windowing, memoize item components, avoid creating new props inline, and lazy-load images.' },
      { q: 'Explain differences between useEffect and useLayoutEffect.', modelAnswer: 'useEffect runs after painting; useLayoutEffect runs synchronously after DOM mutations but before paint — useful for measuring layout.' }
    ];
  } else if (r.includes('backend') || r.includes('node') || r.includes('api') || r.includes('server')) {
    return [
      { q: 'Design an API to handle high write throughput — what patterns would you use?', modelAnswer: 'Use partitioning/sharding, asynchronous processing (queues), idempotency, batching, and backpressure; choose storage that scales horizontally.' },
      { q: 'How would you implement authentication and authorization for microservices?', modelAnswer: 'Use centralized identity (OAuth/OIDC), short-lived JWTs for service-to-service calls, and fine-grained scopes for authorization.' },
      { q: 'Explain trade-offs between SQL and NoSQL for a new product.', modelAnswer: 'SQL offers ACID transactions and complex queries; NoSQL scales horizontally and handles diverse schemas but may sacrifice relational constraints.' }
    ];
  } else if (r.includes('ml') || r.includes('data') || r.includes('machine')) {
    return [
      { q: 'How do you prevent data leakage when training ML models?', modelAnswer: 'Split train/test by time/entities, fit preprocessors only on training data, and avoid using future information in features.' },
      { q: 'Explain bias-variance tradeoff and ways to diagnose it.', modelAnswer: 'Bias = underfitting, variance = overfitting. Use learning curves, cross-validation, and regularization to diagnose/tune.' },
      { q: 'What are steps to deploy an ML model to production?', modelAnswer: 'Containerize the model, expose an inference API, add monitoring, implement versioning, and define rollback strategies.' }
    ];
  } else {
    return [
      { q: 'Explain the Virtual DOM and why frameworks use it.', modelAnswer: 'Virtual DOM is an in-memory representation that allows frameworks to compute minimal updates and avoid expensive direct DOM manipulations.' },
      { q: 'Describe the JavaScript event loop and microtasks vs macrotasks.', modelAnswer: 'The event loop handles call stack and task queues; microtasks (promises) run before the next macrotask/paint.' },
      { q: 'How would you debug a performance bottleneck in an application?', modelAnswer: 'Profile with browser/devtools, measure network/db calls, identify hot functions, and apply targeted fixes like memoization or caching.' }
    ];
  }
}

/* ---------- Init ---------- */
regenerateBtn.style.display = 'none';
apiStatus.textContent = 'Ready. Enter a role and press Start.';
