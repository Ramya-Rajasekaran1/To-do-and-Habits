// netlify/functions/whatsapp.js
// QuestLog WhatsApp Webhook powered by Google Gemini and Supabase

const querystring = require('querystring');

// Helper to decode fallback credentials safely
function decodeKey(b64) {
  try { return Buffer.from(b64, 'base64').toString('utf8'); } catch(e) { return ''; }
}

const FALLBACK_GEMINI = decodeKey('QVEuQWI4Uk42TGxVeTQ3OXBnQ21IeGFRQ3N4M2lMS2NkZ2V5VFczUDFSd2F4VllYbzJqQUE=');
const FALLBACK_SUPA_KEY = decodeKey('c2Jfc2VjcmV0X2dVdXp4QmdaU211cWxPd2lraDNaU1FfMS0xRXlJb0U=');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || FALLBACK_GEMINI;
const SUPA_URL = process.env.SUPABASE_URL || 'https://sknrridioesaapiijqfl.supabase.co';
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || FALLBACK_SUPA_KEY;

// Default user ID for +91 7708914559
const DEFAULT_USER_ID = '4a51d743-b441-4557-a7a5-c68aa47c4fbb';

function formatTime(min) {
  if (min == null) return 'Unscheduled';
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const displayH = h % 12 === 0 ? 12 : h % 12;
  return `${displayH}:${m.toString().padStart(2, '0')} ${ampm}`;
}

function getTodayStr() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Fallback rule-based parser if AI key is missing or rate limited
function parseRuleBased(text, todayStr) {
  let name = text;
  let sm = null;
  let dm = 60;
  let date = todayStr;
  let cat = 'personal';

  if (/\btomorrow\b/i.test(text)) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    date = d.toISOString().split('T')[0];
    name = name.replace(/\btomorrow\b/gi, '');
  }

  const timeMatch = text.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const minute = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridian = timeMatch[3] ? timeMatch[3].toLowerCase() : null;

    if (meridian === 'pm' && hour < 12) hour += 12;
    if (meridian === 'am' && hour === 12) hour = 0;
    if (!meridian && hour >= 1 && hour <= 6) hour += 12;

    sm = hour * 60 + minute;
    name = name.replace(timeMatch[0], '');
  }

  const durMatch = text.match(/\b(\d+)\s*(?:m|min|mins|minutes|h|hr|hours)\b/i);
  if (durMatch) {
    const val = parseInt(durMatch[1], 10);
    if (/h/i.test(durMatch[0])) dm = val * 60;
    else dm = val;
    name = name.replace(durMatch[0], '');
  }

  if (/\b(work|meeting|call|client|sprint|project|deck|presentation|review)\b/i.test(text)) cat = 'work';
  else if (/\b(gym|run|workout|walk|health|doctor|dentist|sleep)\b/i.test(text)) cat = 'health';
  else if (/\b(read|book|course|study|learn)\b/i.test(text)) cat = 'learn';
  else if (/\b(pay|bill|bank|budget|invest|crypto)\b/i.test(text)) cat = 'finance';

  name = name.replace(/^add\s+/i, '').replace(/\s+/g, ' ').trim();
  if (!name) name = 'Quick Task';

  return {
    intent: 'ADD_TASK',
    task: { name, date, sm, dm, cat }
  };
}

async function parseWithGemini(userText, todayStr) {
  if (!GEMINI_API_KEY) {
    return parseRuleBased(userText, todayStr);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
  
  const systemPrompt = `You are the AI task assistant for QuestLog (a daily timeblocking and habit app).
Current date: ${todayStr} (Format YYYY-MM-DD).

Analyze the user's WhatsApp message and determine their intent:
1. ADD_TASK: User wants to create or schedule a task.
2. LIST_TASKS: User asks what they have today, requests schedule, backlog, or says "today", "list", "schedule".
3. COMPLETE_TASK: User says "done <task>", "finished <task>", "check off <task>".

Return ONLY a JSON object with this exact structure:
{
  "intent": "ADD_TASK" | "LIST_TASKS" | "COMPLETE_TASK",
  "task": {
    "name": "Clean title of the task without time/dates",
    "date": "YYYY-MM-DD",
    "sm": integer start minute from midnight (e.g. 9:00 AM = 540, 2:30 PM = 870) or null if unscheduled,
    "dm": integer duration in minutes (default 60 if scheduled, 30 if quick task, or parsed from text like "for 45m"),
    "cat": "work" | "health" | "learn" | "finance" | "personal"
  },
  "searchQuery": "if COMPLETE_TASK, the name or number of task to complete, else null"
}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: `${systemPrompt}\n\nUser message: "${userText}"` }]
        }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });

    if (!res.ok) {
      console.warn('Gemini API call failed, using rule-based parser fallback');
      return parseRuleBased(userText, todayStr);
    }

    const data = await res.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return JSON.parse(rawText);
  } catch (e) {
    console.warn('Gemini parsing exception:', e);
    return parseRuleBased(userText, todayStr);
  }
}

async function insertTaskToSupabase(task, userId) {
  if (!SUPA_KEY) {
    throw new Error('Supabase key not configured in environment');
  }

  const row = {
    user_id: userId || DEFAULT_USER_ID,
    name: task.name,
    cat: task.cat || 'personal',
    done: false,
    sm: task.sm ?? null,
    dm: task.dm || 60,
    created_for: task.date || getTodayStr()
  };

  const res = await fetch(`${SUPA_URL}/rest/v1/tasks`, {
    method: 'POST',
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(row)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Supabase insert failed: ${err.message || res.statusText}`);
  }

  const created = await res.json();
  return Array.isArray(created) ? created[0] : created;
}

async function getTodayTasksFromSupabase(dateStr, userId) {
  if (!SUPA_KEY) return [];
  const uid = userId || DEFAULT_USER_ID;
  const res = await fetch(`${SUPA_URL}/rest/v1/tasks?user_id=eq.${uid}&created_for=eq.${dateStr}&order=sm.asc.nullslast`, {
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`
    }
  });
  if (!res.ok) return [];
  return await res.json();
}

async function completeTaskInSupabase(query, userId) {
  if (!SUPA_KEY) return null;
  const today = getTodayStr();
  const uid = userId || DEFAULT_USER_ID;
  const res = await fetch(`${SUPA_URL}/rest/v1/tasks?user_id=eq.${uid}&created_for=eq.${today}&done=eq.false`, {
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`
    }
  });
  if (!res.ok) return null;
  const tasks = await res.json();
  if (!tasks.length) return null;

  let matched = null;
  const num = parseInt(query, 10);
  if (!isNaN(num) && num > 0 && num <= tasks.length) {
    matched = tasks[num - 1];
  } else {
    const qLower = query.toLowerCase();
    matched = tasks.find(t => t.name.toLowerCase().includes(qLower));
  }

  if (!matched) return null;

  await fetch(`${SUPA_URL}/rest/v1/tasks?id=eq.${matched.id}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': `Bearer ${SUPA_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ done: true })
  });

  return matched;
}

function twimlResponse(messageText) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    body: `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(messageText)}</Message></Response>`
  };
}

function escapeXml(unsafe) {
  return unsafe.replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'online',
        service: 'QuestLog WhatsApp Integration',
        docs: 'POST Twilio form data to this URL'
      })
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    let body = {};
    if (event.isBase64Encoded) {
      const buff = Buffer.from(event.body, 'base64');
      body = querystring.parse(buff.toString('utf8'));
    } else if (typeof event.body === 'string') {
      body = querystring.parse(event.body);
    }

    const fromNumber = body.From || '';
    const incomingText = (body.Body || '').trim();

    console.log(`WhatsApp from: ${fromNumber} | Text: "${incomingText}"`);

    if (!incomingText) {
      return twimlResponse('Received empty message. Send a task like "Call Dave tomorrow at 3pm".');
    }

    const todayStr = getTodayStr();
    const lower = incomingText.toLowerCase();

    // 1. "today" or "list"
    if (lower === 'today' || lower === 'list' || lower === 'schedule') {
      const list = await getTodayTasksFromSupabase(todayStr, DEFAULT_USER_ID);
      if (!list || !list.length) {
        return twimlResponse(`QUESTLOG ───\nNo tasks scheduled for today yet.\n\nReply with any task to add one (e.g. "Meeting at 2pm")!`);
      }
      const lines = list.map((t, idx) => {
        const timeBadge = t.sm != null ? `[${formatTime(t.sm)}]` : '[Unscheduled]';
        const check = t.done ? '[x]' : `[ ]`;
        return `${idx + 1}. ${check} ${timeBadge} ${t.name}`;
      });
      return twimlResponse(`QUESTLOG TODAY ───\n\n${lines.join('\n')}\n\nTip: Reply "done 1" to mark completed!`);
    }

    // 2. "done <name or number>"
    if (lower.startsWith('done ') || lower.startsWith('finish ')) {
      const q = incomingText.replace(/^(done|finish)\s+/i, '').trim();
      const completed = await completeTaskInSupabase(q, DEFAULT_USER_ID);
      if (completed) {
        return twimlResponse(`QUESTLOG ───\n[DONE] Marked complete: "${completed.name}"`);
      } else {
        return twimlResponse(`QUESTLOG ───\nCould not find an open task matching "${q}". Send "today" to see your list.`);
      }
    }

    // 3. AI / Smart parse
    const parsed = await parseWithGemini(incomingText, todayStr);
    console.log('Parsed intent:', JSON.stringify(parsed));

    if (parsed.intent === 'LIST_TASKS') {
      const list = await getTodayTasksFromSupabase(todayStr, DEFAULT_USER_ID);
      if (!list || !list.length) {
        return twimlResponse(`QUESTLOG ───\nNo tasks scheduled for today.\nSend a message to add one!`);
      }
      const lines = list.map((t, idx) => `${idx + 1}. ${t.done ? '[x]' : '[ ]'} ${t.sm != null ? `[${formatTime(t.sm)}]` : '[Unscheduled]'} ${t.name}`);
      return twimlResponse(`QUESTLOG TODAY ───\n\n${lines.join('\n')}`);
    }

    if (parsed.intent === 'COMPLETE_TASK') {
      const completed = await completeTaskInSupabase(parsed.searchQuery || parsed.task?.name || '', DEFAULT_USER_ID);
      if (completed) {
        return twimlResponse(`QUESTLOG ───\n[DONE] Completed: "${completed.name}"`);
      }
    }

    // ADD_TASK
    const taskData = parsed.task || {
      name: incomingText,
      date: todayStr,
      sm: null,
      dm: 60,
      cat: 'personal'
    };

    await insertTaskToSupabase(taskData, DEFAULT_USER_ID);

    const timeLabel = taskData.sm != null ? ` at ${formatTime(taskData.sm)} (${taskData.dm || 60}m)` : ` (${taskData.dm || 60}m unscheduled)`;
    const dateLabel = taskData.date === todayStr ? 'Today' : taskData.date;

    return twimlResponse(`QUESTLOG ───\n[ADDED] ${taskData.name}\nDate: ${dateLabel}${timeLabel}\nCategory: ${(taskData.cat || 'personal').toUpperCase()}\n\nCheck your dashboard at sycora.netlify.app!`);

  } catch (error) {
    console.error('Webhook error:', error);
    return twimlResponse(`QUESTLOG ───\nCould not save task: ${error.message}\nPlease check your Supabase connection.`);
  }
};
