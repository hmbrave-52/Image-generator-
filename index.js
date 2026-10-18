const express = require('express');
const puppeteer = require('puppeteer');
const { Groq } = require('groq-sdk');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- DYNAMIC GROQ KEY ROTATOR (Parses single JSON secret) ---
let groqKeys = [];
try {
  groqKeys = JSON.parse(process.env.GROQ_KEYS_JSON || '[]');
} catch (e) {
  console.error('[Groq Manager] Error parsing GROQ_KEYS_JSON.');
}

if (groqKeys.length === 0 && process.env.GROQ_API_KEY) {
  groqKeys.push(process.env.GROQ_API_KEY);
}

console.log(`[Groq Manager] Successfully loaded ${groqKeys.length} API keys into rotation pool.`);

let currentKeyIndex = 0;

function getGroqClient() {
  if (groqKeys.length === 0) {
    throw new Error('No Groq API keys found in environment variables.');
  }
  return new Groq({ apiKey: groqKeys[currentKeyIndex] });
}

async function callGroqVisionWithRotation(messages, options = {}) {
  let attempts = 0;
  while (attempts < groqKeys.length) {
    try {
      const groq = getGroqClient();
      const response = await groq.chat.completions.create({
        model: 'qwen/qwen3.8-27b',
        messages: messages,
        temperature: options.temperature || 0.1,
        max_completion_tokens: options.max_tokens || 512,
      });
      return response.choices[0]?.message?.content || '';
    } catch (error) {
      if (error.status === 429 || error.status === 401) {
        console.warn(`[Groq Rotator] Key index ${currentKeyIndex} hit rate limit or auth error. Rotating key...`);
        currentKeyIndex = (currentKeyIndex + 1) % groqKeys.length;
        attempts++;
      } else {
        throw error;
      }
    }
  }
  throw new Error('All Groq API keys have been exhausted or hit rate limits.');
}

app.get('/', (req, res) => {
  res.send('Luna Google Flow Real-Time Vision Agent Bridge is active.');
});

app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Prompt is required' });
  }

  console.log(`[Google Flow Agent] Starting vision-driven session for prompt: "${prompt}"`);
  let browser;

  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');

    // Forward console logs for transparency
    page.on('console', msg => console.log(`[Browser Console]: ${msg.text()}`));

    if (!process.env.GOOGLE_COOKIES_JSON) {
      throw new Error('Security Error: GOOGLE_COOKIES_JSON environment variable is missing.');
    }

    const rawCookies = JSON.parse(process.env.GOOGLE_COOKIES_JSON);
    const sanitizedCookies = rawCookies.map(cookie => {
      const cleanCookie = { ...cookie };
      if (!cleanCookie.partitionKey || cleanCookie.partitionKey === null) delete cleanCookie.partitionKey;
      if (cleanCookie.storeId === null) delete cleanCookie.storeId;
      if (cleanCookie.firstPartyDomain === "") delete cleanCookie.firstPartyDomain;
      if (cleanCookie.sameSite === null) delete cleanCookie.sameSite;
      return cleanCookie;
    });

    await page.setCookie(...sanitizedCookies);
    console.log('[Google Flow Agent] Successfully loaded session cookies.');

    // STEP 1: Open Google Flow
    console.log('[Google Flow Agent] Opening flow.google.com...');
    await page.goto('https://flow.google.com', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 4000));

    // NETWORK INTERCEPTOR (Listens for generated image in background)
    let interceptedImageUrl = null;
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('=s32') || url.includes('=s64') || url.includes('avatar') || url.includes('favicon') || url.includes('logo')) return;

        if ((url.includes('googleusercontent.com') || url.includes('gen_img') || url.endsWith('.png') || url.endsWith('.jpg') || url.endsWith('.webp')) && !url.includes('favicon')) {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('image') || url.includes('googleusercontent.com')) {
            if (!interceptedImageUrl) {
              interceptedImageUrl = url;
              console.log('[Google Flow Agent] Intercepted generated image URL:', url);
            }
          }
        }
      } catch (e) {}
    });

    // STEP 2: REAL-TIME VISION AGENT INTERACTION LOOP
    let agentTurns = 0;
    let promptTyped = false;
    let generationTriggered = false;

    while (agentTurns < 5 && !interceptedImageUrl) {
      agentTurns++;
      console.log(`\n--- [Vision Agent Turn ${agentTurns}/5] Inspecting screen ---`);

      const screenshotBase64 = await page.screenshot({ encoding: 'base64' });

      const visionResponseText = await callGroqVisionWithRotation([
        {
          role: 'system',
          content: `You are an expert AI browser automation agent controlling Google Flow. Look at the attached screenshot of the webpage. Your goal is to enter the user's prompt ("${prompt}") and trigger image generation.
Analyze what you see and respond with a JSON object ONLY (no markdown backticks, raw JSON only) containing your next action:
- If you see a "New Project" or "+ Create" button that needs to be clicked first, respond with: {"action": "click_text", "target": "New"}
- If you see a text box / textarea where prompts are entered, respond with: {"action": "type_prompt", "text": "${prompt}"}
- If the prompt is entered and you see a generate/submit button (arrow, play icon, or generate button), respond with: {"action": "click_generate"}
- If generation is already running (loading animation or waiting state), respond with: {"action": "wait"}`
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Current status - Prompt typed: ${promptTyped}, Generation triggered: ${generationTriggered}. What is your next action based on this screenshot?` },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshotBase64}` } }
          ]
        }
      ], { max_tokens: 150 });

      console.log('[Vision Agent Decision]:', visionResponseText);

      // Parse JSON safely
      let agentAction = { action: 'wait' };
      try {
        const cleanJson = visionResponseText.replace(/```json/g, '').replace(/```/g, '').trim();
        agentAction = JSON.parse(cleanJson);
      } catch (parseErr) {
        console.warn('[Vision Agent] Failed to parse agent JSON, defaulting to wait/fallback action.');
      }

      // Execute Agent Action in Browser
      if (agentAction.action === 'click_text') {
        console.log(`[Agent Action] Clicking element containing text: "${agentAction.target}"`);
        await page.evaluate((targetText) => {
          const els = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
          const found = els.find(el => el.innerText?.trim().toLowerCase().includes(targetText.toLowerCase()));
          if (found) found.click();
        }, agentAction.target || 'New');
        await new Promise(r => setTimeout(r, 4000));

      } else if (agentAction.action === 'type_prompt') {
        console.log(`[Agent Action] Typing prompt into input field...`);
        await page.evaluate((userPrompt) => {
          const input = document.querySelector('textarea, input[type="text"], [contenteditable="true"]');
          if (input) {
            input.focus();
            if (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA') {
              input.value = userPrompt;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            } else {
              input.innerText = userPrompt;
              input.dispatchEvent(new InputEvent('input', { bubbles: true }));
            }
          }
        }, prompt);
        promptTyped = true;
        await new Promise(r => setTimeout(r, 2000));

      } else if (agentAction.action === 'click_generate') {
        console.log(`[Agent Action] Triggering generation button...`);
        await page.evaluate(() => {
          const elements = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
          const genBtn = elements.find(el => {
            const text = el.innerText?.trim().toLowerCase() || '';
            const aria = el.getAttribute('aria-label')?.toLowerCase() || '';
            return text.includes('generate') || text.includes('create') || text.includes('run') || aria.includes('generate') || aria.includes('submit');
          });
          if (genBtn) {
            genBtn.click();
          } else {
            const buttons = document.querySelectorAll('button, [role="button"]');
            if (buttons.length > 0) buttons[buttons.length - 1].click();
          }
        });
        generationTriggered = true;
        console.log('[Google Flow Agent] Generation triggered. Waiting for image stream...');
        break; // Exit setup loop and enter image waiting phase

      } else {
        console.log('[Agent Action] Waiting or observing state...');
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // STEP 3: Wait for Image Result Stream (up to 90s)
    const startTime = Date.now();
    while (Date.now() - startTime < 90000) {
      if (interceptedImageUrl) break;

      const domImgUrl = await page.evaluate(() => {
        const imgs = document.querySelectorAll('img');
        for (const img of imgs) {
          const src = img.src || '';
          if (src && !src.includes('avatar') && !src.includes('favicon') && !src.includes('=s32') && (img.naturalWidth > 200 || src.includes('googleusercontent'))) {
            return src;
          }
        }
        return null;
      });

      if (domImgUrl) {
        interceptedImageUrl = domImgUrl;
        break;
      }

      await new Promise(r => setTimeout(r, 3000));
    }

    if (!interceptedImageUrl) {
      // Final Vision Post-Mortem Diagnosis
      const finalScreenshot = await page.screenshot({ encoding: 'base64' });
      const finalDiag = await callGroqVisionWithRotation([
        { role: 'system', content: 'You are a debugging agent. Analyze why this Google Flow screenshot failed to produce an image after generation.' },
        { role: 'user', content: [{ type: 'text', text: 'Why did this generation time out?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${finalScreenshot}` } }] }
      ]);
      throw new Error(`Generation timed out. Vision Diagnostic: ${finalDiag}`);
    }

    await browser.close();
    console.log('[Google Flow Agent] Success! Image URL retrieved.');
    return res.json({ success: true, imageUrl: interceptedImageUrl });

  } catch (error) {
    console.error('[Google Flow Agent Error]:', error.message);
    if (browser) await browser.close();
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Luna Server] Real-Time Vision Agent listening on port ${PORT}`);
});
        
