// netlify/functions/ask.js
// AI Tech Buddy Q&A endpoint for Product Designers

function decodeKey(b64) {
  try { return Buffer.from(b64, 'base64').toString('utf8'); } catch(e) { return ''; }
}

const FALLBACK_GEMINI = decodeKey('QVEuQWI4Uk42TGxVeTQ3OXBnQ21IeGFRQ3N4M2lMS2NkZ2V5VFczUDFSd2F4VllYbzJqQUE=');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || FALLBACK_GEMINI;

const SYSTEM_PROMPT = `You are "Tech Buddy", an expert, friendly senior software engineer pair-programming with a talented Product Designer who has NO technical or coding background.
The designer is building "QuestLog", a daily timeboxing and habit tracker web application styled in Neo-brutalism (thick 3px black borders, #FFE135 yellow highlights, hard offset box-shadows, Outfit typography).

The project consists of:
1. questlog-neobrutalist.html: Pure Vanilla HTML, CSS, and JavaScript. Has a 9am-10pm calendar timeline (#time-grid), draggable backlog tasks (#us-col), and habit tracker.
2. netlify/functions/whatsapp.js: A serverless webhook that receives WhatsApp messages via Twilio, parses them using Gemini 2.5 Flash, and saves them to Supabase.
3. Supabase Database: Hosts the PostgreSQL "tasks" and "habits" tables with columns name, sm (start minute), dm (duration), and user_id.

Guidelines for your answers:
1. Always speak in encouraging, friendly, plain English.
2. ALWAYS use intuitive metaphors related to Figma (Layers, Auto-layout, Variables, Components, Prototypes) or real-world architecture/interior design.
3. Keep answers concise, formatted in crisp bullet points.
4. Give specific examples of where and how it exists in the QuestLog codebase.
5. End with a 1-sentence "How to flex this to engineers" tip.`;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Method Not Allowed' })
    };
  }

  try {
    const { question, history } = JSON.parse(event.body || '{}');

    if (!question || !question.trim()) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Question is required' })
      };
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    const promptText = `${SYSTEM_PROMPT}\n\nDesigner's Question: "${question.trim()}"`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }]
      })
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error (${res.status}): ${errText}`);
    }

    const data = await res.json();
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't formulate an answer. Please try again!";

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      },
      body: JSON.stringify({ answer })
    };

  } catch (error) {
    console.error('Ask endpoint error:', error);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: error.message })
    };
  }
};
