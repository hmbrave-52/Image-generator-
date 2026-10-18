const express = require('express');
const puppeteer = require('puppeteer');
const { Groq } = require('groq-sdk');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- GROQ KEY ROTATOR MANAGER (Using qwen/qwen3.8-27b) ---
const groqKeys = [
  process.env.GROQ_API_KEY_1,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY
].filter(Boolean);

let currentKeyIndex = 0;

function getGroqClient() {
  if (groqKeys.length === 0) {
    throw new Error('No Groq API keys found in environment variables.');
  }
  return new Groq({ apiKey: groqKeys[currentKeyIndex] });
}

async function callGroqWithRotation(messages, options = {}) {
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
// -----------------------------------------------------------

app.get('/', (req, res) => {
  res.send('Luna Google Flow Bridge Server with Qwen/Groq Agent is active.');
});

app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Prompt is required' });
  }

  console.log(`[Google Flow] Processing request for prompt: "${prompt}"`);
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

    // Mask with real desktop Chrome User-Agent to preserve account sync
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');

    // SAFETY CHECK: Load cookies strictly from Render private environment variable
    if (!process.env.GOOGLE_COOKIES_JSON) {
      throw new Error('Security Error: GOOGLE_COOKIES_JSON environment variable is missing.');
    }

    const rawCookies = JSON.parse(process.env.GOOGLE_COOKIES_JSON);

    // Clean cookies to remove null partitionKeys and incompatible attributes
    const sanitizedCookies = rawCookies.map(cookie => {
      const cleanCookie = { ...cookie };
      if (!cleanCookie.partitionKey || cleanCookie.partitionKey === null) {
        delete cleanCookie.partitionKey;
      }
      if (cleanCookie.storeId === null) delete cleanCookie.storeId;
      if (cleanCookie.firstPartyDomain === "") delete cleanCookie.firstPartyDomain;
      if (cleanCookie.sameSite === null) delete cleanCookie.sameSite;
      return cleanCookie;
    });

    await page.setCookie(...sanitizedCookies);
    console.log('[Google Flow] Successfully loaded secure session cookies.');

    // STEP 1: Open Google Flow
    console.log('[Google Flow] Opening flow.google.com...');
    await page.goto('https://flow.google.com', { waitUntil: 'networkidle2', timeout: 60000 });

    // STEP 2: Check workspace status / reuse or create project
    console.log('[Google Flow] Checking workspace status...');
    await new Promise(r => setTimeout(r, 3000));

    const isInputPresent = await page.evaluate(() => {
      return !!document.querySelector('textarea, input[type="text"], [contenteditable="true"]');
    });

    if (!isInputPresent) {
      console.log('[Google Flow] Prompt box not active, clicking New Project...');
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], div'));
        const target = buttons.find(b => {
          const text = b.innerText?.trim().toLowerCase() || '';
          const aria = b.getAttribute('aria-label')?.toLowerCase() || '';
          return text.includes('new') || text.includes('create') || text.includes('+') || aria.includes('new') || aria.includes('create');
        });
        if (target) target.click();
      });
      await new Promise(r => setTimeout(r, 4000));
    } else {
      console.log('[Google Flow] Workspace already open. Reusing project for account sync.');
    }

    // STEP 3: Select model if available
    await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('*'));
      const modelEl = elements.find(el => el.innerText && (el.innerText.includes('Nano Banana') || el.innerText.includes('Model')));
      if (modelEl) modelEl.click();
    });
    await new Promise(r => setTimeout(r, 1000));

    // STEP 4: Enter prompt into text area/box
    console.log('[Google Flow] Entering prompt...');
    const inputSelector = 'textarea, input[type="text"], [contenteditable="true"]';
    await page.waitForSelector(inputSelector, { timeout: 15000 });
    
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

    console.log('[Google Flow] Prompt entered into box.');
    await new Promise(r => setTimeout(r, 1000));

    // STEP 5: Trigger generation (with Qwen agent fallback)
    console.log('[Google Flow] Triggering generation...');
    let clicked = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
      const genBtn = elements.find(el => {
        const text = el.innerText?.trim().toLowerCase() || '';
        const aria = el.getAttribute('aria-label')?.toLowerCase() || '';
        const testId = el.getAttribute('data-testid')?.toLowerCase() || '';
        
        return text.includes('generate') || 
               text.includes('create') || 
               text.includes('run') ||
               aria.includes('generate') || 
               aria.includes('create') || 
               aria.includes('send') ||
               testId.includes('submit') ||
               testId.includes('generate');
      });

      if (genBtn) {
        genBtn.click();
        return true;
      }
      return false;
    });

    if (!clicked && groqKeys.length > 0) {
      console.log('[Google Flow] Standard button match needs assistant. Querying Qwen agent...');
      const domSummary = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, [role="button"], div, span'))
          .map(el => el.innerText?.trim())
          .filter(t => t && t.length < 30)
          .slice(0, 40);
      });

      const agentResponse = await callGroqWithRotation([
        { role: 'system', content: 'You are a browser automation helper. Analyze the UI text elements and determine how to submit.' },
        { role: 'user', content: `Visible UI elements: ${JSON.stringify(domSummary)}. Which one triggers generation?` }
      ]);
      console.log('[Qwen Agent Analysis]:', agentResponse);
    }

    // Fallback confirmation via Enter key
    await page.keyboard.press('Enter');
    console.log('[Google Flow] Generation triggered. Activating network interceptor...');

    // NETWORK INTERCEPTOR: Filters out profile avatars and thumbnails
    let interceptedImageUrl = null;
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('=s32') || url.includes('=s64') || url.includes('avatar') || url.includes('favicon') || url.includes('logo')) {
          return;
        }

        if ((url.includes('googleusercontent.com') || url.includes('gen_img') || url.endsWith('.png') || url.endsWith('.jpg') || url.endsWith('.webp')) &&
            !url.includes('favicon')) {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('image') || url.includes('googleusercontent.com')) {
            if (!interceptedImageUrl) {
              interceptedImageUrl = url;
              console.log('[Google Flow] Intercepted real generated image URL:', url);
            }
          }
        }
      } catch (e) {}
    });

    // STEP 6: Wait for image result (up to 150s)
    const startTime = Date.now();
    while (Date.now() - startTime < 150000) {
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

    await browser.close();

    if (!interceptedImageUrl) {
      throw new Error('Image generation timed out or image URL could not be captured.');
    }

    console.log('[Google Flow] Success! Real image URL retrieved.');
    return res.json({ success: true, imageUrl: interceptedImageUrl });

  } catch (error) {
    if (browser) await browser.close();
    console.log('[Google Flow Error]:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Luna Server] Listening on port ${PORT}`);
});
