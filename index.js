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
  console.error('[Groq Manager] Error parsing GROQ_KEYS_JSON. Ensure it is a valid JSON array.');
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
  res.send('Luna Google Flow Bridge Server with Qwen Diagnostics is active.');
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
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');

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
    console.log('[Google Flow] Successfully loaded secure session cookies.');

    // STEP 1: Open Google Flow
    console.log('[Google Flow] Opening flow.google.com...');
    await page.goto('https://flow.google.com', { waitUntil: 'networkidle2', timeout: 60000 });

    // STEP 2: Check workspace status
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
    }

    // STEP 3: Select model if available
    await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('*'));
      const modelEl = elements.find(el => el.innerText && (el.innerText.includes('Nano Banana') || el.innerText.includes('Model')));
      if (modelEl) modelEl.click();
    });
    await new Promise(r => setTimeout(r, 1000));

    // STEP 4: Enter prompt
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

    await new Promise(r => setTimeout(r, 1000));

    // STEP 5: Trigger generation (Explicitly find and click the submit/generate button)
    console.log('[Google Flow] Triggering generation...');
    const clicked = await page.evaluate(() => {
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
               aria.includes('submit') ||
               testId.includes('submit') ||
               testId.includes('generate');
      });

      if (genBtn) {
        genBtn.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      console.log('[Google Flow] Submit button not found via text, attempting to click the submit icon/arrow near input...');
      // Fallback: Click the last button element or icon inside the input area layout
      await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        if (buttons.length > 0) {
          // Click the last button on the page, which is usually the submit arrow
          buttons[buttons.length - 1].click();
        }
      });
    }

    // NETWORK INTERCEPTOR
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
              console.log('[Google Flow] Intercepted generated image URL:', url);
            }
          }
        }
      } catch (e) {}
    });

    // STEP 6: Wait for image result
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

    // --- AI ERROR DIAGNOSTICIAN IF IT STICKS ---
    if (!interceptedImageUrl) {
      console.warn('[AI Diagnostics] Image generation timed out. Asking Qwen agent to analyze page state...');
      
      const pageDiagnostics = await page.evaluate(() => {
        return {
          title: document.title,
          currentUrl: window.location.href,
          visibleText: document.body.innerText.slice(0, 1500),
          hasCaptcha: document.body.innerText.toLowerCase().includes('captcha') || document.body.innerText.toLowerCase().includes('verify'),
          hasError: document.body.innerText.toLowerCase().includes('error') || document.body.innerText.toLowerCase().includes('failed')
        };
      });

      let aiReason = 'Unknown timeout reason.';
      if (groqKeys.length > 0) {
        try {
          aiReason = await callGroqWithRotation([
            { role: 'system', content: 'You are an expert web automation debugging agent. Analyze the provided Google Flow browser state and explain why the image generation got stuck or failed.' },
            { role: 'user', content: `Page diagnostics: ${JSON.stringify(pageDiagnostics)}` }
          ], { max_tokens: 200 });
        } catch (err) {
          aiReason = 'AI diagnostic failed to execute: ' + err.message;
        }
      }

      await browser.close();
      throw new Error(`Generation stuck / timed out. AI Diagnostic Report: ${aiReason}`);
    }

    await browser.close();
    console.log('[Google Flow] Success! Real image URL retrieved.');
    return res.json({ success: true, imageUrl: interceptedImageUrl });

  } catch (error) {
    if (browser) await browser.close();
    console.error('[Google Flow Error]:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Luna Server] Listening on port ${PORT}`);
});
                                                
